import crypto from 'crypto';
import { StorageBackend } from '../storage/interface.js';
import { Logger } from '../utils/logger.js';

export interface ClusterConfig {
    id: string;
    accessKey: string;
    storageLimitBytes: number;
    usedBytes: number;
    createdAt: number;
    deleted?: boolean;
}

export class ClusterManager {
    private storage: StorageBackend;
    private inFlightBytes: Map<string, number> = new Map();
    private quotaCache: Map<string, { usedBytes: number; storageLimitBytes: number }> = new Map();
    private pushedBytes: Map<string, number> = new Map();

    constructor(storage: StorageBackend) {
        this.storage = storage;
    }

    private getConfigKey(clusterId: string): string {
        return `cluster_config_${clusterId}`;
    }

    public generateClusterKey(): string {
        return 'tb_cl_' + crypto.randomBytes(32).toString('hex');
    }

    public async createCluster(clusterId: string, limitBytes: number): Promise<ClusterConfig> {
        if (!/^[a-z0-9-]+$/.test(clusterId)) {
            throw new Error('Invalid Cluster ID format');
        }

        const existing = await this.storage.readMetadata(this.getConfigKey(clusterId));
        if (existing && !existing.deleted) {
            throw new Error('Cluster already exists');
        }

        const accessKey = this.generateClusterKey();
        const config: ClusterConfig = {
            id: clusterId,
            accessKey,
            storageLimitBytes: limitBytes,
            usedBytes: 0,
            createdAt: Date.now()
        };

        await this.storage.writeMetadata(this.getConfigKey(clusterId), config);
        await this.updateTokenIndex(clusterId, null, accessKey);
        this.quotaCache.set(clusterId, { usedBytes: 0, storageLimitBytes: limitBytes });
        this.pushedBytes.set(clusterId, 0);
        
        return config;
    }

    public async getCluster(clusterId: string): Promise<ClusterConfig | null> {
        const config = await this.storage.readMetadata(this.getConfigKey(clusterId));
        if (config && config.deleted) return null;
        return config;
    }

    public async listClusters(): Promise<Partial<ClusterConfig>[]> {
        const index = await this.storage.readMetadata('cluster_token_index') || {};
        const clusters = [];
        const uniqueIds = Array.from(new Set(Object.values(index) as string[]));
        
        for (const cid of uniqueIds) {
            const config = await this.getCluster(cid);
            if (config) {
                clusters.push({
                    id: config.id,
                    storageLimitBytes: config.storageLimitBytes,
                    usedBytes: config.usedBytes,
                    createdAt: config.createdAt
                });
            }
        }
        return clusters;
    }

    public async deleteCluster(clusterId: string): Promise<void> {
        const config = await this.getCluster(clusterId);
        if (!config) throw new Error('Cluster not found');
        
        config.deleted = true;
        await this.storage.writeMetadata(this.getConfigKey(clusterId), config);
        await this.updateTokenIndex(clusterId, config.accessKey, null);
    }

    public async rotateKey(clusterId: string): Promise<string> {
        const config = await this.getCluster(clusterId);
        if (!config) throw new Error('Cluster not found');

        const oldKey = config.accessKey;
        const newKey = this.generateClusterKey();
        config.accessKey = newKey;
        
        await this.storage.writeMetadata(this.getConfigKey(clusterId), config);
        await this.updateTokenIndex(clusterId, oldKey, newKey);
        
        return newKey;
    }

    public async authenticateCluster(token: string): Promise<string | null> {
        const index = await this.storage.readMetadata('cluster_token_index') || {};
        const clusterId = index[token];
        if (clusterId) {
            const config = await this.getCluster(clusterId);
            if (config && config.accessKey === token) {
                return clusterId;
            }
        }
        return null;
    }

    private async updateTokenIndex(clusterId: string, oldToken: string | null, newToken: string | null) {
        const index = await this.storage.readMetadata('cluster_token_index') || {};
        if (oldToken) delete index[oldToken];
        if (newToken) index[newToken] = clusterId;
        await this.storage.writeMetadata('cluster_token_index', index);
    }

    public async checkAndReserveQuota(clusterId: string, bytes: number): Promise<boolean> {
        let entry = this.quotaCache.get(clusterId);
        if (!entry) {
            const config = await this.getCluster(clusterId);
            if (!config) return false;
            entry = { usedBytes: config.usedBytes, storageLimitBytes: config.storageLimitBytes };
            this.quotaCache.set(clusterId, entry);
        }

        const inFlight = this.inFlightBytes.get(clusterId) || 0;
        const pushed = this.pushedBytes.get(clusterId) || 0;
        if (entry.usedBytes + pushed + inFlight + bytes > entry.storageLimitBytes) {
            return false;
        }

        this.inFlightBytes.set(clusterId, inFlight + bytes);
        return true;
    }

    public releaseInFlightQuota(clusterId: string, bytes: number, success: boolean) {
        const inFlight = this.inFlightBytes.get(clusterId) || 0;
        this.inFlightBytes.set(clusterId, Math.max(0, inFlight - bytes));
        if (success) {
            const pushed = this.pushedBytes.get(clusterId) || 0;
            this.pushedBytes.set(clusterId, pushed + bytes);
        }
    }

    public async recalculateQuotaFromSnapshot(clusterId: string, snapshotId: string): Promise<void> {
        const config = await this.getCluster(clusterId);
        if (!config) return;

        const snapshot = await this.storage.readMetadata(`cluster_${clusterId}_${snapshotId}`);
        if (!snapshot || !snapshot.files) return;

        let totalBytes = 0;
        for (const key in snapshot.files) {
            totalBytes += snapshot.files[key].size || 0;
        }

        config.usedBytes = totalBytes;
        await this.storage.writeMetadata(this.getConfigKey(clusterId), config);
        this.quotaCache.set(clusterId, { usedBytes: totalBytes, storageLimitBytes: config.storageLimitBytes });
        this.inFlightBytes.set(clusterId, 0);
        this.pushedBytes.set(clusterId, 0);
    }
}
