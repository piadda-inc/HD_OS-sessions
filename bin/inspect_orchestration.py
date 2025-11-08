"""CLI inspector for orchestration telemetry."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Iterable, List, Mapping, MutableMapping, Sequence

from sessions.state.logger import resolve_log_path


def load_events(log_path: Path, limit: int = 50) -> List[Mapping[str, object]]:
    """Return the newest events from the JSONL log."""
    target = Path(log_path)
    if not target.exists():
        return []

    lines = target.read_text(encoding="utf-8").splitlines()
    selected = lines[-limit:] if limit else lines
    events: List[Mapping[str, object]] = []
    for line in selected:
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return events


def summarize_groups(events: Sequence[Mapping[str, object]]) -> List[MutableMapping[str, object]]:
    """Return the group snapshot from the latest plan update."""
    for event in reversed(events):
        if event.get("event") != "plan.update":
            continue
        groups = event.get("groups")
        if not isinstance(groups, list):
            continue
        digest = event.get("plan_digest")
        summary: List[MutableMapping[str, object]] = []
        for group in groups:
            if not isinstance(group, Mapping):
                continue
            entry = {
                "group_id": group.get("group_id"),
                "status": group.get("status"),
                "sandbox": group.get("sandbox"),
                "task_ids": group.get("task_ids"),
                "plan_digest": digest,
            }
            summary.append(entry)
        return summary
    return []


def summarize_execute_signals(
    events: Sequence[Mapping[str, object]]
) -> List[MutableMapping[str, object]]:
    """Summarize outstanding execute_plan signals."""
    summary: List[MutableMapping[str, object]] = []
    for event in events:
        if event.get("event") != "subagent_stop.decision":
            continue
        if event.get("decision") != "block":
            continue
        signal_id = event.get("signal_id")
        if not signal_id:
            continue
        summary.append(
            {
                "signal_id": signal_id,
                "group_id": event.get("group_id"),
                "sandbox": event.get("sandbox"),
                "reason": event.get("reason"),
                "ts": event.get("ts"),
            }
        )
    return summary


def _format_event(event: Mapping[str, object]) -> str:
    base = f"[{event.get('ts', '?')}] {event.get('level', 'info')} {event.get('event')}"
    extras = []
    for key in ("decision", "group_id", "signal_id", "tool_name"):
        if key in event:
            extras.append(f"{key}={event[key]}")
    return f"{base} ({', '.join(extras)})" if extras else base


def _print_section(title: str, lines: Iterable[str]) -> None:
    print(title)
    for line in lines:
        print(f"  {line}")
    print()


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Inspect orchestration telemetry events.")
    parser.add_argument(
        "--log-path",
        type=str,
        default=None,
        help="Path to orchestration.log (defaults to sessions/state/orchestration.log).",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=20,
        help="Number of recent events to display.",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """CLI entry point."""
    parser = _build_parser()
    args = parser.parse_args(list(argv) if argv is not None else None)

    log_path = Path(args.log_path).expanduser() if args.log_path else resolve_log_path()
    events = load_events(log_path, limit=args.limit)

    print(f"Orchestration log: {log_path}")
    if not events:
        print("No telemetry entries found.")
        return 0

    _print_section("Recent events", (_format_event(evt) for evt in events))

    groups = summarize_groups(events)
    if groups:
        group_lines = [
            f"{g.get('group_id')} {g.get('status')} sandbox={g.get('sandbox')} tasks={g.get('task_ids')}"
            for g in groups
        ]
        _print_section("Active Groups", group_lines)
    else:
        print("Active Groups\n  No plan updates captured yet.\n")

    signals = summarize_execute_signals(events)
    if signals:
        signal_lines = [
            f"{sig.get('signal_id')} (group={sig.get('group_id')} sandbox={sig.get('sandbox')})"
            for sig in signals
        ]
        _print_section("Outstanding execute_plan signals", signal_lines)
    else:
        print("Outstanding execute_plan signals\n  None recorded.\n")

    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
