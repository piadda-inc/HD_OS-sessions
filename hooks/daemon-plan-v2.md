Hook Daemon v1 Progress & Next Steps (Nov 8)
============================================

Status Snapshot
---------------
- `sessions/hooks/daemon/server.js` is running with `ping` and `statusline` handlers only; it still spins up per-request helpers, caches nothing, and relies on a manually launched process because `listen()` on the sandbox socket path returns `EPERM`.
- CLI wiring currently goes through `sessions/statusline.js → hooks/statusline_daemon.js`, while `hooks/statusline_shim.js` is orphaned. The shim streams stdin/stdout correctly, but we still duplicate connection logic per hook.
- `hooks/transcript_utils.js` (tail reader + lock helpers) now exists, yet both `user_messages.js` and `subagent_hooks.js` continue to embed their own `readTranscriptTail` copies, so we are still doing redundant I/O every call.
- Only the statusline path uses the daemon. `user_messages`, `sessions_enforce`, `post_tool_use`, `session_start`, `subagent_hooks`, and `post_tool_use` are still running as standalone scripts that reload config/state/git on each invocation.
- `backlog-md-python/tests/test_sessions_pretooluse_gate.py` currently fails 5 cases (missing active group tracking + incorrect exit codes) because `sessions/hooks/sessions_enforce.js` lacks the orchestration task gate implemented upstream. This confirms we **must** sync the canonical `sessions` tree before trusting new daemon behavior.
- There are two divergent `sessions/` trees (`/home/heliosuser/sessions` and `/home/heliosuser/backlog-md-python/sessions`). The daemon work is happening in the former; the pytest suite exercises the latter. We need a single source of truth to keep tests meaningful.

Completed / Landed
------------------
1. Added the daemon scaffold (`sessions/hooks/daemon/server.js`) with JSON-RPC over Unix sockets plus a stub `ping` handler.
2. Moved the statusline hook behind the daemon via `hooks/statusline_daemon.js` and kept a transparent fallback to `statusline.legacy.js`.
3. Dropped `hooks/daemon/statusline_handler.js`, which already reuse `shared_state` utilities and centralizes git/context parsing for future caching.
4. Introduced `hooks/transcript_utils.js` (lock management + bounded `readTranscriptTail`) as the building block for transcript-aware handlers.

Outstanding / Blocked
---------------------
1. **Task gating parity**: `pytest tests/test_sessions_pretooluse_gate.py` (run from `backlog-md-python`) fails because the shipped `sessions_enforce.js` does not set `metadata.orchestration.active_group_id` nor return non-zero exit codes when the plan mismatch occurs. We need to either port the upstream file or re-enable the gate before migrating this hook into the daemon.
2. **Socket permission issue**: The sandbox still refuses to let the daemon bind to `/tmp/cc-sessions-$USER.sock`. Until we ship a fallback (stdio server, TCP, or named pipe) automation cannot rely on auto-start.
3. **Duplicate trees**: Work is happening in `/home/heliosuser/sessions`, while automated tests target `/home/heliosuser/backlog-md-python/sessions`. We must reconcile them (symlink, copy on save, or refocus development in the test tree) to avoid false negatives.
4. **State/config churn**: Every hook call still parses `sessions-state.json`, `sessions-config.json`, and shelles out to `git status`. Without caching inside the daemon, we will not see the perf wins that motivated this refactor.
5. **Transcript utilities unused**: The helper exists but `user_messages` and `subagent_hooks` have not been switched over, so transcript I/O continues to be O(N) per hook run.

Plan of Record
--------------
1. **Unify the repository + fix gating regression**
   - Choose `/home/heliosuser/sessions` as the working tree, copy it over `backlog-md-python/sessions`, and keep a script to sync both directions until we can delete the duplicate.
   - Pull `sessions/hooks/sessions_enforce.js` (and supporting fixtures) from GWUDCAP/cc-sessions main, or manually port the missing orchestration gate logic. Re-run `pytest tests/test_sessions_pretooluse_gate.py -q` until all five cases pass.
   - Commit the restored `sessions-state.json` / `sessions-config.json` fixtures used by tests so we do not block on “no canonical state file” again.

