#!/usr/bin/env python3
"""
Integration tests for the SessionStart and PostToolUse hooks with memory enabled.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent

GRAPHITI_SHIM = """#!/usr/bin/env python3
import json, os, sys, time
from pathlib import Path

def main():
    raw = sys.stdin.read()
    if not raw:
        return
    payload = json.loads(raw)
    op = payload.get("operation", "").lower()
    delay = float(os.environ.get(f"GRAPHITI_IPC_DELAY_{op.upper()}", "0") or 0)
    if delay:
        time.sleep(delay)
    capture = os.environ.get("GRAPHITI_IPC_CAPTURE")
    if capture:
        Path(capture).write_text(json.dumps(payload))
    if op == "search":
        response = {"facts": [{"fact": f"Result for {payload.get('data', {}).get('query', '')}", "episode_name": "Fixture"}]}
    else:
        response = {"ok": True}
    sys.stdout.write(json.dumps(response))

if __name__ == "__main__":
    main()
"""


def write_graphiti_shim(tmp_path: Path) -> Path:
    shim = tmp_path / "graphiti_local.py"
    shim.write_text(GRAPHITI_SHIM)
    shim.chmod(0o755)
    return shim


def build_project(tmp_path: Path, shim_path: Path, *, graphiti_path: str | None = None) -> None:
    sessions_dir = tmp_path / "sessions"
    tasks_dir = sessions_dir / "tasks"
    tasks_dir.mkdir(parents=True, exist_ok=True)
    (sessions_dir / "transcripts").mkdir(parents=True, exist_ok=True)

    task_file = tasks_dir / "unit-task.md"
    task_file.write_text(
        """---
task: Unit Task
status: pending
---

Details about the unit task.
"""
    )

    config = {
        "environment": {"developer_name": "Unit Tester"},
        "memory": {
            "enabled": True,
            "provider": "graphiti",
            "graphiti_path": str(graphiti_path or shim_path),
            "auto_search": True,
            "auto_store": "task-completion",
            "search_timeout_ms": 1500,
            "store_timeout_s": 2.0,
            "max_results": 5,
            "group_id": "unit-test",
            "allow_code_snippets": True,
            "sanitize_secrets": True,
        },
    }
    state = {
        "version": "0.0.0",
        "mode": "orchestration",
        "current_task": {"name": "Unit Task", "file": "unit-task.md"},
        "todos": {"active": [{"content": "Wrap up", "status": "completed"}], "stashed": []},
        "api": {},
        "flags": {},
        "metadata": {"update_available": False},
        "active_protocol": "task-completion",
        "model": "opus",
    }

    sessions_dir.mkdir(exist_ok=True)
    (sessions_dir / "sessions-config.json").write_text(json.dumps(config, indent=2))
    (sessions_dir / "sessions-state.json").write_text(json.dumps(state, indent=2))


def run_hook(script: str, *, env: dict[str, str], stdin: str | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, script],
        cwd=str(REPO_ROOT),
        env=env,
        input=stdin,
        text=True,
        capture_output=True,
        check=False,
    )


def test_session_start_includes_memory_block(tmp_path: Path):
    shim = write_graphiti_shim(tmp_path)
    build_project(tmp_path, shim)
    capture_file = tmp_path / "search_capture.json"
    env = os.environ.copy()
    env["CLAUDE_PROJECT_DIR"] = str(tmp_path)
    env["GRAPHITI_IPC_CAPTURE"] = str(capture_file)

    result = run_hook("hooks/session_start.py", env=env)
    assert result.returncode == 0, result.stderr

    payload = json.loads(result.stdout)
    context = payload["hookSpecificOutput"]["additionalContext"]
    assert "## 📚 Relevant Memory" in context
    assert "- Result for Unit Task" in context

    stored_payload = json.loads(capture_file.read_text())
    assert stored_payload["operation"] == "search"


def test_post_tool_use_stores_episode(tmp_path: Path):
    shim = write_graphiti_shim(tmp_path)
    build_project(tmp_path, shim)
    capture_file = tmp_path / "store_capture.json"
    env = os.environ.copy()
    env["CLAUDE_PROJECT_DIR"] = str(tmp_path)
    env["GRAPHITI_IPC_CAPTURE"] = str(capture_file)

    hook_input = {
        "tool_name": "TodoWrite",
        "tool_input": {"summary": "Unit summary", "objectives": ["Wrap up"]},
        "cwd": str(tmp_path),
    }

    result = run_hook("hooks/post_tool_use.py", env=env, stdin=json.dumps(hook_input))
    assert result.returncode == 0, result.stderr

    assert capture_file.exists(), "episode store should finish before the hook exits"

    payload = json.loads(capture_file.read_text())
    assert payload["operation"] == "store"
    assert payload["data"]["episode"]["summary"] == "Unit summary"


def test_post_tool_use_store_timeout_guard(tmp_path: Path):
    shim = write_graphiti_shim(tmp_path)
    build_project(tmp_path, shim)
    capture_file = tmp_path / "timeout_capture.json"
    env = os.environ.copy()
    env["CLAUDE_PROJECT_DIR"] = str(tmp_path)
    env["GRAPHITI_IPC_CAPTURE"] = str(capture_file)
    env["GRAPHITI_IPC_DELAY_STORE"] = "5"

    hook_input = {
        "tool_name": "TodoWrite",
        "tool_input": {"summary": "Slow store test", "objectives": ["Wrap up"]},
        "cwd": str(tmp_path),
    }

    start = time.perf_counter()
    result = run_hook("hooks/post_tool_use.py", env=env, stdin=json.dumps(hook_input))
    duration = time.perf_counter() - start

    assert result.returncode == 0, result.stderr
    assert duration < 2.5, f"hook should not hang when store blocks (duration={duration:.2f}s)"
    assert not capture_file.exists(), "timed-out store should not produce a payload"


def test_post_tool_use_missing_graphiti_is_graceful(tmp_path: Path):
    shim = write_graphiti_shim(tmp_path)
    capture_file = tmp_path / "missing_capture.json"
    missing_binary = tmp_path / "graphiti-missing"
    build_project(tmp_path, shim, graphiti_path=str(missing_binary))

    env = os.environ.copy()
    env["CLAUDE_PROJECT_DIR"] = str(tmp_path)
    env["GRAPHITI_IPC_CAPTURE"] = str(capture_file)

    hook_input = {
        "tool_name": "TodoWrite",
        "tool_input": {"summary": "Missing binary", "objectives": ["Wrap up"]},
        "cwd": str(tmp_path),
    }

    start = time.perf_counter()
    result = run_hook("hooks/post_tool_use.py", env=env, stdin=json.dumps(hook_input))
    duration = time.perf_counter() - start

    assert result.returncode == 0, result.stderr
    assert duration < 0.75, f"hook should exit quickly without a Graphiti binary (duration={duration:.2f}s)"
    assert not capture_file.exists()
