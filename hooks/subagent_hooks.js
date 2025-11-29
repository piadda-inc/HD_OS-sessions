#!/usr/bin/env node

// ===== IMPORTS ===== //

/// ===== STDLIB ===== ///
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
///-///

/// ===== 3RD-PARTY ===== ///
///-///

/// ===== LOCAL ===== ///
const { editState, loadState, PROJECT_ROOT } = require('./shared_state.js');
const {
    ensureTranscriptInfrastructure,
    resolveTranscriptTarget,
    withTranscriptLock,
    readTranscriptTail
} = require('./transcript_utils.js');
///-///

//-//

// ===== FUNCTIONS ===== //

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
        // Read a bounded tail of the transcript to get recent entries
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
                const candidateTail = readTranscriptTail(candidate, 131072);
                const candidateLines = candidateTail.split('\n').filter(line => line.trim());
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

const PYTHON_BIN = process.env.CC_PYTHON || 'python3';
const DEFAULT_STATE_DIR = path.join(PROJECT_ROOT, 'sessions', 'state');
const DEFAULT_TASKS_DIR = path.join(PROJECT_ROOT, 'backlog', 'tasks');

function loadTranscriptEntries(transcriptPath) {
    /**
     * Read transcript JSONL entries into memory.
     *
     * @param {string} transcriptPath - Path to transcript jsonl file
     * @returns {Array} Parsed transcript entries
     */
    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
        return [];
    }
    const entries = [];
    try {
        const lines = fs.readFileSync(transcriptPath, 'utf-8').split('\n');
        for (const line of lines) {
            if (!line.trim()) {
                continue;
            }
            try {
                entries.push(JSON.parse(line));
            } catch (error) {
                console.error(`[Subagent] Failed to parse transcript line: ${error.message}`);
            }
        }
    } catch (error) {
        console.error(`[Subagent] Unable to read transcript: ${error.message}`);
    }
    return entries;
}

function findLastTaskInvocation(transcriptEntries) {
    /**
     * Locate the most recent Task tool invocation within transcript entries.
     *
     * @param {Array} transcriptEntries - Parsed transcript entries
     * @returns {{ input: object, subagentType: string } | null}
     */
    for (let idx = transcriptEntries.length - 1; idx >= 0; idx -= 1) {
        const entry = transcriptEntries[idx];
        const message = entry && entry.message;
        if (!message || !Array.isArray(message.content)) {
            continue;
        }
        for (const block of message.content) {
            if (block && block.type === 'tool_use' && block.name === 'Task') {
                const input = block.input || {};
                const subagentType = input.subagent_type || 'shared';
                return { input, subagentType };
            }
        }
    }
    return null;
}

function normalizeExitStatus(status) {
    /**
     * Normalize exit status text for downstream processing.
     *
     * @param {string | undefined} status - Raw status text
     * @returns {string} Lowercase normalized status
     */
    if (!status) {
        return 'completed';
    }
    const value = String(status).trim().toLowerCase();
    return value || 'completed';
}

function emitPlanSignal(payload, context) {
    /**
     * Persist execute_plan signal metadata into the shared state file.
     *
     * @param {object} payload - Parsed backlog bridge payload
     * @param {object} context - Metadata about the originating event
     */
    const signal = payload && payload.signal ? payload.signal : null;
    const timestamp = new Date().toISOString();
    try {
        editState(state => {
            const metadata = state.metadata || {};
            const orchestration = { ...(metadata.orchestration || {}) };
            orchestration.last_signal = signal;
            orchestration.last_signal_at = timestamp;
            orchestration.last_session_id = context.sessionId;
            orchestration.last_group_id = context.groupId;
            orchestration.last_task_id = context.taskId;
            orchestration.last_exit_status = context.exitStatus;
            orchestration.last_payload = payload;
            metadata.orchestration = orchestration;
            state.metadata = metadata;
        });
    } catch (error) {
        console.error(`[Orchestration] Failed to write execute_plan signal: ${error.message}`);
    }
}

