const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    runHookWithFixture,
    updateFixtureState,
    withTestProjectFixture,
} = require('./test-helpers');

const useFixture = withTestProjectFixture(test);

function requireFixture() {
    return useFixture();
}

function getStateFile() {
    return requireFixture().stateFile;
}

function getExecutionPlanPath() {
    return requireFixture().executionPlanPath;
}

function getProjectRoot() {
    return requireFixture().projectDir;
}

function updateState(updater) {
    updateFixtureState(requireFixture(), updater);
}

function setSubagentFlag(value) {
    updateState(state => {
        state.flags = state.flags || {};
        state.flags.subagent = value;
    });
}

function enterImplementationMode() {
    updateState(state => {
        state.mode = 'implementation';
    });
}

function runHook(payload, extraEnv = {}) {
    return runHookWithFixture(requireFixture(), payload, { env: extraEnv });
}

function buildPayload({ tool, file, command }) {
    const payload = {
        tool_name: tool,
        tool_input: {},
        session_id: 'sess-test',
    };

    if (file) {
        payload.tool_input.file_path = file;
    }

    if (command) {
        payload.tool_input.command = command;
    }

    return payload;
}

test.describe('State Protection - Subagent Guards', { concurrency: false }, () => {
    test.beforeEach(() => {
        enterImplementationMode();
    });

    test.it('blocks subagent Write to sessions-state.json', () => {
        setSubagentFlag(true);
        const payload = buildPayload({
            tool: 'Write',
            file: getStateFile(),
        });
        const result = runHook(payload);
        assert.equal(result.status, 2, result.stderr || result.stdout);
        assert.match(result.stderr, /cannot modify orchestration state/i);
    });

    test.it('blocks subagent Write to sessions-state.json.tmp', () => {
        setSubagentFlag(true);
        const payload = buildPayload({
            tool: 'Write',
            file: `${getStateFile()}.tmp`,
        });
        const result = runHook(payload);
        assert.equal(result.status, 2, result.stderr || result.stdout);
        assert.match(result.stderr, /cannot modify orchestration state/i);
    });

    test.it('blocks subagent Bash write to execution_plan.json', () => {
        setSubagentFlag(true);
        const planPath = getExecutionPlanPath();
        const payload = buildPayload({
            tool: 'Bash',
            file: planPath,
            command: `echo "blocked" >> "${planPath}"`,
        });
        const result = runHook(payload);
        assert.equal(result.status, 2, result.stderr || result.stdout);
        assert.match(result.stderr, /cannot modify orchestration state/i);
    });

    test.it('blocks subagent Bash redirect to sessions-state.json without file_path', () => {
        setSubagentFlag(true);
        const payload = buildPayload({
            tool: 'Bash',
            command: `echo "blocked" > "${getStateFile()}"`,
        });
        const result = runHook(payload);
        assert.equal(result.status, 2, result.stderr || result.stdout);
        assert.match(result.stderr, /cannot modify orchestration state/i);
    });

    test.it('blocks subagent Bash redirect to execution_plan.json without file_path', () => {
        setSubagentFlag(true);
        const planPath = getExecutionPlanPath();
        const payload = buildPayload({
            tool: 'Bash',
            command: `printf "blocked" >> "${planPath}"`,
        });
        const result = runHook(payload);
        assert.equal(result.status, 2, result.stderr || result.stdout);
        assert.match(result.stderr, /cannot modify orchestration state/i);
    });

    test.it('blocks subagent Bash process substitution tee writes', () => {
        setSubagentFlag(true);
        const planPath = getExecutionPlanPath();
        const payload = buildPayload({
            tool: 'Bash',
            command: `printf "blocked" | tee >(cat > "${planPath}") > /dev/null`,
        });
        const result = runHook(payload);
        assert.equal(result.status, 2, result.stderr || result.stdout);
        assert.match(result.stderr, /cannot modify orchestration state/i);
    });

    test.it('blocks subagent Bash process substitution input writes', () => {
        setSubagentFlag(true);
        const planPath = getExecutionPlanPath();
        const payload = buildPayload({
            tool: 'Bash',
            command: `cat <(cat > "${planPath}")`,
        });
        const result = runHook(payload);
        assert.equal(result.status, 2, result.stderr || result.stdout);
        assert.match(result.stderr, /cannot modify orchestration state/i);
    });

    test.it('blocks subagent Bash cp into orchestration files', () => {
        setSubagentFlag(true);
        const planPath = getExecutionPlanPath();
        const payload = buildPayload({
            tool: 'Bash',
            command: `cp "/tmp/source" "${planPath}"`,
        });
        const result = runHook(payload);
        assert.equal(result.status, 2, result.stderr || result.stdout);
        assert.match(result.stderr, /cannot modify orchestration state/i);
    });

    test.it('allows subagent Bash cp from orchestration files to safe path', () => {
        setSubagentFlag(true);
        const planPath = getExecutionPlanPath();
        const payload = buildPayload({
            tool: 'Bash',
            command: `cp "${planPath}" "/tmp/backup-plan.json"`,
        });
        const result = runHook(payload);
        assert.equal(result.status, 0, result.stderr || result.stdout);
    });

    test.it('blocks subagent Bash rm orchestration file targets', () => {
        setSubagentFlag(true);
        const planPath = getExecutionPlanPath();
        const payload = buildPayload({
            tool: 'Bash',
            command: `rm -f "${planPath}"`,
        });
        const result = runHook(payload);
        assert.equal(result.status, 2, result.stderr || result.stdout);
        assert.match(result.stderr, /cannot modify orchestration state/i);
    });

    test.it('blocks subagent Bash dd output to orchestration files', () => {
        setSubagentFlag(true);
        const planPath = getExecutionPlanPath();
        const payload = buildPayload({
            tool: 'Bash',
            command: `dd if=/dev/null of="${planPath}" bs=1 count=0`,
        });
        const result = runHook(payload);
        assert.equal(result.status, 2, result.stderr || result.stdout);
        assert.match(result.stderr, /cannot modify orchestration state/i);
    });

    test.it('allows subagent Bash read of orchestration files', () => {
        setSubagentFlag(true);
        const planPath = getExecutionPlanPath();
        const payload = buildPayload({
            tool: 'Bash',
            command: `cat "${planPath}"`,
        });
        const result = runHook(payload);
        assert.equal(result.status, 0, result.stderr || result.stdout);
    });

    test.it('allows orchestrator Bash redirect to orchestration files', () => {
        setSubagentFlag(false);
        const planPath = getExecutionPlanPath();
        const payload = buildPayload({
            tool: 'Bash',
            command: `echo "ok" > "${planPath}"`,
        });
        const result = runHook(payload);
        assert.equal(result.status, 0, result.stderr || result.stdout);
    });

    test.it('allows subagent Read of orchestration files', () => {
        setSubagentFlag(true);
        const payload = buildPayload({
            tool: 'Read',
            file: getStateFile(),
        });
        const result = runHook(payload);
        assert.equal(result.status, 0, result.stderr || result.stdout);
    });

    test.it('allows orchestrator Write to sessions-state.json', () => {
        setSubagentFlag(false);
        const payload = buildPayload({
            tool: 'Write',
            file: getStateFile(),
        });
        const result = runHook(payload);
        assert.equal(result.status, 0, result.stderr || result.stdout);
    });

    test.it('blocks subagent Write to execution plan via symlink indirection', () => {
        setSubagentFlag(true);
        const planPath = getExecutionPlanPath();
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-protect-symlink-'));
        const symlinkPath = path.join(tmpDir, 'plan-link.json');
        fs.symlinkSync(planPath, symlinkPath);
        try {
            const payload = buildPayload({
                tool: 'Write',
                file: symlinkPath,
            });
            const result = runHook(payload);
            assert.equal(result.status, 2, result.stderr || result.stdout);
            assert.match(result.stderr, /cannot modify orchestration state/i);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test.it('blocks subagent Bash redirect via symlink to execution plan', () => {
        setSubagentFlag(true);
        const planPath = getExecutionPlanPath();
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-protect-bash-symlink-'));
        const symlinkPath = path.join(tmpDir, 'plan-link.json');
        fs.symlinkSync(planPath, symlinkPath);
        try {
            const payload = buildPayload({
                tool: 'Bash',
                command: `echo "blocked" >> "${symlinkPath}"`,
            });
            const result = runHook(payload);
            assert.equal(result.status, 2, result.stderr || result.stdout);
            assert.match(result.stderr, /cannot modify orchestration state/i);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test.it('blocks subagent Write to execution plan via relative path', () => {
        setSubagentFlag(true);
        const relativePath = path.relative(getProjectRoot(), getExecutionPlanPath());
        const payload = buildPayload({
            tool: 'Write',
            file: relativePath,
        });
        const result = runHook(payload);
        assert.equal(result.status, 2, result.stderr || result.stdout);
        assert.match(result.stderr, /cannot modify orchestration state/i);
    });

    test.it('allows subagent Write via hardlink to execution plan', () => {
        setSubagentFlag(true);
        const planPath = getExecutionPlanPath();
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-protect-hardlink-'));
        const hardlinkPath = path.join(tmpDir, 'plan-hardlink.json');
        fs.linkSync(planPath, hardlinkPath);
        try {
            const payload = buildPayload({
                tool: 'Write',
                file: hardlinkPath,
            });
            const result = runHook(payload);
            assert.equal(result.status, 0, result.stderr || result.stdout);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test.it('allows orchestrator Write via symlink to execution plan', () => {
        setSubagentFlag(false);
        const planPath = getExecutionPlanPath();
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-protect-orch-symlink-'));
        const symlinkPath = path.join(tmpDir, 'plan-link.json');
        fs.symlinkSync(planPath, symlinkPath);
        try {
            const payload = buildPayload({
                tool: 'Write',
                file: symlinkPath,
            });
            const result = runHook(payload);
            assert.equal(result.status, 0, result.stderr || result.stdout);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});
