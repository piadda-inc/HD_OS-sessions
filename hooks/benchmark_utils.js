#!/usr/bin/env node
/**
 * Benchmark utilities for measuring hook performance
 *
 * Provides high-resolution timing with minimal overhead.
 * Controlled by CC_SESSIONS_BENCHMARK env var.
 */

const fs = require('fs');
const path = require('path');

// Only enable benchmarking if explicitly requested
const ENABLED = process.env.CC_SESSIONS_BENCHMARK === '1';
const BENCHMARK_LOG = path.join(process.env.HOME || '/tmp', '.claude', 'hooks-benchmark.jsonl');

/**
 * Log a hook performance entry
 * @param {string} hookName - Name of the hook (e.g., 'statusline', 'sessions_enforce')
 * @param {number} durationMs - Duration in milliseconds (will be rounded to 3 decimals)
 * @param {Object} metadata - Additional metadata (status, cache_hit, input_size, etc.)
 */
function logHookPerformance(hookName, durationMs, metadata = {}) {
    if (!ENABLED) return;

    const entry = {
        timestamp: new Date().toISOString(),
        hook: hookName,
        duration_ms: parseFloat(durationMs.toFixed(3)),
        ...metadata
    };

    try {
        // Ensure directory exists
        const dir = path.dirname(BENCHMARK_LOG);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        fs.appendFileSync(BENCHMARK_LOG, JSON.stringify(entry) + '\n');
    } catch (error) {
        // Silently ignore benchmark logging failures to avoid disrupting hooks
    }
}

/**
 * Wrap a function with timing instrumentation
 * @param {string} hookName - Name of the hook being measured
 * @param {Function} fn - Function to execute and measure
 * @param {Object} metadata - Additional metadata to log
 * @returns {*} - Return value of fn()
 */
function withTiming(hookName, fn, metadata = {}) {
    if (!ENABLED) {
        return fn();
    }

    const start = process.hrtime.bigint();
    try {
        const result = fn();
        const end = process.hrtime.bigint();
        const durationMs = Number(end - start) / 1_000_000;

        logHookPerformance(hookName, durationMs, { ...metadata, status: 'success' });
        return result;
    } catch (error) {
        const end = process.hrtime.bigint();
        const durationMs = Number(end - start) / 1_000_000;

        logHookPerformance(hookName, durationMs, {
            ...metadata,
            status: 'error',
            error: error.message
        });
        throw error;
    }
}

/**
 * Wrap an async function with timing instrumentation
 * @param {string} hookName - Name of the hook being measured
 * @param {Function} fn - Async function to execute and measure
 * @param {Object} metadata - Additional metadata to log
 * @returns {Promise<*>} - Promise resolving to fn()'s return value
 */
async function withTimingAsync(hookName, fn, metadata = {}) {
    if (!ENABLED) {
        return await fn();
    }

    const start = process.hrtime.bigint();
    try {
        const result = await fn();
        const end = process.hrtime.bigint();
        const durationMs = Number(end - start) / 1_000_000;

        logHookPerformance(hookName, durationMs, { ...metadata, status: 'success' });
        return result;
    } catch (error) {
        const end = process.hrtime.bigint();
        const durationMs = Number(end - start) / 1_000_000;

        logHookPerformance(hookName, durationMs, {
            ...metadata,
            status: 'error',
            error: error.message
        });
        throw error;
    }
}

/**
 * Create a scoped timer for measuring subsections
 * @param {string} hookName - Name of the hook
 * @returns {Object} - Timer object with .mark() and .measure() methods
 */
function createTimer(hookName) {
    if (!ENABLED) {
        return {
            mark: () => {},
            measure: () => {}
        };
    }

    const marks = new Map();

    return {
        /**
         * Create a named mark at the current time
         * @param {string} name - Name of the mark
         */
        mark(name) {
            marks.set(name, process.hrtime.bigint());
        },

        /**
         * Measure time between two marks and log it
         * @param {string} name - Name for this measurement
         * @param {string} startMark - Name of start mark
         * @param {string} endMark - Name of end mark (defaults to 'now')
         * @param {Object} metadata - Additional metadata
         */
        measure(name, startMark, endMark = null, metadata = {}) {
            const start = marks.get(startMark);
            if (!start) return;

            const end = endMark ? marks.get(endMark) : process.hrtime.bigint();
            if (!end) return;

            const durationMs = Number(end - start) / 1_000_000;
            logHookPerformance(`${hookName}.${name}`, durationMs, metadata);
        }
    };
}

module.exports = {
    ENABLED,
    BENCHMARK_LOG,
    logHookPerformance,
    withTiming,
    withTimingAsync,
    createTimer
};
