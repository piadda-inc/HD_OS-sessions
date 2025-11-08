#!/usr/bin/env node
'use strict';

const net = require('net');
const path = require('path');
const os = require('os');
const { EventEmitter, once } = require('events');
const { randomUUID, randomBytes } = require('crypto');

const DEFAULT_SOCKET_PATH = path.join(process.cwd(), 'sessions', '.meta-learning.sock');
const DEFAULT_TIMEOUT_MS = 2000;

function nextId() {
    if (typeof randomUUID === 'function') {
        return randomUUID();
    }
    return randomBytes(16).toString('hex');
}

class MetaLearningBridge extends EventEmitter {
    constructor(options = {}) {
        super();
        const configuredPath = options.socketPath || DEFAULT_SOCKET_PATH;
        this.socketPath = path.isAbsolute(configuredPath) ? configuredPath : path.resolve(configuredPath);
        this.host = options.host || '127.0.0.1';
        this.port = options.port || 0;
        this.requestTimeoutMs = options.requestTimeoutMs || DEFAULT_TIMEOUT_MS;
        this.reconnectDelayMs = options.reconnectDelayMs || 250;
        this.protocolVersion = options.protocolVersion || 'v1';
        this.clientId = options.clientId || `cc-sessions/${os.hostname()}`;
        this._socket = null;
        this._buffer = '';
        this._pending = new Map();
        this._handshakeComplete = false;
        this._connectPromise = null;
    }

    async getStrategicContext(params) {
        const result = await this._rpc('meta.getStrategicContext', params);
        return result?.strategy ?? null;
    }

    async emitLifecycleEvent(eventName, payload) {
        await this._rpc('meta.emitLifecycle', {
            event: eventName,
            timestamp: new Date().toISOString(),
            ...payload,
        });
    }

    async pushTaskMetrics(snapshot) {
        await this._rpc('metrics.pushTaskMetrics', snapshot);
    }

    async getDashboardSnapshot(query) {
        return await this._rpc('dashboard.getSnapshot', query);
    }

    async close() {
        if (this._socket && !this._socket.destroyed) {
            this._socket.destroy();
        }
        this._socket = null;
        this._buffer = '';
        this._handshakeComplete = false;
        this._rejectAll(new Error('MetaLearningBridge closed'));
    }

    async _rpc(method, params = {}) {
        await this._connectIfNeeded();
        return await this._rawRpc(method, params);
    }

    async _connectIfNeeded() {
        if (this._handshakeComplete && this._socket && !this._socket.destroyed) {
            return;
        }
        if (this._connectPromise) {
            return this._connectPromise;
        }
        this._connectPromise = this._openSocket();
        try {
            await this._connectPromise;
        } finally {
            this._connectPromise = null;
        }
    }

    async _openSocket() {
        const socket = this.socketPath
            ? net.createConnection(this.socketPath)
            : net.createConnection({ host: this.host, port: this.port });
        this._socket = socket;
        socket.setEncoding('utf8');
        socket.on('data', chunk => this._ingest(chunk));
        socket.on('error', err => this._rejectAll(err));
        socket.on('close', () => this._rejectAll(new Error('Meta-learning bridge socket closed')));
        await once(socket, 'connect');
        await this._performHandshake();
    }

    async _performHandshake() {
        const payload = {
            client: this.clientId,
            version: this.protocolVersion,
            capabilities: ['lifecycle', 'strategy', 'metrics', 'dashboard'],
        };
        await this._rawRpc('meta.handshake', payload);
        this._handshakeComplete = true;
    }

    async _rawRpc(method, params) {
        if (!this._socket || this._socket.destroyed) {
            throw new Error('Bridge socket is not connected');
        }
        const id = nextId();
        const envelope = JSON.stringify({ jsonrpc: '2.0', id, method, params });
        const pending = new Promise((resolve, reject) => {
            this._pending.set(id, { resolve, reject, method });
        });
        this._socket.write(`${envelope}\n`, 'utf8');
        return await this._withTimeout(id, pending, this.requestTimeoutMs, method);
    }

    _withTimeout(requestId, promise, timeoutMs, label) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this._pending.has(requestId)) {
                    const entry = this._pending.get(requestId);
                    this._pending.delete(requestId);
                    entry.reject(new Error(`MetaLearningBridge ${label} timeout after ${timeoutMs}ms`));
                }
                reject(new Error(`MetaLearningBridge ${label} timeout after ${timeoutMs}ms`));
            }, timeoutMs);
            promise
                .then(value => {
                    clearTimeout(timer);
                    resolve(value);
                })
                .catch(error => {
                    clearTimeout(timer);
                    this._pending.delete(requestId);
                    reject(error);
                });
        });
    }

    _ingest(chunk) {
        this._buffer += chunk;
        let newlineIndex = this._buffer.indexOf('\n');
        while (newlineIndex !== -1) {
            const raw = this._buffer.slice(0, newlineIndex).trim();
            this._buffer = this._buffer.slice(newlineIndex + 1);
            if (raw) {
                this._handleFrame(raw);
            }
            newlineIndex = this._buffer.indexOf('\n');
        }
    }

    _handleFrame(raw) {
        let message;
        try {
            message = JSON.parse(raw);
        } catch (error) {
            this.emit('error', new Error(`Invalid frame from meta-learning bridge: ${raw}`));
            return;
        }

        if (message.id && this._pending.has(message.id)) {
            const pending = this._pending.get(message.id);
            this._pending.delete(message.id);
            if ('error' in message) {
                pending.reject(new Error(message.error.message || 'Bridge RPC error'));
            } else {
                pending.resolve(message.result);
            }
            return;
        }

        this.emit('notification', message);
    }

    _rejectAll(error) {
        if (error) {
            this.emit('error', error);
        }
        for (const [, pending] of this._pending.entries()) {
            pending.reject(error || new Error('Bridge connection lost'));
        }
        this._pending.clear();
        this._handshakeComplete = false;
    }
}

module.exports = MetaLearningBridge;

/**
 * Example usage:
 *
 * const MetaLearningBridge = require('./sessions/lib/meta_learning_bridge');
 * const bridge = new MetaLearningBridge({ socketPath: '/tmp/meta.sock' });
 *
 * bridge.getStrategicContext({ taskId: 'abc123' })
 *     .then(ctx => console.log('Strategy', ctx))
 *     .catch(err => console.error('Failed to fetch context', err));
 *
 * bridge.on('notification', msg => {
 *     console.log('Meta-learning notification:', msg);
 * });
 */
