import crypto from 'crypto';
import fs from 'fs';
import { pipeline } from 'stream/promises';

export class CryptoUtils {
    /**
     * Compute SHA-256 hash of a string or buffer
     */
    public static hashContent(content: string | Buffer): string {
        return crypto.createHash('sha256').update(content).digest('hex');
    }

    /**
     * Compute SHA-256 hash of a file using streams to avoid memory limits
     */
    public static async hashFile(filePath: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const hash = crypto.createHash('sha256');
            const stream = fs.createReadStream(filePath);
            
            stream.on('error', err => reject(err));
            stream.on('data', chunk => hash.update(chunk));
            stream.on('end', () => resolve(hash.digest('hex')));
        });
    }

    /**
     * Generate a secure random server key
     */
    public static generateServerKey(): string {
        return 'tb_sk_' + crypto.randomBytes(32).toString('hex');
    }
}
