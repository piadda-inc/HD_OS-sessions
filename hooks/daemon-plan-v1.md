Hook Daemon v1 Implementation Plan
==================================

Baseline & Requirements
-----------------------
- Enumerate every existing hook entrypoint (`user_messages`, `sessions_enforce`, `post_tool_use`, `session_start`, `subagent_hooks`, `statusline`) with their inputs, outputs, and stderr side effects.
- Document current git regime checks, todo handling, trigger detection, and context warnings so they become acceptance criteria.
- Measure current latencies (already captured) to compare after the refactor.

Daemon Architecture
-------------------
- Create `sessions/hooks/daemon/server.js` that:
  - Loads `shared_state`, config, and helper utilities once on startup.
  - Listens on a Unix domain socket (e.g., `/tmp/cc-sessions.sock`) using a simple JSON-RPC protocol: `{hook, payload, requestId}` ⇒ `{stdout, stderr, exitCode}`.
  - Maintains in-memory caches for:
    - Parsed `sessions-state.json` / `sessions-config.json`.
    - Git snapshot (`branch`, `ahead/behind`, dirty files, untracked files, last refresh time).
    - Transcript context usage keyed by path + last processed offset.
    - Status line output per session with timestamp for throttling.
- Provide helper methods (`refreshGitSnapshot`, `loadState`, `saveState`, etc.) so hook handlers reuse cached data.

Hook Shims
----------
- Replace each hook script with a thin shim that:
  - Reads stdin as before.
  - Ensures the daemon is running (spawn if necessary).
  - Sends the JSON payload plus hook name to the daemon and streams the response back to stdout/stderr.
  - Falls back to legacy logic if the daemon cannot be reached (feature flag controlled).

Hook Handlers (inside daemon)
-----------------------------
- `handleUserPromptSubmit`: trigger detection, ultrathink context, transcript context calculation via cached offsets.
- `handlePreToolUse` (git regime enforcement): reuse cached git data, only refresh when cache stale (>1s) or repo mutation detected.
- `handlePostToolUse`: todo bookkeeping, state persistence with minimal disk writes (only when data changed).
- `handleSessionStart`: clear state, list tasks using cached directory metadata.
- `handleSubagent`: detect stale transcripts using cached stats.
- `handleStatusLine`: reuse git/todo/task caches and throttle to 1–2 Hz; responses come from cache unless forced refresh requested.

Process & State Management
--------------------------
- Implement a lock-free write-through cache: daemon keeps latest state in memory and writes atomically to disk when `editState` mutates data.
- Use file watchers (optional stretch) to invalidate caches when `sessions-state.json` or repo files change outside the daemon.
- Ensure daemon cleans up its socket on exit and handles concurrent requests sequentially or via a small work queue.

Instrumentation
---------------
- Embed timing logs per handler and per git refresh; log warnings when operations exceed thresholds (e.g., >100 ms).
- Expose a debug command (`claude hook-daemon status`) to inspect cache freshness and outstanding requests.

Testing & Rollout
-----------------
- Write integration tests that feed representative hook payloads through the daemon and assert outputs match legacy behavior.
- Provide a feature flag (`sessions-config.json` → `use_hook_daemon`) allowing rollback to direct execution.
- Document startup instructions, troubleshooting (restart daemon, inspect logs), and performance expectations.
