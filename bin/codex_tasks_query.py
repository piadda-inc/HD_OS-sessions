#!/usr/bin/env python3

"""
Query codex-delegate background task metadata for statusline display.

Outputs a JSON payload with running tasks plus recently finished tasks so the
statusline can show real-time progress without duplicating the SQLite schema.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

def empty_payload() -> Dict[str, List[Dict[str, Any]]]:
    return {"running": [], "recent": []}


def parse_timestamp(value: Optional[str]) -> Optional[datetime]:
    """Parse various SQLite timestamp formats into timezone-aware datetimes."""
    if not value:
        return None
    if isinstance(value, datetime):
        dt = value
    else:
        text = str(value).strip()
        if not text:
            return None
        # Normalize space-separated format into ISO-like representation first
        normalized = text.replace(" ", "T")
        try:
            dt = datetime.fromisoformat(normalized)
        except ValueError:
            # Fallback to common SQLite format
            try:
                dt = datetime.strptime(text, "%Y-%m-%d %H:%M:%S")
            except ValueError:
                return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def to_iso(value: Optional[str]) -> Optional[str]:
    """Convert DB timestamp column into ISO 8601 string with Z suffix."""
    dt = parse_timestamp(value)
    if not dt:
        return None
    return dt.isoformat().replace("+00:00", "Z")


def get_codex_root() -> Optional[str]:
    """Return path to codex-delegate checkout, allowing overrides."""
    env_overrides = [
        os.environ.get("CODEX_DELEGATE_ROOT"),
        os.environ.get("CODEX_DELEGATE_DIR"),
    ]
    for candidate in env_overrides:
        if candidate:
            path = Path(candidate).expanduser()
            if path.exists():
                return str(path)

    default = Path.home() / "codex-delegate"
    if default.exists():
        return str(default)
    return None


def find_git_root(start_path: Optional[str]) -> Optional[Path]:
    """Find the git repository root for the provided path."""
    if not start_path:
        return None
    try:
        current = Path(start_path).resolve()
    except FileNotFoundError:
        return None

    while True:
        if (current / ".git").exists():
            return current
        if current.parent == current:
            return None
        current = current.parent


def _get_project_db(cwd: Optional[str]) -> Optional[Path]:
    """Resolve project-scoped database path if it exists."""
    if not cwd:
        return None

    project_root = find_git_root(cwd)
    if not project_root:
        try:
            project_root = Path(cwd).resolve()
        except FileNotFoundError:
            return None

    db_path = project_root / ".codex-delegate" / "background_tasks.db"
    return db_path if db_path.exists() else None


def get_db_path(cwd: Optional[str] = None) -> Optional[Path]:
    """Resolve database path, preferring project-scoped DB when provided."""
    project_db = _get_project_db(cwd)
    if project_db:
        return project_db

    env_overrides = [
        os.environ.get("CC_SESSIONS_CODEX_DB"),
        os.environ.get("CODEX_DELEGATE_DB"),
        os.environ.get("CODEX_BACKGROUND_DB"),
    ]
    for candidate in env_overrides:
        if candidate:
            path = Path(candidate).expanduser()
            if path.exists():
                return path

    default = Path.home() / ".cache" / "codex-delegate" / "background_tasks.db"
    return default if default.exists() else None


def emit(payload: Dict[str, Any]) -> None:
    """Print JSON payload for the Node statusline reader."""
    print(json.dumps(payload))


def collect_tasks(cwd: Optional[str] = None) -> Dict[str, Any]:
    """Collect running and recent tasks via codex-delegate's API."""
    if not cwd:
        cwd = os.environ.get("CLAUDE_PROJECT_DIR")

    db_path = get_db_path(cwd)
    if not db_path:
        return empty_payload()

    codex_root = get_codex_root()
    if not codex_root:
        return empty_payload()

    if codex_root not in sys.path:
        sys.path.insert(0, codex_root)

    try:
        from codex_delegate.background import BackgroundTaskManager
    except Exception:
        return empty_payload()

    now = datetime.now(timezone.utc)
    stale_cutoff = now - timedelta(minutes=3)
    recent_cutoff = now - timedelta(minutes=5)

    payload: Dict[str, List[Dict[str, Any]]] = empty_payload()

    try:
        with BackgroundTaskManager(str(db_path)) as manager:
            running_rows = manager.list_tasks(status="running")
            for row in running_rows:
                status = manager.get_status(row["task_id"])
                last_update_iso = to_iso(status.get("last_update"))
                last_update_dt = parse_timestamp(status.get("last_update"))
                # Tasks are stale if: no last_update (NULL) OR last_update is too old
                stale = not last_update_dt or last_update_dt < stale_cutoff
                # Skip stale tasks entirely - they're likely dead processes
                if stale:
                    continue
                payload["running"].append(
                    {
                        "task_id": row["task_id"],
                        "name": row["name"],
                        "status": row["status"],
                        "created_at": to_iso(row.get("started_at") or row.get("created_at")),
                        "last_update": last_update_iso,
                        "stale": stale,
                    }
                )
                if len(payload["running"]) >= 5:
                    break

            for status_name in ("completed", "failed", "killed"):
                if len(payload["recent"]) >= 5:
                    break
                for row in manager.list_tasks(status=status_name):
                    completed_dt = parse_timestamp(row.get("completed_at"))
                    if not completed_dt or completed_dt < recent_cutoff:
                        continue
                    payload["recent"].append(
                        {
                            "task_id": row["task_id"],
                            "name": row["name"],
                            "status": row["status"],
                            "created_at": to_iso(row.get("created_at")),
                            "completed_at": to_iso(row.get("completed_at")),
                        }
                    )
                    if len(payload["recent"]) >= 5:
                        break
    except Exception:
        return empty_payload()

    return payload


def main() -> None:
    cwd = os.environ.get("CLAUDE_PROJECT_DIR")
    payload = collect_tasks(cwd=cwd)
    emit(payload)


if __name__ == "__main__":
    main()
