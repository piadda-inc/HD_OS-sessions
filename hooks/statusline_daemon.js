#!/usr/bin/env node
/**
 * Daemon-aware shim for statusline with auto-spawn + legacy fallback.
 */

const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const SOCKET_PATH = process.env.CC_SESSIONS_SOCKET || `/tmp/cc-sessions-${process.env.USER || 'daemon'}.sock`;
const LEGACY_PATH = path.join(__dirname, 'statusline.legacy.js');
const DAEMON_ENTRY = path.join(__dirname, 'daemon', 'server.js');

let daemonStartPromise = null;

function readStdIn() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', chunk => chunks.push(Buffer.from(chunk)));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

function waitForSocket(timeoutMs = 1500) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function check() {
      fs.access(SOCKET_PATH, fs.constants.R_OK | fs.constants.W_OK, err => {
        if (!err) {
          return resolve();
        }
        if (Date.now() - start >= timeoutMs) {
          return reject(new Error('daemon socket unavailable'));
        }
        setTimeout(check, 50);
      });
    }
    check();
  });
}

function ensureDaemonRunning() {
  if (daemonStartPromise) {
    return daemonStartPromise;
  }
  daemonStartPromise = new Promise((resolve, reject) => {
    try {
      if (fs.existsSync(SOCKET_PATH)) {
        try {
          fs.unlinkSync(SOCKET_PATH);
        } catch {
          // best effort cleanup
        }
      }
    } catch {
      // ignore cleanup issues
    }

    const child = spawn(process.execPath, [DAEMON_ENTRY], {
      env: process.env,
      stdio: ['ignore', 'ignore', 'inherit'],
      detached: true,
    });

    child.on('error', err => {
      daemonStartPromise = null;
      reject(err);
    });

    child.unref();

    waitForSocket()
      .then(resolve)
      .catch(err => {
        daemonStartPromise = null;
        reject(err);
      });
  });
  return daemonStartPromise;
}

function requestFromDaemon(payload) {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const client = net.createConnection(SOCKET_PATH);

    client.on('connect', () => {
      const request = {
        hook: 'statusline',
        payload,
        requestId: Date.now().toString(),
      };
      client.write(JSON.stringify(request) + '\n');
    });

    let buffer = '';
    client.on('data', chunk => {
      buffer += chunk.toString('utf8');
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const response = JSON.parse(line);
          resolved = true;
          client.end();
          return resolve(response);
        } catch (error) {
          client.end();
          return reject(error);
        }
      }
    });

    client.on('error', err => {
      if (!resolved) {
        reject(err);
      }
    });

    client.on('end', () => {
      if (!resolved && buffer.trim()) {
        try {
          const response = JSON.parse(buffer.trim());
          resolved = true;
          resolve(response);
        } catch (error) {
          reject(error);
        }
      }
    });
  });
}

function shouldRetry(err) {
  if (!err || typeof err !== 'object') return false;
  return ['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(err.code);
}

async function callDaemon(payload) {
  try {
    return await requestFromDaemon(payload);
  } catch (err) {
    if (!shouldRetry(err)) {
      throw err;
    }
    await ensureDaemonRunning();
    return requestFromDaemon(payload);
  }
}

function runLegacy(input) {
  const legacy = spawnSync(LEGACY_PATH, {
    input: input || '',
    encoding: 'utf8',
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  process.exit(legacy.status ?? 0);
}

async function main() {
  let rawInput = '';
  try {
    rawInput = await readStdIn();
  } catch (err) {
    process.stderr.write(`[statusline daemon] Failed to read stdin: ${err.message}\n`);
    runLegacy('');
    return;
  }

  let payload = {};
  try {
    payload = rawInput ? JSON.parse(rawInput) : {};
  } catch (error) {
    process.stderr.write(`[statusline daemon] Invalid JSON: ${error.message}\n`);
    runLegacy(rawInput);
    return;
  }

  try {
    const response = await callDaemon(payload);
    if (response.stdout) process.stdout.write(response.stdout);
    if (response.stderr) process.stderr.write(response.stderr);
    process.exit(Number.isInteger(response.exitCode) ? response.exitCode : 0);
  } catch (error) {
    process.stderr.write(`[statusline daemon] ${error.message}\n`);
    runLegacy(rawInput);
  }
}

main();
