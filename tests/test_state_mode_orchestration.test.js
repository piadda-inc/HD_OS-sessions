/**
 * Tests for state mode command with orchestration mode terminology.
 *
 * These tests verify that:
 * 1. All three mode names work (orchestration, go, implementation)
 * 2. Help text shows orchestration as canonical
 * 3. JSON responses use actual mode value ("orchestration")
 * 4. Error messages are updated
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { handleModeCommand } = require('../api/state_commands');
const { Mode, loadState, editState } = require('../hooks/shared_state');

// Helper to reset mode before each test
function resetMode() {
    editState(state => {
        state.mode = Mode.NO;
        state.flags.bypass_mode = false;
    });
}

test('orchestration mode name works', () => {
    resetMode();
    const result = handleModeCommand(['orchestration'], true, true);

    assert.strictEqual(result.mode, 'orchestration');
    assert.match(result.message, /Orchestration Mode/);

    const state = loadState();
    assert.strictEqual(state.mode, Mode.GO);
});

test('go alias still works', () => {
    resetMode();
    const result = handleModeCommand(['go'], true, true);

    assert.strictEqual(result.mode, 'orchestration');
    assert.match(result.message, /Orchestration Mode/);

    const state = loadState();
    assert.strictEqual(state.mode, Mode.GO);
});

test('implementation backward compatibility', () => {
    resetMode();
    const result = handleModeCommand(['implementation'], true, true);

    assert.strictEqual(result.mode, 'orchestration');
    assert.match(result.message, /Orchestration Mode/);

    const state = loadState();
    assert.strictEqual(state.mode, Mode.GO);
});

test('help text shows orchestration as canonical', () => {
    resetMode();
    const result = handleModeCommand(['invalid'], false, true);

    assert.match(result.toLowerCase(), /orchestration/);
    assert.match(result.toLowerCase(), /mode orchestration/);

    // Check that orchestration comes before implementation
    const orchPos = result.toLowerCase().indexOf('orchestration');
    const implPos = result.toLowerCase().indexOf('implementation');
    assert.ok(orchPos < implPos, 'orchestration should appear before implementation');
});

test('JSON response uses actual mode value', () => {
    resetMode();
    // Switch to orchestration mode
    handleModeCommand(['orchestration'], false, true);

    // Query current mode
    const result = handleModeCommand([], true, false);

    const state = loadState();
    assert.strictEqual(result.mode, state.mode);
    assert.strictEqual(result.mode, 'orchestration');
});

test('already in orchestration mode message', () => {
    resetMode();
    // Switch to orchestration
    handleModeCommand(['orchestration'], false, true);

    // Try to switch again
    const result = handleModeCommand(['orchestration'], false, true);

    assert.match(result, /Already in orchestration mode/);
});

test('mode switch message uses orchestration terminology', () => {
    resetMode();
    const result = handleModeCommand(['orchestration'], false, true);

    assert.match(result, /discussion.*orchestration/i);
    assert.match(result.toLowerCase(), /coordinate|delegate|orchestration/);
});

test('cli command can switch to orchestration', () => {
    resetMode();
    const result = handleModeCommand(['orchestration'], false, false);

    assert.match(result.toLowerCase(), /orchestration/);
    const state = loadState();
    assert.strictEqual(state.mode, Mode.GO);
});

test('all three names produce same result', () => {
    const modesToTest = ['orchestration', 'go', 'implementation'];

    modesToTest.forEach(modeName => {
        // Reset to discussion
        resetMode();

        // Switch to mode
        const result = handleModeCommand([modeName], true, true);

        // All should result in same state
        const state = loadState();
        assert.strictEqual(state.mode, Mode.GO, `Mode ${modeName} should set mode to GO`);
        assert.strictEqual(result.mode, 'orchestration', `JSON for ${modeName} should return 'orchestration'`);
    });
});

test('error message mentions orchestration', () => {
    resetMode();
    const result = handleModeCommand(['invalid'], false, true);

    assert.match(result.toLowerCase(), /orchestration/);
    assert.match(result, /Unknown mode: invalid/);
});
