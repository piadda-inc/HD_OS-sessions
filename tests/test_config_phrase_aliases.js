#!/usr/bin/env node
/**
 * Test: config_commands.js phrase category aliasing
 *
 * Verifies that legacy "implementation_mode" category works as an alias
 * for "orchestration_mode" in all phrase operations (list/add/remove).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Setup mock project directory
const mockProjectRoot = path.join(os.tmpdir(), `cc-sessions-alias-test-${Date.now()}`);
process.env.CLAUDE_PROJECT_DIR = mockProjectRoot;
fs.mkdirSync(path.join(mockProjectRoot, 'sessions'), { recursive: true });

// Initialize with a test config
const configFilePath = path.join(mockProjectRoot, 'sessions', 'sessions-config.json');
const testConfig = {
    trigger_phrases: {
        orchestration_mode: ["yert"],
        discussion_mode: ["SILENCE"],
        task_creation: ["mek:"],
        task_startup: ["start^"],
        task_completion: ["finito"],
        context_compaction: ["squish"]
    },
    git_preferences: { default_branch: "main" },
    environment: { developer_name: "Test User", os: "linux", shell: "bash" },
    features: {},
    blocked_actions: { implementation_only_tools: [], bash_read_patterns: [], bash_write_patterns: [] }
};
fs.writeFileSync(configFilePath, JSON.stringify(testConfig, null, 2));

// Now require the module (after env setup)
const { handleConfigCommand } = require('../api/config_commands.js');

test('Alias: list implementation_mode shows orchestration_mode phrases', () => {
    const result = handleConfigCommand(['phrases', 'list', 'implementation_mode'], false, false);

    // Should show orchestration_mode phrases
    assert.ok(result.includes('orchestration_mode'));
    assert.ok(result.includes('yert'));
});

test('Alias: add phrase using implementation_mode', () => {
    // Add a phrase using the alias
    const addResult = handleConfigCommand(['phrases', 'add', 'implementation_mode', 'test-alias-phrase'], false, false);
    assert.ok(addResult.includes('Added'));
    assert.ok(addResult.includes('orchestration_mode'));

    // Verify it was added to orchestration_mode
    const listResult = handleConfigCommand(['phrases', 'list', 'orchestration_mode'], false, false);
    assert.ok(listResult.includes('test-alias-phrase'));

    // Cleanup: remove the test phrase
    handleConfigCommand(['phrases', 'remove', 'orchestration_mode', 'test-alias-phrase'], false, false);
});

test('Alias: remove phrase using implementation_mode', () => {
    // First add a phrase
    handleConfigCommand(['phrases', 'add', 'orchestration_mode', 'test-remove-phrase'], false, false);

    // Remove using the alias
    const removeResult = handleConfigCommand(['phrases', 'remove', 'implementation_mode', 'test-remove-phrase'], false, false);
    assert.ok(removeResult.includes('Removed'));
    assert.ok(removeResult.includes('orchestration_mode'));

    // Verify it was removed
    const listResult = handleConfigCommand(['phrases', 'list', 'orchestration_mode'], false, false);
    assert.ok(!listResult.includes('test-remove-phrase'));
});

test('Alias: help text documents implementation_mode alias', () => {
    const helpResult = handleConfigCommand(['phrases', 'help'], false, true);

    // Help should mention the alias
    assert.ok(helpResult.includes('implementation_mode'));
    assert.ok(helpResult.includes('aliases'));
    assert.ok(helpResult.includes('backward compatibility'));
});

test('Alias: both canonical and alias work identically', () => {
    // Add using canonical name
    handleConfigCommand(['phrases', 'add', 'orchestration_mode', 'canonical-test'], false, false);

    // List using alias - should see the same phrase
    const aliasListResult = handleConfigCommand(['phrases', 'list', 'implementation_mode'], false, false);
    assert.ok(aliasListResult.includes('canonical-test'));

    // Remove using canonical name
    handleConfigCommand(['phrases', 'remove', 'orchestration_mode', 'canonical-test'], false, false);
});

// Cleanup
process.on('exit', () => {
    try {
        fs.rmSync(mockProjectRoot, { recursive: true, force: true });
    } catch (err) {
        // Ignore cleanup errors
    }
});

console.log('All config phrase alias tests passed!');
