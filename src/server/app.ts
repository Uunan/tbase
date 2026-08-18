import express from 'express';
import cors from 'cors';
import { requireAuth } from './auth.js';
import { LocalStorageBackend } from '../storage/local.js';
import { Logger } from '../utils/logger.js';

export const createServerApp = (storage: LocalStorageBackend) => {
    const app = express();
    
    app.use(cors());
    app.use(express.json({ limit: '10mb' })); 
    app.use('/api/v1/objects', express.raw({ type: 'application/octet-stream', limit: '1gb' }));

    app.get('/api/v1/health', (req, res) => {
        res.json({ status: 'ok', version: '1.1.0' });
    });

    app.post('/api/v1/objects/:hash', requireAuth, async (req, res) => {
        const hash = req.params.hash as string;
        
        if (!/^[a-f0-9]{64}$/i.test(hash)) {
            return res.status(400).json({ error: 'Invalid hash format' });
        }

        try {
            const exists = await storage.hasObject(hash);
            if (exists) {
                return res.status(200).json({ status: 'ignored', message: 'Object already exists' });
            }

            const content = req.body;
            if (!content || !(content instanceof Buffer)) {
                 return res.status(400).json({ error: 'Missing object content' });
            }

            const { CryptoUtils } = await import('../core/crypto.js');
            const calculatedHash = CryptoUtils.hashContent(content);
            if (calculatedHash !== hash) {
                return res.status(400).json({ error: 'Hash mismatch: The provided hash does not match the content' });
            }

            await storage.writeObject(hash, content);
            res.status(201).json({ status: 'created' });
            
        } catch (err: any) {
            Logger.error(`Failed to upload object ${hash}`, err);
            res.status(500).json({ error: 'Internal server error during upload' });
        }
    });

    app.get('/api/v1/objects/:hash', requireAuth, async (req, res) => {
        const hash = req.params.hash as string;
        
        try {
            const exists = await storage.hasObject(hash);
            if (!exists) {
                return res.status(404).json({ error: 'Object not found' });
            }

            const stream = await storage.readObjectStream(hash);
            res.setHeader('Content-Type', 'application/octet-stream');
            stream.pipe(res);
            
        } catch (err: any) {
            Logger.error(`Failed to read object ${hash}`, err);
            res.status(500).json({ error: 'Internal server error during download' });
        }
    });

    app.post('/api/v1/objects/check', requireAuth, async (req, res) => {
        const { hashes } = req.body;
        if (!Array.isArray(hashes)) {
            return res.status(400).json({ error: 'Expected an array of hashes' });
        }

        try {
            const missing = [];
            for (const hash of hashes) {
                const exists = await storage.hasObject(hash);
                if (!exists) missing.push(hash);
            }
            res.json({ missing });
        } catch (err: any) {
            res.status(500).json({ error: 'Internal server error during check' });
        }
    });

    // Namespace/Cluster support for snapshots
    app.post('/api/v1/clusters/:clusterId/snapshots/:id', requireAuth, async (req, res) => {
        const clusterId = req.params.clusterId as string;
        const snapshotId = req.params.id as string;
        const metadata = req.body;
        
        try {
            await storage.writeMetadata(`cluster_${clusterId}_${snapshotId}`, metadata);
            res.status(201).json({ status: 'created' });
        } catch (err: any) {
            Logger.error(`Failed to create snapshot ${snapshotId} for cluster ${clusterId}`, err);
            res.status(500).json({ error: 'Internal server error saving snapshot' });
        }
    });

    app.get('/api/v1/clusters/:clusterId/snapshots/:id', requireAuth, async (req, res) => {
        const clusterId = req.params.clusterId as string;
        const snapshotId = req.params.id as string;
        
        try {
            const metadata = await storage.readMetadata(`cluster_${clusterId}_${snapshotId}`);
            if (!metadata) {
                return res.status(404).json({ error: 'Snapshot not found' });
            }
            res.json(metadata);
        } catch (err: any) {
            res.status(500).json({ error: 'Internal server error reading snapshot' });
        }
    });

    return app;
};
