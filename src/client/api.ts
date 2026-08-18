import { configManager } from '../utils/config.js';
import { Logger } from '../utils/logger.js';
import fs from 'fs';

export class ClientAPI {
    private baseUrl: string;
    private serverKey: string = "tb_sk_mock_123456789"; 

    constructor() {
        const config = configManager.getConfig();
        if (config.mode !== 'client') {
            throw new Error('Not in client mode');
        }
        const host = config.serverAddress || 'localhost';
        const port = config.serverPort || 7420;
        this.baseUrl = `http://${host}:${port}/api/v1`;
    }

    private getHeaders(contentType: string = 'application/json') {
        const headers: Record<string, string> = {
            'Authorization': `Bearer ${this.serverKey}`
        };
        if (contentType) {
            headers['Content-Type'] = contentType;
        }
        return headers;
    }

    public async healthCheck(): Promise<boolean> {
        try {
            const res = await fetch(`${this.baseUrl}/health`);
            return res.ok;
        } catch {
            return false;
        }
    }

    public async checkMissingObjects(hashes: string[]): Promise<string[]> {
        const res = await fetch(`${this.baseUrl}/objects/check`, {
            method: 'POST',
            headers: this.getHeaders(),
            body: JSON.stringify({ hashes })
        });
        
        if (!res.ok) {
            throw new Error(`Failed to check objects: ${res.statusText}`);
        }

        const data = await res.json() as { missing: string[] };
        return data.missing;
    }

    public async uploadObject(hash: string, filePath: string): Promise<void> {
        const content = await fs.promises.readFile(filePath);
        
        const res = await fetch(`${this.baseUrl}/objects/${hash}`, {
            method: 'POST',
            headers: this.getHeaders('application/octet-stream'),
            body: content
        });

        if (!res.ok) {
            const errorText = await res.text();
            throw new Error(`Failed to upload object ${hash}: ${res.status} ${errorText}`);
        }
    }

    public async downloadObject(hash: string, destPath: string): Promise<void> {
        const res = await fetch(`${this.baseUrl}/objects/${hash}`, {
            headers: this.getHeaders('')
        });

        if (!res.ok) {
            throw new Error(`Failed to download object ${hash}: ${res.statusText}`);
        }

        const buffer = await res.arrayBuffer();
        await fs.promises.writeFile(destPath, Buffer.from(buffer));
    }

    public async saveSnapshot(clusterId: string, snapshotId: string, metadata: any): Promise<void> {
        const res = await fetch(`${this.baseUrl}/clusters/${clusterId}/snapshots/${snapshotId}`, {
            method: 'POST',
            headers: this.getHeaders(),
            body: JSON.stringify(metadata)
        });

        if (!res.ok) {
            throw new Error(`Failed to save snapshot: ${res.statusText}`);
        }
    }

    public async getSnapshot(clusterId: string, snapshotId: string): Promise<any> {
        const res = await fetch(`${this.baseUrl}/clusters/${clusterId}/snapshots/${snapshotId}`, {
            headers: this.getHeaders()
        });

        if (res.status === 404) {
            return null;
        }

        if (!res.ok) {
            throw new Error(`Failed to get snapshot: ${res.statusText}`);
        }

        return await res.json();
    }
}
