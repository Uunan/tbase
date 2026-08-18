#!/usr/bin/env node

import { runCLI } from './cli/index.js';

runCLI().catch(err => {
    console.error('Fatal Error:', err);
    process.exit(1);
});
