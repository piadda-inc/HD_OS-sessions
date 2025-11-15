const test = require('node:test');
const assert = require('node:assert/strict');
const {
    runHookWithFixture,
    updateFixtureState,
    withTestProjectFixture,
} = require('./test-helpers');

const useFixture = withTestProjectFixture(test);

function setStateFlags(flags = {}) {
    updateFixtureState(useFixture(), state => {
        state.flags = {
            ...(state.flags || {}),
            ...flags,
        };
    });
}

function runTaskGate(payload = {}) {
    return runHookWithFixture(useFixture(), {
        hook_event: 'PreToolUse',
        tool_name: 'Task',
        tool_input: {},
        session_id: 'sess-task-gate',
        ...payload,
    });
}

test.describe('Task Gate - Nested Subagent Prevention', () => {
    test('blocks subagent from spawning Task tool', () => {
        setStateFlags({ subagent: true, bypass_mode: false });
        const result = runTaskGate();

        assert.equal(result.status, 2, result.stderr || result.stdout);
        assert.match(result.stderr, /cannot spawn nested subagents/i);
    });

    test('allows orchestrator to spawn Task tool', () => {
        setStateFlags({ subagent: false, bypass_mode: false });
        const result = runTaskGate();

        assert.equal(result.status, 0, result.stderr || result.stdout);
    });

    test('respects bypass_mode flag', () => {
        setStateFlags({ subagent: true, bypass_mode: true });
        const result = runTaskGate();

        assert.equal(result.status, 0, result.stderr || result.stdout);
    });
});
