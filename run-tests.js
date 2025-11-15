#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const TEST_PATH_MAP = new Map([
    ['tests/test_state_protection.spec.js', path.join('hooks', 'tests', 'test_state_protection.spec.js')],
]);

const rawArgs = process.argv.slice(2);
const translatedArgs = rawArgs.map(arg => TEST_PATH_MAP.get(arg) || arg);

const result = spawnSync(process.execPath, ['--test', ...translatedArgs], {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: process.env,
});

if (result.error) {
    console.error(result.error);
    process.exit(1);
}

process.exit(result.status ?? 0);
