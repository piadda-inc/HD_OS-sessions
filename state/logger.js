#!/usr/bin/env node

/**
 * Shared telemetry utilities for Node.js hooks.
 */
const fs = require('fs');
const path = require('path');

const LOG_LEVELS = {
    error: 40,
    warn: 30,
    warning: 30,
    info: 20,
    debug: 10,
};

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_BACKUPS = 3;

function resolveLevelName(level) {
    if (!level) return 'info';
    const normalized = String(level).toLowerCase();
    return LOG_LEVELS[normalized] ? normalized : 'info';
}

function levelValue(level) {
    return LOG_LEVELS[resolveLevelName(level)];
}

function minLevel() {
    return levelValue(process.env.ORCH_LOG_LEVEL || 'info');
}

function resolveLogPath() {
    if (process.env.ORCH_LOG_PATH) {
        return path.resolve(process.env.ORCH_LOG_PATH);
    }
    return path.join(__dirname, 'orchestration.log');
}

function ensureParent(logPath) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
}

function maxBytes() {
    const raw = process.env.ORCH_LOG_MAX_BYTES;
    if (!raw) return DEFAULT_MAX_BYTES;
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_BYTES;
}

function maxBackups() {
    const raw = process.env.ORCH_LOG_MAX_BACKUPS;
    if (!raw) return DEFAULT_MAX_BACKUPS;
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_MAX_BACKUPS;
}

function rotateLogs(logPath) {
    let stats;
    try {
        stats = fs.statSync(logPath);
    } catch {
        return;
    }
    if (stats.size < maxBytes()) {
        return;
    }

    const backups = maxBackups();
    for (let idx = backups; idx >= 1; idx -= 1) {
        const src = `${logPath}.${idx}`;
        const dst = `${logPath}.${idx + 1}`;
        if (fs.existsSync(src)) {
            if (idx === backups) {
                fs.rmSync(src, { force: true });
            } else {
                fs.renameSync(src, dst);
            }
        }
    }
    try {
        fs.renameSync(logPath, `${logPath}.1`);
    } catch {
        // Ignore failures - best effort
    }
}

function shouldLog(level) {
    return levelValue(level) >= minLevel();
}

function timestamp() {
    return new Date().toISOString();
}

function logEvent({ event, component, level = 'info', hook = undefined, ...fields }) {
    const levelName = resolveLevelName(level);
    if (!shouldLog(levelName)) {
        return null;
    }
    const payload = {
        ts: timestamp(),
        level: levelName,
        component,
        event,
    };
    if (hook) {
        payload.hook = hook;
    }
    Object.entries(fields).forEach(([key, value]) => {
        if (value === undefined || value === null) {
            return;
        }
        if (key === 'latency_ms') {
            const numeric = Number(value);
            if (!Number.isNaN(numeric)) {
                payload[key] = Math.round(numeric * 1000) / 1000;
            }
        } else {
            payload[key] = value;
        }
    });

    const logPath = resolveLogPath();
    ensureParent(logPath);
    rotateLogs(logPath);

    try {
        fs.appendFileSync(logPath, `${JSON.stringify(payload)}\n`, { encoding: 'utf-8' });
    } catch {
        // Ignore write failures to avoid blocking hooks
    }
    return payload;
}

function createEventTimer({ event, component, hook, level = 'info', ...fields }) {
    const start = process.hrtime.bigint();
    const captured = { ...fields };

    const finalize = (extra = {}, overrides = {}) => {
        Object.assign(captured, extra || {});
        const duration = Number(process.hrtime.bigint() - start) / 1e6;
        captured.latency_ms = duration;
        logEvent({
            event,
            component,
            hook,
            level: overrides.level || level,
            ...captured,
        });
    };

    const fail = (extra = {}) => {
        Object.assign(captured, extra || {});
        const duration = Number(process.hrtime.bigint() - start) / 1e6;
        captured.latency_ms = duration;
        if (captured.error && captured.error instanceof Error) {
            captured.error = captured.error.message;
        }
        logEvent({
            event,
            component,
            hook,
            level: 'error',
            ...captured,
        });
    };

    return {
        add(extra = {}) {
            Object.assign(captured, extra);
        },
        end(extra = {}, overrides = {}) {
            finalize(extra, overrides);
        },
        error(extra = {}) {
            fail(extra);
        },
    };
}

module.exports = {
    logEvent,
    createEventTimer,
    resolveLogPath,
};
