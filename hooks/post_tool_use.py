#!/usr/bin/env python3

# ===== IMPORTS ===== #

## ===== STDLIB ===== ##
import shutil
import json
import sys
import os
import platform
from datetime import datetime, timezone
from uuid import uuid4
from typing import Any, Dict
from pathlib import Path
##-##

## ===== 3RD-PARTY ===== ##
##-##

## ===== LOCAL ===== ##
HOOKS_DIR = Path(__file__).resolve().parent
REPO_ROOT = HOOKS_DIR.parent
REPO_PARENT = REPO_ROOT.parent
DATA_MODULE_DIR = REPO_ROOT / "sessions"
for candidate in (str(DATA_MODULE_DIR), str(REPO_ROOT), str(REPO_PARENT)):
    if candidate not in sys.path:
        sys.path.insert(0, candidate)

from sessions.memory import get_client

from shared_state import (
    load_state,
    load_config,
    edit_state,
    Mode,
    PROJECT_ROOT,
    SessionsProtocol,
    list_open_tasks,
    TaskState,
    StateError,
)
##-##

#-#

# ===== GLOBALS ===== #

## ===== CI DETECTION ===== ##
def is_ci_environment():
    """Check if running in a CI environment (GitHub Actions)."""
    ci_indicators = [
        'GITHUB_ACTIONS',         # GitHub Actions
        'GITHUB_WORKFLOW',        # GitHub Actions workflow
        'CI',                     # Generic CI indicator (set by GitHub Actions)
        'CONTINUOUS_INTEGRATION', # Generic CI (alternative)
    ]
    return any(os.getenv(indicator) for indicator in ci_indicators)

# Skip post tool use hook in CI environments
if is_ci_environment():
    sys.exit(0)
##-##

input_data = json.load(sys.stdin)
tool_name = input_data.get("tool_name", "")
tool_input = input_data.get("tool_input", {})
cwd = input_data.get("cwd", "")
mod = False

STATE = load_state()
CONFIG = load_config()
MEMORY_CLIENT = get_client(getattr(CONFIG, "memory", None))
#-#

"""
╔════════════════════════════════════════════════════════════════════════════════════════╗
║ ██████╗  █████╗ ██████╗██████╗  ██████╗ █████╗  █████╗ ██╗       ██╗ ██╗██████╗██████╗ ║
║ ██╔══██╗██╔══██╗██╔═══╝╚═██╔═╝  ╚═██╔═╝██╔══██╗██╔══██╗██║       ██║ ██║██╔═══╝██╔═══╝ ║
║ ██████╔╝██║  ██║██████╗  ██║      ██║  ██║  ██║██║  ██║██║       ██║ ██║██████╗█████╗  ║
║ ██╔═══╝ ██║  ██║╚═══██║  ██║      ██║  ██║  ██║██║  ██║██║       ██║ ██║╚═══██║██╔══╝  ║
║ ██║     ╚█████╔╝██████║  ██║      ██║  ╚█████╔╝╚█████╔╝███████╗  ╚████╔╝██████║██████╗ ║
║ ╚═╝      ╚════╝ ╚═════╝  ╚═╝      ╚═╝   ╚════╝  ╚════╝ ╚══════╝   ╚═══╝ ╚═════╝╚═════╝ ║
╚════════════════════════════════════════════════════════════════════════════════════════╝
Handles post-tool execution cleanup and state management:
- Cleans up subagent context flags and transcript directories after Task tool completion
- Auto-returns to discussion mode when all todos are marked complete
- Enforces todo-based execution boundaries in orchestration mode
- Provides directory navigation feedback after cd commands
"""


def _auto_store_enabled(event: str) -> bool:
    auto_store = (getattr(CONFIG.memory, "auto_store", "off") or "off").lower()
    if auto_store == "off":
        return False
    if auto_store == "both":
        return True
    return auto_store == event


def _build_episode_payload(tool_input: dict) -> Dict[str, Any]:
    summary = tool_input.get("summary") or f"Completed task: {STATE.current_task.name or STATE.current_task.file or 'session task'}"
    objectives = tool_input.get("objectives")
    if not isinstance(objectives, list):
        objectives = [t.content for t in STATE.todos.active] if STATE.todos.active else []
    completed_at = tool_input.get("completed_at") or datetime.now(timezone.utc).isoformat()
    episode = {
        "episode_id": tool_input.get("episode_id") or f"{STATE.current_task.file or 'task'}-{uuid4().hex[:8]}",
        "workspace_id": getattr(CONFIG.memory, "group_id", "hd_os_workspace"),
        "task_id": STATE.current_task.file or STATE.current_task.name or f"task-{uuid4().hex[:6]}",
        "summary": summary,
        "objectives": objectives,
        "timestamps": {"completed_at": completed_at},
    }
    return episode


def maybe_store_task_completion(tool_input: dict) -> bool:
    if not (
        getattr(CONFIG.memory, "enabled", False)
        and getattr(MEMORY_CLIENT, "can_store", False)
        and _auto_store_enabled("task-completion")
    ):
        return False
    try:
        episode = _build_episode_payload(tool_input)
        return bool(MEMORY_CLIENT.store_episode(episode))
    except Exception:
        return False

# ===== EXECUTION ===== #

#!> Claude compass (directory position reminder)
if tool_name == "Bash":
    command = tool_input.get("command", "")
    if "cd " in command:
        print(f"[You are in: {cwd}]", file=sys.stderr)
        mod = True
