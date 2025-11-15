# Hook Performance Benchmarking System

This directory contains tools for measuring and analyzing the performance of sessions hooks to identify bottlenecks and optimize Claude Code input latency.

## Quick Start

### 1. Enable Benchmarking

Set the environment variable to enable instrumentation:

```bash
export CC_SESSIONS_BENCHMARK=1
```

### 2. Use Claude Code Normally

All hook invocations will now be logged to `~/.claude/hooks-benchmark.jsonl` with high-resolution timestamps.

### 3. Analyze Results

Use the analysis tool to view performance data:

```bash
# Overall summary grouped by hook
node analyze-hook-performance.js summary

# Timeline of all calls
node analyze-hook-performance.js timeline

# Show 20 slowest calls (adjust N as needed)
node analyze-hook-performance.js slow 20

# Statusline-specific analysis (cache hit rates, burst detection)
node analyze-hook-performance.js statusline

# Clear the benchmark log
node analyze-hook-performance.js clear
```

## What Gets Measured

### Instrumented Hooks

All major hooks are instrumented:

1. **statusline** - Statusline rendering (called very frequently)
   - `statusline.total` - Overall rendering time
   - `statusline.load_state` - State loading overhead
   - `statusline.git_operations` - Git status queries (with cache tracking)

2. **sessions_enforce** - PreToolUse enforcement (every tool call)
   - Tracks tool name and input size

3. **user_messages** - UserPromptSubmit processing (every user message)
   - Tracks prompt size and context injection size

4. **post_tool_use** - PostToolUse cleanup (every tool completion)
   - Tracks tool name and modification status

### Metrics Collected

For each hook invocation:

- **timestamp** - ISO 8601 timestamp with millisecond precision
- **hook** - Hook name (e.g., "statusline", "sessions_enforce")
- **duration_ms** - Execution time in milliseconds (3 decimal precision)
- **status** - "success" or "error"
- **metadata** - Hook-specific data:
  - `cache_hit` - Whether cache was used (statusline)
  - `tool` - Tool name (sessions_enforce, post_tool_use)
  - `input_size` - Input JSON size in bytes
  - `prompt_size` - User prompt length (user_messages)
  - `context_size` - Injected context length (user_messages)

## Analysis Features

### Summary Report

Shows aggregate statistics grouped by hook:

- Call count
- Min/Max/Avg duration
- P95/P99 percentiles
- Total time spent

Sorted by total time (most impactful first).

### Timeline View

Shows every call in chronological order with all metadata. Useful for:

- Identifying patterns
- Correlating slow calls with specific operations
- Finding sequential dependencies

### Slowest Calls

Lists the N slowest hook invocations. Useful for:

- Finding outliers
- Identifying worst-case scenarios
- Debugging specific slow operations

### Statusline Analysis

Specialized analysis for the most frequently-called hook:

- **Overall Statistics** - Summary metrics
- **Cache Hit Rate** - Effectiveness of caching layer
- **Hit vs Miss Performance** - Speedup from caching
- **Call Frequency** - Calls per second
- **Burst Detection** - Identifies rapid-fire calls (5+ within 100ms)

## Performance Overhead

The benchmarking system is designed for minimal overhead:

- **High-resolution timers** - Uses `process.hrtime.bigint()` for nanosecond precision
- **Append-only logging** - No file locking, minimal I/O
- **Conditional execution** - Completely disabled when `CC_SESSIONS_BENCHMARK` is not set
- **Error isolation** - Benchmark failures don't affect hook execution
- **Estimated overhead** - <0.05ms per hook call

## Log Format

The benchmark log is a JSON Lines file (`.jsonl`), one entry per line:

