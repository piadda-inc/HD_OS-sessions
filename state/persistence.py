"""Persistence helpers for orchestration session state artifacts."""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any, Mapping

from sessions.state.bridge import (
    load_unified_state,
    resolve_project_root,
    save_orchestration_state,
)
from sessions.state.models import ExecutionPlan, SessionIndex


def _atomic_write_json(path: Path, payload: Mapping[str, Any]) -> None:
    """Write JSON payload to path atomically (temp file + rename)."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)

    fd, temp_path = tempfile.mkstemp(
        dir=str(target.parent),
        prefix=".tmp_state_",
        suffix=target.suffix or ".json",
        text=True,
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, sort_keys=True)
            handle.write("\n")

        os.replace(temp_path, target)
    except Exception:
        try:
            os.unlink(temp_path)
        except OSError:
            pass
        raise


def _legacy_state_dir() -> Path | None:
    try:
        project_root = resolve_project_root()
    except RuntimeError:
        return None
    return project_root / "sessions" / "state"


def _legacy_path(default_filename: str, path: Path | str | None) -> Path | None:
    if path is not None:
        return Path(path)
    legacy_dir = _legacy_state_dir()
    if legacy_dir is None:
        return None
    return legacy_dir / default_filename


def save_session_index(index: SessionIndex, path: Path | str | None = None) -> Path:
    """Persist a SessionIndex instance, defaulting to the unified sessions-state.json."""
    if path is not None:
        target = Path(path)
        _atomic_write_json(target, index.to_dict())
        return target

    target = save_orchestration_state(session_index=index)
    legacy_path = _legacy_path("session_index.json", None)
    if legacy_path is not None:
        try:
            _atomic_write_json(legacy_path, index.to_dict())
        except OSError:
            pass
    return target


def _load_session_index_from_path(target: Path) -> SessionIndex:
    if not target.exists():
        return SessionIndex()
    try:
        with target.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid session index JSON: {target}") from exc
    if not isinstance(data, dict):
        raise ValueError(f"Session index data must be a JSON object: {target}")
    return SessionIndex.from_dict(data)


def load_session_index(path: Path | str | None = None) -> SessionIndex:
    """Load a SessionIndex, preferring the unified sessions-state.json metadata."""
    if path is not None:
        return _load_session_index_from_path(Path(path))

    try:
        state = load_unified_state()
    except ValueError:
        state = {}
    orchestration = (state.get("metadata") or {}).get("orchestration") or {}
    data = orchestration.get("session_index")
    if isinstance(data, dict):
        return SessionIndex.from_dict(data)

    legacy_path = _legacy_path("session_index.json", None)
    if legacy_path is not None and legacy_path.exists():
        return _load_session_index_from_path(legacy_path)

    return SessionIndex()


def save_execution_plan(plan: ExecutionPlan, path: Path | str | None = None) -> Path:
    """Persist an ExecutionPlan instance, defaulting to the unified state file."""
    if path is not None:
        target = Path(path)
        _atomic_write_json(target, plan.to_dict())
        return target

    target = save_orchestration_state(execution_plan=plan)
    legacy_path = _legacy_path("execution_plan.json", None)
    if legacy_path is not None:
        try:
            _atomic_write_json(legacy_path, plan.to_dict())
        except OSError:
            pass
    return target


def _load_execution_plan_from_path(target: Path) -> ExecutionPlan:
    if not target.exists():
        return ExecutionPlan()

    try:
        with target.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid execution plan JSON: {target}") from exc

    if not isinstance(data, dict):
        raise ValueError(f"Execution plan data must be a JSON object: {target}")

    return ExecutionPlan.from_dict(data)


def load_execution_plan(path: Path | str | None = None) -> ExecutionPlan:
    """Load an ExecutionPlan, preferring the unified sessions-state metadata."""
    if path is not None:
        return _load_execution_plan_from_path(Path(path))

    try:
        state = load_unified_state()
    except ValueError:
        state = {}
    orchestration = (state.get("metadata") or {}).get("orchestration") or {}
    data = orchestration.get("execution_plan")
    if isinstance(data, dict):
        return ExecutionPlan.from_dict(data)

    legacy_path = _legacy_path("execution_plan.json", None)
    if legacy_path is not None and legacy_path.exists():
        return _load_execution_plan_from_path(legacy_path)

    return ExecutionPlan()
