#!/usr/bin/env node
/**
 * Tests for the JavaScript memory adapter implementations.
 *
 * These mirror the Python adapter tests to guarantee feature parity.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const { getClient } = require('../lib/memory');
const { GraphitiAdapter } = require('../lib/memory/graphiti_adapter');
const { NoopAdapter } = require('../lib/memory/noop_adapter');

const GRAPHITI_SHIM = `#!/usr/bin/env python3
import json
import os
import sys
import time
from pathlib import Path

def main():
    raw = sys.stdin.read()
    if not raw:
        raw = os.environ.get("GRAPHITI_PAYLOAD", "")
    if not raw:
        return 1
    payload = json.loads(raw)
    operation = (payload.get("operation") or "").lower()
    delay_env = os.environ.get(f"GRAPHITI_IPC_DELAY_{operation.upper()}") or os.environ.get("GRAPHITI_IPC_DELAY")
    if delay_env:
        try:
            time.sleep(float(delay_env))
        except ValueError:
            pass
    capture = os.environ.get("GRAPHITI_IPC_CAPTURE")
    if capture:
        Path(capture).write_text(json.dumps(payload))
    if os.environ.get(f"GRAPHITI_IPC_FAIL_{operation.upper()}") or os.environ.get("GRAPHITI_IPC_FAIL"):
        return 2
    if operation == "search":
        response = {"facts": [{"fact": f"Result for {payload.get('data', {}).get('query', '')}", "episode_name": "Fixture"}]}
    else:
        response = {"ok": True}
    sys.stdout.write(json.dumps(response))
    sys.stdout.flush()
    return 0

if __name__ == "__main__":
    sys.exit(main())
`;

function createShim() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graphiti-shim-'));
    const shimPath = path.join(dir, 'graphiti_local.js');
    fs.writeFileSync(shimPath, GRAPHITI_SHIM);
    fs.chmodSync(shimPath, 0o755);
    return shimPath;
}

function makeConfig(shimPath, overrides = {}) {
    return {
        enabled: true,
        provider: 'graphiti',
        graphiti_path: shimPath,
        auto_search: true,
        auto_store: 'task-completion',
        search_timeout_ms: 1500,
        store_timeout_s: 2.0,
        max_results: 5,
        group_id: 'unit-test',
        allow_code_snippets: true,
        sanitize_secrets: true,
        ...overrides
    };
}

function waitForFile(filePath) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const interval = setInterval(() => {
            if (fs.existsSync(filePath)) {
                clearInterval(interval);
                resolve();
            } else if (Date.now() - start > 2000) {
                clearInterval(interval);
                reject(new Error('Timed out waiting for file'));
            }
        }, 50);
    });
}

test('getClient returns NoopAdapter when disabled', () => {
    const client = getClient({ enabled: false });
    assert.ok(client instanceof NoopAdapter);
    assert.deepEqual(client.searchMemory('anything'), []);
    assert.equal(client.storeEpisode({ episode_id: 'noop' }), false);
});

test('GraphitiAdapter search returns results and sanitizes metadata', async () => {
    const shimPath = createShim();
    const capturePath = path.join(os.tmpdir(), `graphiti-capture-${Date.now()}.json`);
    process.env.GRAPHITI_IPC_CAPTURE = capturePath;

    try {
        const adapter = new GraphitiAdapter(makeConfig(shimPath));
        const results = await adapter.searchMemory('api integration', { metadata: { api_key: 'sk-unit' } });

        assert.ok(results.length > 0);
        assert.ok(results[0].fact.startsWith('Result for api integration'));
        const payload = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
        assert.equal(payload.operation, 'search');
        assert.equal(payload.data.metadata.api_key, '[REDACTED]');
    } finally {
        delete process.env.GRAPHITI_IPC_CAPTURE;
        if (fs.existsSync(capturePath)) fs.rmSync(capturePath);
    }
});

test('GraphitiAdapter search enforces timeout', async () => {
    const shimPath = createShim();
    process.env.GRAPHITI_IPC_DELAY_SEARCH = '2';
    const adapter = new GraphitiAdapter(makeConfig(shimPath));
    const start = performance.now();
    const results = await adapter.searchMemory('slow query');
    const duration = (performance.now() - start) / 1000;
    assert.equal(results.length, 0);
    assert.ok(duration < 2);
    delete process.env.GRAPHITI_IPC_DELAY_SEARCH;
});

test('GraphitiAdapter storeEpisode resolves after IPC completes', async () => {
    const shimPath = createShim();
    const capturePath = path.join(os.tmpdir(), `graphiti-store-${Date.now()}.json`);
    process.env.GRAPHITI_IPC_CAPTURE = capturePath;
    process.env.GRAPHITI_IPC_DELAY_STORE = '1.5';
    try {
        const adapter = new GraphitiAdapter(makeConfig(shimPath));

        const payload = {
            episode_id: 'ep-123',
            workspace_id: 'workspace',
            task_id: 'task-1',
            summary: 'did work',
            objectives: ['one', 'two'],
            timestamps: { completed_at: 'now' },
            api_key: 'sk-secret'
        };

        const start = performance.now();
        const result = await adapter.storeEpisode(payload);
        const duration = (performance.now() - start) / 1000;
        assert.equal(result, true);
        assert.ok(duration >= 1.2, `store resolved too quickly (${duration}s)`);
        assert.ok(duration < 2.5, `store should respect timeout (${duration}s)`);
        await waitForFile(capturePath);
        const stored = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
        assert.equal(stored.operation, 'store');
        assert.equal(stored.data.episode.api_key, '[REDACTED]');
    } finally {
        delete process.env.GRAPHITI_IPC_CAPTURE;
        delete process.env.GRAPHITI_IPC_DELAY_STORE;
        if (fs.existsSync(capturePath)) fs.rmSync(capturePath);
    }
});

test('GraphitiAdapter gracefully handles missing binary', async () => {
    const adapter = new GraphitiAdapter(makeConfig('/nonexistent-graphiti'));
    const results = await adapter.searchMemory('anything');
    assert.deepEqual(results, []);
    assert.equal(await adapter.storeEpisode({ episode_id: 'noop' }), false);
});
