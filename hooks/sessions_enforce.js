#!/usr/bin/env node

// ===== IMPORTS ===== //

/// ===== STDLIB ===== ///
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
///-///

/// ===== 3RD-PARTY ===== ///
///-///

/// ===== LOCAL ===== ///
const {
    editState,
    loadState,
    Mode,
    PROJECT_ROOT,
    loadConfig,
    findGitRepo,
    CCTools
} = require('./shared_state.js');
const { withTiming } = require('./benchmark_utils.js');
///-///

//-//

// ===== GLOBALS ===== //
// Load input
let inputData = {};
try {
    const stdin = fs.readFileSync(0, 'utf-8');
    inputData = JSON.parse(stdin);
} catch (e) {
    inputData = {};
}

const inputSize = JSON.stringify(inputData).length;

const toolName = inputData.tool_name || "";
const toolInput = inputData.tool_input || {};
const sessionId = inputData.session_id || "";

let filePath = null;
const filePathString = toolInput.file_path || "";
if (filePathString) {
    filePath = normalizeCommandPath(filePathString);
}
const taskId = typeof toolInput.task_id === 'string' ? toolInput.task_id : null;

const STATE = loadState();
const CONFIG = loadConfig();
const BRANCH_DEBUG = process.env.CC_SESSIONS_DEBUG_BRANCH === '1';

let command = "";
let incomingTodos = [];
if (toolName === "Bash") {
    command = (toolInput.command || "").trim();
}
if (toolName === "TodoWrite") {
    incomingTodos = toolInput.todos || [];
}

const STATE_DIR_MARKER = path.join('sessions', 'state');
const STATE_DIR_MARKER_UNIX = STATE_DIR_MARKER.split(path.sep).join('/');

/// ===== PATTERNS ===== ///
const READONLY_FIRST = new Set([
    // Basic file reading
    'cat', 'less', 'more', 'head', 'tail', 'wc', 'nl', 'tac', 'rev',
    // Text search and filtering
    'grep', 'egrep', 'fgrep', 'rg', 'ripgrep', 'ag', 'ack',
    // Text processing (all safe for reading)
    'sort', 'uniq', 'cut', 'paste', 'join', 'comm', 'column',
    'tr', 'expand', 'unexpand', 'fold', 'fmt', 'pr', 'shuf', 'tsort',
    // Comparison
    'diff', 'cmp', 'sdiff', 'vimdiff',
    // Checksums
    'md5sum', 'sha1sum', 'sha256sum', 'sha512sum', 'cksum', 'sum',
    // Binary inspection
    'od', 'hexdump', 'xxd', 'strings', 'file', 'readelf', 'objdump', 'nm',
    // File system inspection
    'ls', 'dir', 'vdir', 'pwd', 'which', 'type', 'whereis', 'locate', 'find',
    'basename', 'dirname', 'readlink', 'realpath', 'stat',
    // User/system info
    'whoami', 'id', 'groups', 'users', 'who', 'w', 'last', 'lastlog',
    'hostname', 'uname', 'arch', 'lsb_release', 'hostnamectl',
    'date', 'cal', 'uptime', 'df', 'du', 'free', 'vmstat', 'iostat',
    // Process monitoring
    'ps', 'pgrep', 'pidof', 'top', 'htop', 'iotop', 'atop',
    'lsof', 'jobs', 'pstree', 'fuser',
    // Network monitoring
    'netstat', 'ss', 'ip', 'ifconfig', 'route', 'arp',
    'ping', 'traceroute', 'tracepath', 'mtr', 'nslookup', 'dig', 'host', 'whois',
    // Environment
    'printenv', 'env', 'set', 'export', 'alias', 'history', 'fc',
    // Output
    'echo', 'printf', 'yes', 'seq', 'jot',
    // Testing
    'test', '[', '[[', 'true', 'false',
    // Calculation
    'bc', 'dc', 'expr', 'factor', 'units',
    // Modern tools
    'jq', 'yq', 'xmlstarlet', 'xmllint', 'xsltproc',
    'bat', 'fd', 'fzf', 'tree', 'ncdu', 'exa', 'lsd',
    'tldr', 'cheat',
    // Note: awk/sed are here but need special argument checking
    'awk', 'sed', 'gawk', 'mawk', 'gsed'
]);

// Add user-configured readonly patterns
CONFIG.blocked_actions.bash_read_patterns.forEach(pattern => {
    READONLY_FIRST.add(pattern);
});

const WRITE_FIRST = new Set([
    // File operations
    'rm', 'rmdir', 'unlink', 'shred',
    'mv', 'rename', 'cp', 'install', 'dd',
    'mkdir', 'mkfifo', 'mknod', 'mktemp', 'touch', 'truncate',
    // Permissions
    'chmod', 'chown', 'chgrp', 'umask',
    'ln', 'link', 'symlink',
    'setfacl', 'setfattr', 'chattr',
    // System management
    'useradd', 'userdel', 'usermod', 'groupadd', 'groupdel',
    'passwd', 'chpasswd', 'systemctl', 'service',
    // Package managers
    'apt', 'apt-get', 'dpkg', 'snap', 'yum', 'dnf', 'rpm',
    'pip', 'pip3', 'npm', 'yarn', 'gem', 'cargo',
    // Build tools
    'make', 'cmake', 'ninja', 'meson',
    // Other dangerous
    'sudo', 'doas', 'su', 'crontab', 'at', 'batch',
    'kill', 'pkill', 'killall', 'tee'
]);

