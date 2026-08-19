import { Request, Response, NextFunction } from 'express';
import { Logger } from '../utils/logger.js';
import crypto from 'crypto';
import { ClusterManager } from './clusterManager.js';

let runtimeServerKey: string | null = null;
let globalClusterManager: ClusterManager | null = null;

export const setRuntimeServerKey = (key: string) => {
    runtimeServerKey = key;
};

export const setClusterManager = (cm: ClusterManager) => {
    globalClusterManager = cm;
};

export const requireManagementAuth = (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        Logger.warn(`Unauthorized management access attempt from ${req.ip}`);
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = authHeader.split(' ')[1];
    
    if (!runtimeServerKey || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(runtimeServerKey))) {
        Logger.warn(`Invalid management key used from ${req.ip}`);
        return res.status(403).json({ error: 'Forbidden: Invalid server management key' });
    }

    next();
};

export const requireClusterAuth = async (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = authHeader.split(' ')[1];
    
    if (!globalClusterManager) {
        return res.status(500).json({ error: 'Cluster Manager not initialized' });
    }

    const authenticatedClusterId = await globalClusterManager.authenticateCluster(token);
    
    if (!authenticatedClusterId) {
        Logger.warn(`Invalid cluster token used from ${req.ip}`);
        return res.status(403).json({ error: 'Forbidden: Invalid cluster key' });
    }

    const urlClusterId = req.params.clusterId;
    if (urlClusterId && urlClusterId !== authenticatedClusterId) {
        Logger.warn(`Isolation Breach Attempt: Token for ${authenticatedClusterId} tried to access ${urlClusterId} from ${req.ip}`);
        return res.status(403).json({ error: 'Forbidden: Cluster isolation violation' });
    }

    // Attach verified ID to request
    (req as any).clusterId = authenticatedClusterId;
    next();
};
