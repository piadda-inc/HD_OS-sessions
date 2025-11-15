#!/usr/bin/env python3
"""Orchestration-aware backlog bridge utilities + legacy task helpers."""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import re
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import (
    Any,
    Dict,
    Iterable,
    List,
    Mapping,
    MutableMapping,
    Optional,
    Sequence,
    Set,
    Tuple,
)

from backlog_md import TaskStatus
from backlog_md.agent import TaskClient
from backlog_md.config import BacklogNotFoundError, get_tasks_dir
from backlog_md.files import load_task_file, load_task_metadata_only, save_task_file
from backlog_md.models import TaskMeta, task_meta_from_dict
from sessions.state.models import ExecutionGroup, ExecutionPlan, GroupStatus, SessionIndex

LOGGER = logging.getLogger(__name__ + ".BacklogBridge")


class BacklogBridgeError(RuntimeError):
    """Raised when the bridge cannot complete an operation."""


class OrchestrationMetadataError(BacklogBridgeError):
    """Raised when orchestration metadata is missing or invalid."""


@dataclass(frozen=True)
class OrchestrationMetadata:
    """Normalized orchestration payload derived from task metadata."""

    task_id: str
    stage_group_id: str
    bootstrap_stage: int
    phase: int
    parallel_group: int
    agent_type: str
    sandbox: str
    depends_on: Tuple[str, ...]
    skills: Tuple[str, ...]
    context_ref: Optional[str]
    estimated_duration_seconds: Optional[int]
    task_path: Path
    task_status: TaskStatus


@dataclass(frozen=True)
class GroupStatusSummary:
    """Aggregated status description for an execution group."""

    status: GroupStatus
    reason: str
    pending_tasks: Tuple[str, ...] = field(default_factory=tuple)
    running_tasks: Tuple[str, ...] = field(default_factory=tuple)
    completed_tasks: Tuple[str, ...] = field(default_factory=tuple)
    failed_tasks: Tuple[str, ...] = field(default_factory=tuple)
    blocking_tasks: Tuple[str, ...] = field(default_factory=tuple)
    depends_on: Tuple[str, ...] = field(default_factory=tuple)


