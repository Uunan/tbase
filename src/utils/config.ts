import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface TamgaConfig {
    mode: 'server' | 'client' | null;
    serverAddress?: string;
    serverPort?: number;
    serverProtocol?: 'http' | 'https';
    storagePath?: string;
    workspacePath?: string;
    keyPolicy?: 'show_once' | 'rotatable';
    clusterId?: string; // New field for Multi-Tenancy/Namespaces
    storageBackend?: 'local' | 's3';
    s3Bucket?: string;
    s3Region?: string;
    s3Prefix?: string;
}

export class ConfigManager {
    private configPath: string;
    private configDir: string;
    private config: TamgaConfig;

    constructor() {
        this.configDir = path.join(os.homedir(), '.tamgabase');
        this.configPath = path.join(this.configDir, 'config.json');
        this.config = this.loadConfig();
    }

    private loadConfig(): TamgaConfig {
        if (!fs.existsSync(this.configDir)) {
            fs.mkdirSync(this.configDir, { recursive: true, mode: 0o700 }); 
        }

        if (fs.existsSync(this.configPath)) {
            try {
                const data = fs.readFileSync(this.configPath, 'utf8');
                return JSON.parse(data);
            } catch (err) {
                return { mode: null };
            }
        }
        return { mode: null };
    }

    public getConfig(): TamgaConfig {
        return this.config;
    }

    public setConfig(newConfig: Partial<TamgaConfig>) {
        this.config = { ...this.config, ...newConfig };
        this.saveConfig();
    }

    private saveConfig() {
        fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), { mode: 0o600 }); 
    }

    public getConfigDir(): string {
        return this.configDir;
    }
}

export const configManager = new ConfigManager();
