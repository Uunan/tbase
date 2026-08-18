import { Request, Response, NextFunction } from 'express';
import { configManager } from '../utils/config.js';
import { Logger } from '../utils/logger.js';
import crypto from 'crypto';

// In a real production scenario, this key would be securely loaded from a vault or secure file.
let runtimeServerKey: string | null = null;

export const setRuntimeServerKey = (key: string) => {
    runtimeServerKey = key;
};

export const requireAuth = (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        Logger.warn(`Unauthorized access attempt from ${req.ip}`);
        return res.status(401).json({ error: 'Unauthorized: Missing or invalid Authorization header' });
    }

    const token = authHeader.split(' ')[1];
    
    if (!runtimeServerKey || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(runtimeServerKey))) {
        Logger.warn(`Invalid server key used from ${req.ip}`);
        return res.status(403).json({ error: 'Forbidden: Invalid server key' });
    }

    next();
};