2. **Daemon runtime hardening**
   - Create `hooks/daemon/process_manager.js` that: spawns the daemon if absent, retries on `ECONNREFUSED`, falls back to a stdio transport when `EPERM` prevents `listen()`, and ensures socket cleanup on exit.
   - Add a watchdog for stale PID files and a `claude hook-daemon restart` CLI entry in `sessions/bin`.
   - Implement lifecycle hooks in `server.js` for SIGINT/SIGTERM so sockets disappear cleanly.

3. **Shared services & caching**
   - Move state/config readers, git snapshotting, and transcript tail caching into a `hooks/daemon/services/` directory (e.g., `state_cache.js`, `git_cache.js`, `transcript_cache.js`).
   - Cache invalidation rules: refresh git when repo mtime changes or cache older than 1s; reload state/config when the file hash changes; memoize transcript offsets per `(path, bytesRead)`.
   - Provide helper APIs (`withState(fn)`, `getGitSnapshot({force})`, `getTranscriptTail(key, {maxBytes})`) so handlers stay thin.

4. **Handler migrations (in order)**
   - **Statusline**: Swap `statusline_handler.renderStatusline` to consume the new caches, add throttling (1–2 Hz) keyed by `session_id`, and remove the duplicate git parsing.
   - **user_messages**: Port trigger detection + ultrathink context building into `daemon/server.js` as `handleUserPromptSubmit`. Use `transcript_utils.readTranscriptTail` for transcript windows, enforce mode toggles via cached state, and persist edits through daemon-managed `editState`.
   - **sessions_enforce**: Implement `handlePreToolUse` that consumes cached git + task metadata, emits the existing stderr warnings, and short-circuits when CI env vars are set. Return structured exit codes so we can keep pytest coverage after migration.
   - **post_tool_use**: Move todo bookkeeping and subagent cleanup into `handlePostToolUse`, leveraging cached state/todo snapshots to minimize disk writes.
   - **session_start / subagent_hooks**: Handle task listing, stale transcript detection, and shared subagent locks from within the daemon so we do not reparse the filesystem per invocation.

5. **Shim + client consolidation**
   - Build a tiny `hooks/daemon/client.js` that all hook entrypoints require. It should read stdin, ensure the daemon is live via the process manager, and proxy the JSON-RPC request with consistent error handling + legacy fallback.
   - Update each hook’s CLI file to just `require('./daemon_client')( 'hook-name', legacyImpl )`.
   - Remove the unused `statusline_shim.js` once the generic client lives.

6. **Instrumentation & diagnostics**
   - Add per-handler timing + cache-hit counters (write to stderr with `[Daemon] hook=user_messages duration=42ms cache_hits=3`).
   - Surface a lightweight `hook-daemon status` command that prints socket path, uptime, cache freshness, and last error.
   - Emit warnings when handler latency exceeds agreed thresholds (>100 ms) so we can spot regressions early.

7. **Testing & rollout**
   - Expand `sessions/hooks/__tests__/` with fixtures that fire JSON payloads through the daemon and assert byte-for-byte parity with legacy hook stdout/stderr/exit codes.
   - Keep running the Python regression suites (`tests/test_sessions_pretooluse_gate.py`, `tests/test_subagent_stop_hook.py`) during each migration.
   - Introduce `use_hook_daemon` in `sessions-config.json` so we can flip back to direct execution if users hit problems.
   - Document daemon operations in `sessions/hooks/README.md` (startup, restarting, troubleshooting, log locations, socket permissions).

Next Helpful Actions
--------------------
- Sync `/home/heliosuser/sessions` into `backlog-md-python/sessions`, rerun the pytest suite, and capture the exact diff that fixes the gating regression.
- Prototype the stdio fallback in `process_manager.js` so we can stop hand-launching the daemon while working inside this sandbox.
