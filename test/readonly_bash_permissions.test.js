const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const {
  SessionsState,
  SessionsConfig,
  Mode
} = require('../hooks/shared_state.js');

const HOOKS_DIR = path.join(__dirname, '..', 'hooks');

function createProjectFixture(stateOverrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'permissions-test-'));
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

test('test_readonly_bash_command_returns_allow_permission', (t) => {
  const fixture = createProjectFixture({
    mode: Mode.NO,  // Discussion mode (read-only)
    flags: { bypass_mode: false }
  });
  t.after(() => fixture.cleanup());

  // Test with a known read-only command
  const result = runHook('sessions_enforce.js', {
    tool_name: 'Bash',
    tool_input: {
      command: 'ls -la'
    }
  }, fixture.root);

  // Hook should exit 0
  assert.equal(result.status, 0, `Hook should exit 0 for read-only command, got ${result.status}. stderr: ${result.stderr}`);

  // Hook should output JSON with permissionDecision: "allow"
  let hookOutput;
  try {
    hookOutput = JSON.parse(result.stdout);
  } catch (e) {
    assert.fail(`Hook stdout should be valid JSON. Got: ${result.stdout}`);
  }

  assert.ok(hookOutput.hookSpecificOutput, 'hookSpecificOutput should be present');
  assert.equal(hookOutput.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(hookOutput.hookSpecificOutput.permissionDecision, 'allow',
    'permissionDecision should be "allow" for read-only command');
  assert.ok(hookOutput.hookSpecificOutput.permissionDecisionReason,
    'permissionDecisionReason should be provided');
});

test('test_write_bash_command_returns_block', (t) => {
  const fixture = createProjectFixture({
    mode: Mode.NO,  // Discussion mode
    flags: { bypass_mode: false }
  });
  t.after(() => fixture.cleanup());

  // Test with a write command
  const result = runHook('sessions_enforce.js', {
    tool_name: 'Bash',
    tool_input: {
      command: 'rm -rf /tmp/test'
    }
  }, fixture.root);

  // Hook should exit 2 (block)
  assert.equal(result.status, 2, `Hook should exit 2 for write command, got ${result.status}`);

  // Should have error message in stderr
  assert.match(result.stderr, /DAIC.*Blocked/i, 'stderr should contain block message');
});

test('test_readonly_bash_with_various_commands', (t) => {
  const fixture = createProjectFixture({
    mode: Mode.NO,
    flags: { bypass_mode: false }
  });
  t.after(() => fixture.cleanup());

  const readOnlyCommands = [
    'cat file.txt',
    'grep "pattern" file.txt',
    'find . -name "*.js"',
    'ls -la',
    'pwd',
    'echo "hello"',
    'git status',
    'git log',
    'tree'
  ];

  for (const command of readOnlyCommands) {
    const result = runHook('sessions_enforce.js', {
      tool_name: 'Bash',
      tool_input: { command }
    }, fixture.root);

    assert.equal(result.status, 0,
      `Command "${command}" should be auto-approved (exit 0), got ${result.status}`);

    let output;
    try {
      output = JSON.parse(result.stdout);
    } catch (e) {
      assert.fail(`Command "${command}" should output valid JSON. Got: ${result.stdout}`);
    }

    assert.equal(output.hookSpecificOutput?.permissionDecision, 'allow',
      `Command "${command}" should have permissionDecision: "allow"`);
  }
});
