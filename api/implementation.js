#!/usr/bin/env node

// ==== IMPORTS ===== //

// ===== LOCAL ===== //
const {
    ExecutionWindowManager,
    Mode,
    loadState
} = require('../hooks/shared_state.js');

// Custom error class for execution window operations
class ExecutionWindowError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ExecutionWindowError';
    }
}
//--//

// ==== FUNCTIONS ===== //

function parseTaskArgs(args) {
    const tasks = [];
    for (let i = 0; i < args.length; i++) {
        const token = args[i];
        if (token === '--tasks') {
            i += 1;
            while (i < args.length && !args[i].startsWith('--')) {
                const value = args[i].trim();
                if (value) {
                    value.split(',').forEach(entry => {
                        const cleaned = entry.trim();
                        if (cleaned) tasks.push(cleaned);
                    });
                }
                i += 1;
            }
            i -= 1; // compensate for loop increment
        } else if (token.startsWith('--tasks=')) {
            const [, raw] = token.split('=');
            raw.split(',').forEach(entry => {
                const cleaned = entry.trim();
                if (cleaned) tasks.push(cleaned);
            });
        }
    }
    return tasks;
}

function parseBooleanFlag(args, positiveFlag, negativeFlag, defaultValue) {
    let value = defaultValue;
    for (const token of args) {
        if (token === positiveFlag) {
            value = true;
        } else if (token === negativeFlag) {
            value = false;
        }
    }
    return value;
}

function parseTimeout(args, defaultMinutes = 60) {
    for (let i = 0; i < args.length; i++) {
        const token = args[i];
        if (token === '--timeout') {
            const next = args[i + 1];
            if (!next) {
                throw new ExecutionWindowError('Missing value for --timeout');
            }
            const minutes = Number.parseInt(next, 10);
            if (!Number.isFinite(minutes) || minutes <= 0) {
                throw new ExecutionWindowError('Timeout must be a positive integer (minutes)');
            }
            return minutes;
        }
        if (token.startsWith('--timeout=')) {
            const [, value] = token.split('=');
            const minutes = Number.parseInt(value, 10);
            if (!Number.isFinite(minutes) || minutes <= 0) {
                throw new ExecutionWindowError('Timeout must be a positive integer (minutes)');
            }
            return minutes;
        }
    }
    return defaultMinutes;
}

function parseExtendMinutes(args) {
    for (let i = 0; i < args.length; i++) {
        const token = args[i];
        if (token === '--minutes') {
            const next = args[i + 1];
            if (!next) {
                throw new ExecutionWindowError('Missing value for --minutes');
            }
            const minutes = Number.parseInt(next, 10);
            if (!Number.isFinite(minutes) || minutes <= 0) {
                throw new ExecutionWindowError('Extension must be a positive integer (minutes)');
            }
            return minutes;
        }
        if (token.startsWith('--minutes=')) {
            const [, value] = token.split('=');
            const minutes = Number.parseInt(value, 10);
            if (!Number.isFinite(minutes) || minutes <= 0) {
                throw new ExecutionWindowError('Extension must be a positive integer (minutes)');
            }
            return minutes;
        }
    }
    throw new ExecutionWindowError('Use --minutes <value> to specify extension length');
}

function parseForceReason(args) {
    for (let i = 0; i < args.length; i++) {
        const token = args[i];
        if (token === '--force') {
            const next = args[i + 1];
            if (!next || next.startsWith('--')) {
                return 'forced';
            }
            return next;
        }
        if (token.startsWith('--force=')) {
            const [, value] = token.split('=');
            return value || 'forced';
        }
    }
    return null;
}

function ensureFeatureEnabled() {
    const configState = ExecutionWindowManager.withState(manager => manager.isEnabled());
    if (!configState) {
        throw new ExecutionWindowError('Execution windows feature disabled in configuration');
    }
}