class BacklogBridge:
    """High-level helper used by hooks to reason about backlog orchestration."""

    _COMPLETED_STATUSES = {"completed", "complete", "done", "success", "succeeded"}
    _FAILED_STATUSES = {"failed", "error", "halted"}
    _RUNNING_STATUSES = {"running", "in_progress", "in progress", "active"}
    _PENDING_STATUSES = {"pending", "queued", "waiting", "new", "scheduled"}

    def __init__(self, tasks_dir: Path | str | None = None):
        if tasks_dir is None:
            self.tasks_dir = Path(get_tasks_dir()).resolve()
        else:
            self.tasks_dir = Path(tasks_dir).expanduser().resolve()
        self.client = TaskClient(self.tasks_dir)
        self.logger = LOGGER

    # ------------------------------------------------------------------
    # Task loading helpers

    def _resolve_task_path(self, candidate: Path | str) -> Path:
        path = Path(candidate)
        if not path.is_absolute():
            if path.exists():
                return path.resolve()
            return (self.tasks_dir / path).resolve()
        return path.resolve()

    def _load_task_with_meta(self, source: Path | str | TaskMeta) -> Tuple[TaskMeta, Dict[str, Any]]:
        if isinstance(source, TaskMeta):
            if not source.file_path:
                raise OrchestrationMetadataError("Task metadata missing file_path reference")
            path = Path(source.file_path)
        else:
            path = self._resolve_task_path(source)
        raw_meta = load_task_metadata_only(path)
        try:
            task_meta = task_meta_from_dict(raw_meta, file_path=path)
        except KeyError as exc:
            missing = exc.args[0]
            raise OrchestrationMetadataError(f"Missing required field '{missing}' in metadata") from exc
        return task_meta, raw_meta

    def load_task(self, task_path: Path | str) -> TaskMeta:
        meta, _ = self._load_task_with_meta(task_path)
        return meta

    def list_orchestrated_tasks(self, *, tasks_dir: Path | str | None = None) -> List[TaskMeta]:
        directory = Path(tasks_dir).expanduser().resolve() if tasks_dir else self.tasks_dir
        client = TaskClient(directory)
        tasks = client.get_tasks_metadata_only(filters={"has_orchestration": True})
        return sorted(tasks, key=lambda meta: meta.id)

    def load_orchestrated_tasks(self, *, tasks_dir: Path | str | None = None) -> List[TaskMeta]:
        return self.list_orchestrated_tasks(tasks_dir=tasks_dir)

    # ------------------------------------------------------------------
    # Metadata extraction

    def extract_orchestration_metadata(
        self,
        source: Path | str | TaskMeta,
        *,
        strict: bool = True,
    ) -> Optional[OrchestrationMetadata]:
        try:
            task_meta, raw_meta = self._load_task_with_meta(source)
        except FileNotFoundError as exc:
            if strict:
                raise OrchestrationMetadataError(f"Task file not found: {source}") from exc
            self.logger.info("file_missing path=%s", source)
            return None
        except OrchestrationMetadataError:
            if strict:
                raise
            self.logger.info("missing_file_path task=%s", getattr(source, "id", source))
            return None

        orchestration = raw_meta.get("orchestration")
        if orchestration is None:
            return None
        if not isinstance(orchestration, dict):
            if strict:
                raise OrchestrationMetadataError("orchestration block must be a mapping")
            self.logger.info("invalid_orchestration task=%s", task_meta.id)
            return None

        try:
            bootstrap_stage = self._coerce_int(orchestration.get("bootstrap_stage"), "bootstrap_stage")
            parallel_group = self._coerce_int(orchestration.get("parallel_group"), "parallel_group")
            phase = self._coerce_int(orchestration.get("phase", 1), "phase")
            stage_group_raw = orchestration.get("stage_group_id")
            stage_group_id = str(stage_group_raw).strip() if stage_group_raw else ""
            if not stage_group_id:
                stage_group_id = f"s{bootstrap_stage}-group-{parallel_group}"
        except OrchestrationMetadataError as exc:
            if strict:
                raise
            self.logger.info("invalid_orchestration task=%s reason=%s", task_meta.id, exc)
            return None

        agent_type = str(orchestration.get("agent_type", "default")).strip() or "default"
        sandbox = str(orchestration.get("sandbox", "read-only")).strip() or "read-only"

        try:
            depends_on = self._coerce_string_tuple(orchestration.get("depends_on", []), "depends_on")
            skills = self._coerce_string_tuple(orchestration.get("skills", []), "skills")
        except OrchestrationMetadataError as exc:
            if strict:
                raise
            self.logger.info("invalid_orchestration task=%s reason=%s", task_meta.id, exc)
            return None
        estimated_duration = self._parse_duration(orchestration.get("estimated_duration"))
        context_ref = raw_meta.get("context_ref")

        metadata = OrchestrationMetadata(
            task_id=task_meta.id,
            stage_group_id=stage_group_id,
            bootstrap_stage=bootstrap_stage,
            phase=phase,
            parallel_group=parallel_group,
            agent_type=agent_type,
            sandbox=sandbox,
            depends_on=depends_on,
            skills=skills,
            context_ref=context_ref,
            estimated_duration_seconds=estimated_duration,
            task_path=Path(task_meta.file_path) if task_meta.file_path else self.tasks_dir,
            task_status=task_meta.status,
        )
        return metadata

    # ------------------------------------------------------------------
    # Group status + plan helpers

    def get_group_status(
        self,
        group_id: str,
        *,
        session_state: SessionIndex,
        plan_state: ExecutionPlan,
    ) -> GroupStatusSummary:
        group_id = group_id.strip()
        if not group_id:
            raise BacklogBridgeError("group_id is required")

        plan_groups = {group.group_id: group for group in plan_state.groups}
        group = plan_groups.get(group_id)
        if not group:
            raise BacklogBridgeError(f"Unknown execution group: {group_id}")

        blocking_tasks, normalized_deps = self._compute_blocking_tasks(group, plan_groups, session_state)
        if blocking_tasks:
            reason = f"waiting on dependency group(s): {', '.join(sorted(set(normalized_deps)))}"
            return GroupStatusSummary(
                status=GroupStatus.BLOCKED,
                reason=reason,
                blocking_tasks=tuple(blocking_tasks),
                depends_on=tuple(normalized_deps),
            )

        statuses = self._collect_session_statuses(group, session_state)
        total_tasks = len(group.task_ids)
        failed = tuple(sorted(tid for tid, state in statuses.items() if state == "failed"))
        completed = tuple(sorted(tid for tid, state in statuses.items() if state == "completed"))
        running = tuple(sorted(tid for tid, state in statuses.items() if state == "running"))
        pending = tuple(sorted(tid for tid, state in statuses.items() if state == "pending"))

        if failed:
            reason = f"{len(failed)} task(s) failed"
            status = GroupStatus.FAILED
        elif total_tasks == 0:
            status = group.status if group.status == GroupStatus.RUNNING else GroupStatus.PENDING
            reason = f"{total_tasks} task(s) scheduled" if status == GroupStatus.RUNNING else "no tasks scheduled"
        elif len(completed) == total_tasks:
            status = GroupStatus.COMPLETED
            reason = f"all {total_tasks} task(s) completed"
        elif running or completed:
            status = GroupStatus.RUNNING
            active = len(running) + len(completed)
            reason = f"{active} of {total_tasks} task(s) in progress"
        elif group.status == GroupStatus.RUNNING:
            status = GroupStatus.RUNNING
            reason = f"{total_tasks} task(s) scheduled"
        else:
            status = GroupStatus.PENDING
            reason = "no sessions started"

        return GroupStatusSummary(
            status=status,
            reason=reason,
            pending_tasks=pending,
            running_tasks=running,
            completed_tasks=completed,
            failed_tasks=failed,
            depends_on=tuple(normalized_deps),
        )

    def build_next_plan(
        self,
        *,
        current_plan: ExecutionPlan | None,
        completed_groups: Set[str],
        bootstrap_stage: int,
        task_snapshot: Sequence[TaskMeta] | None = None,
    ) -> Optional[ExecutionPlan]:
        requested_stage = int(bootstrap_stage)
        completed = {gid.strip() for gid in completed_groups}
        snapshot = list(task_snapshot) if task_snapshot is not None else self.load_orchestrated_tasks()

        # Reuse current plan if applicable (same stage + incomplete)
        if current_plan and any(
            group.bootstrap_stage == requested_stage and group.group_id not in completed
            for group in current_plan.groups
        ):
            return current_plan

        orch_entries: List[Tuple[TaskMeta, OrchestrationMetadata]] = []
        for task in snapshot:
            meta = self.extract_orchestration_metadata(task, strict=False)
            if meta is None:
                continue
            orch_entries.append((task, meta))

        if not orch_entries:
            return None

        metadata_by_task_id = {task.id: meta for task, meta in orch_entries}
        groups: Dict[str, Dict[str, Any]] = {}
        for task, meta in orch_entries:
            group_spec = groups.setdefault(
                meta.stage_group_id,
                {
                    "group_id": meta.stage_group_id,
                    "bootstrap_stage": meta.bootstrap_stage,
                    "phase": meta.phase,
                    "parallel_group": meta.parallel_group,
                    "agent_type": meta.agent_type,
                    "sandbox": meta.sandbox,
                    "tasks": [],
                    "depends_on": set(),
                },
            )
            group_spec["tasks"].append((task, meta))
            group_spec["depends_on"].update(meta.depends_on)

        ready_groups: List[Dict[str, Any]] = []
        blocked_groups = False

        for group_id, spec in groups.items():
            if spec["bootstrap_stage"] != requested_stage:
                continue
            if group_id in completed:
                continue
            all_done = all(meta.task_status == TaskStatus.DONE for task, meta in spec["tasks"])
            if all_done:
                continue

            resolved, unknown = self._resolve_dependency_groups(
                spec["depends_on"], metadata_by_task_id, groups
            )
            if unknown:
                blocked_groups = True
                continue
            outstanding = [dep for dep in resolved if dep not in completed]
            if outstanding:
                blocked_groups = True
                continue

            spec["resolved_depends"] = tuple(resolved)
            spec["has_progress"] = any(meta.task_status != TaskStatus.PENDING for _, meta in spec["tasks"])
            ready_groups.append(spec)

        if not ready_groups:
            return None

        min_parallel = min(spec["parallel_group"] for spec in ready_groups)
        ready_groups = [spec for spec in ready_groups if spec["parallel_group"] == min_parallel]

        ready_groups.sort(key=lambda item: (item["parallel_group"], item["group_id"]))

        execution_groups: List[ExecutionGroup] = []
        for index, spec in enumerate(ready_groups):
            group_tasks = sorted((task.id, meta) for task, meta in spec["tasks"])
            task_ids = tuple(task_id for task_id, _ in group_tasks)
            context_refs = {
                task_id: meta.context_ref
                for task_id, meta in group_tasks
                if meta.context_ref
            }
            estimated_total = sum(
                meta.estimated_duration_seconds or 0 for _, meta in group_tasks
            ) or None
            status = GroupStatus.RUNNING if spec["has_progress"] else GroupStatus.PENDING
            execution_groups.append(
                ExecutionGroup(
                    group_id=spec["group_id"],
                    task_ids=task_ids,
                    parallel=len(task_ids) > 1,
                    agent_type=spec["agent_type"],
                    sandbox=spec["sandbox"],
                    bootstrap_stage=spec["bootstrap_stage"],
                    phase=spec["phase"],
                    stage=spec["parallel_group"],
                    depends_on=tuple(),
                    estimated_duration=estimated_total,
                    context_refs=context_refs,
                    status=status,
                )
            )

        return ExecutionPlan(groups=execution_groups)

    # ------------------------------------------------------------------
    # Helper utilities

    def _resolve_dependency_groups(
        self,
        dependency_tokens: Iterable[str],
        metadata_by_task: Mapping[str, OrchestrationMetadata],
        groups: Mapping[str, Dict[str, Any]],
    ) -> Tuple[List[str], List[str]]:
        resolved: List[str] = []
        unknown: List[str] = []
        for token in dependency_tokens:
            dep = str(token).strip()
            if not dep:
                continue
            if dep in metadata_by_task:
                resolved.append(metadata_by_task[dep].stage_group_id)
            elif dep in groups:
                resolved.append(dep)
            else:
                unknown.append(dep)
        return resolved, unknown

    def _collect_session_statuses(
        self,
        group: ExecutionGroup,
        session_state: SessionIndex,
    ) -> Dict[str, str]:
        statuses = {task_id: "pending" for task_id in group.task_ids}
        for entry in session_state.entries:
            if entry.group_id != group.group_id:
                continue
            normalized = self._normalize_session_status(entry.status)
            statuses[entry.task_id] = normalized
        return statuses

    def _compute_blocking_tasks(
        self,
        group: ExecutionGroup,
        plan_groups: Mapping[str, ExecutionGroup],
        session_state: SessionIndex,
    ) -> Tuple[List[str], List[str]]:
        normalized_deps: List[str] = []
        blocking: List[str] = []
        entries_by_group: MutableMapping[str, List[Any]] = defaultdict(list)
        for entry in session_state.entries:
            if entry.group_id:
                entries_by_group[entry.group_id].append(entry)

        for dep in group.depends_on:
            dep_id = dep.strip()
            if not dep_id:
                continue
            normalized_deps.append(dep_id)
            dep_group = plan_groups.get(dep_id)
            if not dep_group:
                blocking.append(dep_id)
                continue
            dep_statuses = self._collect_session_statuses(dep_group, SessionIndex(entries=tuple(entries_by_group.get(dep_id, []))))
            if dep_group.task_ids:
                all_done = all(state == "completed" for state in dep_statuses.values())
            else:
                all_done = dep_group.status == GroupStatus.COMPLETED
            if not all_done:
                blocking.extend(dep_group.task_ids or (dep_id,))
        return blocking, normalized_deps

    def _normalize_session_status(self, value: Optional[str]) -> str:
        if value is None:
            return "pending"
        normalized = value.strip().lower()
        if normalized in self._COMPLETED_STATUSES:
            return "completed"
        if normalized in self._FAILED_STATUSES:
            return "failed"
        if normalized in self._RUNNING_STATUSES:
            return "running"
        if normalized in self._PENDING_STATUSES:
            return "pending"
        return "running"

    def _coerce_int(self, value: Any, field_name: str) -> int:
        if isinstance(value, bool) or value is None:
            raise OrchestrationMetadataError(f"{field_name} must be an integer")
        if isinstance(value, (int, float)):
            return int(value)
        if isinstance(value, str) and value.strip().isdigit():
            return int(value.strip())
        raise OrchestrationMetadataError(f"{field_name} must be an integer")

    def _coerce_string_tuple(self, value: Any, field_name: str) -> Tuple[str, ...]:
        if value is None:
            return tuple()
        if isinstance(value, str):
            raise OrchestrationMetadataError(f"{field_name} must be a list of strings")
        if not isinstance(value, Iterable):
            raise OrchestrationMetadataError(f"{field_name} must be a list of strings")
        result: List[str] = []
        for item in value:
            if not isinstance(item, str):
                raise OrchestrationMetadataError(f"{field_name} entries must be strings")
            item = item.strip()
            if item:
                result.append(item)
        return tuple(result)

    _DURATION_PATTERN = re.compile(
        r"^(?P<num>\d+(?:\.\d+)?)\s*(?P<unit>s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)?$"
    )

    def _parse_duration(self, value: Any) -> Optional[int]:
        if value is None:
            return None
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return int(value)
        if not isinstance(value, str):
            return None
        text = value.strip().lower()
        if not text:
            return None
        match = self._DURATION_PATTERN.match(text)
        if not match:
            return None
        amount = float(match.group("num"))
        unit = match.group("unit") or "s"
        if unit.startswith("h"):
            seconds = amount * 3600
        elif unit.startswith("m"):
            seconds = amount * 60
        else:
            seconds = amount
        return int(seconds)


# ----------------------------------------------------------------------
# Legacy CLI helpers (status / update / list / validate)


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
    if isinstance(obj, Enum):
        return obj.value
    if isinstance(obj, dict):
        return {key: _deep_convert_enums(value) for key, value in obj.items()}
    if isinstance(obj, (list, tuple)):
        return type(obj)(_deep_convert_enums(item) for item in obj)
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

    return {
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
    except Exception as exc:  # pragma: no cover
        output_json({"error": f"Unexpected error: {exc}"})
        return 2


if __name__ == "__main__":
    import sys as _sys

    _sys.exit(main(_sys.argv[1:]))
