#!/usr/bin/env node
'use strict';

const { test, describe, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Mock MetaLearningBridge
let mockBridge = null;
let mockBridgeConstructor = null;
let mockGetDashboardSnapshot = null;
let mockClose = null;

// Mock shared_state
let mockLoadConfig = null;

// Store original require
const originalRequire = Module.prototype.require;
let handleMetaCommand = null;

describe('Meta Commands', () => {
  before(() => {
    // Setup global mock for require
    Module.prototype.require = function(id) {
      if (id === '../lib/meta_learning_bridge' || id.endsWith('/meta_learning_bridge')) {
        return mockBridgeConstructor;
      }
      if (id === '../hooks/shared_state.js' || id.endsWith('/shared_state.js')) {
        const original = originalRequire.apply(this, arguments);
        return {
          ...original,
          loadConfig: mockLoadConfig || original.loadConfig,
          PROJECT_ROOT: mockLoadConfig ? '/test/project' : original.PROJECT_ROOT,
        };
      }
      return originalRequire.apply(this, arguments);
    };
  });

  beforeEach(() => {
    // Reset mocks
    mockGetDashboardSnapshot = null;
    mockClose = null;

    // Create mock bridge class
    mockBridgeConstructor = function(options) {
      mockBridge = {
        options,
        getDashboardSnapshot: async (query) => {
          if (mockGetDashboardSnapshot) {
            return await mockGetDashboardSnapshot(query);
          }
          return {
            group_id: query.group_id || 'default',
            range_hours: query.range_hours || 24,
            kpis: {
              throughput: 42,
              success_rate: 0.85,
              mean_latency_seconds: 2.5,
            },
            deltas: [
              { metric: 'success_rate', trend: 0.05, window: '24h' },
              { metric: 'mean_latency', trend: -0.3, window: '24h' },
            ],
            watch_items: [
              { severity: 'warning', label: 'High latency', summary: 'Mean latency above threshold' },
            ],
          };
        },
        close: async () => {
          if (mockClose) {
            return await mockClose();
          }
        },
      };
      return mockBridge;
    };

    // Mock shared_state.loadConfig
    mockLoadConfig = () => ({
      features: {
        meta_learning: {
          enabled: true,
          request_timeout_ms: 1800,
          reconnect_delay_ms: 250,
          group_id: 'test-group',
          dashboard_default_range_hours: 24,
          dashboard_default_limit: 5,
        },
      },
      environment: {
        group_id: 'env-group',
      },
    });

    // Clear module cache to force reload
    delete require.cache[require.resolve('../api/meta_commands')];
    ({ handleMetaCommand } = require('../api/meta_commands'));
  });

  afterEach(() => {
    mockBridge = null;
    // Clear cache after each test
    delete require.cache[require.resolve('../api/meta_commands')];
  });

  describe('Help command', () => {
    test('returns help with no args', async () => {
      const { handleMetaCommand } = require('../api/meta_commands');
      const result = await handleMetaCommand([]);
      assert.ok(result.includes('Usage:'));
      assert.ok(result.includes('sessions meta dashboard'));
      assert.ok(result.includes('Examples:'));
    });

    test('returns help with help arg', async () => {
      const { handleMetaCommand } = require('../api/meta_commands');
      const result = await handleMetaCommand(['help']);
      assert.ok(result.includes('Usage:'));
      assert.ok(result.includes('sessions meta dashboard'));
    });

    test('returns help with HELP arg (case insensitive)', async () => {
      const { handleMetaCommand } = require('../api/meta_commands');
      const result = await handleMetaCommand(['HELP']);
      assert.ok(result.includes('Usage:'));
    });
  });

  describe('Dashboard command', () => {
    test('executes dashboard with default options', async () => {
      const result = await handleMetaCommand(['dashboard']);

      assert.ok(typeof result === 'string');
      assert.ok(result.includes('Meta-learning dashboard'));
      assert.ok(result.includes('Throughput: 42'));
      assert.ok(result.includes('Success rate: 85.0%'));
      assert.ok(result.includes('Mean latency: 2.5s'));
      assert.ok(result.includes('Recent deltas:'));
      assert.ok(result.includes('Watch items:'));
    });

    test('executes dashboard with custom group', async () => {
      mockGetDashboardSnapshot = async (query) => {
        assert.strictEqual(query.group_id, 'custom-group');
        return {
          group_id: 'custom-group',
          range_hours: 24,
          kpis: { throughput: 10, success_rate: 0.9, mean_latency_seconds: 1.2 },
          deltas: [],
          watch_items: [],
        };
      };

      const result = await handleMetaCommand(['dashboard', '--group', 'custom-group']);
      assert.ok(result.includes('custom-group'));
    });

    test('executes dashboard with custom range', async () => {
      mockGetDashboardSnapshot = async (query) => {
        assert.strictEqual(query.range_hours, 48);
        return {
          group_id: 'test-group',
          range_hours: 48,
          kpis: { throughput: 20, success_rate: 0.8, mean_latency_seconds: 3.0 },
          deltas: [],
          watch_items: [],
        };
      };

      const result = await handleMetaCommand(['dashboard', '--range', '48']);
      assert.ok(result.includes('last 48h'));
    });

    test('executes dashboard with custom limit', async () => {
      mockGetDashboardSnapshot = async (query) => {
        assert.strictEqual(query.limit, 10);
        return {
          group_id: 'test-group',
          range_hours: 24,
          kpis: { throughput: 15, success_rate: 0.75, mean_latency_seconds: 2.0 },
          deltas: [],
          watch_items: [],
        };
      };

      const result = await handleMetaCommand(['dashboard', '--limit', '10']);
      assert.ok(result);
    });

    test('executes dashboard with JSON output', async () => {
      const result = await handleMetaCommand(['dashboard', '--json']);

      assert.ok(typeof result === 'object');
      assert.strictEqual(result.kpis.throughput, 42);
      assert.strictEqual(result.kpis.success_rate, 0.85);
      assert.ok(Array.isArray(result.deltas));
      assert.ok(Array.isArray(result.watch_items));
    });

    test('executes dashboard with jsonOutput parameter', async () => {
      const result = await handleMetaCommand(['dashboard'], true);

      assert.ok(typeof result === 'object');
      assert.strictEqual(result.kpis.throughput, 42);
    });

    test('executes dashboard with combined options', async () => {
      mockGetDashboardSnapshot = async (query) => {
        assert.strictEqual(query.group_id, 'pilot');
        assert.strictEqual(query.range_hours, 72);
        assert.strictEqual(query.limit, 15);
        return {
          group_id: 'pilot',
          range_hours: 72,
          kpis: { throughput: 100, success_rate: 0.95, mean_latency_seconds: 1.5 },
          deltas: [],
          watch_items: [],
        };
      };

      const result = await handleMetaCommand(['dashboard', '--group', 'pilot', '--range', '72', '--limit', '15']);
      assert.ok(result.includes('pilot'));
      assert.ok(result.includes('last 72h'));
    });

    test('validates bridge options are passed correctly', async () => {
      await handleMetaCommand(['dashboard']);

      assert.ok(mockBridge);
      assert.strictEqual(mockBridge.options.socketPath, '/test/project/sessions/.meta-learning.sock');
      assert.strictEqual(mockBridge.options.requestTimeoutMs, 1800);
      assert.strictEqual(mockBridge.options.reconnectDelayMs, 250);
    });

    test('closes bridge after execution', async () => {
      let closeCalled = false;
      mockClose = async () => {
        closeCalled = true;
      };

      await handleMetaCommand(['dashboard']);
      assert.strictEqual(closeCalled, true);
    });

    test('closes bridge even if getDashboardSnapshot throws', async () => {
      let closeCalled = false;
      mockClose = async () => {
        closeCalled = true;
      };
      mockGetDashboardSnapshot = async () => {
        throw new Error('Test error');
      };

      await assert.rejects(handleMetaCommand(['dashboard']), {
        message: 'Test error',
      });
      assert.strictEqual(closeCalled, true);
    });
  });

  describe('Format dashboard output', () => {
    test('formats dashboard with all sections', async () => {
      const result = await handleMetaCommand(['dashboard']);

      const lines = result.split('\n');
      assert.ok(lines.some(l => l.includes('Meta-learning dashboard')));
      assert.ok(lines.some(l => l.includes('Throughput:')));
      assert.ok(lines.some(l => l.includes('Success rate:')));
      assert.ok(lines.some(l => l.includes('Mean latency:')));
      assert.ok(lines.some(l => l.includes('Recent deltas:')));
      assert.ok(lines.some(l => l.includes('Watch items:')));
    });

    test('formats dashboard with empty deltas', async () => {
      mockGetDashboardSnapshot = async () => ({
        group_id: 'test',
        range_hours: 24,
        kpis: { throughput: 5, success_rate: 0.8, mean_latency_seconds: 1.0 },
        deltas: [],
        watch_items: [],
      });

      const result = await handleMetaCommand(['dashboard']);
      assert.ok(!result.includes('Recent deltas:'));
    });

    test('formats dashboard with empty watch items', async () => {
      mockGetDashboardSnapshot = async () => ({
        group_id: 'test',
        range_hours: 24,
        kpis: { throughput: 5, success_rate: 0.8, mean_latency_seconds: 1.0 },
        deltas: [{ metric: 'test', trend: 0.1, window: '1h' }],
        watch_items: [],
      });

      const result = await handleMetaCommand(['dashboard']);
      assert.ok(!result.includes('Watch items:'));
    });

    test('formats positive and negative trends correctly', async () => {
      mockGetDashboardSnapshot = async () => ({
        group_id: 'test',
        range_hours: 24,
        kpis: { throughput: 5, success_rate: 0.8, mean_latency_seconds: 1.0 },
        deltas: [
          { metric: 'positive', trend: 0.15, window: '24h' },
          { metric: 'negative', trend: -0.25, window: '24h' },
        ],
        watch_items: [],
      });

      const result = await handleMetaCommand(['dashboard']);
      assert.ok(result.includes('+0.15'));
      assert.ok(result.includes('-0.25'));
    });

    test('formats watch item severities', async () => {
      mockGetDashboardSnapshot = async () => ({
        group_id: 'test',
        range_hours: 24,
        kpis: { throughput: 5, success_rate: 0.8, mean_latency_seconds: 1.0 },
        deltas: [],
        watch_items: [
          { severity: 'error', label: 'Critical', summary: 'System down' },
          { severity: 'warning', label: 'High load', summary: 'CPU at 90%' },
          { label: 'Info', summary: 'No severity field' },
        ],
      });

      const result = await handleMetaCommand(['dashboard']);
      assert.ok(result.includes('[error]'));
      assert.ok(result.includes('[warning]'));
      assert.ok(result.includes('[info]'));
    });
  });

  describe('Argument parsing', () => {
    test('handles invalid range gracefully', async () => {
      mockGetDashboardSnapshot = async (query) => {
        // Should default to minimum of 1
        assert.ok(query.range_hours >= 1);
        return {
          group_id: 'test',
          range_hours: query.range_hours,
          kpis: { throughput: 0, success_rate: 0, mean_latency_seconds: 0 },
          deltas: [],
          watch_items: [],
        };
      };

      await handleMetaCommand(['dashboard', '--range', 'invalid']);
      await handleMetaCommand(['dashboard', '--range', '-5']);
      await handleMetaCommand(['dashboard', '--range', '0']);
    });

    test('handles missing argument values', async () => {
      // Missing value should be ignored, use defaults
      const result = await handleMetaCommand(['dashboard', '--group']);
      assert.ok(result);
    });

    test('handles multiple json flags', async () => {
      const result = await handleMetaCommand(['dashboard', '--json', '--json']);
      assert.ok(typeof result === 'object');
    });
  });

  describe('Configuration handling', () => {
    test('throws error if meta-learning is disabled', async () => {
      mockLoadConfig = () => ({
        features: {
          meta_learning: {
            enabled: false,
          },
        },
      });

      // Need to reload module to pick up new mock
      delete require.cache[require.resolve('../api/meta_commands')];
      const { handleMetaCommand: reloadedHandler } = require('../api/meta_commands');

      await assert.rejects(reloadedHandler(['dashboard']), {
        message: /Meta-learning features are disabled/,
      });

      // Restore
      delete require.cache[require.resolve('../api/meta_commands')];
    });

    test('uses feature.socket_path when available', async () => {
      mockLoadConfig = () => ({
        features: {
          meta_learning: {
            enabled: true,
            socket_path: 'custom/path.sock',
          },
        },
      });

      delete require.cache[require.resolve('../api/meta_commands')];
      const { handleMetaCommand: reloadedHandler } = require('../api/meta_commands');

      await reloadedHandler(['dashboard']);
      assert.ok(mockBridge.options.socketPath.includes('custom/path.sock'));

      delete require.cache[require.resolve('../api/meta_commands')];
    });

    test('uses default socket path when not configured', async () => {
      mockLoadConfig = () => ({
        features: {
          meta_learning: {
            enabled: true,
          },
        },
      });

      delete require.cache[require.resolve('../api/meta_commands')];
      const { handleMetaCommand: reloadedHandler } = require('../api/meta_commands');

      await reloadedHandler(['dashboard']);
      assert.ok(mockBridge.options.socketPath.includes('.meta-learning.sock'));

      delete require.cache[require.resolve('../api/meta_commands')];
    });

    test('uses group_id from options over config', async () => {
      mockGetDashboardSnapshot = async (query) => {
        assert.strictEqual(query.group_id, 'override-group');
        return {
          group_id: 'override-group',
          range_hours: 24,
          kpis: { throughput: 0, success_rate: 0, mean_latency_seconds: 0 },
          deltas: [],
          watch_items: [],
        };
      };

      await handleMetaCommand(['dashboard', '--group', 'override-group']);
    });

    test('uses feature.group_id when no option provided', async () => {
      mockGetDashboardSnapshot = async (query) => {
        assert.strictEqual(query.group_id, 'test-group');
        return {
          group_id: 'test-group',
          range_hours: 24,
          kpis: { throughput: 0, success_rate: 0, mean_latency_seconds: 0 },
          deltas: [],
          watch_items: [],
        };
      };

      await handleMetaCommand(['dashboard']);
    });

    test('falls back to environment.group_id', async () => {
      mockLoadConfig = () => ({
        features: {
          meta_learning: {
            enabled: true,
          },
        },
        environment: {
          group_id: 'env-fallback',
        },
      });

      mockGetDashboardSnapshot = async (query) => {
        assert.strictEqual(query.group_id, 'env-fallback');
        return {
          group_id: 'env-fallback',
          range_hours: 24,
          kpis: { throughput: 0, success_rate: 0, mean_latency_seconds: 0 },
          deltas: [],
          watch_items: [],
        };
      };

      delete require.cache[require.resolve('../api/meta_commands')];
      const { handleMetaCommand: reloadedHandler } = require('../api/meta_commands');

      await reloadedHandler(['dashboard']);

      delete require.cache[require.resolve('../api/meta_commands')];
    });
  });

  describe('Error handling', () => {
    test('throws error for unknown subcommand', async () => {
      await assert.rejects(handleMetaCommand(['unknown']), {
        message: /Unknown meta subcommand: unknown/,
      });
    });

    test('throws error for unknown subcommand (case preserved)', async () => {
      await assert.rejects(handleMetaCommand(['DASHBOARD']), {
        message: /Unknown meta subcommand: dashboard/,
      });
    });
  });
});
