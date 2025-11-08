# Reflection Capture Protocol

Graphiti's meta-learning loop now requires a structured reflection whenever a task reaches completion. The `SessionHookAdapter` translates the hook payloads below into `TaskCompletedEvent` objects that feed `ReflectionService`.

---

## Trigger

1. Fire immediately after the task completion agents finish (before final Git operations).
2. Payload source of truth is the current `sessions/hooks/post_tool_use.js` hook.

---

## Required Payload

| Field | Description |
| --- | --- |
| `type` | Must be `task.completed` |
| `task.id` | Task identifier (`task-###` or directory slug) |
| `task.group_id` | Matches `GROUP_ID` from `.env.local` |
| `task.summary` | One-paragraph recap of the work done |
| `task.objectives` | Ordered list of user-approved goals |
| `task.instructions` | Final instructions / acceptance criteria |
| `task.started_at` / `task.completed_at` | ISO8601 timestamps |
| `task.episode_ids` | Array of Graphiti episode UUIDs touched |
| `task.tool_traces` | Summaries of important tool invocations |
| `metadata` | Free-form notes (must include `success` flag) |

---

## Hook Wiring (exact diff)

```diff
@@ sessions/hooks/post_tool_use.js @@
-// Existing completion logic only closed todos
+if (toolName === "Task" && STATE.current_task.status === "complete") {
+    const reflectionPayload = {
+        type: "task.completed",
+        event_id: crypto.randomUUID(),
+        success: STATE.current_task.status === "complete",
+        task: {
+            id: STATE.current_task.name,
+            group_id: STATE.config.group_id,
+            summary: STATE.current_task.summary,
+            instructions: STATE.current_task.instructions,
+            objectives: STATE.current_task.objectives,
+            started_at: STATE.current_task.started_at,
+            completed_at: new Date().toISOString(),
+            episode_ids: STATE.current_task.episode_ids,
+            tool_traces: STATE.tool_traces,
+            metadata: STATE.current_task.metadata,
+        },
+        metadata: { task_file: STATE.current_task.file }
+    };
+    spawnSync("python3", [
+        "-m",
+        "graphiti_local.services.emit_reflection",
+        JSON.stringify(reflectionPayload)
+    ], {
+        cwd: require('path').join(__dirname, '../../local'),
+        encoding: 'utf-8'
+    });
+}
```

> The Python entry point simply loads the JSON payload and calls `SessionHookAdapter.dispatch_hook_payload`.

---

## Manual Backfill (if automation fails)

1. Run `cd local && python -m graphiti_local.scripts.capture_reflection --task <task-id> --notes "<summary>"`.
2. Provide `episodes.jsonl` export via `graphiti-local episode list --format json`.
3. Verify reflection storage via `graphiti-local search facts --query reflection`.

---

## Validation

- `graphiti-local tests --filter reflection` ensures unit coverage.
- `sessions/bin/sessions protocol reflection` dry-runs hook scripts with sample payloads.

Keep this document beside `task-completion.md`; every completion must either emit this payload or log why it was skipped.
