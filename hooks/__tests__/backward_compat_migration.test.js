const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Mock the PROJECT_ROOT before requiring shared_state
const mockProjectRoot = path.join(os.tmpdir(), `cc-sessions-migration-test-${Date.now()}`);
process.env.CLAUDE_PROJECT_DIR = mockProjectRoot;

// Ensure directory exists
fs.mkdirSync(path.join(mockProjectRoot, 'sessions'), { recursive: true });

const {
    SessionsState,
    SessionsConfig,
    TriggerPhrases,
    Mode,
    TriggerCategory,
    loadState,
    loadConfig
} = require('../shared_state');

const stateFilePath = path.join(mockProjectRoot, 'sessions', 'sessions-state.json');
const configFilePath = path.join(mockProjectRoot, 'sessions', 'sessions-config.json');

test('SessionsState: migrate "implementation" to "orchestration" in mode field', () => {
    // RED: Old state file with "implementation"
    const oldState = {
        version: "0.3.6",
        mode: "implementation",  // Old value
        current_task: { path: null },
        todos: { active: [], stashed: [] },
        flags: {}
    };

    const state = SessionsState.fromDict(oldState);

    // Should be migrated to "orchestration"
    assert.strictEqual(state.mode, 'orchestration');
    assert.strictEqual(state.mode, Mode.GO);
});

test('SessionsState: keep "orchestration" mode unchanged', () => {
    // New state file with "orchestration"
    const newState = {
        version: "0.3.6",
        mode: "orchestration",
        current_task: { path: null },
        todos: { active: [], stashed: [] },
        flags: {}
    };

    const state = SessionsState.fromDict(newState);

    assert.strictEqual(state.mode, 'orchestration');
    assert.strictEqual(state.mode, Mode.GO);
});

test('SessionsState: keep "discussion" mode unchanged', () => {
    const state = SessionsState.fromDict({
        mode: "discussion",
        current_task: { path: null },
        todos: { active: [], stashed: [] },
        flags: {}
    });

    assert.strictEqual(state.mode, 'discussion');
    assert.strictEqual(state.mode, Mode.NO);
});

test('SessionsState: load old state file from disk and migrate', () => {
    // Clean first
    if (fs.existsSync(stateFilePath)) fs.unlinkSync(stateFilePath);

    // Write old state file
    const oldState = {
        version: "0.3.6",
        mode: "implementation",
        current_task: { path: null },
        todos: { active: [], stashed: [] },
        flags: {}
    };
    fs.writeFileSync(stateFilePath, JSON.stringify(oldState, null, 2));

    const state = loadState();

    assert.strictEqual(state.mode, 'orchestration');

    // Cleanup
    fs.unlinkSync(stateFilePath);
});

test('SessionsConfig: migrate "implementation_mode" to "orchestration_mode"', () => {
    // RED: Old config with "implementation_mode"
    const oldConfig = {
        trigger_phrases: {
            implementation_mode: ["yert", "go"],  // Old key
            discussion_mode: ["SILENCE"],
            task_creation: ["mek:"],
            task_startup: ["start^"],
            task_completion: ["finito"],
            context_compaction: ["squish"]
        },
        git_preferences: {},
        environment: {},
        features: {}
    };

    const config = SessionsConfig.fromDict(oldConfig);

    // Should be migrated to "orchestration_mode"
    assert.deepStrictEqual(config.trigger_phrases.orchestration_mode, ["yert", "go"]);
});

test('SessionsConfig: keep "orchestration_mode" unchanged if present', () => {
    const newConfig = {
        trigger_phrases: {
            orchestration_mode: ["yert"],  // New key
            discussion_mode: ["SILENCE"],
            task_creation: ["mek:"],
            task_startup: ["start^"],
            task_completion: ["finito"],
            context_compaction: ["squish"]
        }
    };

    const config = SessionsConfig.fromDict(newConfig);

    assert.deepStrictEqual(config.trigger_phrases.orchestration_mode, ["yert"]);
});

test('SessionsConfig: prefer "orchestration_mode" if both keys exist', () => {
    // Edge case: both keys present (shouldn't happen, but be defensive)
    const mixedConfig = {
        trigger_phrases: {
            implementation_mode: ["old1", "old2"],
            orchestration_mode: ["new1"],  // This should win
            discussion_mode: ["SILENCE"]
        }
    };

    const config = SessionsConfig.fromDict(mixedConfig);

    assert.deepStrictEqual(config.trigger_phrases.orchestration_mode, ["new1"]);
});

test('SessionsConfig: load old config file from disk and migrate', () => {
    // Clean first
    if (fs.existsSync(configFilePath)) fs.unlinkSync(configFilePath);

    // Write old config file
    const oldConfig = {
        trigger_phrases: {
            implementation_mode: ["yert"],
            discussion_mode: ["SILENCE"]
        },
        git_preferences: { default_branch: "main" },
        environment: {},
        features: {}
    };
    fs.writeFileSync(configFilePath, JSON.stringify(oldConfig, null, 2));

    const config = loadConfig();

    assert.deepStrictEqual(config.trigger_phrases.orchestration_mode, ["yert"]);

    // Cleanup
    fs.unlinkSync(configFilePath);
});

test('SessionsConfig: write migrated config back to disk', () => {
    // Clean first
    if (fs.existsSync(configFilePath)) fs.unlinkSync(configFilePath);

    // Write old config
    const oldConfig = {
        trigger_phrases: {
            implementation_mode: ["yert"],
            discussion_mode: ["SILENCE"]
        },
        git_preferences: { default_branch: "main" },
        environment: {},
        features: {}
    };
    fs.writeFileSync(configFilePath, JSON.stringify(oldConfig, null, 2));

    // Load config (triggers migration)
    const config = loadConfig();

    // Verify migration happened in memory
    assert.deepStrictEqual(config.trigger_phrases.orchestration_mode, ["yert"]);

    // Read file again to verify it was persisted
    const savedConfig = JSON.parse(fs.readFileSync(configFilePath, 'utf8'));
    assert.deepStrictEqual(savedConfig.trigger_phrases.orchestration_mode, ["yert"]);
    // Old key should be gone from file
    assert.strictEqual(savedConfig.trigger_phrases.implementation_mode, undefined);

    // Cleanup
    fs.unlinkSync(configFilePath);
});

test('TriggerPhrases: map "implement" to ORCHESTRATION_MODE', () => {
    const phrases = new TriggerPhrases();
    const category = phrases._coaxPhraseType('implement');
    assert.strictEqual(category, TriggerCategory.ORCHESTRATION_MODE);
});

test('TriggerPhrases: map "orchestration_mode" to ORCHESTRATION_MODE', () => {
    const phrases = new TriggerPhrases();
    const category = phrases._coaxPhraseType('orchestration_mode');
    assert.strictEqual(category, TriggerCategory.ORCHESTRATION_MODE);
});
