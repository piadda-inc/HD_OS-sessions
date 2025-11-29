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
        setStateFlags({ subagent: true, subagent_session_id: 'sess-task-gate', bypass_mode: false });
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
        setStateFlags({ subagent: true, subagent_session_id: 'sess-task-gate', bypass_mode: true });
        const result = runTaskGate();

        assert.equal(result.status, 0, result.stderr || result.stdout);
    });
});

test.describe('Task Gate - Stale Subagent Flag Auto-Clear', () => {
    test('clears stale subagent flag from different session', () => {
        // Set subagent flag with a different session ID
        setStateFlags({ subagent: true, subagent_session_id: 'old-session-123', bypass_mode: false });

        // Run with a new session ID - should auto-clear and allow
        const result = runTaskGate({ session_id: 'new-session-456' });

        assert.equal(result.status, 0, result.stderr || result.stdout);
    });

    test('clears stale subagent flag with no session tracking', () => {
        // Set subagent flag without session ID (legacy state)
        setStateFlags({ subagent: true, subagent_session_id: null, bypass_mode: false });

        // Run with a session ID - should auto-clear and allow
        const result = runTaskGate({ session_id: 'new-session-789' });

        assert.equal(result.status, 0, result.stderr || result.stdout);
    });

    test('clears stale subagent flag when request has no session_id', () => {
        // Set subagent flag with a session ID
        setStateFlags({ subagent: true, subagent_session_id: 'old-session-abc', bypass_mode: false });

        // Run WITHOUT a session ID - should assume stale and clear
        const result = runTaskGate({ session_id: '' });

        assert.equal(result.status, 0, result.stderr || result.stdout);
    });

    test('clears same-session stale flag in orchestration mode', () => {
        // Simulate crashed subagent: flag set with same session but we're in orchestration mode
        // The state file has mode: orchestration and the flag with matching session ID
        // This happens when a Task subagent crashes mid-execution
        updateFixtureState(useFixture(), state => {
            state.mode = 'orchestration';
            state.flags = {
                subagent: true,
                subagent_session_id: 'sess-task-gate',
                bypass_mode: false,
            };
        });

        // Run with same session ID but in orchestration mode - should clear and allow
        const result = runTaskGate({ session_id: 'sess-task-gate' });

        assert.equal(result.status, 0, result.stderr || result.stdout);
    });

    test('blocks when same session has subagent flag in discussion mode', () => {
        // Set subagent flag with current session ID in discussion mode
        // This represents an actual nested subagent attempt
        updateFixtureState(useFixture(), state => {
            state.mode = 'discussion';
            state.flags = {
                subagent: true,
                subagent_session_id: 'sess-task-gate',
                bypass_mode: false,
            };
        });

        // Run with same session ID in discussion mode - should block
        const result = runTaskGate({ session_id: 'sess-task-gate' });

        assert.equal(result.status, 2, result.stderr || result.stdout);
        assert.match(result.stderr, /cannot spawn nested subagents/i);
    });
});
