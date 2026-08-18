import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import { select, input, password, confirm } from '@inquirer/prompts';
import { configManager } from '../utils/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class CLI_UI {
    public static displayBanner() {
        try {
            let bannerPath = path.join(__dirname, '..', '..', 'ascii-art.txt');
            if (!fs.existsSync(bannerPath)) {
                bannerPath = path.join(__dirname, '..', 'ascii-art.txt');
            }
            if (!fs.existsSync(bannerPath)) {
                bannerPath = path.resolve('ascii-art.txt');
            }

            if (fs.existsSync(bannerPath)) {
                const banner = fs.readFileSync(bannerPath, 'utf8');
                console.log(chalk.cyan(banner));
            } else {
                console.log(chalk.cyan.bold('\n  TAMGABASE  \n'));
            }
            
            console.log(chalk.gray('  Local-first distributed storage & synchronization\n'));

            // Display current mode as a badge
            const config = configManager.getConfig();
            if (config.mode === 'server') {
                console.log('  ' + chalk.bgCyan.black.bold(' MODE: SERVER ') + ' \n');
            } else if (config.mode === 'client') {
                console.log('  ' + chalk.bgGreen.black.bold(' MODE: CLIENT ') + ' \n');
            } else {
                console.log('  ' + chalk.bgGray.white.bold(' UNINITIALIZED ') + ' \n');
            }

        } catch (error) {
            console.log(chalk.cyan('TamgaBase'));
        }
    }

    public static async askMode(): Promise<'server' | 'client'> {
        const mode = await select({
            message: 'Choose your operating mode:',
            choices: [
                {
                    name: 'Server (Storage Backend)',
                    value: 'server',
                    description: 'Run as a self-hosted storage backend'
                },
                {
                    name: 'Client (Sync Node)',
                    value: 'client',
                    description: 'Connect to an existing TamgaBase server'
                }
            ]
        });
        return mode as 'server' | 'client';
    }

    public static async askServerKeyPolicy(): Promise<'show_once' | 'rotatable'> {
        const policy = await select({
            message: 'How should your server key behave?',
            choices: [
                {
                    name: 'Show once and store securely',
                    value: 'show_once',
                    description: 'More secure. Key is shown once and cannot be recovered if lost.'
                },
                {
                    name: 'Re-displayable and rotatable',
                    value: 'rotatable',
                    description: 'Convenient. Key can be shown again using CLI.'
                }
            ]
        });
        return policy as 'show_once' | 'rotatable';
    }

    public static async askServerAddress(): Promise<string> {
        return input({
            message: 'TamgaBase server address (e.g. localhost or 192.168.1.50):',
            default: 'localhost'
        });
    }

    public static async askServerPort(): Promise<number> {
        const portStr = await input({
            message: 'Server port:',
            default: '7420'
        });
        return parseInt(portStr, 10) || 7420;
    }

    public static async askServerKey(): Promise<string> {
        return password({
            message: 'Server key (e.g. tb_sk_...):',
            mask: '*'
        });
    }
}
