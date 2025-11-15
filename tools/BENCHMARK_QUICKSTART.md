# Hook Benchmarking Quick Start

## TL;DR

```bash
# Enable benchmarking
export CC_SESSIONS_BENCHMARK=1

# Use Claude Code normally...

# View results
cd /home/heliosuser/sessions/tools
node analyze-hook-performance.js summary
node analyze-hook-performance.js statusline

# Clear when done
node analyze-hook-performance.js clear
```

## Common Commands

### Summary (grouped by hook)
```bash
node analyze-hook-performance.js summary
```
Shows min/max/avg/p95/p99 for each hook, sorted by total time.

### Statusline Analysis
```bash
node analyze-hook-performance.js statusline
```
Shows cache hit rates, call frequency, burst detection.

### Find Slow Calls
```bash
node analyze-hook-performance.js slow 20
```
Lists the 20 slowest hook invocations.

### Timeline
```bash
node analyze-hook-performance.js timeline
```
Shows all calls in chronological order with metadata.

### Clear Log
```bash
node analyze-hook-performance.js clear
```
Deletes the benchmark log file.

## What Gets Measured

- **statusline** - Rendering time, state loading, git operations (+ cache hits)
- **sessions_enforce** - PreToolUse validation (+ tool name, input size)
- **user_messages** - UserPromptSubmit processing (+ prompt/context size)
- **post_tool_use** - PostToolUse cleanup (+ tool name, modified status)

## Interpreting Results

### Good Performance
- statusline: <3ms per call
- sessions_enforce: <1ms per call
- user_messages: <2ms per call
- post_tool_use: <0.1ms per call

### Warning Signs
- statusline >5ms consistently → check git performance or state file size
- sessions_enforce >2ms → complex command parsing
- Many burst detections → hook called too frequently
- Low cache hit rate → cache TTL too short or CWD changing

## Example Workflow

```bash
# 1. Clear old data
node analyze-hook-performance.js clear

# 2. Enable benchmarking
export CC_SESSIONS_BENCHMARK=1

# 3. Use Claude Code for your task
# (benchmarking happens automatically)

# 4. View summary
node analyze-hook-performance.js summary

# 5. Check statusline (most frequent hook)
node analyze-hook-performance.js statusline

# 6. Find outliers
node analyze-hook-performance.js slow 10

# 7. Archive results (optional)
cp ~/.claude/hooks-benchmark.jsonl ./profile-$(date +%Y%m%d).jsonl
```

## Troubleshooting

**No data logged?**
- Check `CC_SESSIONS_BENCHMARK=1` is set
- Verify `~/.claude/` directory exists

**Statusline missing?**
- Restart daemon: `pkill -f 'cc-sessions.*daemon' && rm -f /tmp/cc-sessions-*.sock`

**High overhead?**
- Normal overhead: <0.05ms per call
- If higher, check disk I/O

## Log Location

```
~/.claude/hooks-benchmark.jsonl
```

JSONL format (one JSON object per line).

## Full Documentation

See `BENCHMARK_README.md` for complete details.
