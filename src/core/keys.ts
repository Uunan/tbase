import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { configManager } from '../utils/config.js';

export class KeyManager {
    private static getKeyPath(): string {
        return path.join(configManager.getConfigDir(), '.server_key');
    }

    public static initializeKey(): string {
        const config = configManager.getConfig();
        if (config.mode !== 'server') {
            throw new Error('Key management is only for server mode.');
        }

        const newKey = 'tb_sk_' + crypto.randomBytes(32).toString('hex');
        
        fs.writeFileSync(this.getKeyPath(), newKey, { mode: 0o600 });
        return newKey;
    }

    public static loadKey(): string | null {
        const keyPath = this.getKeyPath();
        if (fs.existsSync(keyPath)) {
            return fs.readFileSync(keyPath, 'utf8').trim();
        }
        return null;
    }

    public static rotateKey(): string {
        return this.initializeKey();
    }
}
