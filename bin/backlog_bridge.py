"""CLI entrypoint that coordinates SubagentStop orchestration updates."""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, MutableMapping, Sequence, Set

from backlog_md.models import TaskMeta

from sessions.backlog_bridge import BacklogBridge, BacklogBridgeError
from sessions.state.bridge import StateLock
from sessions.state.models import ExecutionGroup, ExecutionPlan, GroupStatus, SessionIndex, SessionIndexEntry
from sessions.state.persistence import (
    load_execution_plan,
    load_session_index,
    save_execution_plan,
    save_session_index,
)

try:  # pragma: no cover - optional integration
    from sessions.state.bridge import save_orchestration_state
except Exception:  # pragma: no cover - bridge not available
    save_orchestration_state = None

STATE_INDEX_FILENAME = "session_index.json"
STATE_PLAN_FILENAME = "execution_plan.json"
SUCCESS_STATUSES = {"completed", "complete", "success", "succeeded", "ok"}


def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def _default_project_root() -> Path:
    env_root = os.environ.get("CLAUDE_PROJECT_DIR")
    if env_root:
        return Path(env_root).expanduser().resolve()
    return Path(__file__).resolve().parents[2]


def _default_state_dir() -> Path:
    override = os.environ.get("SESSIONS_STATE_DIR")
    if override:
        return Path(override).expanduser().resolve()
    return (_default_project_root() / "sessions" / "state").resolve()


def _default_tasks_dir() -> Path:
    override = os.environ.get("BACKLOG_TASKS_DIR")
    if override:
        return Path(override).expanduser().resolve()
    return (_default_project_root() / "backlog" / "tasks").resolve()


def _normalize_status(value: str | None) -> str:
    text = (value or "").strip().lower()
    return text or "completed"


def _is_success_status(value: str) -> bool:
    return value in SUCCESS_STATUSES


def _create_backup(path: Path) -> Path | None:
    if not path.exists():
        return None
    backup = path.with_name(f"{path.stem}.prev{path.suffix}")
    shutil.copy2(path, backup)
    return backup


def _restore_backup(backup: Path | None, path: Path) -> None:
    if backup is None:
        return
    shutil.copy2(backup, path)


def _update_session_index(
    index: SessionIndex,
    *,
    session_id: str,
    task_id: str,
    status: str,
    group_id: str,
    subagent_type: str,
    now: str,
) -> SessionIndex:
    entries: List[SessionIndexEntry] = list(index.entries)
    for idx, entry in enumerate(entries):
        if entry.session_id == session_id:
            entries[idx] = SessionIndexEntry(
                session_id=session_id,
                task_id=task_id,
                created_at=entry.created_at,
                updated_at=now,
                status=status,
                group_id=group_id,
                subagent_type=subagent_type,
            )
            break
    else:
        entries.append(
            SessionIndexEntry(
                session_id=session_id,
                task_id=task_id,
                created_at=now,
                updated_at=now,
                status=status,
                group_id=group_id,
                subagent_type=subagent_type,
            )
        )
    return SessionIndex(entries=tuple(entries))


def _update_plan_status(
    plan: ExecutionPlan,
    *,
    group_id: str,
    new_status: GroupStatus,
    completed_at: str,
) -> ExecutionPlan:
    updated: List[ExecutionGroup] = []
    for group in plan.groups:
        if group.group_id != group_id:
            updated.append(group)
            continue
        updated.append(
            ExecutionGroup(
                group_id=group.group_id,
                task_ids=group.task_ids,
                parallel=group.parallel,
                agent_type=group.agent_type,
                sandbox=group.sandbox,
                bootstrap_stage=group.bootstrap_stage,
                phase=group.phase,
                stage=group.stage,
                depends_on=group.depends_on,
                estimated_duration=group.estimated_duration,
                context_refs=group.context_refs,
                status=new_status,
                started_at=group.started_at or completed_at,
                completed_at=completed_at,
            )
        )
    return ExecutionPlan(groups=updated or plan.groups)


def _successful_groups(index: SessionIndex) -> Set[str]:
    completed: Set[str] = set()
    for entry in index.entries:
        if entry.group_id and _is_success_status(entry.status):
            completed.add(entry.group_id)
    return completed


def _collect_metadata(
    bridge: BacklogBridge,
    *,
    task_id: str,
) -> tuple[int, List[TaskMeta]]:
    tasks = bridge.load_orchestrated_tasks()
    task_lookup: MutableMapping[str, TaskMeta] = {task.id: task for task in tasks}
    task_meta = task_lookup.get(task_id)
    if task_meta is None:
        raise BacklogBridgeError(f"Unknown task id: {task_id}")
    metadata = bridge.extract_orchestration_metadata(task_meta)
    if metadata is None:
        raise BacklogBridgeError(f"Task {task_id} lacks orchestration metadata")
    return metadata.bootstrap_stage, tasks


