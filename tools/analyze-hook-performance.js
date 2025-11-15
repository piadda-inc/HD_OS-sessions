#!/usr/bin/env node
/**
 * Hook performance analysis tool
 *
 * Analyzes benchmark logs to identify performance bottlenecks.
 *
 * Usage:
 *   node analyze-hook-performance.js summary      - Show overall statistics
 *   node analyze-hook-performance.js timeline     - Show call timeline
 *   node analyze-hook-performance.js slow [N]     - Show N slowest calls (default: 20)
 *   node analyze-hook-performance.js statusline   - Statusline-specific analysis
 *   node analyze-hook-performance.js clear        - Clear benchmark log
 */

const fs = require('fs');
const path = require('path');

const BENCHMARK_LOG = path.join(process.env.HOME || '/tmp', '.claude', 'hooks-benchmark.jsonl');

/**
 * Load all benchmark entries from the log
 * @returns {Array} - Array of parsed log entries
 */
function loadBenchmarkLog() {
    if (!fs.existsSync(BENCHMARK_LOG)) {
        console.error(`No benchmark log found at: ${BENCHMARK_LOG}`);
        console.error('Run hooks with CC_SESSIONS_BENCHMARK=1 to collect data.');
        return [];
    }

    const content = fs.readFileSync(BENCHMARK_LOG, 'utf8');
    const lines = content.trim().split('\n').filter(line => line.trim());

    return lines.map(line => {
        try {
            return JSON.parse(line);
        } catch (error) {
            console.error(`Failed to parse line: ${line}`);
            return null;
        }
    }).filter(entry => entry !== null);
}

/**
 * Calculate statistics for a set of durations
 * @param {Array<number>} durations - Array of duration values
 * @returns {Object} - Statistics object
 */
function calculateStats(durations) {
    if (durations.length === 0) {
        return { count: 0, min: 0, max: 0, avg: 0, p50: 0, p95: 0, p99: 0, total: 0 };
    }

    const sorted = durations.slice().sort((a, b) => a - b);
    const sum = sorted.reduce((acc, val) => acc + val, 0);

    return {
        count: sorted.length,
        min: sorted[0],
        max: sorted[sorted.length - 1],
        avg: sum / sorted.length,
        p50: sorted[Math.floor(sorted.length * 0.5)],
        p95: sorted[Math.floor(sorted.length * 0.95)],
        p99: sorted[Math.floor(sorted.length * 0.99)],
        total: sum
    };
}

/**
 * Format duration in milliseconds with appropriate precision
 * @param {number} ms - Duration in milliseconds
 * @returns {string} - Formatted duration
 */
