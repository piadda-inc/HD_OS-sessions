#!/usr/bin/env node

// Windows UTF-8 stdout fix
// Windows uses cp1252 by default, which can't encode Unicode block characters (█, ░)
// Force UTF-8 encoding for stdout to prevent encoding errors
if (process.platform === 'win32') {
    process.stdout.setDefaultEncoding('utf8');
}

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { getCodexTasks, formatCodexTasks } = require('./daemon/codex_tasks.js');
const { loadState, editState, loadConfig, Mode, Model, IconStyle, PROJECT_ROOT } = require('./shared_state.js');

/**
 * Count backlog tasks by status
 * Returns { todo: N, in_progress: N, done: N, total: N }
 */
function getBacklogStats(cwd) {
    const backlogPath = path.join(cwd, 'backlog', 'tasks');

    if (!fs.existsSync(backlogPath)) {
        return null;
    }

    const stats = { todo: 0, in_progress: 0, done: 0, total: 0 };

    try {
        const files = fs.readdirSync(backlogPath).filter(f => f.endsWith('.md'));

        for (const file of files) {
            const filePath = path.join(backlogPath, file);
            const content = fs.readFileSync(filePath, 'utf-8');

            // Parse YAML frontmatter
            const match = content.match(/^---\n([\s\S]*?)\n---/);
            if (match) {
                const frontmatter = match[1];
                const statusMatch = frontmatter.match(/status:\s*["']?([^"'\n]+)["']?/i);

                if (statusMatch) {
                    const status = statusMatch[1].trim().toLowerCase();
                    stats.total++;

                    if (status === 'to do' || status === 'todo' || status === 'pending') {
                        stats.todo++;
                    } else if (status === 'in progress' || status === 'in-progress' || status === 'inprogress') {
                        stats.in_progress++;
                    } else if (status === 'done' || status === 'completed') {
                        stats.done++;
                    }
                }
            }
        }

        return stats;
    } catch (err) {
        return null;
    }
}

// ANSI color detection for Windows
function supportsAnsi() {
    /**
     * Check if the current environment supports ANSI color codes.
     * @returns {boolean} True if ANSI is supported
     */
    // Windows detection
    if (process.platform === 'win32') {
        // Windows Terminal and PowerShell 7+ support ANSI
        const wtSession = process.env.WT_SESSION;
        const pwshVersion = process.env.POWERSHELL_DISTRIBUTION_CHANNEL;

        // Windows Terminal always supports ANSI
        if (wtSession) {
            return true;
        }

        // PowerShell 7+ supports ANSI
        if (pwshVersion && pwshVersion.includes('PSCore')) {
            return true;
        }

        // Windows 10+ with VT100 support
        // Try to enable it, if it fails, no ANSI support
        try {
            // On Windows 10+, ANSI is typically supported
            const winVer = require('os').release();
            const majorVer = parseInt(winVer.split('.')[0]);
            if (majorVer >= 10) {
                // Windows 10+ has built-in ANSI support
                return true;
            }
        } catch {
            // Fall through to return false
        }

        // Fallback: no ANSI support on old Windows
        return false;
    }

    // Unix-like systems support ANSI
    return true;
}

// Determine if ANSI is supported
const ansiSupported = supportsAnsi();

// Colors/styles - conditional based on ANSI support
let green, orange, red, gray, lGray, cyan, purple, reset;
if (ansiSupported) {
    green = '\033[38;5;114m';
    orange = '\033[38;5;215m';
    red = '\033[38;5;203m';
    gray = '\033[38;5;242m';
    lGray = '\033[38;5;250m';
    cyan = '\033[38;5;111m';
    purple = '\033[38;5;183m';
    reset = '\033[0m';
} else {
    // No color support - use empty strings
    green = orange = red = gray = lGray = cyan = purple = reset = '';
}

function findGitRepo(startPath) {
    let current = startPath;
    while (current !== path.dirname(current)) {
        const gitPath = path.join(current, '.git');
        if (fs.existsSync(gitPath)) {
            return gitPath;
        }
        current = path.dirname(current);
    }
    return null;
}

