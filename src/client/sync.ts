import fs from 'fs';
import path from 'path';
import { ClientAPI } from './api.js';
import { CryptoUtils } from '../core/crypto.js';
import { Logger } from '../utils/logger.js';
import { configManager } from '../utils/config.js';
import ora from 'ora';
import chalk from 'chalk';

interface FileState {
    path: string;
    hash: string;
    size: number;
    mtime: number;
}

export class SyncEngine {
    private api: ClientAPI;
    private workspace: string;
    private clusterId: string;

    constructor() {
        this.api = new ClientAPI();
        const config = configManager.getConfig();
        if (!config.workspacePath) {
            throw new Error('Workspace path not set in config');
        }
        this.workspace = config.workspacePath;
        this.clusterId = config.clusterId || 'default-cluster';
    }

    private async scanDirectory(dir: string, baseDir: string, spinner: any): Promise<FileState[]> {
        const results: FileState[] = [];
        let entries;
        try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch (err: any) {
            return results;
        }

        for (const entry of entries) {
            if (entry.name === '.tamgabase' || entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') {
                continue;
            }

            const fullPath = path.join(dir, entry.name);
            const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');

            if (entry.isDirectory()) {
                const subResults = await this.scanDirectory(fullPath, baseDir, spinner);
                results.push(...subResults);
            } else if (entry.isFile()) {
                try {
                    const stat = await fs.promises.stat(fullPath);
                    spinner.text = `Scanning: ${relPath}`;
                    const hash = await CryptoUtils.hashFile(fullPath);
                    results.push({
                        path: relPath,
                        hash,
                        size: stat.size,
                        mtime: stat.mtimeMs
                    });
                } catch (err: any) {
                    if (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES') {
                        continue;
                    }
                }
            }
        }
        return results;
    }

    public async push(message: string = 'Snapshot'): Promise<void> {
        const spinner = ora(`Scanning workspace for cluster [${chalk.cyan(this.clusterId)}]...`).start();
        
        try {
            const files = await this.scanDirectory(this.workspace, this.workspace, spinner);
            spinner.succeed(`Scanned ${files.length} files`);
            
            if (files.length === 0) {
                Logger.info('No files to push.');
                return;
            }

            spinner.start('Checking objects with server...');
            const allHashes = Array.from(new Set(files.map(f => f.hash)));
            const missingHashes = await this.api.checkMissingObjects(allHashes);
            spinner.succeed(`Objects: ${missingHashes.length} new, ${allHashes.length - missingHashes.length} already known`);

            if (missingHashes.length > 0) {
                spinner.start(`Uploading ${missingHashes.length} objects...`);
                let uploaded = 0;
                for (const hash of missingHashes) {
                    const file = files.find(f => f.hash === hash);
                    if (file) {
                        const fullPath = path.join(this.workspace, file.path);
                        await this.api.uploadObject(hash, fullPath);
                        uploaded++;
                        spinner.text = `Uploading objects... ${Math.round((uploaded / missingHashes.length) * 100)}%`;
                    }
                }
                spinner.succeed('Upload complete');
            }

            spinner.start('Creating snapshot...');
            const snapshotId = `tb_${Date.now()}`;
            const metadata = {
                id: snapshotId,
                clusterId: this.clusterId,
                timestamp: Date.now(),
                message,
                files: files.reduce((acc, f) => {
                    acc[f.path] = { hash: f.hash, size: f.size, mtime: f.mtime };
                    return acc;
                }, {} as Record<string, any>)
            };

            // Snapshot verisini kaydet
            await this.api.saveSnapshot(this.clusterId, snapshotId, metadata);
            // İlgili cluster'ın "latest" referansını güncelle
            await this.api.saveSnapshot(this.clusterId, 'latest', { ref: snapshotId });
            
            spinner.succeed(`Snapshot created for cluster ${chalk.cyan(this.clusterId)}: ${chalk.green(snapshotId)}`);
            
        } catch (err: any) {
            spinner.fail('Push failed');
            Logger.error('Error during push', err.message || err);
        }
    }

    public async pull(): Promise<void> {
        const spinner = ora(`Fetching latest snapshot for cluster [${chalk.cyan(this.clusterId)}]...`).start();
        try {
            const latestRef = await this.api.getSnapshot(this.clusterId, 'latest');
            if (!latestRef || !latestRef.ref) {
                spinner.fail(`No snapshots found for cluster ${this.clusterId}`);
                return;
            }

            const snapshot = await this.api.getSnapshot(this.clusterId, latestRef.ref);
            if (!snapshot || !snapshot.files) {
                spinner.fail('Snapshot data corrupted');
                return;
            }

            const files = snapshot.files;
            const filePaths = Object.keys(files);
            spinner.succeed(`Found snapshot ${chalk.green(snapshot.id)} with ${filePaths.length} files`);

            spinner.start('Downloading missing objects...');
            for (const relPath of filePaths) {
                const fileMeta = files[relPath];
                const fullPath = path.join(this.workspace, relPath);
                
                let needsDownload = true;
                if (fs.existsSync(fullPath)) {
                    try {
                        const currentHash = await CryptoUtils.hashFile(fullPath);
                        if (currentHash === fileMeta.hash) {
                            needsDownload = false;
                        }
                    } catch {
                        // Kilitli dosya falan varsa mecburen es geçebiliriz
                    }
                }

                if (needsDownload) {
                    const dir = path.dirname(fullPath);
                    if (!fs.existsSync(dir)) {
                        fs.mkdirSync(dir, { recursive: true });
                    }
                    await this.api.downloadObject(fileMeta.hash, fullPath);
                }
            }
            spinner.succeed('Pull complete. Workspace updated.');

        } catch (err: any) {
            spinner.fail('Pull failed');
            Logger.error('Error during pull', err.message || err);
        }
    }
}
