import { Command } from 'commander';
import { CLI_UI } from './ui.js';
import { configManager } from '../utils/config.js';
import { Logger } from '../utils/logger.js';
import { KeyManager } from '../core/keys.js';
import chalk from 'chalk';
import path from 'path';
import fs from 'fs';
import { confirm, input } from '@inquirer/prompts';

export async function runCLI() {
    const program = new Command();
    program
        .name('tamgabase')
        .description('TamgaBase - Git-like self-hosted data synchronization')
        .version('1.3.0');

    program
        .command('init')
        .description('Initialize TamgaBase configuration')
        .action(async () => {
            CLI_UI.displayBanner();
            let config = configManager.getConfig();
            
            if (config.mode) {
                Logger.warn(`TamgaBase is already initialized in ${config.mode.toUpperCase()} mode.`);
                
                const wantsReset = await confirm({ message: 'Do you want to reset current configuration and re-initialize?', default: false });
                if (!wantsReset) return;

                const areYouSure = await confirm({ message: chalk.red('Are you absolutely sure? This will remove your current settings!'), default: false });
                if (!areYouSure) return;

                configManager.setConfig({
                    mode: null, serverAddress: undefined, serverPort: undefined,
                    storagePath: undefined, workspacePath: undefined, keyPolicy: undefined, clusterId: undefined
                });
                
                try {
                    const keyPath = path.join(configManager.getConfigDir(), '.server_key');
                    if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath);
                } catch(e) {}
            }

            const mode = await CLI_UI.askMode();
            
            if (mode === 'server') {
                const policy = await CLI_UI.askServerKeyPolicy();
                
                configManager.setConfig({
                    mode: 'server',
                    keyPolicy: policy,
                    serverPort: 7420,
                    storagePath: path.join(configManager.getConfigDir(), 'data')
                });

                const key = KeyManager.initializeKey();

                Logger.success('Server initialized successfully!');
                console.log(chalk.yellow(`\n  🔑 Your Server Management Key is: `) + chalk.bgWhite.black(` ${key} `));
                
                if (policy === 'show_once') {
                    console.log(chalk.red.bold('\n  ⚠️ WARNING: This key will only be shown ONCE. Store it securely!'));
                }
                
                console.log(chalk.green('\nYou can now start the server with: ') + chalk.bold('tamgabase server'));
                console.log(chalk.green('And then create clusters using: ') + chalk.bold('tamgabase cluster create'));
                
            } else {
                const address = await CLI_UI.askServerAddress();
                const port = await CLI_UI.askServerPort();
                const key = await CLI_UI.askServerKey(); // This should be a cluster key now!
                const clusterId = await CLI_UI.askClusterId();
                
                configManager.setConfig({
                    mode: 'client',
                    serverAddress: address,
                    serverPort: port,
                    workspacePath: process.cwd(),
                    clusterId: clusterId
                });
                
                // Save the cluster key in the config (in production use secure keychain)
                const configPath = path.join(configManager.getConfigDir(), 'client_keys.json');
                let keys: any = {};
                if (fs.existsSync(configPath)) keys = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                keys[clusterId] = key;
                fs.writeFileSync(configPath, JSON.stringify(keys), { mode: 0o600 });
                
                Logger.success(`Client initialized successfully in cluster: ${chalk.cyan(clusterId)}`);
                console.log(chalk.green('\nYou can now push your files with: ') + chalk.bold('tamgabase push'));
            }
        });

    program
        .command('status')
        .description('Show current TamgaBase configuration status')
        .action(() => {
            CLI_UI.displayBanner();
            const config = configManager.getConfig();
            if (!config.mode) {
                Logger.info('TamgaBase is not initialized. Run `tamgabase init`');
                return;
            }
            if (config.mode === 'server') {
                console.log(chalk.cyan(`  Port:`), config.serverPort);
                console.log(chalk.cyan(`  Storage Path:`), config.storagePath);
                console.log(chalk.cyan(`  Storage Backend:`), config.storageBackend || 'local');
                if (config.storageBackend === 's3') {
                    console.log(chalk.cyan(`  S3 Bucket:`), config.s3Bucket);
                    console.log(chalk.cyan(`  S3 Region:`), config.s3Region || process.env.AWS_REGION || 'us-east-1');
                }
                console.log(chalk.cyan(`  Key Policy:`), config.keyPolicy);
            } else {
                console.log(chalk.cyan(`  Server Address:`), `${config.serverAddress}:${config.serverPort}`);
                console.log(chalk.cyan(`  Cluster ID:`), config.clusterId);
                console.log(chalk.cyan(`  Workspace:`), config.workspacePath);
            }
            console.log();
        });

    program
        .command('server')
        .description('Start the TamgaBase Storage Server')
        .action(async () => {
            CLI_UI.displayBanner();
            const { startServer } = await import('../server/index.js');
            startServer();
        });

    program
        .command('push')
        .description('Push local workspace changes to the server')
        .option('-m, --message <msg>', 'Snapshot message', 'Snapshot')
        .action(async (options) => {
            CLI_UI.displayBanner();
            const config = configManager.getConfig();
            if (config.mode !== 'client') {
                Logger.error('You are not configured as a client. Run `tamgabase init` first.');
                process.exit(1);
            }
            const { SyncEngine } = await import('../client/sync.js');
            const engine = new SyncEngine();
            await engine.push(options.message);
        });

    program
        .command('pull')
        .description('Pull latest snapshot from the server')
        .action(async () => {
            CLI_UI.displayBanner();
            const config = configManager.getConfig();
            if (config.mode !== 'client') {
                Logger.error('You are not configured as a client. Run `tamgabase init` first.');
                process.exit(1);
            }
            const { SyncEngine } = await import('../client/sync.js');
            const engine = new SyncEngine();
            await engine.pull();
        });

    program
        .command('heartbeat')
        .description('Continuously ping the server until "q" is pressed')
        .action(async () => {
            CLI_UI.displayBanner();
            const config = configManager.getConfig();
            if (config.mode !== 'client') {
                Logger.error('You are not configured as a client. Run `tamgabase init` first.');
                process.exit(1);
            }
            const { ClientAPI } = await import('../client/api.js');
            const api = new ClientAPI();
            
            console.log(chalk.cyan('  Starting heartbeat. Press "q" to stop.\n'));
            process.stdin.setRawMode(true);
            process.stdin.resume();
            process.stdin.on('data', (key) => {
                if (key.toString().toLowerCase() === 'q' || key[0] === 3) process.exit(0);
            });
            const ping = async () => {
                const start = Date.now();
                const ok = await api.healthCheck();
                const latency = Date.now() - start;
                const time = new Date().toLocaleTimeString();
                if (ok) console.log(chalk.green(`  [${time}] PONG from ${config.serverAddress}:${config.serverPort} - ${latency}ms`));
                else console.log(chalk.red(`  [${time}] FAIL to reach ${config.serverAddress}:${config.serverPort}`));
            };
            ping();
            setInterval(ping, 1000);
        });

    // ============================
    // CLUSTER MANAGEMENT COMMANDS
    // ============================
    const clusterCmd = program.command('cluster').description('Manage clusters (Server Mode Only)');

    clusterCmd.command('create <clusterId>')
        .description('Create a new cluster')
        .option('-q, --quota <gb>', 'Storage Quota in GB', '50')
        .action(async (clusterId, options) => {
            const { MgmtAPI } = await import('../client/api.js');
            const api = new MgmtAPI();
            const bytes = parseFloat(options.quota) * 1024 * 1024 * 1024;
            const res = await api.createCluster(clusterId, bytes);
            Logger.success(`Cluster ${chalk.cyan(clusterId)} created!`);
            console.log(chalk.yellow(`  🔑 Access Key: `) + chalk.bgWhite.black(` ${res.access_key} `));
            console.log(chalk.cyan(`  Quota:`), `${options.quota} GB`);
        });

    clusterCmd.command('list')
        .description('List all clusters')
        .action(async () => {
            const { MgmtAPI } = await import('../client/api.js');
            const api = new MgmtAPI();
            const clusters = await api.listClusters();
            if (clusters.length === 0) return console.log('No clusters found.');
            console.table(clusters.map((c: any) => ({
                ID: c.id,
                Used: `${(c.usedBytes / (1024*1024)).toFixed(2)} MB`,
                Quota: `${(c.storageLimitBytes / (1024*1024*1024)).toFixed(2)} GB`
            })));
        });

    clusterCmd.command('delete <clusterId>')
        .description('Delete a cluster')
        .action(async (clusterId) => {
            const areYouSure = await confirm({ message: chalk.red(`Are you sure you want to delete cluster ${clusterId}?`), default: false });
            if (!areYouSure) return;
            const { MgmtAPI } = await import('../client/api.js');
            const api = new MgmtAPI();
            await api.deleteCluster(clusterId);
            Logger.success(`Cluster ${clusterId} deleted.`);
        });

    const keyCmd = program.command('key').description('Manage server keys');
    
    keyCmd.command('show')
        .description('Show the current server management key')
        .action(() => {
            const config = configManager.getConfig();
            if (config.mode !== 'server') return Logger.error('Only servers have keys.');
            if (config.keyPolicy === 'show_once') return Logger.error('Your key policy is "show_once". Key cannot be displayed again.');
            const key = KeyManager.loadKey();
            console.log(chalk.yellow(`  🔑 Current Server Key: `) + chalk.bgWhite.black(` ${key} `) + '\n');
        });

