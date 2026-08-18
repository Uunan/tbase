import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { StorageBackend } from './interface.js';

export class LocalStorageBackend implements StorageBackend {
    private basePath: string;
    private objectsPath: string;
    private metadataPath: string;
    private tmpPath: string;

    constructor(basePath: string) {
        this.basePath = basePath;
        this.objectsPath = path.join(this.basePath, 'objects');
        this.metadataPath = path.join(this.basePath, 'metadata');
        this.tmpPath = path.join(this.basePath, 'tmp');
        this.initDirs();
    }

    private initDirs() {
        [this.objectsPath, this.metadataPath, this.tmpPath].forEach(dir => {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
            }
        });
    }

    private getObjectPath(hash: string): string {
        if (!/^[a-f0-9]{64}$/i.test(hash)) {
            throw new Error(`Invalid SHA-256 hash format: ${hash}`);
        }
        // Format: objects/ab/cdef123...
        const prefix = hash.substring(0, 2);
        const rest = hash.substring(2);
        const dir = path.join(this.objectsPath, prefix);
        
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        }
        
        return path.join(dir, rest);
    }

    public async writeObject(hash: string, content: Buffer | Readable | string): Promise<void> {
        const finalPath = this.getObjectPath(hash);
        
        if (await this.hasObject(hash)) {
            return; // Deduplication: already exists
        }

        // Write to temp file first, then atomically rename
        const tmpFile = path.join(this.tmpPath, `obj_${hash}_${Date.now()}`);
        
        try {
            if (content instanceof Readable) {
                const writeStream = fs.createWriteStream(tmpFile);
                await pipeline(content, writeStream);
            } else {
                await fsPromises.writeFile(tmpFile, content);
            }
            
            // Atomically rename to final destination
            await fsPromises.rename(tmpFile, finalPath);
        } catch (err) {
            // Clean up on failure
            if (fs.existsSync(tmpFile)) {
                await fsPromises.unlink(tmpFile).catch(() => {});
            }
            throw err;
        }
    }

    public async readObject(hash: string): Promise<Buffer> {
        const filePath = this.getObjectPath(hash);
        return fsPromises.readFile(filePath);
    }

    public async readObjectStream(hash: string): Promise<Readable> {
        const filePath = this.getObjectPath(hash);
        if (!fs.existsSync(filePath)) {
            throw new Error(`Object not found: ${hash}`);
        }
        return fs.createReadStream(filePath);
    }

    public async hasObject(hash: string): Promise<boolean> {
        try {
            const filePath = this.getObjectPath(hash);
            const stat = await fsPromises.stat(filePath);
            return stat.isFile();
        } catch {
            return false;
        }
    }

    public async writeMetadata(key: string, data: any): Promise<void> {
        // Prevent path traversal
        const safeKey = key.replace(/[^a-z0-9-_.]/gi, '_');
        const finalPath = path.join(this.metadataPath, `${safeKey}.json`);
        const tmpFile = path.join(this.tmpPath, `meta_${safeKey}_${Date.now()}`);
        
        try {
            await fsPromises.writeFile(tmpFile, JSON.stringify(data, null, 2));
            await fsPromises.rename(tmpFile, finalPath);
        } catch (err) {
            if (fs.existsSync(tmpFile)) {
                await fsPromises.unlink(tmpFile).catch(() => {});
            }
            throw err;
        }
    }

    public async readMetadata(key: string): Promise<any> {
        const safeKey = key.replace(/[^a-z0-9-_.]/gi, '_');
        const finalPath = path.join(this.metadataPath, `${safeKey}.json`);
        
        if (!fs.existsSync(finalPath)) {
            return null;
        }
        
        const content = await fsPromises.readFile(finalPath, 'utf8');
        return JSON.parse(content);
    }
}
