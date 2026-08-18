import chalk from 'chalk';

export enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3
}

export class Logger {
    private static level: LogLevel = LogLevel.INFO;

    public static setLevel(level: LogLevel) {
        this.level = level;
    }

    public static debug(message: string, ...meta: any[]) {
        if (this.level <= LogLevel.DEBUG) {
            console.log(chalk.gray(`[DEBUG] ${message}`), ...meta);
        }
    }

    public static info(message: string, ...meta: any[]) {
        if (this.level <= LogLevel.INFO) {
            console.log(chalk.blue(`[INFO]`), message, ...meta);
        }
    }

    public static warn(message: string, ...meta: any[]) {
        if (this.level <= LogLevel.WARN) {
            console.log(chalk.yellow(`[WARN]`), message, ...meta);
        }
    }

    public static error(message: string, error?: any) {
        if (this.level <= LogLevel.ERROR) {
            console.log(chalk.red(`[ERROR]`), message);
            if (error) {
                console.error(error);
            }
        }
    }

    public static success(message: string) {
        if (this.level <= LogLevel.INFO) {
            console.log(chalk.green(`[SUCCESS]`), message);
        }
    }
}
