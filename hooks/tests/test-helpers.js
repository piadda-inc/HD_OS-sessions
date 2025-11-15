const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const WORKSPACE_ROOT = path.resolve(__dirname, '..', '..', '..');
const HOOK_PATH = path.join(WORKSPACE_ROOT, 'sessions', 'hooks', 'sessions_enforce.js');

function copyFileFromWorkspace(relativePath, projectDir) {
    const source = path.join(WORKSPACE_ROOT, relativePath);
    if (!fs.existsSync(source)) {
        return false;
    }
    const destination = path.join(projectDir, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const stats = fs.statSync(source);
    if (stats.isDirectory()) {
        fs.cpSync(source, destination, { recursive: true });
    } else {
        fs.copyFileSync(source, destination);
    }
    return true;
}

function ensureFixtureFile(relativePath, projectDir, defaultContents) {
    const destination = path.join(projectDir, relativePath);
    if (fs.existsSync(destination)) {
        return;
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, defaultContents, 'utf8');
}

function createTestProjectFixture() {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-test-'));
    const projectDir = path.join(tempRoot, 'project');
    fs.mkdirSync(projectDir, { recursive: true });

    // The .claude marker keeps consumers happy when they fall back to filesystem discovery
    fs.writeFileSync(path.join(projectDir, '.claude'), 'fixture\n', 'utf8');

    if (!copyFileFromWorkspace('sessions/sessions-state.json', projectDir)) {
        throw new Error('Unable to locate sessions/sessions-state.json in workspace');
    }
    copyFileFromWorkspace('sessions/sessions-config.json', projectDir);
    const stateDir = path.join(projectDir, 'sessions', 'state');
    fs.mkdirSync(stateDir, { recursive: true });

    // Provide the orchestration state directory + files that tests exercise.
    ensureFixtureFile(
        'sessions/state/execution_plan.json',
        projectDir,
        `${JSON.stringify({ groups: [] }, null, 2)}\n`
    );

    return {
        projectDir,
        stateFile: path.join(projectDir, 'sessions', 'sessions-state.json'),
        executionPlanPath: path.join(projectDir, 'sessions', 'state', 'execution_plan.json'),
        stateDir,
        cleanup: () => {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        },
    };
}

function withTestProjectFixture(testInterface) {
    let fixture = null;
    testInterface.beforeEach(() => {
        fixture = createTestProjectFixture();
    });
    testInterface.afterEach(() => {
        fixture?.cleanup();
        fixture = null;
    });
    return () => {
        if (!fixture) {
            throw new Error('Fixture not initialized');
        }
        return fixture;
    };
}

function readFixtureState(fixture) {
    return JSON.parse(fs.readFileSync(fixture.stateFile, 'utf8'));
}

function writeFixtureState(fixture, payload) {
    fs.writeFileSync(fixture.stateFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function updateFixtureState(fixture, updater) {
    const state = readFixtureState(fixture);
    updater(state);
    writeFixtureState(fixture, state);
}

function runHookWithFixture(fixture, payload, options = {}) {
    return spawnSync(process.execPath, [HOOK_PATH], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        cwd: options.cwd || WORKSPACE_ROOT,
        env: {
            ...process.env,
            CLAUDE_PROJECT_DIR: fixture.projectDir,
            ...options.env,
        },
    });
}

module.exports = {
    HOOK_PATH,
    WORKSPACE_ROOT,
    createTestProjectFixture,
    readFixtureState,
    writeFixtureState,
    updateFixtureState,
    runHookWithFixture,
    withTestProjectFixture,
};