function triggerReasoningExtraction(taskId, trajectory, exitCode, config) {
    /**
     * Fire-and-forget reasoning extraction from subagent trajectory.
     *
     * Extracts reasoning memories and stores them in Graphiti via the
     * reasoning_bank operations. Non-blocking to avoid slowing down hook.
     *
     * @param {string} taskId - Task identifier
     * @param {string} trajectory - Subagent output/transcript
     * @param {number} exitCode - Exit code (0 = success, non-zero = failure)
     * @param {object} config - Sessions configuration with reasoning_bank settings
     */
    try {
        // Check if auto_extract is enabled
        const reasoning_bank = config?.reasoning_bank;
        if (!reasoning_bank || !reasoning_bank.enabled || !reasoning_bank.auto_extract) {
            return;
        }

        // Skip short trajectories (< 500 chars provides little value)
        if (!trajectory || trajectory.length < 500) {
            return;
        }

        // Determine outcome based on exit code
        const outcome = exitCode === 0 ? "success" : "failure";
        const groupId = reasoning_bank.group_id || "hd_os_workspace";

        // Fire-and-forget extraction via Python script
        // Don't wait for completion - this runs asynchronously
        const extractArgs = [
            "-m",
            "reasoning_bank.cli",
            "extract",
            "--task-id",
            taskId,
            "--outcome",
            outcome,
            "--group-id",
            groupId,
            "--trajectory-stdin"
        ];

        const { spawn } = require('child_process');
        const extractProc = spawn(PYTHON_BIN, extractArgs, {
            cwd: PROJECT_ROOT,
            stdio: ['pipe', 'ignore', 'pipe'],  // stdin=pipe, stdout=ignore, stderr=pipe
            detached: true,
            timeout: 30000  // 30 second max (generous for LLM extraction)
        });

        // Send trajectory via stdin
        if (extractProc.stdin) {
            extractProc.stdin.write(trajectory);
            extractProc.stdin.end();
        }

        // Log errors but don't block
        extractProc.stderr.on('data', (data) => {
            console.error(`[reasoning_bank] Extraction warning: ${data.toString().trim()}`);
        });

        extractProc.on('error', (error) => {
            console.error(`[reasoning_bank] Failed to spawn extraction: ${error.message}`);
        });

        // Unref to prevent blocking hook completion
        extractProc.unref();

    } catch (error) {
        // Log but never throw - extraction is best-effort
        console.error(`[reasoning_bank] Extraction trigger failed: ${error.message}`);
    }
}