function formatDuration(ms) {
    if (ms < 0.001) return `${(ms * 1000).toFixed(3)}μs`;
    if (ms < 1) return `${ms.toFixed(3)}ms`;
    if (ms < 1000) return `${ms.toFixed(2)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * Display summary statistics grouped by hook
 */
function showSummary() {
    const entries = loadBenchmarkLog();
    if (entries.length === 0) return;

    console.log('=== HOOK PERFORMANCE SUMMARY ===\n');

    // Group entries by hook name
    const byHook = new Map();
    for (const entry of entries) {
        if (!byHook.has(entry.hook)) {
            byHook.set(entry.hook, []);
        }
        byHook.get(entry.hook).push(entry.duration_ms);
    }

    // Calculate stats for each hook
    const hookStats = [];
    for (const [hookName, durations] of byHook.entries()) {
        const stats = calculateStats(durations);
        hookStats.push({ hook: hookName, ...stats });
    }

    // Sort by total time (most impactful first)
    hookStats.sort((a, b) => b.total - a.total);

    // Display table
    console.log('Hook                  | Count |    Min |    Avg |    P95 |    P99 |    Max |  Total');
    console.log('----------------------|-------|--------|--------|--------|--------|--------|--------');

    for (const stats of hookStats) {
        console.log(
            `${stats.hook.padEnd(20)} | ` +
            `${String(stats.count).padStart(5)} | ` +
            `${formatDuration(stats.min).padStart(6)} | ` +
            `${formatDuration(stats.avg).padStart(6)} | ` +
            `${formatDuration(stats.p95).padStart(6)} | ` +
            `${formatDuration(stats.p99).padStart(6)} | ` +
            `${formatDuration(stats.max).padStart(6)} | ` +
            `${formatDuration(stats.total).padStart(6)}`
        );
    }

    console.log('\n=== OVERALL ===');
    const allDurations = entries.map(e => e.duration_ms);
    const overall = calculateStats(allDurations);
    console.log(`Total calls: ${overall.count}`);
    console.log(`Total time: ${formatDuration(overall.total)}`);
    console.log(`Average: ${formatDuration(overall.avg)}`);
    console.log(`P95: ${formatDuration(overall.p95)}`);
    console.log(`P99: ${formatDuration(overall.p99)}`);
}

/**
 * Show timeline of hook calls
 */
function showTimeline() {
    const entries = loadBenchmarkLog();
    if (entries.length === 0) return;

    console.log('=== HOOK CALL TIMELINE ===\n');
    console.log('Timestamp                | Hook                  | Duration | Status | Metadata');
    console.log('-------------------------|----------------------|----------|--------|----------');

    for (const entry of entries) {
        const timestamp = new Date(entry.timestamp).toISOString().slice(11, 23); // HH:MM:SS.mmm
        const metadata = Object.entries(entry)
            .filter(([key]) => !['timestamp', 'hook', 'duration_ms', 'status'].includes(key))
            .map(([key, val]) => `${key}=${val}`)
            .join(', ');

        console.log(
            `${timestamp} | ` +
            `${entry.hook.padEnd(20)} | ` +
            `${formatDuration(entry.duration_ms).padStart(8)} | ` +
            `${(entry.status || 'ok').padEnd(6)} | ` +
            metadata
        );
    }
}

/**
 * Show slowest hook calls
 * @param {number} limit - Number of entries to show
 */
function showSlowest(limit = 20) {
    const entries = loadBenchmarkLog();
    if (entries.length === 0) return;

    // Sort by duration (slowest first)
    const sorted = entries.slice().sort((a, b) => b.duration_ms - a.duration_ms);
    const toShow = sorted.slice(0, limit);

    console.log(`=== ${limit} SLOWEST HOOK CALLS ===\n`);
    console.log('Timestamp                | Hook                  | Duration | Metadata');
    console.log('-------------------------|----------------------|----------|----------');

    for (const entry of toShow) {
        const timestamp = new Date(entry.timestamp).toISOString().slice(11, 23);
        const metadata = Object.entries(entry)
            .filter(([key]) => !['timestamp', 'hook', 'duration_ms', 'status'].includes(key))
            .map(([key, val]) => `${key}=${val}`)
            .join(', ');

        console.log(
            `${timestamp} | ` +
            `${entry.hook.padEnd(20)} | ` +
            `${formatDuration(entry.duration_ms).padStart(8)} | ` +
            metadata
        );
    }
}

/**
 * Statusline-specific analysis
 */
function showStatuslineAnalysis() {
    const entries = loadBenchmarkLog();
    const statuslineEntries = entries.filter(e => e.hook.startsWith('statusline'));

    if (statuslineEntries.length === 0) {
        console.log('No statusline entries found.');
        return;
    }

    console.log('=== STATUSLINE PERFORMANCE ANALYSIS ===\n');

    // Overall stats
    const durations = statuslineEntries.map(e => e.duration_ms);
    const stats = calculateStats(durations);

    console.log('Overall Statistics:');
    console.log(`  Calls: ${stats.count}`);
    console.log(`  Average: ${formatDuration(stats.avg)}`);
    console.log(`  P50: ${formatDuration(stats.p50)}`);
    console.log(`  P95: ${formatDuration(stats.p95)}`);
    console.log(`  P99: ${formatDuration(stats.p99)}`);
    console.log(`  Max: ${formatDuration(stats.max)}`);
    console.log(`  Total: ${formatDuration(stats.total)}`);

    // Cache hit rate
    const cacheEntries = statuslineEntries.filter(e => e.cache_hit !== undefined);
    if (cacheEntries.length > 0) {
        const hits = cacheEntries.filter(e => e.cache_hit === true).length;
        const misses = cacheEntries.length - hits;
        const hitRate = (hits / cacheEntries.length) * 100;

        console.log('\nCache Statistics:');
        console.log(`  Hits: ${hits} (${hitRate.toFixed(1)}%)`);
        console.log(`  Misses: ${misses} (${(100 - hitRate).toFixed(1)}%)`);

        // Compare hit vs miss performance
        const hitDurations = cacheEntries.filter(e => e.cache_hit).map(e => e.duration_ms);
        const missDurations = cacheEntries.filter(e => !e.cache_hit).map(e => e.duration_ms);

        if (hitDurations.length > 0 && missDurations.length > 0) {
            const hitStats = calculateStats(hitDurations);
            const missStats = calculateStats(missDurations);

            console.log('\nCache Hit Performance:');
            console.log(`  Average: ${formatDuration(hitStats.avg)}`);
            console.log(`  P95: ${formatDuration(hitStats.p95)}`);

            console.log('\nCache Miss Performance:');
            console.log(`  Average: ${formatDuration(missStats.avg)}`);
            console.log(`  P95: ${formatDuration(missStats.p95)}`);

            const speedup = missStats.avg / hitStats.avg;
            console.log(`\nCache speedup: ${speedup.toFixed(1)}x`);
        }
    }

    // Call frequency analysis (calls per second)
    if (statuslineEntries.length > 1) {
        const first = new Date(statuslineEntries[0].timestamp);
        const last = new Date(statuslineEntries[statuslineEntries.length - 1].timestamp);
        const durationSeconds = (last - first) / 1000;
        const callsPerSecond = statuslineEntries.length / durationSeconds;

        console.log('\nCall Frequency:');
        console.log(`  Duration: ${durationSeconds.toFixed(1)}s`);
        console.log(`  Calls/second: ${callsPerSecond.toFixed(2)}`);

        // Detect bursts (5+ calls within 100ms)
        let burstCount = 0;
        for (let i = 0; i < statuslineEntries.length - 4; i++) {
            const windowStart = new Date(statuslineEntries[i].timestamp);
            const windowEnd = new Date(statuslineEntries[i + 4].timestamp);
            if (windowEnd - windowStart <= 100) {
                burstCount++;
            }
        }

        if (burstCount > 0) {
            console.log(`  Bursts detected: ${burstCount} (5+ calls within 100ms)`);
        }
    }
}

/**
 * Clear the benchmark log
 */
function clearLog() {
    if (fs.existsSync(BENCHMARK_LOG)) {
        fs.unlinkSync(BENCHMARK_LOG);
        console.log('Benchmark log cleared.');
    } else {
        console.log('No benchmark log to clear.');
    }
}

// CLI handling
const command = process.argv[2] || 'summary';
const arg = process.argv[3];

switch (command) {
    case 'summary':
        showSummary();
        break;
    case 'timeline':
        showTimeline();
        break;
    case 'slow':
        const limit = arg ? parseInt(arg, 10) : 20;
        showSlowest(limit);
        break;
    case 'statusline':
        showStatuslineAnalysis();
        break;
    case 'clear':
        clearLog();
        break;
    default:
        console.error('Unknown command:', command);
        console.error('\nUsage:');
        console.error('  node analyze-hook-performance.js summary      - Show overall statistics');
        console.error('  node analyze-hook-performance.js timeline     - Show call timeline');
        console.error('  node analyze-hook-performance.js slow [N]     - Show N slowest calls');
        console.error('  node analyze-hook-performance.js statusline   - Statusline-specific analysis');
        console.error('  node analyze-hook-performance.js clear        - Clear benchmark log');
        process.exit(1);
}
