const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const {
    loadState,
    editState,
    loadConfig,
    Mode,
    Model,
    IconStyle,
    PROJECT_ROOT,
} = require('../shared_state.js');
const { getCodexTasks, formatCodexTasks } = require('./codex_tasks.js');
const { readTranscriptTail } = require('../transcript_utils.js');
const { createTimer } = require('../benchmark_utils.js');

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

// ===== CACHING ===== //
const cache = {
    git: { timestamp: 0, cwd: null, data: null },
    transcript: { path: null, mtime: 0, contextLength: null },
    tasks: { timestamp: 0, count: 0 }
};

const CACHE_TTL = {
    git: 2000,      // 2 seconds - git status doesn't change often
    tasks: 5000,    // 5 seconds - task list changes infrequently
};
// transcript uses mtime, no TTL needed

function supportsAnsi() {
    if (process.platform === 'win32') {
        if (process.env.WT_SESSION) {
            return true;
        }
        const pwsh = process.env.POWERSHELL_DISTRIBUTION_CHANNEL;
        if (pwsh && pwsh.includes('PSCore')) {
            return true;
        }
        try {
            const release = os.release();
            const major = parseInt(release.split('.')[0], 10);
            if (!Number.isNaN(major) && major >= 10) {
                return true;
            }
        } catch {
            return false;
        }
        return false;
    }
    return true;
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
    // Check cache first
    const now = Date.now();
    if (cache.git.data &&
        cache.git.cwd === cwd &&
        (now - cache.git.timestamp) < CACHE_TTL.git) {
        return cache.git.data;
    }

    const result = {
        branch: null,
        detached: false,
        commit: null,
        upstream: null,
        ahead: 0,
        behind: 0,
        staged: 0,
        unstaged: 0,
    };

    try {
        const escapedCwd = cwd.replace(/"/g, '\\"');
        const output = execSync(`git -C "${escapedCwd}" status --porcelain=2 --branch`, {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
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
                result.staged += 1;
                result.unstaged += 1;
            } else if (line.startsWith('? ')) {
                result.unstaged += 1;
            }
        }

        // Update cache before returning
        cache.git = {
            timestamp: now,
            cwd,
            data: result
        };
    } catch {
        return null;
    }

    return result;
}

function findCurrentTranscript(transcriptPath, sessionId, staleThreshold = 30) {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
        return transcriptPath;
    }

    try {
        const tailContent = readTranscriptTail(transcriptPath, 131072);
        const lines = tailContent.split('\n').filter(line => line.trim());
        if (!lines.length) {
            return transcriptPath;
        }

        const lastLine = lines[lines.length - 1];
        const lastMsg = JSON.parse(lastLine);
        const lastTimestamp = lastMsg.timestamp;
        if (!lastTimestamp) {
            return transcriptPath;
        }

        const lastTime = new Date(lastTimestamp);
        const currentTime = new Date();
        const ageSeconds = (currentTime - lastTime) / 1000;
        if (ageSeconds <= staleThreshold) {
            return transcriptPath;
        }

        const transcriptDir = path.dirname(transcriptPath);
        const allFiles = fs
            .readdirSync(transcriptDir)
            .filter(f => f.endsWith('.jsonl'))
            .map(f => path.join(transcriptDir, f))
            .sort((a, b) => fs.statSync(b).mtime - fs.statSync(a).mtime)
            .slice(0, 5);

        for (const candidate of allFiles) {
            try {
                const candidateTail = readTranscriptTail(candidate, 131072);
                const candidateLines = candidateTail.split('\n').filter(line => line.trim());
                if (!candidateLines.length) {
                    continue;
                }
                const candidateLast = JSON.parse(candidateLines[candidateLines.length - 1]);
                const candidateSessionId = candidateLast.sessionId;
                if (candidateSessionId === sessionId) {
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
        return transcriptPath;
    } catch {
        return transcriptPath;
    }
}

function renderStatusline(payload = {}) {
    const timer = createTimer('statusline');
    timer.mark('start');

    const { cwd = '.', model, session_id: sessionId, transcript_path: transcriptPath } = payload;

    // Set CLAUDE_PROJECT_DIR for codex-delegate project-scoped database detection
    if (cwd && cwd !== '.') {
        process.env.CLAUDE_PROJECT_DIR = cwd;
    }

    timer.mark('load_state_start');
    const state = loadState() || {};
    const config = loadConfig() || {};
    timer.mark('load_state_end');
    timer.measure('load_state', 'load_state_start', 'load_state_end');

    const iconStyle = config?.features?.icon_style || IconStyle.NERD_FONTS;
    const taskDir = path.join(PROJECT_ROOT, 'sessions', 'tasks');

    const ansiSupported = supportsAnsi();
    const colors = ansiSupported
        ? {
              green: '\u001b[38;5;114m',
              orange: '\u001b[38;5;215m',
              red: '\u001b[38;5;203m',
              gray: '\u001b[38;5;242m',
              lGray: '\u001b[38;5;250m',
              cyan: '\u001b[38;5;111m',
              purple: '\u001b[38;5;183m',
              reset: '\u001b[0m',
          }
        : {
              green: '',
              orange: '',
              red: '',
              gray: '',
              lGray: '',
              cyan: '',
              purple: '',
              reset: '',
          };

    const modelName = typeof model === 'string' ? model : (model?.display_name || model?.name || 'unknown');
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

    if (!state || state.model !== currModel) {
        editState(s => {
            s.model = currModel;
        });
        if (state) {
            state.model = currModel;
        }
    }

    let currentTranscriptPath = transcriptPath;
    if (transcriptPath) {
        currentTranscriptPath = findCurrentTranscript(transcriptPath, sessionId || '');
    }

    let contextLength = null;
    if (currentTranscriptPath && fs.existsSync(currentTranscriptPath)) {
        try {
            // Check cache based on file modification time
            const stat = fs.statSync(currentTranscriptPath);
            if (cache.transcript.path === currentTranscriptPath &&
                cache.transcript.mtime === stat.mtimeMs &&
                cache.transcript.contextLength !== null) {
                contextLength = cache.transcript.contextLength;
            } else {
                // Parse transcript
                const tailContent = readTranscriptTail(currentTranscriptPath, 131072);
                const lines = tailContent.split('\n');
                let mostRecentUsage = null;
                let mostRecentTimestamp = null;
                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const lineData = JSON.parse(line);
                        if (lineData.isSidechain) continue;
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
                if (mostRecentUsage) {
                    contextLength =
                        (mostRecentUsage.input_tokens || 0) +
                        (mostRecentUsage.cache_read_input_tokens || 0) +
                        (mostRecentUsage.cache_creation_input_tokens || 0);
                }

                // Update cache
                cache.transcript = {
                    path: currentTranscriptPath,
                    mtime: stat.mtimeMs,
                    contextLength
                };
            }
        } catch {
            // ignore transcript errors
        }
    }

    if (contextLength && contextLength < 17000) {
        contextLength = 17000;
    }

    let progressPctInt = 0;
    let progressPct = '0.0';
    if (contextLength && contextLimit) {
        const pct = (contextLength * 100) / contextLimit;
        progressPct = pct.toFixed(1);
        progressPctInt = Math.floor(pct);
        if (progressPctInt > 100) {
            progressPct = '100.0';
            progressPctInt = 100;
        }
    }

    const formattedTokens = contextLength ? `${Math.floor(contextLength / 1000)}k` : '17k';
    const formattedLimit = `${Math.floor(contextLimit / 1000)}k`;
    const filledBlocks = Math.min(Math.floor(progressPctInt / 10), 10);
    const emptyBlocks = 10 - filledBlocks;

    let barColor = colors.green;
    if (progressPctInt >= 80) {
        barColor = colors.red;
    } else if (progressPctInt >= 50) {
        barColor = colors.orange;
    }

    let contextIcon = '';
    if (iconStyle === IconStyle.NERD_FONTS) {
        contextIcon = '󰋼';
    } else if (iconStyle === IconStyle.EMOJI) {
        contextIcon = '🧠';
    }

    const progressBar =
        `${colors.reset}${colors.lGray}${contextIcon ? `${contextIcon} ` : ''}` +
        barColor +
        '█'.repeat(filledBlocks) +
        colors.gray +
        '░'.repeat(emptyBlocks) +
        colors.reset +
        ` ${colors.lGray}${progressPct}% (${formattedTokens}/${formattedLimit})${colors.reset}`;

    timer.mark('git_start');
    const gitPath = findGitRepo(path.resolve(cwd));
    let gitBranchInfo = null;
    let upstreamInfo = null;
    let totalEdited = 0;
    let cacheHit = false;
    if (gitPath) {
        const gitInfo = getGitStatusInfo(cwd);
        cacheHit = cache.git.data && cache.git.cwd === cwd;
        timer.mark('git_end');
        timer.measure('git_operations', 'git_start', 'git_end', { cache_hit: cacheHit });
        if (gitInfo) {
            totalEdited = gitInfo.staged + gitInfo.unstaged;
            if (gitInfo.branch) {
                let branchIcon;
                if (iconStyle === IconStyle.NERD_FONTS) {
                    branchIcon = '󰘬 ';
                } else if (iconStyle === IconStyle.EMOJI) {
                    branchIcon = 'Branch: ';
                } else {
                    branchIcon = 'Branch: ';
                }
                gitBranchInfo = `${colors.lGray}${branchIcon}${gitInfo.branch}${colors.reset}`;
            } else if (gitInfo.detached && gitInfo.commit) {
                if (iconStyle === IconStyle.NERD_FONTS) {
                    gitBranchInfo = `${colors.lGray}󰌺 @${gitInfo.commit.slice(0, 7)}${colors.reset}`;
                } else {
                    gitBranchInfo = `${colors.lGray}@${gitInfo.commit.slice(0, 7)} [detached]${colors.reset}`;
                }
            }
            if (gitInfo.ahead > 0 || gitInfo.behind > 0) {
                const parts = [];
                if (gitInfo.ahead > 0) parts.push(`↑${gitInfo.ahead}`);
                if (gitInfo.behind > 0) parts.push(`↓${gitInfo.behind}`);
                upstreamInfo = `${colors.orange}${parts.join('')}${colors.reset}`;
            }
        }
    }

    // Backlog statistics (prioritize over sessions task)
    const backlogStats = getBacklogStats(cwd);

    const currTask = state?.current_task?.name || null;
    const currMode = state?.mode === Mode.GO ? 'Orchestration' : 'Discussion';

    const contextPart = progressBar || `${colors.gray}No context usage data${colors.reset}`;
    let taskIcon;
    if (iconStyle === IconStyle.NERD_FONTS) {
        taskIcon = '󰒓 ';
    } else if (iconStyle === IconStyle.EMOJI) {
        taskIcon = '⚙️ ';
    } else {
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
        taskPart = `${colors.cyan}${taskIcon}${statsText}${colors.reset}`;
    } else if (currTask) {
        // Fallback to sessions task
        taskPart = `${colors.cyan}${taskIcon}${currTask}${colors.reset}`;
    } else {
        taskPart = `${colors.cyan}${taskIcon}${colors.gray}No Tasks${colors.reset}`;
    }

    const line1 = `${contextPart} | ${taskPart}`;

    const uncommittedParts = [`${colors.orange}✎ ${totalEdited}${colors.reset}`];
    if (upstreamInfo) {
        uncommittedParts.push(upstreamInfo);
    }
    const uncommittedStr = uncommittedParts.join(' ');

    let modeIcon;
    if (iconStyle === IconStyle.NERD_FONTS) {
        modeIcon = state?.mode === Mode.GO ? '󰷫 ' : '󰭹 ';
    } else if (iconStyle === IconStyle.EMOJI) {
        modeIcon = state?.mode === Mode.GO ? '🛠️ ' : '💬 ';
    } else {
        modeIcon = 'Mode: ';
    }

    let tasksIcon;
    if (iconStyle === IconStyle.NERD_FONTS) {
        tasksIcon = '󰈙 ';
    } else if (iconStyle === IconStyle.EMOJI) {
        tasksIcon = '💼 ';
    } else {
        tasksIcon = '';
    }

    let openTasks = 0;

    // Check cache first
    const now = Date.now();
    if (cache.tasks.count !== null &&
        (now - cache.tasks.timestamp) < CACHE_TTL.tasks) {
        openTasks = cache.tasks.count;
    } else {
        // Scan directory
        let openTaskCount = 0;
        let openTaskDirCount = 0;
        try {
            if (fs.existsSync(taskDir) && fs.statSync(taskDir).isDirectory()) {
                const items = fs.readdirSync(taskDir);
                for (const item of items) {
                    const itemPath = path.join(taskDir, item);
                    const stat = fs.statSync(itemPath);
                    if (stat.isFile() && item !== 'TEMPLATE.md' && item.endsWith('.md')) {
                        openTaskCount += 1;
                    }
                    if (stat.isDirectory() && item !== 'done' && item !== 'indexes') {
                        openTaskDirCount += 1;
                    }
                }
            }
        } catch {
            // ignore task scan errors
        }

        openTasks = openTaskCount + openTaskDirCount;

        // Update cache
        cache.tasks = {
            timestamp: now,
            count: openTasks
        };
    }
    const line2Parts = [
        `${colors.purple}${modeIcon}${currMode}${colors.reset}`.trim(),
        uncommittedStr,
        `${colors.cyan}${tasksIcon}${openTasks} open${colors.reset}`.trim(),
    ];
    if (gitBranchInfo) {
        line2Parts.push(gitBranchInfo);
    }

    let codexLine = '';
    try {
        const codexSummary = formatCodexTasks(getCodexTasks(), { iconStyle });
        if (codexSummary) {
            codexLine = codexSummary;
        }
    } catch {
        // Codex integration is best-effort
    }

    const line2 = line2Parts.filter(Boolean).join(' | ');

    timer.mark('end');
    timer.measure('total', 'start', 'end', {
        cache_hit_git: cache.git.data && cache.git.cwd === cwd,
        cache_hit_transcript: cache.transcript.path === currentTranscriptPath,
        cache_hit_tasks: (now - cache.tasks.timestamp) < CACHE_TTL.tasks
    });

    if (codexLine) {
        return `${line1}\n${line2}\n${codexLine}\n`;
    }
    return `${line1}\n${line2}\n`;
}

module.exports = { renderStatusline };