function handleSubagentStopEvent(inputData, toolName) {
    /**
     * Respond to SubagentStop hooks by updating execution plan state.
     *
     * @param {object} inputData - Hook payload
     * @param {string} toolName - Name of the tool that triggered the hook
     */
    if (toolName !== "Task") {
        return;
    }

    // Load config for reasoning_bank check
    const { loadConfig } = require('./shared_state.js');
    const config = loadConfig();

    // Check if backlog integration is ready
    try {
        const state = loadState();
        const backlogReady = state?.metadata?.orchestration?.backlog_ready;
        if (backlogReady === false) {
            console.error("[Orchestration] piadda-backlog not installed - orchestration disabled.");
            console.error("[Orchestration] Run: python3 -m pip install \"piadda-backlog @ git+https://github.com/piadda-inc/piadda-backlog.git\"");
            return;
        }
    } catch (error) {
        // If we can't load state, proceed anyway (backward compatibility)
        console.error(`[Orchestration] Warning: Could not check backlog_ready flag: ${error.message}`);
    }

    let transcriptPath = inputData.transcript_path || "";
    const sessionId = inputData.session_id || "";
    if (!transcriptPath || !sessionId) {
        console.error("[Orchestration] Missing transcript or session metadata for SubagentStop.");
        return;
    }

    transcriptPath = findCurrentTranscript(transcriptPath, sessionId);
    const transcriptEntries = loadTranscriptEntries(transcriptPath);
    if (!transcriptEntries.length) {
        console.error("[Orchestration] Transcript is empty; skipping plan update.");
        return;
    }

    const invocation = findLastTaskInvocation(transcriptEntries);
    if (!invocation) {
        console.error("[Orchestration] Unable to locate Task input for SubagentStop.");
        return;
    }

    const taskInput = invocation.input || {};
    const taskId = taskInput.task_id || taskInput.id || null;
    const groupId = taskInput.group_id || taskInput.stage_group_id || null;
    const subagentType = taskInput.subagent_type || invocation.subagentType || "shared";

    if (!taskId || !groupId) {
        console.error("[Orchestration] Task metadata incomplete; cannot update execution plan.");
        return;
    }

    const exitStatusRaw =
        inputData.exit_status ||
        (inputData.tool_response && inputData.tool_response.exit_status) ||
        taskInput.exit_status;
    const exitStatus = normalizeExitStatus(exitStatusRaw);

    const stateDir = process.env.SESSIONS_STATE_DIR || DEFAULT_STATE_DIR;
    const tasksDir = process.env.BACKLOG_TASKS_DIR || DEFAULT_TASKS_DIR;
    const cliArgs = [
        "-m",
        "sessions.bin.backlog_bridge",
        "subagent-stop",
        "--session-id",
        sessionId,
        "--task-id",
        taskId,
        "--group-id",
        groupId,
        "--subagent-type",
        subagentType,
        "--exit-status",
        exitStatus,
        "--state-dir",
        stateDir,
        "--tasks-dir",
        tasksDir,
    ];

    const env = { ...process.env, SESSIONS_STATE_DIR: stateDir, BACKLOG_TASKS_DIR: tasksDir };
    const result = spawnSync(PYTHON_BIN, cliArgs, {
        cwd: PROJECT_ROOT,
        encoding: "utf-8",
        env,
    });

    if (result.error && (result.status === null || result.status === undefined)) {
        console.error(`[Orchestration] Failed to launch backlog bridge: ${result.error.message}`);
        return;
    }

    if (typeof result.status === "number" && result.status !== 0) {
        const stderr = result.stderr ? result.stderr.trim() : "unknown error";
        console.error(`[Orchestration] Backlog bridge exited with ${result.status}: ${stderr}`);
        return;
    }

    let payload = {};
    try {
        payload = JSON.parse(result.stdout || "{}");
    } catch (error) {
        console.error(`[Orchestration] Invalid backlog bridge output: ${error.message}`);
        return;
    }

    emitPlanSignal(payload, { sessionId, groupId, taskId, subagentType, exitStatus });
    const signal = payload.signal || "none";
    console.error(`[Orchestration] Session ${sessionId} (${groupId}) emitted ${signal}`);

    // Trigger reasoning extraction if enabled
    // Extract trajectory from tool_response or build from transcript
    let trajectory = "";
    if (inputData.tool_response && inputData.tool_response.output) {
        trajectory = inputData.tool_response.output;
    } else {
        // Fallback: extract text content from transcript entries
        trajectory = transcriptEntries
            .map(entry => {
                const msg = entry.message;
                if (!msg || !msg.content) return "";
                if (typeof msg.content === "string") return msg.content;
                if (Array.isArray(msg.content)) {
                    return msg.content
                        .filter(block => block.type === "text")
                        .map(block => block.text || "")
                        .join("\n");
                }
                return "";
            })
            .filter(text => text.length > 0)
            .join("\n\n");
    }

    // Determine exit code from exit status
    // "completed" or "success" = 0, anything else = 1
    const exitCode = (exitStatus === "completed" || exitStatus === "success") ? 0 : 1;

    // Fire-and-forget extraction (non-blocking)
    triggerReasoningExtraction(taskId, trajectory, exitCode, config);
}

//-//

// ===== GLOBALS ===== //

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

