const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const {
  SessionsState,
  SessionsConfig,
  TodoStatus,
  Mode
} = require('../hooks/shared_state.js');

const HOOKS_DIR = path.join(__dirname, '..', 'hooks');
const SNAPSHOT_LOG_TAG = '[Todo Snapshot]';
const SUBAGENT_GUARD_TAG = '[Subagent Todo Guard]';

function createProjectFixture(stateOverrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-snapshot-'));
  fs.mkdirSync(path.join(root, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude'), 'test');

  const configPath = path.join(root, 'sessions', 'sessions-config.json');
  const config = new SessionsConfig();
  fs.writeFileSync(configPath, JSON.stringify(config.toDict(), null, 2));

  const statePath = path.join(root, 'sessions', 'sessions-state.json');
  const stateData = {
    ...stateOverrides,
    metadata: {
      update_available: false,
      latest_version: '0.0.0',
      ...(stateOverrides.metadata || {})
    }
  };
  const state = new SessionsState(stateData);
  fs.writeFileSync(statePath, JSON.stringify(state.toDict(), null, 2));

  const transcriptsDir = path.join(root, 'sessions', 'transcripts');
  fs.mkdirSync(transcriptsDir, { recursive: true });

  return {
    root,
    statePath,
    readState: () => JSON.parse(fs.readFileSync(statePath, 'utf8')),
    writeState: (data) => fs.writeFileSync(statePath, JSON.stringify(data, null, 2)),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true })
  };
}

function runHook(scriptName, input, projectRoot) {
  const scriptPath = path.join(HOOKS_DIR, scriptName);
  return spawnSync(process.execPath, [scriptPath], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: projectRoot
    },
    input: JSON.stringify(input || {}),
    encoding: 'utf8'
  });
}

test('test_parent_todos_preserved_after_subagent_todowrite', () => {
  const state = new SessionsState({
    todos: {
      active: [
        { content: 'A', status: TodoStatus.PENDING },
        { content: 'B', status: TodoStatus.PENDING },
        { content: 'C', status: TodoStatus.IN_PROGRESS }
      ]
    }
  });

  state.todos.snapshotParent();
  state.todos.clearActive();
  state.todos.storeTodos([
    { content: 'X', status: TodoStatus.PENDING },
    { content: 'Y', status: TodoStatus.PENDING }
  ]);

  const restoreResult = state.todos.restoreParent();

  assert.equal(restoreResult.restored, true);
  assert.deepEqual(state.todos.listContent('active'), ['A', 'B', 'C']);
  assert.deepEqual(restoreResult.restoredTodos, ['A', 'B', 'C']);
});

test('test_subagent_can_use_todowrite_during_bypass', (t) => {
  const fixture = createProjectFixture({
    mode: Mode.GO,
    flags: { subagent: true, bypass_mode: true },
    todos: { active: [] }
  });
  t.after(() => fixture.cleanup());

  const result = runHook('sessions_enforce.js', {
    tool_name: 'TodoWrite',
    tool_input: {
      todos: [
        { content: 'child-1', status: TodoStatus.PENDING }
      ]
    }
  }, fixture.root);

  assert.equal(result.status, 0, result.stderr);
});

test('test_parent_todowrite_blocked_during_subagent', (t) => {
  const fixture = createProjectFixture({
    mode: Mode.GO,
    flags: { subagent: true, bypass_mode: false },
    todos: {
      active: [
        { content: 'parent-1', status: TodoStatus.PENDING }
      ]
    }
  });
  t.after(() => fixture.cleanup());

  const result = runHook('sessions_enforce.js', {
    tool_name: 'TodoWrite',
    tool_input: {
      todos: [
        { content: 'parent-1', status: TodoStatus.PENDING }
      ]
    }
  }, fixture.root);

  assert.equal(result.status, 2);
  assert.match(result.stderr, new RegExp(SUBAGENT_GUARD_TAG));
});

test('test_snapshot_restored_after_crash', (t) => {
  const fixture = createProjectFixture({
    mode: Mode.GO,
    flags: { subagent: false, bypass_mode: false },
    todos: { active: [] }
  });
  t.after(() => fixture.cleanup());

  const rawState = fixture.readState();
  rawState.todos.parent_snapshot = [
    { content: 'keep-me', status: TodoStatus.PENDING, activeForm: null }
  ];
  fixture.writeState(rawState);

  const result = runHook('session_start.js', {}, fixture.root);
  assert.equal(result.status, 0, result.stderr);

  const reloaded = fixture.readState();
  const restored = reloaded.todos.active.map(todo => todo.content);
  assert.deepEqual(restored, ['keep-me']);
});

test('test_empty_snapshot_case', () => {
  const state = new SessionsState({
    todos: { active: [] }
  });

  state.todos.snapshotParent();
  state.todos.clearActive();
  state.todos.storeTodos([
    { content: 'child', status: TodoStatus.PENDING }
  ]);

  const restore = state.todos.restoreParent();
  assert.equal(restore.restored, true);
  assert.deepEqual(state.todos.listContent('active'), []);
});

test('test_corrupted_snapshot_handling', (t) => {
  const fixture = createProjectFixture({
    flags: { subagent: true, bypass_mode: false },
    todos: { active: [] }
  });
  t.after(() => fixture.cleanup());

  const corrupted = fixture.readState();
  corrupted.todos.parent_snapshot = 'broken';
  fixture.writeState(corrupted);

  const result = runHook('post_tool_use.js', {
    tool_name: 'Task',
    tool_input: { subagent_type: 'shared' }
  }, fixture.root);

  assert.equal(result.status, 0);
  assert.match(result.stderr, new RegExp(SNAPSHOT_LOG_TAG));
});
