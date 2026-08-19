import { Readable } from 'stream';
import {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
    S3ServiceException,
    PutObjectCommandInput
} from '@aws-sdk/client-s3';
import { StorageBackend } from './interface.js';

export interface S3StorageBackendOptions {
    bucket: string;
    region?: string;
    prefix?: string;
    endpoint?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
}

/**
 * AWS S3 storage backend.
 *
 * Object layout mirrors LocalStorageBackend exactly:
 *   <prefix>/objects/<first-2-hex>/<remaining-62-hex>   (CAS by SHA-256)
 *   <prefix>/metadata/<safeKey>.json
 *
 * Atomicity: every S3 PUT is atomic for single-part uploads, so
 * interrupted writes never leave a partial object or metadata file.
 */
export class S3StorageBackend implements StorageBackend {
    private client: S3Client;
    private bucket: string;
    private prefix: string;

    constructor(options: S3StorageBackendOptions) {
        this.bucket = options.bucket;
        this.prefix = (options.prefix || '').replace(/^\/+|\/+$/g, '');

        const accessKeyId = options.accessKeyId || process.env.AWS_ACCESS_KEY_ID;
        const secretAccessKey = options.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY;
        const region = options.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';

        if (!this.bucket) {
            throw new Error('S3 bucket not configured. Set AWS_S3_BUCKET or pass bucket option.');
        }
        if (!accessKeyId || !secretAccessKey) {
            throw new Error('AWS credentials not found. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables.');
        }

        this.client = new S3Client({
            region,
            endpoint: options.endpoint || undefined,
            credentials: {
                accessKeyId,
                secretAccessKey
            },
            maxAttempts: 2
        });
    }

    private objectKey(hash: string): string {
        if (!/^[a-f0-9]{64}$/i.test(hash)) {
            throw new Error(`Invalid SHA-256 hash format: ${hash}`);
        }
        const rel = `objects/${hash.substring(0, 2)}/${hash.substring(2)}`;
        return this.prefix ? `${this.prefix}/${rel}` : rel;
    }

    private metadataKey(key: string): string {
        const safeKey = key.replace(/[^a-z0-9-_.]/gi, '_');
        const rel = `metadata/${safeKey}.json`;
        return this.prefix ? `${this.prefix}/${rel}` : rel;
    }

    private mapError(err: any): Error {
        const name = (err && (err.name || err.Code)) || 'UnknownError';
        const message = (err && err.message) || '';
        const status = (err && err.$metadata && err.$metadata.httpStatusCode) || 0;
        if (name === 'CredentialsProviderError' || name === 'InvalidAccessKeyId' || message.includes('SignatureDoesNotMatch') || name === 'UnrecognizedClientException' || (name === 'Unknown' && status === 403)) {
            return new Error('S3: invalid AWS credentials');
        }
        if (name === 'AccessDenied') {
            return new Error('S3: Access Denied - check IAM permissions');
        }
        if (name === 'NoSuchBucket' || name === 'NoSuchKey' || (name === 'NotFound' && status === 404 && message.includes('bucket'))) {
            return new Error(`S3: bucket/object not found (${name})`);
        }
        if (name === 'NetworkError' || name === 'TimeoutError' || name === 'RequestTimeout' || name === 'ECONNREFUSED' || name === 'ENOTFOUND' || name === 'EAI_AGAIN' || message.includes('fetch failed') || message.includes('getaddrinfo')) {
            return new Error('S3: network error connecting to AWS');
        }
        if (name === 'PermanentRedirect' || name === 'RequestRedirect' || name === 'MovedPermanently' || status === 301 || message.includes('The bucket is in this region')) {
            return new Error('S3: wrong region configured for this bucket');
        }
        if (err instanceof S3ServiceException) {
            return new Error(`S3: ${err.name} (${status || 'unknown status'})`);
        }
        return new Error(`S3: ${name}`);
    }

        private async putWithRetry(params: PutObjectCommandInput): Promise<void> {
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                await this.client.send(new PutObjectCommand(params));
                return;
            } catch (err: any) {
                if ((err.name === 'SlowDown' || err.Code === 'SlowDown') && attempt < 2) {
                    await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
                    continue;
                }
                throw err;
            }
        }
    }

    public async writeObject(hash: string, content: Buffer | Readable | string): Promise<void> {
        if (await this.hasObject(hash)) {
            return; // CAS deduplication: already exists
        }
        const key = this.objectKey(hash);
        try {
            await this.putWithRetry({
                Bucket: this.bucket,
                Key: key,
                Body: content,
                ContentType: 'application/octet-stream'
            });
        } catch (err) {
            throw this.mapError(err);
        }
    }

    public async readObject(hash: string): Promise<Buffer> {
        const key = this.objectKey(hash);
        try {
            const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
            if (!res.Body) throw new Error('Empty response body');
            const bytes = await res.Body.transformToByteArray();
            return Buffer.from(bytes);
        } catch (err: any) {
            if (err.name === 'NoSuchKey') throw new Error(`Object not found: ${hash}`);
            throw this.mapError(err);
        }
    }

    public async readObjectStream(hash: string): Promise<Readable> {
        const key = this.objectKey(hash);
        try {
            const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
            if (!res.Body) throw new Error('Empty response body');
            return res.Body as unknown as Readable;
        } catch (err: any) {
            if (err.name === 'NoSuchKey') throw new Error(`Object not found: ${hash}`);
            throw this.mapError(err);
        }
    }

    public async hasObject(hash: string): Promise<boolean> {
        const key = this.objectKey(hash);
        try {
            await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
            return true;
        } catch (err: any) {
            if (err.name === 'NotFound' || err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
                return false;
            }
            throw this.mapError(err);
        }
    }

    public async writeMetadata(key: string, data: any): Promise<void> {
        const objectKey = this.metadataKey(key);
        try {
            await this.putWithRetry({
                Bucket: this.bucket,
                Key: objectKey,
                Body: JSON.stringify(data),
                ContentType: 'application/json'
            });
        } catch (err) {
            throw this.mapError(err);
        }
    }

    public async readMetadata(key: string): Promise<any> {
        const objectKey = this.metadataKey(key);
        try {
            const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }));
            if (!res.Body) return null;
            const bytes = await res.Body.transformToByteArray();
            return JSON.parse(Buffer.from(bytes).toString('utf8'));
        } catch (err: any) {
            if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
                return null;
            }
            throw this.mapError(err);
        }
    }
}