def _handle_subagent_stop(args: argparse.Namespace) -> Dict[str, object]:
    state_dir = Path(args.state_dir).expanduser().resolve() if args.state_dir else _default_state_dir()
    tasks_dir = Path(args.tasks_dir).expanduser().resolve() if args.tasks_dir else _default_tasks_dir()
    session_index_path = state_dir / STATE_INDEX_FILENAME
    execution_plan_path = state_dir / STATE_PLAN_FILENAME
    state_lock_path = state_dir / "sessions-state.json"
    state_dir.mkdir(parents=True, exist_ok=True)

    with StateLock(state_path=state_lock_path):
        plan = load_execution_plan(execution_plan_path)
        index = load_session_index(session_index_path)

        bridge = BacklogBridge(tasks_dir=tasks_dir)
        bootstrap_stage, tasks = _collect_metadata(bridge, task_id=args.task_id)

        now = _timestamp()
        normalized_status = _normalize_status(args.exit_status)
        updated_index = _update_session_index(
            index,
            session_id=args.session_id,
            task_id=args.task_id,
            status=normalized_status,
            group_id=args.group_id,
            subagent_type=args.subagent_type,
            now=now,
        )

        success = _is_success_status(normalized_status)
        new_plan = _update_plan_status(
            plan,
            group_id=args.group_id,
            new_status=GroupStatus.COMPLETED if success else GroupStatus.FAILED,
            completed_at=now,
        )

        completed_groups = _successful_groups(updated_index)
        next_plan = bridge.build_next_plan(
            current_plan=new_plan,
            completed_groups=completed_groups,
            bootstrap_stage=bootstrap_stage,
            task_snapshot=tasks,  # type: ignore[arg-type]
        )

        if success:
            persisted_plan = next_plan or ExecutionPlan()
        else:
            persisted_plan = new_plan
        plan_backup = _create_backup(execution_plan_path)
        index_backup = _create_backup(session_index_path)

        delay_txt = os.environ.get("BACKLOG_BRIDGE_TEST_SLEEP_BEFORE_SAVE")
        if delay_txt:
            try:
                delay = float(delay_txt)
            except ValueError:
                delay = 0.0
            if delay > 0:
                time.sleep(delay)

        try:
            save_execution_plan(persisted_plan, execution_plan_path)
            save_session_index(updated_index, session_index_path)
            if save_orchestration_state:
                save_orchestration_state(session_index=updated_index, execution_plan=persisted_plan)
        except Exception:
            _restore_backup(plan_backup, execution_plan_path)
            _restore_backup(index_backup, session_index_path)
            raise

        if success and persisted_plan.groups:
            next_group_id = persisted_plan.groups[0].group_id
            signal = f"execute_plan:group-{next_group_id}"
            status = "next-group"
        elif success:
            next_group_id = None
            signal = "execute_plan:complete"
            status = "complete"
        else:
            next_group_id = None
            signal = "execute_plan:halt"
            status = "failed"

        return {
            "status": status,
            "signal": signal,
            "next_group_id": next_group_id,
            "session_index_path": str(session_index_path),
            "execution_plan_path": str(execution_plan_path),
            "session_id": args.session_id,
            "group_id": args.group_id,
            "completed_groups": sorted(completed_groups),
        }


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Backlog bridge orchestration CLI.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    stop_parser = subparsers.add_parser("subagent-stop", help="Handle SubagentStop orchestration bookkeeping.")
    stop_parser.add_argument("--session-id", required=True)
    stop_parser.add_argument("--task-id", required=True)
    stop_parser.add_argument("--group-id", required=True)
    stop_parser.add_argument("--subagent-type", required=True)
    stop_parser.add_argument("--exit-status", required=True)
    stop_parser.add_argument("--state-dir", default=None)
    stop_parser.add_argument("--tasks-dir", default=None)

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(list(argv) if argv is not None else None)

    try:
        if args.command == "subagent-stop":
            payload = _handle_subagent_stop(args)
            json.dump(payload, sys.stdout)
            sys.stdout.write("\n")
            return 0
        parser.error(f"Unknown command: {args.command}")
    except (BacklogBridgeError, FileNotFoundError, RuntimeError, OSError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:  # pragma: no cover - surface unexpected errors
        print(f"Unexpected error: {exc}", file=sys.stderr)
        return 1
    return 1


if __name__ == "__main__":  # pragma: no mutate
    raise SystemExit(main())
