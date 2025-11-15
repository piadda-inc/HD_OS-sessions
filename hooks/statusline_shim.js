#!/usr/bin/env node

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const SHIM_PATH = path.join(__dirname, 'statusline_daemon.js');

function runShim() {
  try {
    const input = fs.readFileSync(0, 'utf8');
    const result = spawnSync(SHIM_PATH, {
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status ?? 0);
  } catch (error) {
    process.stderr.write(`[statusline shim] ${error.message}\n`);
    process.exit(1);
  }
}

runShim();
