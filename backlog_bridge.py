#!/usr/bin/env python3
"""Thin CLI wrapper around backlog_md APIs for Node.js interoperability."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from backlog_md import TaskStatus
from backlog_md.config import BacklogNotFoundError, get_tasks_dir
from backlog_md.files import load_task_file, save_task_file


class BacklogBridgeError(RuntimeError):
    """Raised when the bridge cannot complete an operation."""


def _status_aliases() -> Dict[str, TaskStatus]:
    aliases: Dict[str, TaskStatus] = {}
    for status in TaskStatus:
        aliases[status.name.lower()] = status
        aliases[status.value.lower()] = status
    aliases.update(
        {
            "todo": TaskStatus.PENDING,
            "to do": TaskStatus.PENDING,
            "pending": TaskStatus.PENDING,
            "in_progress": TaskStatus.IN_PROGRESS,
            "in progress": TaskStatus.IN_PROGRESS,
            "doing": TaskStatus.IN_PROGRESS,
            "done": TaskStatus.DONE,
            "complete": TaskStatus.DONE,
            "completed": TaskStatus.DONE,
        }
    )
    return aliases


STATUS_ALIASES = _status_aliases()


def _deep_convert_enums(obj: Any) -> Any:
    """Recursively convert all Enum instances to their values for JSON serialization."""
    if isinstance(obj, Enum):
        return obj.value
    elif isinstance(obj, dict):
        return {key: _deep_convert_enums(value) for key, value in obj.items()}
    elif isinstance(obj, (list, tuple)):
        return type(obj)(_deep_convert_enums(item) for item in obj)
    else:
        return obj


def _parse_status(value: str) -> TaskStatus:
    key = value.strip().lower()
    if key in STATUS_ALIASES:
        return STATUS_ALIASES[key]
    raise BacklogBridgeError(f"Unsupported status value: {value}")


def _tasks_root() -> Path:
    try:
        return Path(get_tasks_dir()).resolve()
    except BacklogNotFoundError as exc:
        raise BacklogBridgeError(str(exc)) from exc


def _resolve_task_path(path_str: str) -> Path:
    if not path_str:
        raise BacklogBridgeError("Task path is required")

    candidate = Path(path_str)
    if not candidate.is_absolute():
        candidate = _tasks_root() / candidate
    candidate = candidate.resolve()

    try:
        candidate.relative_to(_tasks_root())
    except ValueError as exc:
        raise BacklogBridgeError(f"Task path must live inside { _tasks_root() }") from exc

    if candidate.is_dir():
        readme = candidate / "README.md"
        if readme.exists():
            candidate = readme
        else:
            raise BacklogBridgeError(f"Directory tasks must contain README.md: {candidate}")

    if not candidate.exists():
        raise BacklogBridgeError(f"Task file not found: {candidate}")

    return candidate


def _read_task(task_path: Path) -> Dict[str, Any]:
    metadata, body = load_task_file(task_path)
    stat = task_path.stat()
    content = task_path.read_bytes()
    sha_digest = hashlib.sha256(content).hexdigest()
    raw_dependencies = metadata.get("dependencies", [])
    if isinstance(raw_dependencies, (list, tuple)):
        dependencies = list(raw_dependencies)
    else:
        dependencies = []

    branch = metadata.get("branch")
    if isinstance(branch, list):
        branch = branch[0] if branch else None

    status = metadata.get("status")
    if isinstance(status, TaskStatus):
        status_value = status.value
        status_key = status.name
    else:
        status_value = str(status) if status is not None else None
        status_key = status_value.lower().replace(" ", "_") if status_value else None

    # Ensure ALL data is JSON-serializable by deep-converting all Enum instances
    result: Dict[str, Any] = {
        "path": str(task_path.relative_to(_tasks_root())),
        "absolute_path": str(task_path),
        "id": metadata.get("id"),
        "title": metadata.get("title"),
        "status": status_value,
        "status_key": status_key,
        "mtime": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
        "hash": sha_digest,
        "dependencies": dependencies,
        "branch": branch,
        "labels": metadata.get("labels", []),
        "metadata": _deep_convert_enums(metadata),
        "body": body,
    }
    return result


def handle_status(task_path: str) -> Dict[str, Any]:
    path = _resolve_task_path(task_path)
    return _read_task(path)


def handle_update(task_path: str, status: str) -> Dict[str, Any]:
    path = _resolve_task_path(task_path)
    metadata, body = load_task_file(path)
    new_status = _parse_status(status)
    metadata["status"] = new_status
    save_task_file(path, metadata, body)
    return _read_task(path)


def handle_validate(task_path: str) -> Dict[str, Any]:
    try:
        info = handle_status(task_path)
        info.pop("body", None)
        return {"valid": True, "task": info}
    except BacklogBridgeError as exc:
        return {"valid": False, "error": str(exc)}


def _iter_tasks() -> Iterable[Path]:
    root = _tasks_root()
    if not root.exists():
        return []
    for path in sorted(root.rglob("*.md")):
        if path.name.startswith("TEMPLATE"):
            continue
        yield path


def handle_list(status_filter: Optional[str]) -> Dict[str, Any]:
    tasks: List[Dict[str, Any]] = []
    filter_status: Optional[TaskStatus] = None
    if status_filter:
        filter_status = _parse_status(status_filter)

    for task_path in _iter_tasks():
        try:
            info = _read_task(task_path)
        except BacklogBridgeError:
            # Skip unreadable task files but record failure
            continue

        if filter_status:
            current = info.get("status")
            if isinstance(current, str) and current.lower() != filter_status.value.lower():
                continue
        info.pop("body", None)
        tasks.append(info)

    return {"tasks": tasks}


def output_json(data: Dict[str, Any]) -> None:
    print(json.dumps(data, indent=2, ensure_ascii=False))


def main(argv: List[str]) -> int:
    parser = argparse.ArgumentParser(prog="backlog_bridge")
    sub = parser.add_subparsers(dest="command", required=True)

    status_cmd = sub.add_parser("status", help="Inspect a task file")
    status_cmd.add_argument("task_path")

    update_cmd = sub.add_parser("update", help="Update a task's status")
    update_cmd.add_argument("task_path")
    update_cmd.add_argument("status")

    list_cmd = sub.add_parser("list", help="List tasks")
    list_cmd.add_argument("--status", dest="status_filter")

    validate_cmd = sub.add_parser("validate", help="Validate a task path")
    validate_cmd.add_argument("task_path")

    args = parser.parse_args(argv)

    try:
        if args.command == "status":
            output_json(handle_status(args.task_path))
        elif args.command == "update":
            output_json(handle_update(args.task_path, args.status))
        elif args.command == "list":
            output_json(handle_list(args.status_filter))
        elif args.command == "validate":
            output_json(handle_validate(args.task_path))
        else:
            raise BacklogBridgeError(f"Unknown command: {args.command}")
        return 0
    except BacklogBridgeError as exc:
        output_json({"error": str(exc)})
        return 1
    except Exception as exc:  # pragma: no cover - safety net
        output_json({"error": f"Unexpected error: {exc}"})
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