keyCmd.command('rotate')
        .description('Rotate the server management key')
        .action(async () => {
            const config = configManager.getConfig();
            if (config.mode !== 'server') return Logger.error('Only servers have keys.');
            console.log(chalk.red.bold('  �s���? WARNING: Rotating this key will invalidate all existing management clients.'));
            const proceed = await confirm({ message: 'Continue?', default: false });
            if (proceed) {
                const newKey = KeyManager.rotateKey();
                Logger.success('Key rotated successfully.');
                console.log(chalk.yellow(`  �Y"' New Server Key: `) + chalk.bgWhite.black(` ${newKey} `) + '\n');
            }
        });

    // ============================
    // STORAGE BACKEND COMMANDS
    // ============================
    const storageCmd = program.command('storage').description('Configure the storage backend (Server Mode Only)');

    storageCmd.command('local')
        .description('Use local disk storage')
        .action(() => {
            const config = configManager.getConfig();
            if (config.mode !== 'server') return Logger.error('Only servers can select a storage backend.');
            configManager.setConfig({
                storageBackend: 'local',
                s3Bucket: undefined,
                s3Region: undefined,
                s3Prefix: undefined
            });
            Logger.success('Storage backend set to LOCAL.');
            console.log(chalk.gray('  Data will be stored under: ' + (config.storagePath || path.join(configManager.getConfigDir(), 'data')) + '\n'));
        });

    storageCmd.command('s3')
        .description('Use AWS S3 storage (credentials come from AWS_* environment variables)')
        .action(async () => {
            const config = configManager.getConfig();
            if (config.mode !== 'server') return Logger.error('Only servers can select a storage backend.');
            const bucket = await input({ message: 'S3 Bucket name:', required: true });
            const region = await input({ message: 'AWS Region (default: us-east-1):', default: 'us-east-1' });
            const prefix = await input({ message: 'S3 key prefix (optional, e.g. "tamgabase"):', default: '' });

            configManager.setConfig({
                storageBackend: 's3',
                s3Bucket: bucket,
                s3Region: region || 'us-east-1',
                s3Prefix: prefix || undefined
            });
            Logger.success('Storage backend set to S3.');
            console.log(chalk.gray('  Credentials will be read from AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables.'));
            console.log(chalk.gray('  They are never stored in config.json.\n'));
        });

    if (process.argv.length === 2) {
        CLI_UI.displayBanner();
        const config = configManager.getConfig();
        if (!config.mode) {
            console.log('  Run ' + chalk.cyan('tamgabase init') + ' to get started.\n');
            program.help();
        } else {
            console.log('  Use ' + chalk.cyan('tamgabase --help') + ' to see available commands.\n');
        }
    } else {
        program.parse(process.argv);
    }
}
