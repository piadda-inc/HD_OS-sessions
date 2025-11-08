#!/usr/bin/env node

const path = require('path');
const MetaLearningBridge = require('../lib/meta_learning_bridge');
const { PROJECT_ROOT, loadConfig } = require('../hooks/shared_state.js');

function parseDashboardArgs(args) {
  const opts = { rangeHours: 24, limit: 5, groupId: null, jsonFlag: false };
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === '--group' && args[i + 1]) {
      opts.groupId = args[i + 1];
      i += 1;
    } else if (token === '--range' && args[i + 1]) {
      const parsed = parseInt(args[i + 1], 10);
      if (!Number.isNaN(parsed)) {
        opts.rangeHours = Math.max(parsed, 1);
      }
      i += 1;
    } else if (token === '--limit' && args[i + 1]) {
      const parsed = parseInt(args[i + 1], 10);
      if (!Number.isNaN(parsed)) {
        opts.limit = Math.max(parsed, 1);
      }
      i += 1;
    } else if (token === '--json') {
      opts.jsonFlag = true;
    }
  }
  return opts;
}

function formatDashboard(snapshot) {
  const lines = [
    `Meta-learning dashboard for ${snapshot.group_id || 'default'} (last ${snapshot.range_hours}h)`,
    `Throughput: ${snapshot.kpis?.throughput ?? 0}`,
    `Success rate: ${(((snapshot.kpis?.success_rate ?? 0) * 100).toFixed(1))}%`,
    `Mean latency: ${(snapshot.kpis?.mean_latency_seconds ?? 0).toFixed(1)}s`,
    ''
  ];

  if (Array.isArray(snapshot.deltas) && snapshot.deltas.length) {
    lines.push('Recent deltas:');
    snapshot.deltas.forEach(delta => {
      const trend = delta.trend >= 0 ? `+${delta.trend.toFixed(2)}` : delta.trend.toFixed(2);
      lines.push(`  • ${delta.metric}: ${trend} (${delta.window})`);
    });
    lines.push('');
  }

  if (Array.isArray(snapshot.watch_items) && snapshot.watch_items.length) {
    lines.push('Watch items:');
    snapshot.watch_items.forEach(item => {
      lines.push(`  • [${item.severity || 'info'}] ${item.label} — ${item.summary}`);
    });
  }

  return lines.join('\n');
}

function formatMetaHelp() {
  return `Usage:
  sessions meta dashboard [--group <group-id>] [--range <hours>] [--limit <n>] [--json]

Examples:
  sessions meta dashboard --group pilot --range 48
  sessions meta dashboard --json`;
}

async function handleMetaCommand(args, jsonOutput = false) {
  if (!args || args.length === 0 || args[0].toLowerCase() === 'help') {
    return formatMetaHelp();
  }

  const rawSubcommand = args[0];
  const normalizedSubcommand = rawSubcommand.toLowerCase();
  if (rawSubcommand !== 'dashboard') {
    throw new Error(`Unknown meta subcommand: ${normalizedSubcommand}`);
  }

  const options = parseDashboardArgs(args.slice(1));
  const config = loadConfig();
  const feature = config.features?.meta_learning || {};
  if (!feature.enabled) {
    throw new Error('Meta-learning features are disabled in sessions-config.json (features.meta_learning.enabled)');
  }

  const bridge = new MetaLearningBridge({
    socketPath: feature.socket_path
      ? path.resolve(PROJECT_ROOT, feature.socket_path)
      : path.join(PROJECT_ROOT, 'sessions', '.meta-learning.sock'),
    requestTimeoutMs: feature.request_timeout_ms || 1800,
    reconnectDelayMs: feature.reconnect_delay_ms || 250,
  });

  try {
    const snapshot = await bridge.getDashboardSnapshot({
      group_id: options.groupId || feature.group_id || config.environment?.group_id || null,
      range_hours: options.rangeHours ?? feature.dashboard_default_range_hours,
      limit: options.limit ?? feature.dashboard_default_limit,
    });
    if (options.jsonFlag || jsonOutput) {
      return snapshot;
    }
    return formatDashboard(snapshot);
  } finally {
    await bridge.close();
  }
}

module.exports = { handleMetaCommand };
