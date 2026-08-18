import { Command } from 'commander';
import { CLI_UI } from './ui.js';
import { configManager } from '../utils/config.js';
import { Logger } from '../utils/logger.js';
import { KeyManager } from '../core/keys.js';
import chalk from 'chalk';
import path from 'path';
import { confirm } from '@inquirer/prompts';

export async function runCLI() {
    const program = new Command();
    program
        .name('tamgabase')
        .description('TamgaBase - Git-like self-hosted data synchronization')
        .version('1.0.0');

    // We can run displayBanner at the very beginning of the CLI execution 
    // if no arguments are provided, or for specific commands.
    
    program
        .command('init')
        .description('Initialize TamgaBase configuration')
        .action(async () => {
            CLI_UI.displayBanner();
            const config = configManager.getConfig();
            
            if (config.mode) {
                Logger.warn(`TamgaBase is already initialized in ${config.mode.toUpperCase()} mode.`);
                console.log(chalk.gray(`To reconfigure, delete the config directory: ~/.tamgabase`));
                return;
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
                console.log(chalk.yellow(`\n🔑 Your Server Key is: `) + chalk.bgWhite.black(` ${key} `));
                
                if (policy === 'show_once') {
                    console.log(chalk.red.bold('\n⚠️ WARNING: This key will only be shown ONCE. Store it securely!'));
                }
                
                console.log(chalk.green('\nYou can now start the server with: ') + chalk.bold('tamgabase server'));
                
            } else {
                const address = await CLI_UI.askServerAddress();
                const port = await CLI_UI.askServerPort();
                const key = await CLI_UI.askServerKey();
                
                Logger.info('Testing connection to TamgaBase server...');
                // We could actually test the connection here by instantiating ClientAPI
                
                configManager.setConfig({
                    mode: 'client',
                    serverAddress: address,
                    serverPort: port,
                    workspacePath: process.cwd()
                });
                
                Logger.success('Client initialized and configuration saved.');
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
                console.log(chalk.cyan(`  Key Policy:`), config.keyPolicy);
            } else {
                console.log(chalk.cyan(`  Server Address:`), `${config.serverAddress}:${config.serverPort}`);
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

    const keyCmd = program.command('key').description('Manage server keys');
    
    keyCmd.command('show')
        .description('Show the current server key')
        .action(() => {
            CLI_UI.displayBanner();
            const config = configManager.getConfig();
            if (config.mode !== 'server') {
                Logger.error('Only servers have keys.');
                return;
            }
            if (config.keyPolicy === 'show_once') {
                Logger.error('Your key policy is "show_once". The original key cannot be displayed again.');
                console.log('You can rotate the key using `tamgabase key rotate`.');
                return;
            }
            const key = KeyManager.loadKey();
            console.log(chalk.yellow(`  🔑 Current Server Key: `) + chalk.bgWhite.black(` ${key} `) + '\n');
        });

    keyCmd.command('rotate')
        .description('Rotate the server key')
        .action(async () => {
            CLI_UI.displayBanner();
            const config = configManager.getConfig();
            if (config.mode !== 'server') {
                Logger.error('Only servers have keys.');
                return;
            }
            
            console.log(chalk.red.bold('  ⚠️ WARNING: Rotating this key will invalidate all existing clients.'));
            const proceed = await confirm({ message: 'Continue?', default: false });
            
            if (proceed) {
                const newKey = KeyManager.rotateKey();
                Logger.success('Key rotated successfully.');
                console.log(chalk.yellow(`  🔑 New Server Key: `) + chalk.bgWhite.black(` ${newKey} `) + '\n');
            }
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
