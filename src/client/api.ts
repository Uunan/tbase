import { configManager } from '../utils/config.js';
import { KeyManager } from '../core/keys.js';
import { Logger } from '../utils/logger.js';
import fs from 'fs';
import path from 'path';

export class ClientAPI {
    private baseUrl: string;
    private serverKey: string; 

    constructor() {
        const config = configManager.getConfig();
        if (config.mode !== 'client') {
            throw new Error('Not in client mode');
        }
        const host = config.serverAddress || 'localhost';
        const port = config.serverPort || 7420;
        const protocol = config.serverProtocol || 'http';
        this.baseUrl = `${protocol}://${host}:${port}/api/v1`;

        const configPath = path.join(configManager.getConfigDir(), 'client_keys.json');
        let keys: any = {};
        if (fs.existsSync(configPath)) keys = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        this.serverKey = keys[config.clusterId!] || "missing_key";
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

    public async checkMissingObjects(clusterId: string, hashes: string[]): Promise<string[]> {
        const res = await fetch(`${this.baseUrl}/clusters/${clusterId}/objects/check`, {
            method: 'POST',
            headers: this.getHeaders(),
            body: JSON.stringify({ hashes })
        });
        if (!res.ok) {
            const err: any = new Error(`Failed to check objects: ${res.status} ${res.statusText}`);
            err.status = res.status;
            throw err;
        }
        const data = await res.json() as { missing: string[] };
        return data.missing;
    }

    public async uploadObject(clusterId: string, hash: string, filePath: string): Promise<void> {
        const content = await fs.promises.readFile(filePath);
        const res = await fetch(`${this.baseUrl}/clusters/${clusterId}/objects/${hash}`, {
            method: 'POST',
            headers: this.getHeaders('application/octet-stream'),
            body: content
        });
        if (!res.ok) {
            const errorText = await res.text();
            const err: any = new Error(`Failed to upload object ${hash}: ${res.status} ${errorText}`);
            err.status = res.status;
            throw err;
        }
    }

    public async downloadObject(clusterId: string, hash: string, destPath: string): Promise<void> {
        const res = await fetch(`${this.baseUrl}/clusters/${clusterId}/objects/${hash}`, {
            headers: this.getHeaders('')
        });
        if (!res.ok) {
            const err: any = new Error(`Failed to download object ${hash}: ${res.statusText}`);
            err.status = res.status;
            throw err;
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
            const err: any = new Error(`Failed to save snapshot: ${res.statusText}`);
            err.status = res.status;
            throw err;
        }
    }

    public async getSnapshot(clusterId: string, snapshotId: string): Promise<any> {
        const res = await fetch(`${this.baseUrl}/clusters/${clusterId}/snapshots/${snapshotId}`, {
            headers: this.getHeaders()
        });
        if (res.status === 404) return null;
        if (!res.ok) {
            const err: any = new Error(`Failed to get snapshot: ${res.statusText}`);
            err.status = res.status;
            throw err;
        }
        return await res.json();
    }
}

export class MgmtAPI {
    private baseUrl: string;
    private serverKey: string; 

    constructor() {
        const config = configManager.getConfig();
        if (config.mode !== 'server') {
            throw new Error('Must be run on the server machine to manage clusters via CLI');
        }
        const port = config.serverPort || 7420;
        this.baseUrl = `http://localhost:${port}/api/v1/management`;
        this.serverKey = KeyManager.loadKey() || '';
    }

    private getHeaders() {
        return {
            'Authorization': `Bearer ${this.serverKey}`,
            'Content-Type': 'application/json'
        };
    }

    public async createCluster(clusterId: string, limitBytes: number): Promise<any> {
        const res = await fetch(`${this.baseUrl}/clusters`, {
            method: 'POST',
            headers: this.getHeaders(),
            body: JSON.stringify({ cluster_id: clusterId, storage_limit_bytes: limitBytes })
        });
        if (!res.ok) {
            const errJson = await res.json().catch(() => null);
            const err: any = new Error((errJson && errJson.error) || 'Failed to create cluster');
            err.status = res.status;
            throw err;
        }
        return await res.json();
    }

    public async listClusters(): Promise<any> {
        const res = await fetch(`${this.baseUrl}/clusters`, { headers: this.getHeaders() });
        if (!res.ok) {
            const err: any = new Error('Failed to list clusters');
            err.status = res.status;
            throw err;
        }
        return await res.json();
    }

    public async getCluster(clusterId: string): Promise<any> {
        const res = await fetch(`${this.baseUrl}/clusters/${clusterId}`, { headers: this.getHeaders() });
        if (!res.ok) {
            const err: any = new Error('Failed to get cluster');
            err.status = res.status;
            throw err;
        }
        return await res.json();
    }

    public async deleteCluster(clusterId: string): Promise<void> {
        const res = await fetch(`${this.baseUrl}/clusters/${clusterId}`, { method: 'DELETE', headers: this.getHeaders() });
        if (!res.ok) {
            const err: any = new Error('Failed to delete cluster');
            err.status = res.status;
            throw err;
        }
    }

    public async rotateKey(clusterId: string): Promise<string> {
        const res = await fetch(`${this.baseUrl}/clusters/${clusterId}/rotate-key`, { method: 'POST', headers: this.getHeaders() });
        if (!res.ok) {
            const err: any = new Error('Failed to rotate cluster key');
            err.status = res.status;
            throw err;
        }
        const data = await res.json() as any;
        return data.access_key;
    }
}