// Skip subagent hooks in CI environments
if (isCIEnvironment()) {
    process.exit(0);
}
///-///

// Load input from stdin
let inputData = {};
try {
    const stdin = fs.readFileSync(0, 'utf-8');
    inputData = JSON.parse(stdin);
} catch (e) {
    console.error(`Error: Invalid JSON input: ${e.message}`);
    process.exit(1);
}

// Determine hook event type
const toolName = inputData.tool_name || "";
const eventName = inputData.hook_event_name || "";

if (eventName === "SubagentStop") {
    handleSubagentStopEvent(inputData, toolName);
    process.exit(0);
}

if (toolName !== "Task") {
    process.exit(0);
}

if (eventName && eventName !== "PreToolUse") {
    process.exit(0);
}

// Get the transcript path and session ID from the input data
let transcriptPath = inputData.transcript_path || "";
const sessionId = inputData.session_id || "";
if (!transcriptPath) {
    process.exit(0);
}

// Detect and recover from stale transcript
if (transcriptPath) {
    transcriptPath = findCurrentTranscript(transcriptPath, sessionId);
}

// Get the transcript into memory
let transcript = [];
try {
    const content = readTranscriptTail(transcriptPath, 131072);
    const lines = content.split('\n');
    for (const line of lines) {
        if (line.trim()) {
            transcript.push(JSON.parse(line));
        }
    }
} catch (e) {
    process.exit(0);
}
//-//

/*
╔═══════════════════════════════════════════════════════════════════╗
║ ██████╗██╗ ██╗█████╗  █████╗  █████╗██████╗██╗  ██╗██████╗██████╗ ║
║ ██╔═══╝██║ ██║██╔═██╗██╔══██╗██╔═══╝██╔═══╝███╗ ██║╚═██╔═╝██╔═══╝ ║
║ ██████╗██║ ██║█████╔╝███████║██║    █████╗ ████╗██║  ██║  ██████╗ ║
║ ╚═══██║██║ ██║██╔═██╗██╔══██║██║ ██╗██╔══╝ ██╔████║  ██║  ╚═══██║ ║
║ ██████║╚████╔╝█████╔╝██║  ██║╚█████║██████╗██║╚███║  ██║  ██████║ ║
║ ╚═════╝ ╚═══╝ ╚════╝ ╚═╝  ╚═╝ ╚════╝╚═════╝╚═╝ ╚══╝  ╚═╝  ╚═════╝ ║
╚═══════════════════════════════════════════════════════════════════╝
PreToolUse:Task:subagent_type hooks

This module handles PreToolUse processing for the Task tool:
    - Chunks the transcript for subagents based on token limits
    - Saves transcript chunks to designated directories
    - Sets flags to manage subagent context
*/

// ===== EXECUTION ===== //

//!> Set subagent flag with session tracking
editState(s => {
    s.flags.setSubagent(sessionId);
});
const STATE = loadState();
//!<

//!> Trunc + clean transcript
// Remove any pre-work transcript entries
let startFound = false;
let transcriptQueue = [...transcript];
while (!startFound && transcriptQueue.length > 0) {
    const entry = transcriptQueue.shift();
    const message = entry.message;
    if (message) {
        const content = message.content;
        if (Array.isArray(content)) {
            for (const block of content) {
                if (block.type === 'tool_use' && ['Edit', 'MultiEdit', 'Write'].includes(block.name)) {
                    startFound = true;
                    break;
                }
            }
        }
    }
}

// Clean the transcript
const cleanTranscript = [];
for (const entry of transcriptQueue) {
    const message = entry.message;
    const messageType = entry.type;

    if (message && ['user', 'assistant'].includes(messageType)) {
        const content = message.content;
        const role = message.role;
        cleanTranscript.push({ role: role, content: content });
    }
}
//!<

//!> Prepare subagent dir for transcript files
let subagentType = 'shared';
if (cleanTranscript.length === 0) {
    console.log("[Subagent] No relevant transcript entries found, skipping snapshot.");
    process.exit(0);
}

