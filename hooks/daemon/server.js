#!/usr/bin/env node

const fs = require('fs');
const net = require('net');
const path = require('path');
const { withTiming } = require('../benchmark_utils.js');

const SOCKET_PATH = process.env.CC_SESSIONS_SOCKET || `/tmp/cc-sessions-${process.env.USER || 'daemon'}.sock`;

const handlers = {
    ping: _payload => ({ stdout: '', stderr: '', exitCode: 0 }),
    statusline: require('../daemon/statusline_handler.js'),
};

function startServer() {
    try {
        if (fs.existsSync(SOCKET_PATH)) {
            fs.unlinkSync(SOCKET_PATH);
        }
    } catch (err) {
        console.error(`[Daemon] Failed to remove socket: ${err.message}`);
    }

    const server = net.createServer(socket => {
        let buffer = '';
        socket.on('data', chunk => {
            buffer += chunk.toString('utf8');
            let idx;
            while ((idx = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, idx).trim();
                buffer = buffer.slice(idx + 1);
                if (!line) continue;
                handleRequest(line, response => {
                    socket.write(JSON.stringify(response) + '\n');
                });
            }
        });
        socket.on('error', err => {
            console.error(`[Daemon] Socket error: ${err.message}`);
        });
    });

    server.listen(SOCKET_PATH, () => {
        try {
            fs.chmodSync(SOCKET_PATH, 0o600);
        } catch {
            // ignore
        }
        console.error(`[Daemon] Listening on ${SOCKET_PATH}`);
    });

    server.on('error', err => {
        console.error(`[Daemon] Server error: ${err.message}`);
        process.exit(1);
    });
}

function handleRequest(line, reply) {
    let request;
    try {
        request = JSON.parse(line);
    } catch (err) {
        reply({ requestId: null, stdout: '', stderr: `Invalid JSON: ${err.message}`, exitCode: 1 });
        return;
    }

    const { requestId = null, hook, payload = {} } = request;
    const handler = handlers[hook];
    if (!handler) {
        reply({ requestId, stdout: '', stderr: `Unknown hook: ${hook}`, exitCode: 2 });
        return;
    }

    try {
        const result = withTiming(hook, () => {
            return handler.renderStatusline ? { stdout: handler.renderStatusline(payload), stderr: '', exitCode: 0 } : handler(payload);
        }, { request_id: requestId });

        reply({
            requestId,
            stdout: result.stdout || '',
            stderr: result.stderr || '',
            exitCode: Number.isInteger(result.exitCode) ? result.exitCode : 0,
        });
    } catch (err) {
        reply({ requestId, stdout: '', stderr: `Handler error: ${err.message}`, exitCode: 3 });
    }
}

if (require.main === module) {
    startServer();
}