function renderTaskLine(task) {
    const base = task.path || task.id || 'unknown';
    const status = task.status || 'Unknown';
    const suffix = task.branch ? ` [branch: ${task.branch}]` : '';
    return `  • ${base} (${status})${suffix}`;
}

function renderWindowSummary(window) {
    const lines = [];
    lines.push(`Window: ${window.id}`);
    lines.push(`State: ${window.state}`);
    lines.push(`Opened: ${window.opened_at}`);
    if (window.expires_at) {
        lines.push(`Expires: ${window.expires_at}`);
    }
    lines.push(`Timeout: ${window.timeout_minutes} minutes`);
    lines.push(`Allow subagents: ${window.allow_subagents ? 'yes' : 'no'}`);
    lines.push('Tasks:');
    for (const task of window.tasks) {
        lines.push(renderTaskLine(task));
    }
    if (window.close_reason) {
        lines.push(`Close reason: ${window.close_reason}`);
    }
    if (window.closed_at) {
        lines.push(`Closed: ${window.closed_at}`);
    }
    return lines.join('\n');
}

function windowToJSON(window) {
    return window ? window.toDict() : null;
}

function handleBegin(args, jsonOutput) {
    ensureFeatureEnabled();

    const tasks = parseTaskArgs(args);
    if (!tasks.length) {
        throw new ExecutionWindowError('Provide at least one task path using --tasks');
    }
    const timeout = parseTimeout(args, 60);
    const allowSubagents = parseBooleanFlag(args, '--allow-subagents', '--no-subagents', true);

    const window = ExecutionWindowManager.open(tasks, {
        timeoutMinutes: timeout,
        allowSubagents
    });

    if (jsonOutput) {
        return {
            ok: true,
            window: windowToJSON(window),
            mode: Mode.GO
        };
    }

    return [
        'Implementation window opened.',
        renderWindowSummary(window),
        '',
        'Implementation mode activated.'
    ].join('\n');
}

function handleStatus(jsonOutput) {
    ensureFeatureEnabled();
    const result = ExecutionWindowManager.refresh();
    const window = result ? result.window : null;

    if (!window) {
        if (jsonOutput) {
            return { window: null, mode: loadState().mode };
        }
        return 'No active execution window.';
    }

    if (jsonOutput) {
        return {
            window: windowToJSON(window),
            closed: !!result.closed,
            close_reason: result.close_reason || null,
            mode: loadState().mode
        };
    }

    const lines = [renderWindowSummary(window)];
    if (result.closed) {
        lines.push('');
        lines.push(`Window closed automatically (${result.close_reason}).`);
    }
    return lines.join('\n');
}

function handleExtend(args, jsonOutput) {
    ensureFeatureEnabled();
    const minutes = parseExtendMinutes(args);
    const result = ExecutionWindowManager.extend(minutes);
    const window = result.window;

    if (jsonOutput) {
        return {
            window: windowToJSON(window),
            expires_at: result.expires_at
        };
    }

    return `Execution window ${window.id} extended by ${minutes} minutes. New expiry: ${result.expires_at}`;
}

function handleEnd(args, jsonOutput) {
    ensureFeatureEnabled();
    const reason = parseForceReason(args) || 'manual';
    const window = ExecutionWindowManager.close(reason, { details: { source: 'cli' } });

    if (jsonOutput) {
        return {
            window: windowToJSON(window),
            close_reason: reason,
            mode: Mode.NO
        };
    }

    return [
        `Execution window ${window.id} closed (${reason}).`,
        'Returned to discussion mode.'
    ].join('\n');
}

