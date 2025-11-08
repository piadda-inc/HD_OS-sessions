#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const { PROJECT_ROOT } = require('./shared_state.js');
const { logEvent } = require('../state/logger.js');

const TRANSCRIPTS_ROOT = path.join(PROJECT_ROOT, 'sessions', 'transcripts');
const LOCKS_ROOT = path.join(TRANSCRIPTS_ROOT, '.locks');

function emitTranscriptLock(level, event, lockPath, extra = {}) {
    try {
        logEvent({
            event,
            component: 'transcript_utils',
            hook: 'TranscriptLock',
            level,
            lock: path.relative(LOCKS_ROOT, lockPath),
            ...extra
        });
    } catch {
        // Ignore telemetry failures
    }
}

function ensureTranscriptInfrastructure() {
    if (!fs.existsSync(TRANSCRIPTS_ROOT)) {
        fs.mkdirSync(TRANSCRIPTS_ROOT, { recursive: true });
    }
    if (!fs.existsSync(LOCKS_ROOT)) {
        fs.mkdirSync(LOCKS_ROOT, { recursive: true });
    }
}

function sanitizeComponent(value, fallback = 'shared') {
    if (!value) {
        return fallback;
    }
    const trimmed = String(value).trim();
    if (!trimmed) {
        return fallback;
    }
    const normalized = trimmed
        .replace(/[^a-zA-Z0-9._-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '');
    const safe = normalized.slice(0, 120);
    return safe || fallback;
}

function resolveTranscriptTarget(sessionId, subagentType = 'shared') {
    const sanitizedSession = sanitizeComponent(sessionId, '');
    const dirName = sanitizedSession || sanitizeComponent(subagentType, 'shared');
    return {
        dirName,
        dirPath: path.join(TRANSCRIPTS_ROOT, dirName),
        lockPath: path.join(LOCKS_ROOT, `${dirName}.lock`)
    };
}

function sleep(ms) {
    const sab = new SharedArrayBuffer(4);
    const arr = new Int32Array(sab);
    Atomics.wait(arr, 0, 0, ms);
}

function acquireLock(lockPath, { retryDelayMs = 25, timeoutMs = 5000 } = {}) {
    const start = Date.now();
    while (true) {
        try {
            const fd = fs.openSync(lockPath, 'wx');
            fs.writeSync(fd, String(process.pid));
            return fd;
        } catch (error) {
            if (error.code !== 'EEXIST') {
                throw error;
            }
            if (Date.now() - start >= timeoutMs) {
                emitTranscriptLock('warn', 'transcript.lock_timeout', lockPath, {
                    timeout_ms: timeoutMs
                });
                throw new Error(`Timed out waiting for lock ${lockPath}`);
            }
            sleep(retryDelayMs);
        }
    }
}

function releaseLock(fd, lockPath) {
    if (fd !== undefined && fd !== null) {
        try {
            fs.closeSync(fd);
        } catch {
            // ignore close errors
        }
    }
    try {
        if (fs.existsSync(lockPath)) {
            fs.unlinkSync(lockPath);
        }
    } catch {
        // ignore cleanup errors
    }
}

function withTranscriptLock(lockPath, callback, options = {}) {
    const fd = acquireLock(lockPath, options);
    try {
        return callback();
    } finally {
        releaseLock(fd, lockPath);
    }
}

module.exports = {
    TRANSCRIPTS_ROOT,
    LOCKS_ROOT,
    ensureTranscriptInfrastructure,
    resolveTranscriptTarget,
    withTranscriptLock,
    sleep
};
