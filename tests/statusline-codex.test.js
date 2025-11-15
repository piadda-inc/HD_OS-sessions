const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { mock } = test;

const {
    withTestProjectFixture,
} = require('../hooks/tests/test-helpers');

const useFixture = withTestProjectFixture(test);

function freshModule(modulePath) {
    const resolved = require.resolve(modulePath);
    delete require.cache[resolved];
    return require(modulePath);
}

function loadCodexTasksModule() {
    return freshModule('../hooks/daemon/codex_tasks.js');
}

function setupStatuslineWithCodexMocks(projectDir, { codexReturn, codexDisplay }) {
    delete require.cache[require.resolve('../hooks/shared_state.js')];
    delete require.cache[require.resolve('../hooks/daemon/statusline_handler.js')];
    delete require.cache[require.resolve('../hooks/daemon/codex_tasks.js')];

    process.env.CLAUDE_PROJECT_DIR = projectDir;

    const codexTasks = require('../hooks/daemon/codex_tasks.js');
    const restorers = [];
    if (codexReturn !== undefined) {
        const stub = mock.method(codexTasks, 'getCodexTasks', () => codexReturn);
        restorers.push(stub);
    }
    if (codexDisplay !== undefined) {
        const stub = mock.method(codexTasks, 'formatCodexTasks', () => codexDisplay);
        restorers.push(stub);
    }

    const handler = require('../hooks/daemon/statusline_handler.js');
    return {
        handler,
        restore: () => restorers.forEach(entry => entry.mock.restore()),
    };
}

test.afterEach(() => {
    delete process.env.CLAUDE_PROJECT_DIR;
    delete process.env.CODEX_DELEGATE_DB;
    delete process.env.CC_SESSIONS_CODEX_DB;
    delete process.env.CODEX_BACKGROUND_DB;
});

test.describe('getCodexTasks', { concurrency: false }, () => {
    test('returns empty result when sqlite query fails', () => {
        process.env.CODEX_DELEGATE_DB = '/tmp/codex.db';
        const resolvedDb = path.resolve('/tmp/codex.db');
        const fs = require('node:fs');
        const existsStub = mock.method(fs, 'existsSync', target => target === resolvedDb);
        const childProcess = require('node:child_process');
        const execStub = mock.method(childProcess, 'execFileSync', () => {
            throw new Error('boom');
        });

        try {
            const codexTasks = loadCodexTasksModule();
            const result = codexTasks.getCodexTasks({ force: true });
            assert.deepEqual(result, { running: 0, pending: 0, names: [] });
        } finally {
            existsStub.mock.restore();
            execStub.mock.restore();
        }
    });

    test('parses sqlite output into running and pending counts with sanitized names', () => {
        process.env.CODEX_DELEGATE_DB = '/tmp/codex.db';
        const resolvedDb = path.resolve('/tmp/codex.db');
        const fs = require('node:fs');
        const existsStub = mock.method(fs, 'existsSync', target => target === resolvedDb);
        const childProcess = require('node:child_process');
        const execStub = mock.method(childProcess, 'execFileSync', (cmd, args) => {
            const sql = args[args.length - 1];
            if (sql.startsWith('SELECT status')) {
                return ['status\tcount', 'running\t2', 'pending\t1'].join('\n');
            }
            if (sql.startsWith('SELECT name')) {
                return ['name\tstatus', 'analysis\trunning', 'review\tpending'].join('\n');
            }
            throw new Error('unexpected SQL');
        });

        try {
            const codexTasks = loadCodexTasksModule();
            const result = codexTasks.getCodexTasks({ force: true });
            assert.equal(result.running, 2);
            assert.equal(result.pending, 1);
            assert.deepEqual(result.names, [
                { name: 'analysis', status: 'running' },
                { name: 'review', status: 'pending' },
            ]);
        } finally {
            existsStub.mock.restore();
            execStub.mock.restore();
        }
    });

    test('returns accurate counts beyond display sample size', () => {
        process.env.CODEX_DELEGATE_DB = '/tmp/codex.db';
        const resolvedDb = path.resolve('/tmp/codex.db');
        const fs = require('node:fs');
        const existsStub = mock.method(fs, 'existsSync', target => target === resolvedDb);
        const childProcess = require('node:child_process');
        const execStub = mock.method(childProcess, 'execFileSync', (cmd, args) => {
            const sql = args[args.length - 1];
            if (sql.startsWith('SELECT status')) {
                return ['status\tcount', 'running\t10'].join('\n');
            }
            if (sql.startsWith('SELECT name')) {
                const rows = [
                    'name\tstatus',
                    'agent1\trunning',
                    'agent2\trunning',
                    'agent3\trunning',
                    'agent4\trunning',
                    'agent5\trunning',
                ];
                return rows.join('\n');
            }
            throw new Error('unexpected SQL');
        });

        try {
            const codexTasks = loadCodexTasksModule();
            const result = codexTasks.getCodexTasks({ force: true });
            assert.equal(result.running, 10);
            assert.equal(result.pending, 0);
            assert.equal(result.names.length, 5);
        } finally {
            existsStub.mock.restore();
            execStub.mock.restore();
        }
    });

    test('sanitizes control characters in task names', () => {
        process.env.CODEX_DELEGATE_DB = '/tmp/codex.db';
        const resolvedDb = path.resolve('/tmp/codex.db');
        const fs = require('node:fs');
        const existsStub = mock.method(fs, 'existsSync', target => target === resolvedDb);
        const childProcess = require('node:child_process');
        const execStub = mock.method(childProcess, 'execFileSync', (cmd, args) => {
            const sql = args[args.length - 1];
            if (sql.startsWith('SELECT status')) {
                return ['status\tcount', 'running\t1'].join('\n');
            }
            if (sql.startsWith('SELECT name')) {
                return ['name\tstatus', '\x07cleanup\trunning'].join('\n');
            }
            throw new Error('unexpected SQL');
        });

        try {
            const codexTasks = loadCodexTasksModule();
            const result = codexTasks.getCodexTasks({ force: true });
            assert.equal(result.names[0].name, 'cleanup');
        } finally {
            existsStub.mock.restore();
            execStub.mock.restore();
        }
    });

    test('sanitizes ANSI escape sequences in task names', () => {
        process.env.CODEX_DELEGATE_DB = '/tmp/codex.db';
        const resolvedDb = path.resolve('/tmp/codex.db');
        const fs = require('node:fs');
        const existsStub = mock.method(fs, 'existsSync', target => target === resolvedDb);
        const childProcess = require('node:child_process');
        const execStub = mock.method(childProcess, 'execFileSync', (cmd, args) => {
            const sql = args[args.length - 1];
            if (sql.startsWith('SELECT status')) {
                return ['status\tcount', 'pending\t1'].join('\n');
            }
            if (sql.startsWith('SELECT name')) {
                return ['name\tstatus', '\x1b[2Jdanger\tpending'].join('\n');
            }
            throw new Error('unexpected SQL');
        });

        try {
            const codexTasks = loadCodexTasksModule();
            const result = codexTasks.getCodexTasks({ force: true });
            assert.equal(result.names[0].name, 'danger');
        } finally {
            existsStub.mock.restore();
            execStub.mock.restore();
        }
    });
});