#!<

#!> Subagent cleanup
if tool_name == "Task" and STATE.flags.subagent:
    with edit_state() as s:
        s.flags.subagent = False
        STATE = s
    # Clean up agent transcript directory
    subagent_type = tool_input.get("subagent_type", "shared")
    agent_dir = PROJECT_ROOT / "sessions" / "transcripts" / subagent_type
    if agent_dir.exists():
        shutil.rmtree(agent_dir)
    sys.exit(0)
#!<

#!> Todo completion
if STATE.mode is Mode.GO and tool_name == "TodoWrite" and STATE.todos.all_complete():
    # Check if all complete (names already verified to match if active_todos existed)
    print("[DAIC: Todos Complete] All todos completed.\n\n", file=sys.stderr)

    if STATE.active_protocol is SessionsProtocol.COMPLETE:
        maybe_store_task_completion(tool_input)
        with edit_state() as s:
            s.mode = Mode.NO
            s.active_protocol = None
            s.current_task.clear_task()
            s.todos.active = []
            STATE = s
        print(list_open_tasks())
        sys.exit(0)

    if STATE.active_protocol is not None:
        with edit_state() as s:
            s.active_protocol = None
            STATE = s

    if STATE.todos.stashed:
        with edit_state() as s:
            num_restored = s.todos.restore_stashed()
            restored = [t.content for t in s.todos.active]
            # Enable the todos clear command for this context
            s.api.todos_clear = True
            STATE = s
            mod = True
        if num_restored:
            # Detect OS for correct sessions command
            is_windows = platform.system() == "Windows"
            sessions_cmd = "sessions/bin/sessions.bat" if is_windows else "sessions/bin/sessions"

            print(
                f"Your previous {num_restored} todos have been restored:\n\n{
                    json.dumps(restored, indent=2)
                }\n\nIf these todos are no longer relevant, you should clear them using: {sessions_cmd} todos clear\nNote: You can only use this command immediately - it will be disabled after any other tool use.\n\n",
                file=sys.stderr,
            )
    else:
        with edit_state() as s:
            s.todos.active = []
            s.mode = Mode.NO
            STATE = s
        print(
            "You have returned to discussion mode. You may now discuss next steps with the user.\n\n",
            file=sys.stderr,
        )
        mod = True
#!<

#!> Implementation mode + no Todos enforcement
if (
    STATE.mode is Mode.GO
    and not STATE.flags.subagent
    and not STATE.todos.active
    and STATE.current_task.name
):
    # In orchestration mode but no todos - show reminder only during task-based work
    print("[Reminder] You're in orchestration mode without approved todos. "
        "If you proposed todos that were approved, add them. "
        "If the user asked you to do something without todo proposal/approval that is **reasonably complex or multi-step**, translate *only the remaining work* to todos and add them (all 'pending'). ", file=sys.stderr,)
    mod = True
#!<

#!> Task file auto-update detection
if (
    tool_name in ["Edit", "Write", "MultiEdit"]
    and STATE.current_task.name
    and STATE.current_task.file
):
    # Extract file path from tool input
    file_path_str = tool_input.get("file_path")
    if file_path_str:
        file_path = Path(file_path_str)
        task_path = PROJECT_ROOT / "sessions" / "tasks" / STATE.current_task.file

        # Check if the edited file is the current task file
        if file_path.resolve() == task_path.resolve():
            try:
                # Task file was edited - re-parse frontmatter to detect changes
                updated_task = TaskState.load_task(path=task_path)

                # Update session state with any changes from the re-parsed frontmatter
                if updated_task:
                    with edit_state() as s:
                        # Update relevant fields from the re-parsed task
                        if updated_task.status != STATE.current_task.status:
                            s.current_task.status = updated_task.status
                        if updated_task.updated != STATE.current_task.updated:
                            s.current_task.updated = updated_task.updated
                        if updated_task.branch != STATE.current_task.branch:
                            s.current_task.branch = updated_task.branch
                        if updated_task.submodules != STATE.current_task.submodules:
                            s.current_task.submodules = updated_task.submodules
                        # Update other relevant fields as needed
                        if updated_task.started != STATE.current_task.started:
                            s.current_task.started = updated_task.started
                        if updated_task.dependencies != STATE.current_task.dependencies:
                            s.current_task.dependencies = updated_task.dependencies
                        STATE = s
            except (FileNotFoundError, StateError):
                # File might be temporarily invalid during editing
                # or frontmatter might be malformed - silently skip
                pass
#!<

#!> Disable windowed API permissions after any tool use (except the windowed command itself)
if STATE.api.todos_clear and tool_name == "Bash":
    # Check if this is the todos clear command
    import json

    tool_input = json.loads(os.environ.get("__TOOL_INPUT__", "{}"))
    command = tool_input.get("command", "")
    # Check for either Unix or Windows version of the command
    if "sessions/bin/sessions todos clear" not in command and "sessions/bin/sessions.bat todos clear" not in command:
        # Not the todos clear command, disable the permission
        with edit_state() as s:
            s.api.todos_clear = False
            STATE = s
elif STATE.api.todos_clear:
    # Any other tool was used, disable the permission
    with edit_state() as s:
        s.api.todos_clear = False
        STATE = s
#!<

#-#

if mod:
    sys.exit(2)  # Exit code 2 feeds stderr back to Claude
sys.exit(0)