function getGitStatusInfo(cwd) {
    /**
     * Return branch, upstream, ahead/behind counts, and staged/unstaged counts
     * using a single porcelain status call to keep the hook fast.
     */
    const result = {
        branch: null,
        detached: false,
        commit: null,
        upstream: null,
        ahead: 0,
        behind: 0,
        staged: 0,
        unstaged: 0
    };

    try {
        const escapedCwd = cwd.replace(/"/g, '\\"');
        const output = execSync(
            `git -C "${escapedCwd}" status --porcelain=2 --branch`,
            { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
        );

        const lines = output.split('\n');
        for (const rawLine of lines) {
            if (!rawLine) continue;
            const line = rawLine.trimEnd();

            if (line.startsWith('# branch.head ')) {
                const head = line.slice('# branch.head '.length).trim();
                if (head && head !== '(detached)') {
                    result.branch = head;
                } else {
                    result.detached = true;
                }
            } else if (line.startsWith('# branch.upstream ')) {
                result.upstream = line.slice('# branch.upstream '.length).trim();
            } else if (line.startsWith('# branch.ab ')) {
                // Format: "# branch.ab +A -B"
                const parts = line.slice('# branch.ab '.length).trim().split(/\s+/);
                for (const part of parts) {
                    if (part.startsWith('+')) {
                        result.ahead = parseInt(part.slice(1), 10) || 0;
                    } else if (part.startsWith('-')) {
                        result.behind = parseInt(part.slice(1), 10) || 0;
                    }
                }
            } else if (line.startsWith('# branch.oid ')) {
                result.commit = line.slice('# branch.oid '.length).trim();
            } else if (line[0] === '1' || line[0] === '2') {
                // Tracked file entry: "1 XY ..." or "2 XY ..."
                const parts = line.split(' ');
                if (parts.length > 1) {
                    const status = parts[1];
                    const stagedCode = status[0];
                    const worktreeCode = status[1];
                    if (stagedCode && stagedCode !== '.') {
                        result.staged += 1;
                    }
                    if (worktreeCode && worktreeCode !== '.') {
                        result.unstaged += 1;
                    }
                }
            } else if (line.startsWith('u ')) {
                // Unmerged paths affect both sides
                result.staged += 1;
                result.unstaged += 1;
            } else if (line.startsWith('? ')) {
                // Untracked file in worktree
                result.unstaged += 1;
            }
        }

        return result;
    } catch {
        return null;
    }
}

function findCurrentTranscript(transcriptPath, sessionId, staleThreshold = 30) {
    /**
     * Detect stale transcripts and find the current one by session ID.
     *
     * @param {string} transcriptPath - Path to the transcript file we received
     * @param {string} sessionId - Current session ID to match
     * @param {number} staleThreshold - Seconds threshold for considering transcript stale
     * @returns {string} Path to the current transcript (may be same as input if not stale)
     */
    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
        return transcriptPath;
    }

    try {
        // Read last line of transcript to get last message timestamp
        const lines = fs.readFileSync(transcriptPath, 'utf-8').split('\n').filter(line => line.trim());
        if (!lines.length) {
            return transcriptPath;
        }

        const lastLine = lines[lines.length - 1];
        const lastMsg = JSON.parse(lastLine);
        const lastTimestamp = lastMsg.timestamp;

        if (!lastTimestamp) {
            return transcriptPath;
        }

        // Parse ISO timestamp and compare to current time
        const lastTime = new Date(lastTimestamp);
        const currentTime = new Date();
        const ageSeconds = (currentTime - lastTime) / 1000;

        // If transcript is fresh, return it
        if (ageSeconds <= staleThreshold) {
            return transcriptPath;
        }

        // Transcript is stale - search for current one
        const transcriptDir = path.dirname(transcriptPath);
        const allFiles = fs.readdirSync(transcriptDir)
            .filter(f => f.endsWith('.jsonl'))
            .map(f => path.join(transcriptDir, f))
            .sort((a, b) => fs.statSync(b).mtime - fs.statSync(a).mtime)
            .slice(0, 5);  // Top 5 most recent

        // Check each transcript for matching session ID
        for (const candidate of allFiles) {
            try {
                const candidateLines = fs.readFileSync(candidate, 'utf-8').split('\n').filter(line => line.trim());
                if (!candidateLines.length) {
                    continue;
                }

                // Check last line for session ID
                const candidateLast = JSON.parse(candidateLines[candidateLines.length - 1]);
                const candidateSessionId = candidateLast.sessionId;

                if (candidateSessionId === sessionId) {
                    // Verify this transcript is fresh
                    const candidateTimestamp = candidateLast.timestamp;
                    if (candidateTimestamp) {
                        const candidateTime = new Date(candidateTimestamp);
                        const candidateAge = (currentTime - candidateTime) / 1000;

                        if (candidateAge <= staleThreshold) {
                            return candidate;
                        }
                    }
                }
            } catch {
                continue;
            }
        }

        // No fresh transcript found, return original
        return transcriptPath;
    } catch {
        // Any error, return original path
        return transcriptPath;
    }
}

function main() {
    // Read JSON input from stdin
    let inputData = '';
    try {
        inputData = fs.readFileSync(0, 'utf-8');
    } catch {
        // No stdin, use defaults
        inputData = '{}';
    }

    let data = {};
    try {
        data = JSON.parse(inputData);
    } catch {
        data = {};
    }

    const cwd = data.cwd || '.';
    const modelName = data.model?.display_name || 'unknown';
    const sessionId = data.session_id || 'unknown';
    const transcriptPath = data.transcript_path || null;

    const taskDir = path.join(PROJECT_ROOT, 'sessions', 'tasks');

    // Determine model and context limit
    let currModel = Model.UNKNOWN;
    let contextLimit = 160000;

    if (modelName.toLowerCase().includes('[1m]')) {
        contextLimit = 800000;
    }
    if (modelName.toLowerCase().includes('sonnet')) {
        currModel = Model.SONNET;
    } else if (modelName.toLowerCase().includes('opus')) {
        currModel = Model.OPUS;
    }

    // Update model in shared state
    const state = loadState();
    if (!state || state.model !== currModel) {
        editState(s => {
            s.model = currModel;
        });
    }

    // Load config for icon style preference
    const config = loadConfig();
    const iconStyle = config?.features?.icon_style || IconStyle.NERD_FONTS;

    // Pull context length from transcript
    let contextLength = null;

    // Detect and recover from stale transcript
    let currentTranscriptPath = transcriptPath;
    if (transcriptPath) {
        currentTranscriptPath = findCurrentTranscript(transcriptPath, sessionId);
    }

    if (currentTranscriptPath && fs.existsSync(currentTranscriptPath)) {
        try {
            const lines = fs.readFileSync(currentTranscriptPath, 'utf-8').split('\n');
            let mostRecentUsage = null;
            let mostRecentTimestamp = null;

            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const lineData = JSON.parse(line);
                    // Skip sidechain entries (subagent calls)
                    if (lineData.isSidechain) continue;

                    // Check for usage data in main-chain messages
                    if (lineData.message?.usage) {
                        const timestamp = lineData.timestamp;
                        if (timestamp && (!mostRecentTimestamp || timestamp > mostRecentTimestamp)) {
                            mostRecentTimestamp = timestamp;
                            mostRecentUsage = lineData.message.usage;
                        }
                    }
                } catch {
                    continue;
                }
            }

            // Calculate context length (input + cache tokens only, NOT output)
            if (mostRecentUsage) {
                contextLength = (mostRecentUsage.input_tokens || 0) +
                               (mostRecentUsage.cache_read_input_tokens || 0) +
                               (mostRecentUsage.cache_creation_input_tokens || 0);
            }
        } catch {
            // Ignore errors
        }
    }

    // Use context_length and context_limit to calculate context percentage
    if (contextLength && contextLength < 17000) {
        contextLength = 17000;
    }

    let progressPct = '0.0';
    let progressPctInt = 0;

    if (contextLength && contextLimit) {
        const pct = (contextLength * 100) / contextLimit;
        progressPct = pct.toFixed(1);
        progressPctInt = Math.floor(pct);
        if (progressPctInt > 100) {
            progressPct = '100.0';
            progressPctInt = 100;
        }
    }

    // Format token counts in 'k'
    const formattedTokens = contextLength ? `${Math.floor(contextLength / 1000)}k` : '17k';
    const formattedLimit = contextLimit ? `${Math.floor(contextLimit / 1000)}k` : '160k';

    // Progress bar blocks (0-10)
    const filledBlocks = Math.min(Math.floor(progressPctInt / 10), 10);
    const emptyBlocks = 10 - filledBlocks;

    // Choose color based on percentage
    let barColor = green;
    if (progressPctInt >= 80) {
        barColor = red;
    } else if (progressPctInt >= 50) {
        barColor = orange;
    }

    // Build progress bar string
    let contextIcon = '';
    if (iconStyle === IconStyle.NERD_FONTS) {
        contextIcon = '󱃖 ';
    } else if (iconStyle === IconStyle.EMOJI) {
        contextIcon = '';
    } else {  // ASCII
        contextIcon = '';
    }
    const progressBar =
        `${reset}${lGray}${contextIcon} ` +
        barColor + '█'.repeat(filledBlocks) +
        gray + '░'.repeat(emptyBlocks) +
        reset + ` ${lGray}${progressPct}% (${formattedTokens}/${formattedLimit})${reset}`;

    // Find git repository path and collect status info with a single command
    const gitPath = findGitRepo(path.resolve(cwd));
    let gitBranchInfo = null;
    let upstreamInfo = null;
    let totalEdited = 0;

    if (gitPath) {
        const gitInfo = getGitStatusInfo(cwd);
        if (gitInfo) {
            totalEdited = gitInfo.staged + gitInfo.unstaged;

            if (gitInfo.branch) {
                let branchIcon;
                if (iconStyle === IconStyle.NERD_FONTS) {
                    branchIcon = '󰘬 ';
                } else if (iconStyle === IconStyle.EMOJI) {
                    branchIcon = 'Branch: ';
                } else {  // ASCII
                    branchIcon = 'Branch: ';
                }
                gitBranchInfo = `${lGray}${branchIcon}${gitInfo.branch}${reset}`;
            } else if (gitInfo.detached && gitInfo.commit) {
                if (iconStyle === IconStyle.NERD_FONTS) {
                    gitBranchInfo = `${lGray}󰌺 @${gitInfo.commit.slice(0, 7)}${reset}`;
                } else {
                    gitBranchInfo = `${lGray}@${gitInfo.commit.slice(0, 7)} [detached]${reset}`;
                }
            }

            if (gitInfo.ahead > 0 || gitInfo.behind > 0) {
                const upstreamParts = [];
                if (gitInfo.ahead > 0) upstreamParts.push(`↑${gitInfo.ahead}`);
                if (gitInfo.behind > 0) upstreamParts.push(`↓${gitInfo.behind}`);
                upstreamInfo = `${orange}${upstreamParts.join('')}${reset}`;
            }
        }
    }

    // Backlog statistics (prioritize over sessions task)
    const backlogStats = getBacklogStats(cwd);

    // Current task (fallback if no backlog)
    const currTask = state?.current_task?.name || null;

    // Current mode
    const currMode = state?.mode === Mode.GO ? 'Orchestration' : 'Discussion';
    let modeIcon;
    if (iconStyle === IconStyle.NERD_FONTS) {
        modeIcon = state?.mode === Mode.GO ? '󰷫 ' : '󰭹 ';
    } else if (iconStyle === IconStyle.EMOJI) {
        modeIcon = state?.mode === Mode.GO ? '🛠️: ' : '💬:';
    } else {  // ASCII
        modeIcon = 'Mode:';
    }

    // Count open tasks
    let openTaskCount = 0;
    let openTaskDirCount = 0;

    if (fs.existsSync(taskDir) && fs.statSync(taskDir).isDirectory()) {
        const items = fs.readdirSync(taskDir);
        for (const item of items) {
            const itemPath = path.join(taskDir, item);
            const stat = fs.statSync(itemPath);
            if (stat.isFile() && item !== 'TEMPLATE.md' && item.endsWith('.md')) {
                openTaskCount++;
            }
            if (stat.isDirectory() && item !== 'done' && item !== 'indexes') {
                openTaskDirCount++;
            }
        }
    }

    // Final output
    // Line 1 - Progress bar | Task
    const contextPart = progressBar || `${gray}No context usage data${reset}`;
    let taskIcon;
    if (iconStyle === IconStyle.NERD_FONTS) {
        taskIcon = '󰒓 ';
    } else if (iconStyle === IconStyle.EMOJI) {
        taskIcon = '⚙️ ';
    } else {  // ASCII
        taskIcon = 'Task: ';
    }
    let taskPart;
    if (backlogStats && backlogStats.total > 0) {
        // Show backlog stats: "📋 3 todo | 2 active | 5 done"
        const parts = [];
        if (backlogStats.todo > 0) parts.push(`${backlogStats.todo} todo`);
        if (backlogStats.in_progress > 0) parts.push(`${backlogStats.in_progress} active`);
        if (backlogStats.done > 0) parts.push(`${backlogStats.done} done`);

        const statsText = parts.length > 0 ? parts.join(' | ') : `${backlogStats.total} tasks`;
        taskPart = `${cyan}${taskIcon}${statsText}${reset}`;
    } else if (currTask) {
        // Fallback to sessions task
        taskPart = `${cyan}${taskIcon}${currTask}${reset}`;
    } else {
        taskPart = `${cyan}${taskIcon}${gray}No Tasks${reset}`;
    }
    console.log(contextPart + ' | ' + taskPart);

    // Line 2 - Mode | Edited & Uncommitted with upstream | Open Tasks | Git branch
    let tasksIcon;
    if (iconStyle === IconStyle.NERD_FONTS) {
        tasksIcon = '󰈙 ';
    } else if (iconStyle === IconStyle.EMOJI) {
        tasksIcon = '💼 ';
    } else {  // ASCII
        tasksIcon = '';
    }
    // Build uncommitted section with optional upstream indicators
    const uncommittedParts = [`${orange}✎ ${totalEdited}${reset}`];
    if (upstreamInfo) {
        uncommittedParts.push(upstreamInfo);
    }
    const uncommittedStr = uncommittedParts.join(' ');

    const line2Parts = [
        `${purple}${modeIcon}${currMode}${reset}`,
        uncommittedStr,
        `${cyan}${tasksIcon}${openTaskCount + openTaskDirCount} open${reset}`
    ];
    if (gitBranchInfo) {
        line2Parts.push(gitBranchInfo);
    }
    console.log(line2Parts.join(' | '));

    try {
        const codexSummary = formatCodexTasks(getCodexTasks(), { iconStyle });
        if (codexSummary) {
            console.log(codexSummary);
        }
    } catch {
        // Codex agent display is best-effort
    }
}

if (require.main === module) {
    main();
}
