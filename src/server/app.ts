import express from 'express';
import cors from 'cors';
import { requireManagementAuth, requireClusterAuth, setClusterManager } from './auth.js';
import { StorageBackend } from '../storage/interface.js';
import { Logger } from '../utils/logger.js';
import { ClusterManager } from './clusterManager.js';

export const createServerApp = (storage: StorageBackend) => {
    const app = express();
    const clusterManager = new ClusterManager(storage);
    setClusterManager(clusterManager);
    
    app.use(cors());
    app.use(express.json({ limit: '10mb' })); 
    app.use('/api/v1/clusters/:clusterId/objects/:hash', express.raw({ type: 'application/octet-stream', limit: '5gb' }));

    app.get('/api/v1/health', (req, res) => {
        res.json({ status: 'ok', version: '1.3.0' });
    });

    // ==========================================
    // MANAGEMENT API
    // ==========================================
    const mgmtRouter = express.Router();
    mgmtRouter.use(requireManagementAuth);

    mgmtRouter.post('/clusters', async (req, res) => {
        try {
            const { cluster_id, storage_limit_bytes } = req.body;
            if (!cluster_id || !storage_limit_bytes) return res.status(400).json({ error: 'Missing parameters' });
            
            const cluster = await clusterManager.createCluster(cluster_id, storage_limit_bytes);
            res.status(201).json({
                cluster_id: cluster.id,
                access_key: cluster.accessKey,
                storage_limit_bytes: cluster.storageLimitBytes
            });
        } catch (err: any) {
            res.status(400).json({ error: err.message });
        }
    });

    mgmtRouter.get('/clusters', async (req, res) => {
        try {
            const clusters = await clusterManager.listClusters();
            res.json(clusters);
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });

    mgmtRouter.get('/clusters/:clusterId', async (req, res) => {
        try {
            const cluster = await clusterManager.getCluster(req.params.clusterId);
            if (!cluster) return res.status(404).json({ error: 'Not found' });
            // Don't return access_key in GET
            res.json({
                id: cluster.id,
                storageLimitBytes: cluster.storageLimitBytes,
                usedBytes: cluster.usedBytes,
                createdAt: cluster.createdAt
            });
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });

    mgmtRouter.delete('/clusters/:clusterId', async (req, res) => {
        try {
            await clusterManager.deleteCluster(req.params.clusterId);
            res.json({ status: 'deleted' });
        } catch (err: any) {
            res.status(400).json({ error: err.message });
        }
    });

    mgmtRouter.post('/clusters/:clusterId/rotate-key', async (req, res) => {
        try {
            const newKey = await clusterManager.rotateKey(req.params.clusterId);
            res.json({ access_key: newKey });
        } catch (err: any) {
            res.status(400).json({ error: err.message });
        }
    });

    app.use('/api/v1/management', mgmtRouter);

    // ==========================================
    // DATA API (Cluster Isolated)
    // ==========================================
    const dataRouter = express.Router({ mergeParams: true });
    dataRouter.use(requireClusterAuth);

    dataRouter.post('/objects/check', async (req, res) => {
        const { hashes } = req.body;
        if (!Array.isArray(hashes)) return res.status(400).json({ error: 'Expected an array of hashes' });

        try {
            const missing = [];
            for (const hash of hashes) {
                const exists = await storage.hasObject(hash);
                if (!exists) missing.push(hash);
            }
            res.json({ missing });
        } catch (err: any) {
            res.status(500).json({ error: 'Internal error' });
        }
    });

    dataRouter.post('/objects/:hash', async (req, res) => {
        const hash = req.params.hash as string;
        const clusterId = (req as any).clusterId;
        
        if (!/^[a-f0-9]{64}$/i.test(hash)) return res.status(400).json({ error: 'Invalid hash format' });

        try {
            const exists = await storage.hasObject(hash);
            if (exists) return res.status(200).json({ status: 'ignored' });

            const content = req.body;
            if (!content || !(content instanceof Buffer)) return res.status(400).json({ error: 'Missing content' });

            // Quota check
            const size = content.length;
            const allowed = await clusterManager.checkAndReserveQuota(clusterId, size);
            if (!allowed) {
                return res.status(402).json({ error: 'Quota Exceeded' });
            }

            let writeSuccess = false;
            try {
                const { CryptoUtils } = await import('../core/crypto.js');
                const calculatedHash = CryptoUtils.hashContent(content);
                if (calculatedHash !== hash) throw new Error('Hash mismatch');

                await storage.writeObject(hash, content);
                writeSuccess = true;
                res.status(201).json({ status: 'created' });
            } finally {
                // Always release in-flight after physical write completes/fails
                clusterManager.releaseInFlightQuota(clusterId, size, writeSuccess);
            }
        } catch (err: any) {
            Logger.error(`Upload error ${hash}`, err);
            res.status(err.message === 'Hash mismatch' ? 400 : 500).json({ error: err.message });
        }
    });

    dataRouter.get('/objects/:hash', async (req, res) => {
        const hash = req.params.hash as string;
        try {
            const exists = await storage.hasObject(hash);
            if (!exists) return res.status(404).json({ error: 'Not found' });

            const stream = await storage.readObjectStream(hash);
            res.setHeader('Content-Type', 'application/octet-stream');
            stream.pipe(res);
        } catch (err: any) {
            res.status(500).json({ error: 'Download error' });
        }
    });

    dataRouter.post('/snapshots/:id', async (req, res) => {
        const snapshotId = req.params.id as string;
        const clusterId = (req as any).clusterId;
        const metadata = req.body;
        
        // Prevent path traversal in snapshot ID
        if (!/^[a-z0-9-_]+$/i.test(snapshotId)) return res.status(400).json({ error: 'Invalid snapshot ID' });

        try {
            await storage.writeMetadata(`cluster_${clusterId}_${snapshotId}`, metadata);
            
            // Recalculate quota safely
            await clusterManager.recalculateQuotaFromSnapshot(clusterId, snapshotId);
            
            res.status(201).json({ status: 'created' });
        } catch (err: any) {
            res.status(500).json({ error: 'Error saving snapshot' });
        }
    });

    dataRouter.get('/snapshots/:id', async (req, res) => {
        const snapshotId = req.params.id as string;
        const clusterId = (req as any).clusterId;
        
        if (!/^[a-z0-9-_]+$/i.test(snapshotId)) return res.status(400).json({ error: 'Invalid snapshot ID' });

        try {
            const metadata = await storage.readMetadata(`cluster_${clusterId}_${snapshotId}`);
            if (!metadata) return res.status(404).json({ error: 'Not found' });
            res.json(metadata);
        } catch (err: any) {
            res.status(500).json({ error: 'Error reading snapshot' });
        }
    });

    app.use('/api/v1/clusters/:clusterId', dataRouter);

    return app;
};
