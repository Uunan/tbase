import { createServerApp } from './app.js';
import { LocalStorageBackend } from '../storage/local.js';
import { setRuntimeServerKey } from './auth.js';
import { Logger } from '../utils/logger.js';
import { configManager } from '../utils/config.js';
import { KeyManager } from '../core/keys.js';
import chalk from 'chalk';
import path from 'path';

export const startServer = () => {
    const config = configManager.getConfig();
    if (config.mode !== 'server') {
        Logger.error('TamgaBase is not configured as a server. Run `tamgabase init` first.');
        process.exit(1);
    }

    const port = config.serverPort || 7420;
    const storagePath = config.storagePath || path.join(configManager.getConfigDir(), 'data');
    
    let key = KeyManager.loadKey();
    if (!key) {
        Logger.warn('Server key not found. Generating a new one...');
        key = KeyManager.initializeKey();
        console.log(chalk.yellow(`New Server Key generated: `) + chalk.bgWhite.black(` ${key} `));
        console.log(chalk.red('Make sure to update your clients with this new key!'));
    }
    
    setRuntimeServerKey(key);

    const storage = new LocalStorageBackend(storagePath);
    const app = createServerApp(storage);

    const server = app.listen(port, '0.0.0.0', () => {
        console.log(chalk.green(`  ✓ TamgaBase Server running on port ${port}`));
        console.log(chalk.cyan(`  Storage Path: ${storagePath}`));
        console.log(chalk.cyan(`  Key Policy: ${config.keyPolicy}`));
        console.log(`\n  ⏳ Waiting for client connections...\n`);
    });

    server.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
            console.log(chalk.red(`\n  [ERROR] Port ${port} is already in use.`));
            console.log(chalk.yellow(`  It seems another TamgaBase server (or process) is already running on this port.`));
            console.log(chalk.gray(`  To fix this in PowerShell, run:`));
            console.log(chalk.white(`  Stop-Process -Id (Get-NetTCPConnection -LocalPort ${port}).OwningProcess -Force`));
            console.log();
            process.exit(1);
        } else {
            console.error(err);
        }
    });
};