// Add user-configured write patterns
CONFIG.blocked_actions.bash_write_patterns.forEach(pattern => {
    WRITE_FIRST.add(pattern);
});

// Enhanced redirection detection (includes stderr redirections)
const REDIR_PATTERNS = [
    /(?:^|\s)(?:>>?|<<?|<<<)\s/,           // Basic redirections
    /(?:^|\s)\d*>&?\d*(?:\s|$)/,            // File descriptor redirections (2>&1, etc)
    /(?:^|\s)&>/                            // Combined stdout/stderr redirect
];
const REDIR = new RegExp(REDIR_PATTERNS.map(p => p.source).join('|'));

// Commands that accept explicit destination arguments which can mutate files
const COMMAND_WRITE_PARSERS = {
    cp: takeLastPositionalArg,
    mv: takeLastPositionalArg,
    install: takeLastPositionalArg,
    ln: takeLastPositionalArg,
    link: takeLastPositionalArg,
    symlink: takeLastPositionalArg,
    touch: takeAllPositionalArgs,
    truncate: takeAllPositionalArgs,
    rm: takeAllPositionalArgs,
    rmdir: takeAllPositionalArgs,
    unlink: takeAllPositionalArgs,
    shred: takeAllPositionalArgs,
    mkdir: takeAllPositionalArgs,
    dd: extractDdTargets
};
///-///

function getGitBranchDetails(repoPath) {
    /**
     * Retrieve branch/detached info via a single porcelain status call to
     * avoid multiple git invocations per hook.
     */
    try {
        const output = execSync(
            `git -C "${repoPath.replace(/"/g, '\\"')}" status --porcelain=2 --branch`,
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
        );
        const details = { branch: null, commit: null, detached: false };
        for (const line of output.split('\n')) {
            if (!line) continue;
            if (line.startsWith('# branch.head ')) {
                const head = line.slice('# branch.head '.length).trim();
                if (head && head !== '(detached)') {
                    details.branch = head;
                } else {
                    details.detached = true;
                }
            } else if (line.startsWith('# branch.oid ')) {
                details.commit = line.slice('# branch.oid '.length).trim();
            }
        }
        return details;
    } catch {
        return null;
    }
}

function getExecutionPlanContext() {
    const metadata = STATE.metadata || {};
    const orchestration = metadata.orchestration;
    if (!orchestration || !orchestration.execution_plan) {
        return null;
    }

    const plan = orchestration.execution_plan;
    const groups = Array.isArray(plan.groups) ? plan.groups : [];
    if (groups.length === 0) {
        return null;
    }

    return { orchestration, groups };
}

/// ===== CI DETECTION ===== ///
function isCIEnvironment() {
    // Check if running in a CI environment (GitHub Actions)
    const ciIndicators = [
        'GITHUB_ACTIONS',         // GitHub Actions
        'GITHUB_WORKFLOW',        // GitHub Actions workflow
        'CI',                     // Generic CI indicator (set by GitHub Actions)
        'CONTINUOUS_INTEGRATION', // Generic CI (alternative)
    ];
    return ciIndicators.some(indicator => process.env[indicator]);
}
///-///

//-//

/*
╔══════════════════════════════════════════════════════════════════════════════╗
║ ██████╗ █████╗ ██████╗ ██████╗ █████╗  █████╗ ██╗      ██╗ ██╗██████╗██████╗ ║
║ ██╔══██╗██╔═██╗██╔═══╝ ╚═██╔═╝██╔══██╗██╔══██╗██║      ██║ ██║██╔═══╝██╔═══╝ ║
║ ██████╔╝█████╔╝█████╗    ██║  ██║  ██║██║  ██║██║      ██║ ██║██████╗█████╗  ║
║ ██╔═══╝ ██╔═██╗██╔══╝    ██║  ██║  ██║██║  ██║██║      ██║ ██║╚═══██║██╔══╝  ║
║ ██║     ██║ ██║██████╗   ██║  ╚█████╔╝╚█████╔╝███████╗ ╚████╔╝██████║██████╗ ║
║ ╚═╝     ╚═╝ ╚═╝╚═════╝   ╚═╝   ╚════╝  ╚════╝ ╚══════╝  ╚═══╝ ╚═════╝╚═════╝ ║
╚══════════════════════════════════════════════════════════════════════════════╝
PreToolUse Hook

Trigger conditions:
- Write/subagent tool invocation (Bash, Write, Edit, MultiEdit, Task, TodoWrite)

Enforces DAIC (Discussion, Alignment, Implementation, Check) workflow:
- Blocks write tools in discussion mode
- Validates TodoWrite operations for proper scope management
- Enforces git branch consistency with task requirements
- Protects system state files from unauthorized modification
*/

