const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const HOOK_PATH = path.join(PROJECT_ROOT, 'sessions', 'hooks', 'subagent_hooks.js');
const STATE_FILE = path.join(PROJECT_ROOT, 'sessions', 'sessions-state.json');
const BASE_TASKS_DIR = path.join(PROJECT_ROOT, 'tests', 'fixtures', 'backlog_sample');
const TASK_FIXTURE_FILES = [
    'task-orch-fixture-001 - Stage-1-group-1A.md',
    'task-orch-fixture-002 - Stage-1-group-1B.md',
    'task-orch-fixture-003 - Stage-1-group-2A.md',
    'task-orch-fixture-004 - Stage-1-group-2B.md',
    'task-orch-fixture-005 - Stage-1-group-3.md',
];
const FIXTURE_INPUT = path.join(PROJECT_ROOT, 'tests', 'fixtures', 'hooks', 'subagent_stop_input.json');

const ORIGINAL_STATE = fs.readFileSync(STATE_FILE, 'utf8');

function readJson(targetPath) {
    return JSON.parse(fs.readFileSync(targetPath, 'utf8'));
}

function writeTranscript(dir, sessionId, options = {}) {
    const {
        includeTaskEntry = true,
        includeGroupId = true,
        taskId = 'task-orch-fixture-003',
        groupId = 's1-fixture-group-2',
        subagentType = 'general-purpose',
    } = options;

    const now = new Date().toISOString();
    const entries = [];
    if (includeTaskEntry) {
        const input = {
            task_id: taskId,
            subagent_type: subagentType,
        };
        if (includeGroupId && groupId) {
            input.group_id = groupId;
        }
        entries.push({
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [
                    {
                        type: 'tool_use',
                        name: 'Task',
                        input,
                    },
                ],
            },
            timestamp: now,
            sessionId,
        });
    }
    entries.push({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'ack' }] },
        timestamp: now,
        sessionId,
    });

    const target = path.join(dir, `${sessionId}.jsonl`);
    const payload = entries.map(entry => JSON.stringify(entry)).join('\n');
    fs.writeFileSync(target, `${payload}\n`, 'utf8');
    return target;
}

function seedOrchestrationState(stateDir) {
    fs.mkdirSync(stateDir, { recursive: true });
    const script = `
from datetime import datetime, timezone
from pathlib import Path
import sys
from sessions.state.models import ExecutionGroup, ExecutionPlan, GroupStatus, SessionIndex, SessionIndexEntry
from sessions.state.persistence import save_execution_plan, save_session_index

state_dir = Path(sys.argv[1])
state_dir.mkdir(parents=True, exist_ok=True)
session_index_path = state_dir / "session_index.json"
execution_plan_path = state_dir / "execution_plan.json"

now = datetime.now(timezone.utc).isoformat()
entry = SessionIndexEntry(
    session_id="sess-alpha",
    task_id="task-orch-fixture-003",
    created_at=now,
    status="running",
    group_id="s1-fixture-group-2",
    subagent_type="general-purpose",
)
plan = ExecutionPlan(
    groups=[
        ExecutionGroup(
            group_id="s1-fixture-group-2",
            task_ids=("task-orch-fixture-003", "task-orch-fixture-004"),
            parallel=True,
            bootstrap_stage=1,
            status=GroupStatus.RUNNING,
        )
    ]
)

save_session_index(SessionIndex(entries=(entry,)), session_index_path)
save_execution_plan(plan, execution_plan_path)
`;
    const result = spawnSync('python3', ['-c', script, stateDir], {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
    });
    if (result.status !== 0) {
        console.error(result.stdout);
        console.error(result.stderr);
        throw new Error(result.stderr || 'Failed to seed orchestration state');
    }
    console.error(`[seed] state_dir=${stateDir}`);
}

function buildPayload(overrides = {}) {
    const template = readJson(FIXTURE_INPUT);
    return {
        ...template,
        ...overrides,
    };
}

function runHook(payload, { stateDir, tasksDir = BASE_TASKS_DIR, env: extraEnv = {} } = {}) {
    const env = {
        ...process.env,
        CLAUDE_PROJECT_DIR: PROJECT_ROOT,
        SESSIONS_STATE_DIR: stateDir,
        BACKLOG_TASKS_DIR: tasksDir,
        CC_PYTHON: process.env.CC_PYTHON || 'python3',
        ...extraEnv,
    };
    console.error('running hook with env', {
        CLAUDE_PROJECT_DIR: env.CLAUDE_PROJECT_DIR,
        SESSIONS_STATE_DIR: env.SESSIONS_STATE_DIR,
        BACKLOG_TASKS_DIR: env.BACKLOG_TASKS_DIR,
    });
    return spawnSync('node', [HOOK_PATH], {
        cwd: PROJECT_ROOT,
        input: JSON.stringify(payload),
        encoding: 'utf8',
        env,
    });
}

function tempDir(prefix = 'subagent-stop-') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function prepareTasksDir(destination) {
    fs.mkdirSync(destination, { recursive: true });
    for (const filename of TASK_FIXTURE_FILES) {
        const source = path.join(BASE_TASKS_DIR, filename);
        const target = path.join(destination, filename);
        fs.copyFileSync(source, target);
    }
    return destination;
}

function main() {
    fs.writeFileSync(STATE_FILE, ORIGINAL_STATE, 'utf8');
    const sandbox = tempDir();
    const stateDir = path.join(sandbox, 'state-success');
    console.error('state dir', stateDir);
    seedOrchestrationState(stateDir);
    console.error('seeded');
    const tasksDir = prepareTasksDir(path.join(sandbox, 'tasks-success'));
    console.error('tasks prepared', tasksDir);
    const transcript = writeTranscript(sandbox, 'sess-alpha');
    console.error('transcript', transcript);
    const payload = buildPayload({ transcript_path: transcript });
    console.error('payload ready');

    const result = runHook(payload, { stateDir, tasksDir });
    console.error('hook done status', result.status);
    console.error('stdout', result.stdout);
    console.error('stderr', result.stderr);
}

main();
