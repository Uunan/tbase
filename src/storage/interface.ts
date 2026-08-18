import { Readable } from 'stream';

export interface StorageMetadata {
    size: number;
    lastModified: number;
    hash?: string;
}

export interface StorageBackend {
    /**
     * Store an object by its SHA-256 hash.
     * Deduplication is handled intrinsically by content addressing.
     */
    writeObject(hash: string, content: Buffer | Readable | string): Promise<void>;
    
    /**
     * Read an object by its SHA-256 hash.
     */
    readObject(hash: string): Promise<Buffer>;
    
    /**
     * Get a readable stream for large objects.
     */
    readObjectStream(hash: string): Promise<Readable>;
    
    /**
     * Check if an object exists.
     */
    hasObject(hash: string): Promise<boolean>;
    
    /**
     * Store snapshot/metadata atomically
     */
    writeMetadata(key: string, data: any): Promise<void>;
    
    /**
     * Read metadata
     */
    readMetadata(key: string): Promise<any>;
}