// ===== FUNCTIONS ===== //

/// ===== HELPERS ===== ///
function checkCommandArguments(parts) {
    // Check if command arguments indicate write operations
    if (!parts || parts.length === 0) return true;

    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    // Check sed for in-place editing
    if (cmd === 'sed' || cmd === 'gsed') {
        for (const arg of args) {
            if (arg.startsWith('-i') || arg === '--in-place') {
                return false;  // sed -i is a write operation
            }
        }
    }

    // Check awk for file output operations
    if (['awk', 'gawk', 'mawk'].includes(cmd)) {
        const script = args.join(' ');
        // Check for output redirection within awk script
        if (/>s*["'].*["']/.test(script) || />>s*["'].*["']/.test(script)) {
            return false;
        }
        if (script.includes('print >') || script.includes('print >>') ||
            script.includes('printf >') || script.includes('printf >>')) {
            return false;
        }
    }

    // Check find for dangerous operations
    if (cmd === 'find') {
        if (args.includes('-delete')) {
            return false;
        }
        for (let i = 0; i < args.length; i++) {
            if (args[i] === '-exec' || args[i] === '-execdir') {
                if (i + 1 < args.length) {
                    const execCmd = args[i + 1].toLowerCase();
                    if (WRITE_FIRST.has(execCmd) || ['rm', 'mv', 'cp', 'shred'].includes(execCmd)) {
                        return false;
                    }
                }
            }
        }
    }

    // Check xargs for dangerous commands
    if (cmd === 'xargs') {
        for (const writeCmd of WRITE_FIRST) {
            if (args.some(arg => arg === writeCmd)) {
                return false;
            }
        }
        // Check for sed -i through xargs
        const sedIndex = args.indexOf('sed');
        if (sedIndex > -1 && sedIndex + 1 < args.length && args[sedIndex + 1].startsWith('-i')) {
            return false;
        }
    }

    return true;
}

function blockSubagentOrchestrationWrite(targetPath) {
    const message = "[Subagent Security] Subagents cannot modify orchestration state files.\n" +
                    "File: " + targetPath + "\n" +
                    "Only the orchestrator can update execution plans and session indexes.";
    try {
        fs.writeSync(process.stderr.fd, `${message}\n`);
    } catch {
        console.error(message);
    }
    process.exit(2);
}

function normalizeCommandPath(rawPath) {
    if (typeof rawPath !== 'string') {
        return null;
    }

    let target = rawPath.trim();
    if (!target) {
        return null;
    }

    if (target === '~' && process.env.HOME) {
        target = process.env.HOME;
    } else if (target.startsWith('~/') && process.env.HOME) {
        target = path.join(process.env.HOME, target.slice(2));
    }

    const absolute = path.isAbsolute(target) ? target : path.join(PROJECT_ROOT, target);
    return path.resolve(absolute);
}

function getOrchestrationFilePath(candidatePath) {
    const normalizedPath = normalizeCommandPath(candidatePath);
    if (!normalizedPath) {
        return null;
    }

    let stats = null;
    try {
        stats = fs.lstatSync(normalizedPath);
        if (stats.isSymbolicLink()) {
            return normalizedPath;
        }
    } catch {
        stats = null;
    }

    let resolvedPath = normalizedPath;
    try {
        resolvedPath = fs.realpathSync(normalizedPath);
    } catch {
        // Ignore - file might not exist yet
    }

    if (matchesOrchestrationTarget(resolvedPath)) {
        return normalizedPath;
    }

    if (resolvedPath !== normalizedPath && matchesOrchestrationTarget(normalizedPath)) {
        return normalizedPath;
    }

    return null;
}

function matchesOrchestrationTarget(targetPath) {
    if (!targetPath) {
        return false;
    }

    const basename = path.basename(targetPath);
    const isUnifiedState = basename === 'sessions-state.json' || basename.startsWith('sessions-state.json.');
    if (isUnifiedState) {
        return true;
    }

    const isSessionIndex = basename === 'session_index.json' || basename.startsWith('session_index.json.');
    const isExecutionPlan = basename === 'execution_plan.json' || basename.startsWith('execution_plan.json.');
    if (!isSessionIndex && !isExecutionPlan) {
        return false;
    }

    return isWithinStateDirectory(targetPath);
}

function isWithinStateDirectory(targetPath) {
    const relative = path.relative(PROJECT_ROOT, targetPath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        return false;
    }

    const normalizedRelative = relative.split(path.sep).join('/');
    return normalizedRelative === STATE_DIR_MARKER_UNIX ||
        normalizedRelative.startsWith(`${STATE_DIR_MARKER_UNIX}/`);
}

function isProcessSubstitutionTarget(target) {
    return typeof target === 'string' && /^[<>]\(/.test(target.trim());
}

function getProcessSubstitutionCommand(expression) {
    if (!isProcessSubstitutionTarget(expression)) {
        return null;
    }

    const parsed = readProcessSubstitution(expression.trim(), 0);
    if (parsed && typeof parsed.command === 'string') {
        return parsed.command;
    }

    return null;
}

function isFileDescriptorReference(operator, target) {
    return typeof target === 'string' &&
        /^\d+$/.test(target) &&
        typeof operator === 'string' &&
        operator.endsWith('&');
}

function readRedirectTarget(command, startIndex) {
    const len = command.length;
    let i = startIndex;

    while (i < len && /\s/.test(command[i])) {
        i++;
    }

    if (i >= len) {
        return { token: '', nextIndex: len };
    }

    let processSubstitution = null;
    if (command[i] === '(' && i > 0 && (command[i - 1] === '>' || command[i - 1] === '<')) {
        processSubstitution = readProcessSubstitution(command, i - 1);
    } else {
        processSubstitution = readProcessSubstitution(command, i);
    }
    if (processSubstitution) {
        return {
            token: processSubstitution.expression,
            nextIndex: processSubstitution.nextIndex,
            processSubstitution: processSubstitution.command
        };
    }

    let token = '';
    let inSingle = false;
    let inDouble = false;
    let escape = false;

    while (i < len) {
        const ch = command[i];

        if (escape) {
            token += ch;
            escape = false;
            i++;
            continue;
        }

        if (ch === '\\' && !inSingle) {
            escape = true;
            i++;
            continue;
        }

        if (ch === "'" && !inDouble) {
            inSingle = !inSingle;
            i++;
            continue;
        }

        if (ch === '"' && !inSingle) {
            inDouble = !inDouble;
            i++;
            continue;
        }

        if (!inSingle && !inDouble) {
            if (/\s/.test(ch) || ch === ';' || ch === '|' || ch === '&' || ch === '>') {
                break;
            }
        }

        token += ch;
        i++;
    }

    return { token: token.trim(), nextIndex: i };
}

function readWriteRedirection(command, startIndex) {
    const len = command.length;
    let i = startIndex;

    let prefix = '';
    while (i < len && /\d/.test(command[i])) {
        prefix += command[i];
        i++;
    }

    if (i >= len) {
        return null;
    }

    if (command[i] === '&' && command[i + 1] === '>') {
        const operator = (prefix || '') + '&>';
        return { operator, nextIndex: i + 2 };
    }

    if (command[i] !== '>') {
        return null;
    }

    let operator = prefix + '>';
    i++;

    if (command[i] === '>') {
        operator += '>';
        i++;
    }

    if (command[i] === '&') {
        operator += '&';
        i++;
    }

    return { operator, nextIndex: i };
}

function readProcessSubstitution(command, startIndex) {
    const len = command.length;
    let i = startIndex;

    if (i >= len) {
        return null;
    }

    const operator = command[i];
    if (operator !== '>' && operator !== '<') {
        return null;
    }

    if (i + 1 >= len || command[i + 1] !== '(') {
        return null;
    }

    i += 2; // Skip operator and opening parenthesis
    let depth = 1;
    let inSingle = false;
    let inDouble = false;
    let escape = false;
    let content = '';

    while (i < len) {
        const ch = command[i];

        if (escape) {
            content += ch;
            escape = false;
            i++;
            continue;
        }

        if (ch === '\\' && !inSingle) {
            escape = true;
            i++;
            continue;
        }

        content += ch;

        if (ch === "'" && !inDouble) {
            inSingle = !inSingle;
        } else if (ch === '"' && !inSingle) {
            inDouble = !inDouble;
        } else if (!inSingle && !inDouble) {
            if (ch === '(') {
                depth++;
            } else if (ch === ')') {
                depth--;
                if (depth === 0) {
                    content = content.slice(0, -1);
                    return {
                        expression: command.slice(startIndex, i + 1),
                        command: content,
                        nextIndex: i + 1
                    };
                }
            }
        }

        i++;
    }

    return {
        expression: command.slice(startIndex),
        command: content,
        nextIndex: len
    };
}

function tokenizeShell(command) {
    const tokens = [];
    if (!command) {
        return tokens;
    }

    let current = '';
    let inSingle = false;
    let inDouble = false;
    let escape = false;

    const flush = () => {
        if (current) {
            tokens.push(current);
            current = '';
        }
    };

    for (let i = 0; i < command.length; i++) {
        const ch = command[i];

        if (escape) {
            current += ch;
            escape = false;
            continue;
        }

        if (ch === '\\' && !inSingle) {
            escape = true;
            continue;
        }

        if (ch === "'" && !inDouble) {
            inSingle = !inSingle;
            continue;
        }

        if (ch === '"' && !inSingle) {
            inDouble = !inDouble;
            continue;
        }

        if (!inSingle && !inDouble) {
            if (/\s/.test(ch)) {
                flush();
                continue;
            }

            if (ch === '|' || ch === '&' || ch === ';') {
                flush();

                let op = ch;
                if ((ch === '|' || ch === '&') && command[i + 1] === ch) {
                    op += command[++i];
                } else if (ch === '|' && command[i + 1] === '&') {
                    op += command[++i];
                }
                tokens.push(op);
                continue;
            }
        }

        current += ch;
    }

    flush();
    return tokens;
}

function extractTeeTargets(command) {
    const tokens = tokenizeShell(command);
    const targets = [];

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (path.basename(token) !== 'tee') {
            continue;
        }

        for (let j = i + 1; j < tokens.length; j++) {
            const candidate = tokens[j];
            if (candidate === '|' || candidate === '||' || candidate === '&&' || candidate === ';') {
                break;
            }

            if (!candidate || candidate.startsWith('-')) {
                continue;
            }

            targets.push(candidate);
        }
    }

    return targets;
}

function extractBashTargets(command) {
    if (!command) {
        return [];
    }

    const targets = [];
    const len = command.length;
    let i = 0;
    let inSingle = false;
    let inDouble = false;
    let escape = false;

    while (i < len) {
        const ch = command[i];

        if (escape) {
            escape = false;
            i++;
            continue;
        }

        if (ch === '\\' && !inSingle) {
            escape = true;
            i++;
            continue;
        }

        if (ch === "'" && !inDouble) {
            inSingle = !inSingle;
            i++;
            continue;
        }

        if (ch === '"' && !inSingle) {
            inDouble = !inDouble;
            i++;
            continue;
        }

        if (!inSingle && ch === '<' && i + 1 < len && command[i + 1] === '(') {
            const substitution = readProcessSubstitution(command, i);
            if (substitution) {
                const nestedTargets = extractBashTargets(substitution.command);
                targets.push(...nestedTargets);
                i = substitution.nextIndex;
                continue;
            }
        }

        if (!inSingle && (ch === '>' || ch === '&' || /\d/.test(ch))) {
            const redir = readWriteRedirection(command, i);
            if (redir) {
                const { token, nextIndex, processSubstitution } = readRedirectTarget(command, redir.nextIndex);
                i = nextIndex;
                if (!token) {
                    continue;
                }
                if (isFileDescriptorReference(redir.operator, token)) {
                    continue;
                }
                if (processSubstitution) {
                    const nestedTargets = extractBashTargets(processSubstitution);
                    targets.push(...nestedTargets);
                    continue;
                }
                if (isProcessSubstitutionTarget(token)) {
                    const substitutionCommand = getProcessSubstitutionCommand(token);
                    if (substitutionCommand) {
                        const nestedTargets = extractBashTargets(substitutionCommand);
                        targets.push(...nestedTargets);
                    }
                    continue;
                }
                targets.push(token);
                continue;
            }
        }

        i++;
    }

    for (const candidate of extractTeeTargets(command)) {
        if (candidate && !isProcessSubstitutionTarget(candidate)) {
            targets.push(candidate);
        }
    }

    const seen = new Set();
    return targets.filter(target => {
        if (!target) {
            return false;
        }
        if (seen.has(target)) {
            return false;
        }
        seen.add(target);
        return true;
    });
}

function extractCommandWriteTargets(command) {
    if (!command) {
        return [];
    }

    const tokens = tokenizeShell(command);
    if (tokens.length === 0) {
        return [];
    }

    const segments = [];
    let current = [];
    for (const token of tokens) {
        if (token === '|' || token === '||' || token === '&&' || token === ';') {
            if (current.length > 0) {
                segments.push(current);
            }
            current = [];
            continue;
        }
        current.push(token);
    }
    if (current.length > 0) {
        segments.push(current);
    }

    const targets = [];
    for (const segment of segments) {
        if (segment.length === 0) {
            continue;
        }
        const first = segment[0].toLowerCase();
        const parser = COMMAND_WRITE_PARSERS[first];
        if (!parser) {
            continue;
        }
        const args = segment.slice(1);
        for (const candidate of parser(args)) {
            if (candidate && !isProcessSubstitutionTarget(candidate)) {
                targets.push(candidate);
            }
        }
    }

    const seen = new Set();
    return targets.filter(target => {
        if (seen.has(target)) {
            return false;
        }
        seen.add(target);
        return true;
    });
}

function extractPositionalArgs(args) {
    const positional = [];
    let afterDoubleDash = false;
    for (const arg of args) {
        if (!afterDoubleDash && arg === '--') {
            afterDoubleDash = true;
            continue;
        }
        if (!afterDoubleDash && arg.startsWith('-')) {
            continue;
        }
        positional.push(arg);
    }
    return positional;
}

function takeLastPositionalArg(args) {
    const positional = extractPositionalArgs(args);
    if (positional.length === 0) {
        return [];
    }
    return [positional[positional.length - 1]];
}

function takeAllPositionalArgs(args) {
    return extractPositionalArgs(args);
}

function extractDdTargets(args) {
    const targets = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg.startsWith('of=')) {
            const target = arg.slice(3);
            if (target) {
                targets.push(target);
            }
            continue;
        }
        if (arg === 'of' && i + 1 < args.length) {
            const target = args[i + 1];
            if (target) {
                targets.push(target);
            }
            i++;
        }
    }
    return targets;
}