```json
{"timestamp":"2025-11-14T16:30:04.765Z","hook":"statusline.total","duration_ms":2.456,"cache_hit_git":true,"cache_hit_transcript":true,"cache_hit_tasks":true,"status":"success"}
{"timestamp":"2025-11-14T16:30:04.767Z","hook":"sessions_enforce","duration_ms":0.123,"tool":"Edit","input_size":245,"status":"success"}
{"timestamp":"2025-11-14T16:30:04.789Z","hook":"user_messages","duration_ms":1.234,"prompt_size":128,"context_size":512,"status":"success"}
{"timestamp":"2025-11-14T16:30:04.801Z","hook":"post_tool_use","duration_ms":0.045,"tool":"Edit","input_size":245,"modified":false,"status":"success"}
```

## Example Workflows

### Find Why Input Latency Is High

1. Enable benchmarking: `export CC_SESSIONS_BENCHMARK=1`
2. Use Claude Code and notice slowness
3. Check summary: `node analyze-hook-performance.js summary`
4. Look for hooks with high total time
5. Check slow outliers: `node analyze-hook-performance.js slow 10`
6. Examine timeline around slow calls: `node analyze-hook-performance.js timeline`

### Verify Caching Improvements

1. Clear log: `node analyze-hook-performance.js clear`
2. Enable benchmarking and use Claude Code
3. Check statusline analysis: `node analyze-hook-performance.js statusline`
4. Look at cache hit rate and speedup metrics

### Profile a Specific Session

1. Clear log before starting work
2. Complete the session
3. Generate summary report
4. Review timeline for patterns
5. Archive the log: `cp ~/.claude/hooks-benchmark.jsonl ./session-profile.jsonl`

## Files

- **benchmark_utils.js** - Timing utilities for hook instrumentation
- **analyze-hook-performance.js** - Analysis tool for benchmark logs
- **test-benchmark.sh** - Automated test script
- **BENCHMARK_README.md** - This file

## Troubleshooting

### No Data Being Logged

- Verify `CC_SESSIONS_BENCHMARK=1` is set
- Check `~/.claude/` directory exists and is writable
- Ensure hooks have been instrumented (check for `require('./benchmark_utils.js')`)

### Statusline Not Appearing in Logs

- The statusline daemon needs to be restarted after instrumentation
- Kill any running daemon: `pkill -f 'cc-sessions.*daemon'`
- Remove socket: `rm -f /tmp/cc-sessions-*.sock`
- Next statusline call will spawn new instrumented daemon

### High Overhead

- Benchmarking should add <0.05ms per hook call
- If overhead is higher, check disk I/O (slow filesystem?)
- Consider sampling: only benchmark every Nth call (requires code modification)

## Future Enhancements

Potential improvements:

1. **Sampling** - Only benchmark every Nth call to reduce overhead
2. **Aggregation** - Real-time stats in daemon (avoid log parsing)
3. **Tracing** - Distributed tracing across hook boundaries
4. **Visualization** - Generate flamegraphs or timeline charts
5. **Alerts** - Warn when hooks exceed thresholds

## Implementation Details

### Timing Approach

Uses Node.js `process.hrtime.bigint()` for nanosecond-precision monotonic timing:

```javascript
const start = process.hrtime.bigint();
// ... operation ...
const end = process.hrtime.bigint();
const durationMs = Number(end - start) / 1_000_000;
```

### Instrumentation Pattern

Hooks are wrapped with `withTiming()`:

```javascript
const { withTiming } = require('./benchmark_utils.js');

const exitCode = withTiming('hook_name', () => {
    // ... hook logic ...
    return exitCode;
}, { custom_metadata: 'value' });

process.exit(exitCode);
```

For async operations, use `withTimingAsync()`.

For subsection timing, use `createTimer()`:

```javascript
const timer = createTimer('hook_name');
timer.mark('start');
// ... operation ...
timer.mark('end');
timer.measure('subsection', 'start', 'end', { metadata });
```

## Contributing

When adding new hooks or modifying existing ones:

1. Import benchmark utils: `const { withTiming } = require('./benchmark_utils.js')`
2. Wrap main logic with `withTiming()`
3. Include relevant metadata (tool name, input size, cache hits, etc.)
4. Test with `CC_SESSIONS_BENCHMARK=1` to verify logging
5. Update this README if adding new metrics