function handleLocks(jsonOutput) {
    const state = loadState();
    const window = state.execution_windows?.getActiveWindow();

    if (!window || !window.tasks || window.tasks.length === 0) {
        if (jsonOutput) {
            return {locks: []};
        }
        return 'No active execution window or tasks.';
    }

    const locks = [];
    for (const task of window.tasks) {
        if (task.assigned_to && task.assigned_files && task.assigned_files.length > 0) {
            for (const file of task.assigned_files) {
                locks.push({
                    file: file,
                    owner: task.assigned_to,
                    task: task.path,
                    assigned_at: task.assigned_at,
                    status: task.status
                });
            }
        }
    }

    if (jsonOutput) {
        return {locks: locks};
    }

    if (locks.length === 0) {
        return 'No file locks active.';
    }

    const lines = [];
    lines.push('');
    lines.push(`File Locks (${locks.length} files assigned):`);
    lines.push('');
    for (const lock of locks) {
        lines.push(`  ${lock.file}`);
        lines.push(`    Owner: ${lock.owner}`);
        lines.push(`    Task: ${lock.task}`);
        lines.push(`    Assigned: ${lock.assigned_at}`);
        lines.push(`    Status: ${lock.status}`);
        lines.push('');
    }
    return lines.join('\n');
}

function handleOwnership(args, jsonOutput) {
    const filePath = args[0];

    if (!filePath) {
        throw new ExecutionWindowError('File path required. Usage: implementation ownership <file>');
    }

    const state = loadState();
    const window = state.execution_windows?.getActiveWindow();

    if (!window || !window.tasks) {
        if (jsonOutput) {
            return {
                file: filePath,
                status: 'available',
                reason: 'no active execution window'
            };
        }
        return `File: ${filePath}\nStatus: Not assigned (no active execution window)`;
    }

    // Normalize the input path for comparison
    const path = require('path');
    const normalizedInput = filePath.replace(/^\.\//, '');

    // Find task that owns this file
    let owner = null;
    for (const task of window.tasks) {
        if (task.assigned_files && task.assigned_files.length > 0) {
            for (const assignedFile of task.assigned_files) {
                if (assignedFile === normalizedInput ||
                    assignedFile.endsWith('/' + normalizedInput)) {
                    owner = {
                        subagent: task.assigned_to,
                        task: task.path,
                        assigned_at: task.assigned_at,
                        status: task.status,
                        all_files: task.assigned_files
                    };
                    break;
                }
            }
        }
        if (owner) break;
    }

    if (jsonOutput) {
        if (owner) {
            return {
                file: filePath,
                status: 'assigned',
                owner: owner.subagent,
                task: owner.task,
                assigned_at: owner.assigned_at,
                task_status: owner.status,
                all_files: owner.all_files
            };
        }
        return {
            file: filePath,
            status: 'available'
        };
    }

    const lines = [];
    lines.push('');
    lines.push(`File: ${filePath}`);
    if (owner) {
        lines.push(`Status: ASSIGNED`);
        lines.push(`Owner: ${owner.subagent}`);
        lines.push(`Task: ${owner.task}`);
        lines.push(`Assigned: ${owner.assigned_at}`);
        lines.push(`Task Status: ${owner.status}`);
        lines.push('');
        lines.push('All files in this assignment:');
        for (const file of owner.all_files) {
            lines.push(`  - ${file}`);
        }
    } else {
        lines.push('Status: AVAILABLE (not assigned)');
    }
    lines.push('');
    return lines.join('\n');
}

function handleImplementationCommand(args, jsonOutput = false, _fromSlash = false) {
    if (!args || args.length === 0) {
        throw new ExecutionWindowError('Usage: implementation <begin|status|extend|end|locks|ownership> [options]');
    }

    const subcommand = args[0];
    const subArgs = args.slice(1);

    switch (subcommand) {
        case 'begin':
            return handleBegin(subArgs, jsonOutput);
        case 'status':
            return handleStatus(jsonOutput);
        case 'extend':
            return handleExtend(subArgs, jsonOutput);
        case 'end':
            return handleEnd(subArgs, jsonOutput);
        case 'locks':
            return handleLocks(jsonOutput);
        case 'ownership':
            return handleOwnership(subArgs, jsonOutput);
        default:
            throw new ExecutionWindowError(`Unknown implementation command: ${subcommand}`);
    }
}

// ==== EXPORTS ===== //

module.exports = {
    handleImplementationCommand
};