// Check if a bash command is read-only (no writes, no redirections)
function isBashReadOnly(command, extrasafe = CONFIG.blocked_actions.extrasafe || true) {
    /*Determine if a bash command is read-only.

    Enhanced to check command arguments for operations like:
    - sed -i (in-place editing)
    - awk with file output
    - find -delete or -exec rm
    - xargs with write commands

    Args:
        command (str): The bash command to evaluate.
        extrasafe (bool): If True, unrecognized commands are treated as write-like.*/

    const s = (command || '').trim();
    if (!s) return true;

    if (REDIR.test(s)) {
        return false;
    }

    // Split on |, && and || while avoiding splitting on escaped pipes
    const segments = s.split(/(?<!\|)\|(?!\|)|&&|\|\|/).map(seg => seg.trim());

    for (const segment of segments) {
        if (!segment) continue;

        // Parse command parts (handling quotes)
        let parts = [];
        try {
            // Simple shlex-like splitting for JavaScript
            const regex = /[^\s"']+|"([^"]*)"|'([^']*)'/g;
            let match;
            while ((match = regex.exec(segment)) !== null) {
                parts.push(match[1] || match[2] || match[0]);
            }
        } catch (error) {
            return !CONFIG.blocked_actions.extrasafe;
        }

        if (parts.length === 0) continue;

        const first = parts[0].toLowerCase();
        if (first === 'cd') continue;

        // Special case: Commands with read-only subcommands
        if (['pip', 'pip3'].includes(first)) {
            const subcommand = parts[1]?.toLowerCase() || '';
            if (['show', 'list', 'search', 'check', 'freeze', 'help'].includes(subcommand)) {
                continue;  // Allow read-only pip operations
            }
            return false;  // Block write operations
        }

        if (['npm', 'yarn'].includes(first)) {
            const subcommand = parts[1]?.toLowerCase() || '';
            if (['list', 'ls', 'view', 'show', 'search', 'help'].includes(subcommand)) {
                continue;  // Allow read-only npm/yarn operations
            }
            return false;  // Block write operations
        }

        if (['python', 'python3'].includes(first)) {
            // Allow python -c for simple expressions and python -m for module execution
            if (parts.length > 1 && ['-c', '-m'].includes(parts[1])) {
                continue;  // These are typically read-only operations in our context
            }
            // Block other python invocations as potentially write-like
            return false;
        }

        if (WRITE_FIRST.has(first)) return false;

        // Check command arguments for write operations
        if (!checkCommandArguments(parts)) return false;

        // Check if command is in user's custom readonly list
        if (CONFIG.blocked_actions.bash_read_patterns.includes(first)) continue;  // Allow custom readonly commands

        // If extrasafe is on and command not in readonly list, block it
        if (!READONLY_FIRST.has(first) && CONFIG.blocked_actions.extrasafe) return false;
    }

    return true;
}
///-///

//-//

// ===== EXECUTION ===== //

// Wrap the entire execution in timing
const exitCode = withTiming('sessions_enforce', () => {

// Skip DAIC enforcement in CI environments
if (isCIEnvironment()) {
    return 0;
}

//!> Task orchestration gate
if (toolName === "Task" && !STATE.flags?.bypass_mode) {
    // CRITICAL: Block nested subagents
    if (STATE.flags.subagent) {
        console.error("[Task Gate] Subagents cannot spawn nested subagents.\n" +
                      "Only the orchestrator can dispatch Task tools.\n" +
                      "Current context: subagent | Required context: orchestrator");
        process.exit(2);
    }

    const planContext = getExecutionPlanContext();
    if (planContext && taskId) {
        const { orchestration, groups } = planContext;
        const planSession = orchestration.session_id;

        if (planSession && sessionId && sessionId !== planSession) {
            console.error(`[Task Gate] Execution plan belongs to session '${planSession}', but this request is for session '${sessionId}'.`);
            process.exit(2);
        }

        const owningGroup = groups.find(group => {
            const taskIds = Array.isArray(group?.task_ids) ? group.task_ids : [];
            return taskIds.includes(taskId);
        });

        if (!owningGroup) {
            console.error(`[Task Gate] Task '${taskId}' is not part of the current execution plan.`);
            console.error("Update the execution plan or request access to the running group before invoking Task.");
            process.exit(2);
        }

        if ((owningGroup.status || '').toLowerCase() !== 'running') {
            console.error(`[Task Gate] Group '${owningGroup.group_id}' is in status '${owningGroup.status}'. Only running groups may dispatch tasks.`);
            process.exit(2);
        }

        const dependencies = Array.isArray(owningGroup.depends_on) ? owningGroup.depends_on : [];
        if (dependencies.length > 0) {
            const unresolved = dependencies.filter(depId => {
                const match = groups.find(group => group?.group_id === depId);
                if (!match) {
                    return true;
                }
                return (match.status || '').toLowerCase() !== 'completed';
            });

            if (unresolved.length > 0) {
                console.error(`[Task Gate] Dependencies still running: ${unresolved.join(', ')}`);
                process.exit(2);
            }
        }

        editState(state => {
            if (!state.metadata) state.metadata = {};
            if (!state.metadata.orchestration) state.metadata.orchestration = {};
            state.metadata.orchestration.active_group_id = owningGroup.group_id;
        });
    }
}
//!<

//!> Bash command handling
// For Bash commands, check if it's a read-only operation
if (toolName === "Bash" && STATE.mode === Mode.NO && !STATE.flags.bypass_mode) {
    // Special case: Allow sessions.api commands in discussion mode
    if (command && (command.includes('sessions ') || command.includes('python -m cc_sessions.scripts.api'))) {
        // API commands are allowed in discussion mode for state inspection and safe config operations
        process.exit(0);
    }

    if (!isBashReadOnly(command)) {
        // Detect OS for correct sessions command
        const isWindows = process.platform === "win32";
        const sessionsCmd = isWindows ? "sessions/bin/sessions.bat" : "sessions/bin/sessions";

        console.error(`[DAIC] Blocked write-like Bash command in Discussion mode. Only the user can activate orchestration mode. Explain what you want to do and seek alignment and approval first.\n` +
                      `Note: Both Claude and the user can configure allowed commands:\n` +
                      `  - View allowed: ${sessionsCmd} config read list\n` +
                      `  - Add command: ${sessionsCmd} config read add <command>\n` +
                      `  - Remove command: ${sessionsCmd} config read remove <command>`);
        process.exit(2);  // Block with feedback
    } else {
        process.exit(0);
    }
}
//!<

//!> Subagent Bash command orchestration protection (command parsing)
if (STATE.flags.subagent && toolName === "Bash" && command) {
    const bashTargets = [
        ...extractBashTargets(command),
        ...extractCommandWriteTargets(command)
    ];
    for (const target of new Set(bashTargets)) {
        const orchestrationPath = getOrchestrationFilePath(target);
        if (orchestrationPath) {
            blockSubagentOrchestrationWrite(orchestrationPath);
        }
    }
}
//!<

//!> Block any attempt to modify sessions-state.json directly
if (STATE.flags.subagent && filePath && toolName === "Bash" &&
    path.basename(filePath) === 'sessions-state.json' &&
    path.basename(path.dirname(filePath)) === 'sessions') {
    // Check if it's a modifying operation
    if (!isBashReadOnly(command)) {
        blockSubagentOrchestrationWrite(filePath);
    }
}
//!<

//!> Subagent orchestration state protection
if (STATE.flags.subagent && filePath) {
    const orchestrationPath = getOrchestrationFilePath(filePath);
    if (orchestrationPath) {
        if (toolName === "Bash" && !isBashReadOnly(command)) {
            blockSubagentOrchestrationWrite(orchestrationPath);
        }

        if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(toolName)) {
            blockSubagentOrchestrationWrite(orchestrationPath);
        }
    }
}
//!<

// --- All commands beyond here contain write patterns (read patterns exit early) ---

//!> Discussion mode guard (block write tools)
if (STATE.mode === Mode.NO && !STATE.flags.bypass_mode) {
    if (CONFIG.blocked_actions.isToolBlocked(toolName)) {
        console.error(`[DAIC: Tool Blocked] You're in discussion mode. The ${toolName} tool is not allowed. You need to seek alignment first.`);
        process.exit(2);  // Block with feedback
    } else {
        process.exit(0);  // Allow read-only tools
    }
}
//!<

//!> TodoWrite tool handling
if (toolName === "TodoWrite" && !STATE.flags.bypass_mode) {
    // Check for name mismatch first (regardless of completion state)
    if (STATE.todos.active && STATE.todos.active.length > 0) {
        const activeNames = STATE.todos.active.map(t => t.content);
        const incomingNames = incomingTodos.map(t => t.content || '');

        if (JSON.stringify(activeNames) !== JSON.stringify(incomingNames)) {
            // Todo names changed - safety violation
            // Prepare detailed diff for Claude before clearing state
            const originalCount = activeNames.length;
            const proposedCount = incomingNames.length;

            // Format original todos
            const originalDisplay = activeNames.map((name, i) => `  ${i+1}. ${name}`).join('\n');

            // Format proposed todos
            const proposedDisplay = incomingNames.map((name, i) => `  ${i+1}. ${name}`).join('\n');

            // Get user's implementation trigger phrases
            const triggerPhrases = CONFIG.trigger_phrases.orchestration_mode;
            const triggerList = triggerPhrases.map(p => `"${p}"`).join(', ');

            // Clear todos and revert to discussion mode (preparing for re-approval)
            editState(s => {
                s.todos.clearActive();
                s.mode = Mode.NO;
            });

            // Construct message directed at Claude with prescribed format
            const message = `[DAIC: Todo Change Blocked]

You attempted to modify the agreed-upon todo list without user approval.

ORIGINAL TODOS (${originalCount} items):
${originalDisplay}

PROPOSED TODOS (${proposedCount} items):
${proposedDisplay}

The original todos have been cleared and you have been returned to discussion mode.

YOUR NEXT MESSAGE MUST use this exact format:

---
[SHAME RITUAL]
I made a boo boo. I just tried to change the plan.

The todos you approved were:
${originalDisplay}

I tried to change them by [adding/removing/modifying] them:
[Show the changes - use + for added items, - for removed items, -> for modifications]

This [seems fine/is unimportant | was a violation of the execution boundary].

If you approve of the change, you can let me cook by saying: ${triggerList}

Or, feel free to yell at me or redirect me like I'm a 5 year old child.
---

After the user approves with a trigger phrase, you may re-submit the updated todo list using TodoWrite.`;

            console.error(message);
            process.exit(2);
        }
    }

    editState(s => {
        if (!s.todos.storeTodos(incomingTodos)) {
            console.error("[TodoWrite Error] Failed to store todos - check format");
            process.exit(2);
        }
    });
}
//!<

//!> TodoList modification guard
// Get the file path being edited
if (!filePath) {
    process.exit(0); // No file path, allow to proceed
}

// Block direct modification of state file via Write/Edit/MultiEdit for subagents
if (STATE.flags.subagent &&
    ["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(toolName) &&
    path.basename(filePath) === 'sessions-state.json' &&
    path.basename(path.dirname(filePath)) === 'sessions') {
    blockSubagentOrchestrationWrite(filePath);
}
//!<

//!> Git branch/task submodules enforcement
const expectedBranch = STATE.current_task?.branch;
if (!expectedBranch) {
    process.exit(0); // No branch/task info, allow to proceed
}

// Check if branch enforcement is enabled
if (!CONFIG.features.branch_enforcement) {
    process.exit(0); // Branch enforcement disabled, allow to proceed
}

const repoPath = findGitRepo(path.dirname(filePath));

if (repoPath) {
    if (BRANCH_DEBUG) {
        console.error(`[BranchDebug] repoPath=${repoPath}`);
    }
    try {
        const gitDetails = getGitBranchDetails(repoPath);
        if (!gitDetails) {
            console.error(`Warning: Could not verify branch for ${path.basename(repoPath)}.`);
            process.exit(0);
        }
        if (BRANCH_DEBUG) {
            console.error(`[BranchDebug] details=${JSON.stringify(gitDetails)}`);
        }

        const currentBranch = gitDetails.branch || null;
        const branchLabel = currentBranch ||
            (gitDetails.commit ? gitDetails.commit.slice(0, 7) : '(detached)');

        // Extract the submodule name from the repo path
        const submoduleName = path.basename(repoPath);

        // Check both conditions: branch status and task inclusion
        const branchCorrect = (currentBranch === expectedBranch);
        const inTask = (STATE.current_task.submodules && STATE.current_task.submodules.includes(submoduleName)) ||
                       (repoPath === PROJECT_ROOT); // Root repo - always considered in task

        // Scenario 1: Everything is correct - allow to proceed
        if (inTask && branchCorrect) {
            // Allow
        }
        // Scenario 2: Submodule is in task but on wrong branch
        else if (inTask && !branchCorrect) {
            console.error(`[Branch Mismatch] Submodule '${submoduleName}' is part of this task but is on branch '${branchLabel}' instead of '${expectedBranch}'.`);
            console.error(`Please run: cd ${path.relative(PROJECT_ROOT, repoPath)} && git checkout ${expectedBranch}`);
            process.exit(2);
        }
        // Scenario 3: Submodule not in task but already on correct branch
        else if (!inTask && branchCorrect) {
            console.error(`[Submodule Not in Task] Submodule '${submoduleName}' is on the correct branch '${expectedBranch}' but is not listed in the task file.`);
            console.error(`Please update the task file to include '${submoduleName}' in the submodules list.`);
            process.exit(2);
        }
        // Scenario 4: Submodule not in task AND on wrong branch
        else {
            console.error(`[Submodule Not in Task + Wrong Branch] Submodule '${submoduleName}' has two issues:`);
            console.error(`  1. Not listed in the task file's submodules`);
            console.error(`  2. On branch '${branchLabel}' instead of '${expectedBranch}'`);
            console.error(`To fix: cd ${path.relative(PROJECT_ROOT, repoPath)} && git checkout -b ${expectedBranch}`);
            console.error(`Then update the task file to include '${submoduleName}' in the submodules list.`);
            process.exit(2);
        }
    } catch (error) {
        // Can't check branch, allow to proceed but warn
        console.error(`Warning: Could not verify branch for ${path.basename(repoPath)}: ${error.message}`);
    }
}
//!<

//-//

// Allow tool to proceed
return 0;

}, { tool: toolName, input_size: inputSize });

process.exit(exitCode);
