#!/bin/bash
# Test script for hook benchmarking

set -e

BENCHMARK_LOG="$HOME/.claude/hooks-benchmark.jsonl"
SESSIONS_DIR="/home/heliosuser/sessions"

echo "=== Hook Benchmarking Test ==="
echo ""

# Clear any existing log
if [ -f "$BENCHMARK_LOG" ]; then
    echo "Clearing existing benchmark log..."
    rm "$BENCHMARK_LOG"
fi

# Enable benchmarking
export CC_SESSIONS_BENCHMARK=1

echo "Running test hook calls..."
echo ""

# Test statusline hook
echo "Testing statusline hook..."
cd "$SESSIONS_DIR/hooks"
echo '{"cwd":"/tmp","model":"claude-sonnet-4.5"}' | node statusline_daemon.js > /dev/null 2>&1 || true
echo '{"cwd":"/tmp","model":"claude-sonnet-4.5"}' | node statusline_daemon.js > /dev/null 2>&1 || true
echo '{"cwd":"/tmp","model":"claude-sonnet-4.5"}' | node statusline_daemon.js > /dev/null 2>&1 || true
echo '{"cwd":"/tmp","model":"claude-sonnet-4.5"}' | node statusline_daemon.js > /dev/null 2>&1 || true
echo '{"cwd":"/tmp","model":"claude-sonnet-4.5"}' | node statusline_daemon.js > /dev/null 2>&1 || true

# Test sessions_enforce hook
echo "Testing sessions_enforce hook..."
echo '{"tool_name":"Bash","tool_input":{"command":"ls"},"session_id":"test"}' | node sessions_enforce.js > /dev/null 2>&1 || true
echo '{"tool_name":"Read","tool_input":{"file_path":"test.txt"},"session_id":"test"}' | node sessions_enforce.js > /dev/null 2>&1 || true

# Test user_messages hook
echo "Testing user_messages hook..."
echo '{"prompt":"test prompt"}' | node user_messages.js > /dev/null 2>&1 || true

# Test post_tool_use hook
echo "Testing post_tool_use hook..."
echo '{"tool_name":"Bash","tool_input":{"command":"ls"},"cwd":"/tmp"}' | node post_tool_use.js > /dev/null 2>&1 || true

echo ""
echo "=== Analysis Results ==="
echo ""

# Run analysis
cd "$SESSIONS_DIR/tools"
node analyze-hook-performance.js summary
