"""Unified state bridge that coordinates with Node's sessions-state.json.

This module provides StateLock for cross-runtime synchronization between Python
and Node.js when accessing sessions/sessions-state.json. Always use StateLock
when writing state to prevent race conditions.

Critical: Python and Node.js both write to sessions-state.json concurrently.
Never bypass StateLock for "quick writes" - race conditions WILL corrupt state.

Lock implementation uses mkdir() for atomicity (cross-platform, no flock() needed).
Stale locks cleaned up via process liveness checks (os.kill(pid, 0)).
"""
from __future__ import annotations

import json
import os
import shutil
import socket
import tempfile
import time
from contextlib import AbstractContextManager
from types import TracebackType
from pathlib import Path
from typing import Any, Dict, Mapping, MutableMapping, Type

from sessions.state.models import ExecutionPlan, SessionIndex

STATE_FILENAME = "sessions-state.json"
LOCK_INFO_FILENAME = "lock_info.json"

_PROJECT_ROOT: Path | None = None


def resolve_project_root() -> Path:
    """Locate the project root by inspecting CLAUDE_PROJECT_DIR or the filesystem."""
    env_root = os.environ.get("CLAUDE_PROJECT_DIR")
    if env_root:
        return Path(env_root).expanduser().resolve()

    global _PROJECT_ROOT
    if _PROJECT_ROOT is not None:
        return _PROJECT_ROOT

    current = Path.cwd().resolve()
    while True:
        if (current / ".claude").exists():
            _PROJECT_ROOT = current
            return current
        parent = current.parent
        if parent == current:
            raise RuntimeError("Unable to locate project root (.claude directory missing)")
        current = parent


def resolve_unified_state_path(state_path: Path | str | None = None) -> Path:
    if state_path is not None:
        return Path(state_path).expanduser().resolve()
    project_root = resolve_project_root()
    return (project_root / "sessions" / STATE_FILENAME).resolve()


def _lock_dir_for_state(state_path: Path) -> Path:
    if state_path.suffix == ".json":
        candidate = state_path.with_name(state_path.name.replace(".json", ".lock"))
        if candidate.suffix:
            return candidate
    return state_path.with_name(f"{state_path.name}.lock")


def _atomic_write(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(
        dir=str(path.parent),
        prefix=".tmp_state_",
        suffix=path.suffix or ".json",
        text=True,
    )
    temp_path = Path(temp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, sort_keys=True)
            handle.write("\n")
        os.replace(temp_path, path)
    except Exception:
        try:
            temp_path.unlink()
        except OSError:
            pass
        raise


class StateLock(AbstractContextManager["StateLock"]):
    """File-system lock compatible with Node's sessions-state.lock protocol."""

    def __init__(
        self,
        *,
        state_path: Path | str | None = None,
        timeout: float = 1.0,
        poll_interval: float = 0.05,
        stale_timeout: float = 30.0,
    ) -> None:
        self._state_path = resolve_unified_state_path(state_path)
        self._lock_dir = _lock_dir_for_state(self._state_path)
        self._timeout = timeout
        self._poll_interval = poll_interval
        self._stale_timeout = stale_timeout
        self._held = False

    def __enter__(self) -> "StateLock":
        deadline = time.monotonic() + self._timeout
        self._lock_dir.parent.mkdir(parents=True, exist_ok=True)
        while True:
            self._cleanup_stale_lock()
            try:
                self._lock_dir.mkdir()
                self._write_lock_info()
                self._held = True
                return self
            except FileExistsError:
                if time.monotonic() > deadline:
                    raise TimeoutError(f"Unable to acquire sessions state lock at {self._lock_dir}")
                time.sleep(self._poll_interval)

    def __exit__(
        self,
        exc_type: Type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.release()

    def release(self) -> None:
        """Release the lock if held."""
        if not self._held:
            return
        shutil.rmtree(self._lock_dir, ignore_errors=True)
        self._held = False

    def _cleanup_stale_lock(self) -> None:
        if not self._lock_dir.exists():
            return
        info_path = self._lock_dir / LOCK_INFO_FILENAME
        try:
            lock_info = json.loads(info_path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            if self._lock_dir_age() > self._stale_timeout:
                shutil.rmtree(self._lock_dir, ignore_errors=True)
            return

        timestamp_raw = lock_info.get("timestamp")
        try:
            timestamp = float(timestamp_raw)
        except (TypeError, ValueError):
            if self._lock_dir_age() > self._stale_timeout:
                shutil.rmtree(self._lock_dir, ignore_errors=True)
            return

        if (time.time() - timestamp) <= self._stale_timeout:
            return

        pid_raw = lock_info.get("pid")
        try:
            pid = int(pid_raw)
        except (TypeError, ValueError):
            if self._lock_dir_age() > self._stale_timeout:
                shutil.rmtree(self._lock_dir, ignore_errors=True)
            return

        if pid <= 0:
            if self._lock_dir_age() > self._stale_timeout:
                shutil.rmtree(self._lock_dir, ignore_errors=True)
            return

        if not self._process_alive(pid):
            shutil.rmtree(self._lock_dir, ignore_errors=True)

    @staticmethod
    def _process_alive(pid: int) -> bool:
        if pid <= 0:
            return False
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        else:
            return True

    def _write_lock_info(self) -> None:
        info = {
            "pid": os.getpid(),
            "timestamp": time.time(),
            "host": socket.gethostname(),
        }
        info_path = self._lock_dir / LOCK_INFO_FILENAME
        info_path.write_text(json.dumps(info), encoding="utf-8")

    def _lock_dir_age(self) -> float:
        try:
            return time.time() - self._lock_dir.stat().st_mtime
        except FileNotFoundError:
            return 0.0


def load_unified_state(state_path: Path | str | None = None) -> Dict[str, Any]:
    """Load the shared sessions-state.json payload."""
    path = resolve_unified_state_path(state_path)
    if not path.exists():
        return {}
    try:
        with path.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid sessions state JSON: {path}") from exc

    if not isinstance(data, dict):
        raise ValueError(f"Sessions state must be a JSON object: {path}")
    return data


def save_orchestration_state(
    *,
    session_index: SessionIndex | Mapping[str, Any] | None = None,
    execution_plan: ExecutionPlan | Mapping[str, Any] | None = None,
    state_path: Path | str | None = None,
) -> Path:
    """Persist orchestration metadata inside sessions-state.json."""
    path = resolve_unified_state_path(state_path)
    with StateLock(state_path=path):
        payload = load_unified_state(path) or {}
        metadata: MutableMapping[str, Any] = dict(payload.get("metadata") or {})
        orchestration: MutableMapping[str, Any] = dict(metadata.get("orchestration") or {})

        if session_index is not None:
            orchestration["session_index"] = (
                session_index.to_dict() if isinstance(session_index, SessionIndex) else dict(session_index)
            )
        if execution_plan is not None:
            orchestration["execution_plan"] = (
                execution_plan.to_dict() if isinstance(execution_plan, ExecutionPlan) else dict(execution_plan)
            )

        metadata["orchestration"] = orchestration
        payload["metadata"] = metadata
        _atomic_write(path, payload)
    return path