test.describe('formatCodexTasks', () => {
    test('uses Nerd Font icon and running label', () => {
        const codexTasks = loadCodexTasksModule();
        const output = codexTasks.formatCodexTasks(
            { running: 1, pending: 0, names: [{ name: 'analysis' }] },
            { iconStyle: 'nerd_fonts' }
        );
        assert.match(output, /󱁤 Codex: 1 running/);
        assert.match(output, /\(analysis\)/);
    });

    test('uses ASCII fallback with pending label', () => {
        const codexTasks = loadCodexTasksModule();
        const output = codexTasks.formatCodexTasks(
            { running: 0, pending: 1, names: [{ name: 'plan' }] },
            { iconStyle: 'ascii' }
        );
        assert.equal(output, 'Codex: 1 pending (plan)');
    });

    test('describes mixed statuses as active with emoji icon', () => {
        const codexTasks = loadCodexTasksModule();
        const output = codexTasks.formatCodexTasks(
            {
                running: 1,
                pending: 1,
                names: [{ name: 'analysis' }, { name: 'review' }],
            },
            { iconStyle: 'emoji' }
        );
        assert.match(output, /🤖 Codex: 2 active/);
        assert.match(output, /\(analysis, review\)/);
    });

    test('truncates long task lists and appends +N more', () => {
        const codexTasks = loadCodexTasksModule();
        const tasks = {
            running: 3,
            pending: 1,
            names: [
                { name: 'analysis' },
                { name: 'planning session' },
                { name: 'regression sweep' },
                { name: 'doc updates' },
            ],
        };
        const output = codexTasks.formatCodexTasks(tasks, { iconStyle: 'emoji' });
        assert.match(output, /\+\d+ more/);
    });

    test('returns empty string when no tasks available', () => {
        const codexTasks = loadCodexTasksModule();
        assert.equal(codexTasks.formatCodexTasks({ running: 0, pending: 0, names: [] }), '');
    });
});

test.describe('statusline integration', { concurrency: false }, () => {
    test('includes Codex task summary when formatter returns data', () => {
        const fixture = useFixture();
        const { handler, restore } = setupStatuslineWithCodexMocks(fixture.projectDir, {
            codexReturn: { running: 1, pending: 0, names: [] },
            codexDisplay: 'CODEx tasks',
        });

        try {
            const output = handler.renderStatusline({
                cwd: fixture.projectDir,
                model: { display_name: 'Sonnet' },
            });
            assert.match(output, /CODEx tasks/);
        } finally {
            restore();
        }
    });

    test('omits Codex section when formatter is empty', () => {
        const fixture = useFixture();
        const { handler, restore } = setupStatuslineWithCodexMocks(fixture.projectDir, {
            codexReturn: { running: 0, pending: 0, names: [] },
            codexDisplay: '',
        });

        try {
            const output = handler.renderStatusline({
                cwd: fixture.projectDir,
                model: { display_name: 'Sonnet' },
            });
            assert.doesNotMatch(output, /Codex tasks/i);
        } finally {
            restore();
        }
    });
});
