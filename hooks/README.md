# Subagent Hooks

This directory contains the Node hook entrypoints that Claude Code invokes for
subagent orchestration. The `subagent_hooks.js` script now handles both the
PreToolUse task setup flow and the SubagentStop orchestration updates.

## Manual Testing

1. Ensure development dependencies are installed (`pip install -e ".[dev]"`).
2. Run the targeted regression tests:

   ```bash
   pytest tests/test_backlog_bridge_cli.py tests/test_subagent_stop_hook.py -q
   ```

3. To exercise the hook manually, feed it JSON describing a SubagentStop event:

   ```bash
   cd /path/to/repo
   python3 - <<'PY'
   import json, sys
   payload = {
       "hook_event_name": "SubagentStop",
       "tool_name": "Task",
       "session_id": "dev-session",
       "transcript_path": "/tmp/transcript.jsonl",
       "exit_status": "completed",
   }
   sys.stdout.write(json.dumps(payload))
   PY | env SESSIONS_STATE_DIR=/tmp/orch-state \
          BACKLOG_TASKS_DIR=$PWD/tests/fixtures/backlog_sample \
          CLAUDE_PROJECT_DIR=$PWD \
          node sessions/hooks/subagent_hooks.js
   ```

   Replace the transcript path with a JSONL transcript that includes the most
   recent `Task` tool invocation so the hook can extract the task/group ids.

## Execute Plan Signals

The SubagentStop handler records orchestration signals inside the shared
`sessions/sessions-state.json` metadata block. The Python bridge updates the
plan/index files and then the hook stores the signal payload for downstream
consumers.

`state.metadata.orchestration` now contains:

| Field               | Description                                                 |
|---------------------|-------------------------------------------------------------|
| `last_signal`       | `execute_plan:group-<id>`, `execute_plan:complete`, or `execute_plan:halt` |
| `last_signal_at`    | ISO-8601 timestamp when the signal was emitted              |
| `last_session_id`   | The Claude session id associated with the run               |
| `last_group_id`     | Execution group identifier                                  |
| `last_task_id`      | Backlog task id used to build the plan                      |
| `last_exit_status`  | Normalized exit status reported by the SubagentStop event   |
| `last_payload`      | Raw JSON response emitted by `sessions.bin.backlog_bridge`  |
| `execution_plan`    | Snapshot of the persisted execution_plan.json               |
| `session_index`     | Snapshot of the persisted session_index.json                |

Consumers should watch the `last_signal` field for `execute_plan:*` markers and
inspect the `last_payload` structure to determine which group(s) are ready to
run next.
