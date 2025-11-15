const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const MAX_DISPLAY_NAMES = 40;
const CACHE_TTL_MS = 4000;
const DEFAULT_RESULT = () => ({ running: 0, pending: 0, names: [] });

const CONTROL_CHARS_REGEX = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const ANSI_ESCAPE_REGEX = /\x1b\[[0-9;?]*[A-Za-z]/g;

let cache = {
    timestamp: 0,
    data: DEFAULT_RESULT(),
    dbPath: null,
};

function sanitizeName(name) {
    if (typeof name !== 'string') {
        return 'task';
    }
    const cleaned = name
        .replace(ANSI_ESCAPE_REGEX, '')
        .replace(CONTROL_CHARS_REGEX, '')
        .trim();
    return cleaned || 'task';
}

function expandHome(input) {
    if (!input) {
        return input;
    }
    if (input.startsWith('~')) {
        return path.join(os.homedir(), input.slice(1));
    }
    return input;
}

function detectDbPath() {
    const candidates = [];
    const envOverrides = [
        process.env.CC_SESSIONS_CODEX_DB,
        process.env.CODEX_DELEGATE_DB,
        process.env.CODEX_BACKGROUND_DB,
    ];
    for (const candidate of envOverrides) {
        if (candidate) {
            candidates.push(path.resolve(expandHome(candidate)));
        }
    }

    const projectDir = process.env.CLAUDE_PROJECT_DIR;
    if (projectDir) {
        candidates.push(path.join(projectDir, '.codex-delegate', 'background_tasks.db'));
    }

    const home = os.homedir();
    // Python codex-delegate default location (highest priority)
    candidates.push(path.join(home, '.cache', 'codex-delegate', 'background_tasks.db'));
    candidates.push(path.join(home, 'codex-delegate', '.codex-delegate', 'background_tasks.db'));
    candidates.push(path.join(home, '.codex-delegate', 'background_tasks.db'));

    for (const candidate of candidates) {
        if (candidate && fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return null;
}

function parseTabularOutput(output) {
    const trimmed = output.trim();
    if (!trimmed) {
        return [];
    }
    const lines = trimmed.split('\n');
    if (!lines.length) {
        return [];
    }
    const headers = lines.shift().split('\t');
    const rows = [];
    for (const line of lines) {
        if (!line.trim()) continue;
        const cells = line.split('\t');
        const row = {};
        headers.forEach((header, idx) => {
            row[header] = cells[idx] ?? '';
        });
        rows.push(row);
    }
    return rows;
}

function querySqlite(dbPath, sql) {
    const args = ['-readonly', '-header', '-separator', '\t', dbPath, sql];
    const output = execFileSync('sqlite3', args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseTabularOutput(output);
}

function queryTaskCounts(dbPath) {
    const sql = "SELECT status, COUNT(*) AS count FROM background_tasks WHERE status IN ('running','pending') GROUP BY status;";
    const rows = querySqlite(dbPath, sql);
    const counts = { running: 0, pending: 0 };
    for (const row of rows) {
        const status = (row.status || '').toLowerCase();
        const value = parseInt(row.count, 10);
        if (status === 'running' || status === 'pending') {
            counts[status] = Number.isNaN(value) ? 0 : value;
        }
    }
    return counts;
}

function queryTaskSamples(dbPath) {
    const sql = "SELECT name, status FROM background_tasks WHERE status IN ('running','pending') ORDER BY COALESCE(started_at, created_at) DESC LIMIT 5;";
    const rows = querySqlite(dbPath, sql);
    return rows.map(row => ({
        name: sanitizeName(row.name || ''),
        status: (row.status || '').toLowerCase(),
    }));
}

function getCodexTasks(options = {}) {
    const now = Date.now();
    if (!options.force && cache.data && (now - cache.timestamp) < CACHE_TTL_MS) {
        return cache.data;
    }

    const dbPath = detectDbPath();
    if (!dbPath) {
        const fallback = DEFAULT_RESULT();
        cache = { timestamp: now, data: fallback, dbPath: null };
        return fallback;
    }

    try {
        const counts = queryTaskCounts(dbPath);
        const names = queryTaskSamples(dbPath);
        const normalized = {
            running: counts.running || 0,
            pending: counts.pending || 0,
            names,
        };
        cache = { timestamp: now, data: normalized, dbPath };
        return normalized;
    } catch {
        const fallback = DEFAULT_RESULT();
        cache = { timestamp: now, data: fallback, dbPath: null };
        return fallback;
    }
}

function formatNames(names, maxLength = MAX_DISPLAY_NAMES) {
    if (!names || !names.length) {
        return '';
    }
    let result = '';
    let shown = 0;

    for (const rawName of names) {
        const name = String(rawName);
        const part = shown === 0 ? name : `, ${name}`;
        if ((result + part).length > maxLength) {
            if (shown === 0) {
                const sliceLength = Math.max(1, maxLength - 3);
                result = `${name.slice(0, sliceLength)}...`;
                shown = 1;
            }
            const remaining = names.length - shown;
            if (remaining > 0) {
                if (!result.endsWith('...')) {
                    result = `${result}...`;
                }
                result = `${result} +${remaining} more`;
            }
            return result;
        }
        result += part;
        shown += 1;
    }

    return result;
}

function buildPrefix(iconStyle) {
    switch (iconStyle) {
        case 'emoji':
            return '🤖 Codex';
        case 'ascii':
            return 'Codex';
        default:
            return '󱁤 Codex';
    }
}

function buildStatusLabel(runningCount, pendingCount) {
    const total = runningCount + pendingCount;
    if (total === 0) {
        return '';
    }
    if (runningCount === total) {
        return `${total} running`;
    }
    if (pendingCount === total) {
        return `${total} pending`;
    }
    return `${total} active`;
}

function formatCodexTasks(tasks = {}, options = {}) {
    const iconStyle = options.iconStyle || 'nerd_fonts';
    const runningCount = Array.isArray(tasks.running) ? tasks.running.length : Number(tasks.running) || 0;
    const pendingCount = Array.isArray(tasks.pending) ? tasks.pending.length : Number(tasks.pending) || 0;
    const total = runningCount + pendingCount;
    if (total === 0) {
        return '';
    }

    const prefix = buildPrefix(iconStyle);
    const statusLabel = buildStatusLabel(runningCount, pendingCount);
    let names = [];
    if (Array.isArray(tasks.names) && tasks.names.length) {
        names = tasks.names.map(entry => entry?.name ?? entry ?? '');
    } else {
        const runningEntries = Array.isArray(tasks.running) ? tasks.running : [];
        const pendingEntries = Array.isArray(tasks.pending) ? tasks.pending : [];
        names = runningEntries.concat(pendingEntries).map(entry => entry?.name ?? entry ?? '');
    }
    const sanitizedNames = names.map(value => sanitizeName(value));
    const namesPart = formatNames(sanitizedNames);
    const suffix = namesPart ? ` (${namesPart})` : '';
    return `${prefix}: ${statusLabel}${suffix}`;
}

module.exports = {
    getCodexTasks,
    formatCodexTasks,
};