const taskCall = cleanTranscript[cleanTranscript.length - 1];
const content = taskCall.content;
if (Array.isArray(content)) {
    for (const block of content) {
        if (block.type === 'tool_use' && block.name === 'Task') {
            const taskInput = block.input || {};
            subagentType = taskInput.subagent_type || subagentType;
        }
    }
}

ensureTranscriptInfrastructure();
const { dirPath: BATCH_DIR, lockPath: TRANSCRIPT_LOCK } = resolveTranscriptTarget(sessionId, subagentType);
//!<

//!> Chunk and save transcript batches
const MAX_BYTES = 24000;
let usableContext = 160000;
if (STATE.model === "sonnet") {
    usableContext = 800000;
}

const cleanTranscriptText = JSON.stringify(cleanTranscript, null, 2);

const chunks = [];
let bufChars = [];
let bufBytes = 0;
let lastNewlineIdx = null;
let lastSpaceIdx = null;

// Convert string to byte array for accurate byte counting
const encoder = new TextEncoder();

for (let i = 0; i < cleanTranscriptText.length; i++) {
    const ch = cleanTranscriptText[i];
    const chBytes = encoder.encode(ch).length;

    // If overflowing, flush a chunk
    if (bufBytes + chBytes > MAX_BYTES) {
        let cutIdx = null;
        if (lastNewlineIdx !== null) {
            cutIdx = lastNewlineIdx;
        } else if (lastSpaceIdx !== null) {
            cutIdx = lastSpaceIdx;
        }

        if (cutIdx !== null && cutIdx > 0) {
            // Emit chunk up to the breakpoint
            chunks.push(bufChars.slice(0, cutIdx).join(''));
            const remainder = bufChars.slice(cutIdx);
            bufChars = remainder;
            bufBytes = encoder.encode(bufChars.join('')).length;
        } else {
            // No breakpoints, hard cut what we got
            if (bufChars.length > 0) {
                chunks.push(bufChars.join(''));
            }
            bufChars = [];
            bufBytes = 0;
        }

        lastNewlineIdx = null;
        lastSpaceIdx = null;
    }

    bufChars.push(ch);
    bufBytes += chBytes;

    if (ch === '\n') {
        lastNewlineIdx = bufChars.length;
        lastSpaceIdx = null;
    } else if (ch === ' ' && lastNewlineIdx === null) {
        lastSpaceIdx = bufChars.length;
    }
}

// Flush any remaining buffer
if (bufChars.length > 0) {
    chunks.push(bufChars.join(''));
}

// Verify all chunks meet byte limit
for (const chunk of chunks) {
    const byteLength = encoder.encode(chunk).length;
    if (byteLength > MAX_BYTES) {
        console.error("Chunking failed to enforce byte limit");
        process.exit(1);
    }
}

function persistChunks() {
    if (!fs.existsSync(BATCH_DIR)) {
        fs.mkdirSync(BATCH_DIR, { recursive: true });
    } else {
        const files = fs.readdirSync(BATCH_DIR);
        for (const file of files) {
            const filePath = path.join(BATCH_DIR, file);
            try {
                if (fs.statSync(filePath).isFile()) {
                    fs.unlinkSync(filePath);
                }
            } catch {
                continue;
            }
        }
    }

    chunks.forEach((chunk, idx) => {
        const partName = `current_transcript_${String(idx + 1).padStart(3, '0')}.txt`;
        const partPath = path.join(BATCH_DIR, partName);
        fs.writeFileSync(partPath, chunk, 'utf8');
    });
}

try {
    withTranscriptLock(TRANSCRIPT_LOCK, persistChunks, { timeoutMs: 8000 });
} catch (error) {
    console.error(`[Subagent] Failed to persist transcript chunks: ${error.message}`);
    process.exit(1);
}
//!<

//-//

// Allow the tool call to proceed
process.exit(0);
