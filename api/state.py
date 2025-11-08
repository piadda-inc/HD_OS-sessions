"""CLI utilities for managing orchestration state artifacts."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Sequence

from sessions.state.models import ExecutionPlan, SessionIndex
from sessions.state.persistence import save_execution_plan, save_session_index

SESSION_INDEX_FILENAME = "session_index.json"
EXECUTION_PLAN_FILENAME = "execution_plan.json"
DEFAULT_STATE_DIR = (Path(__file__).resolve().parents[1] / "state").resolve()


def initialize_state_directory(state_dir: Path, *, force: bool = False) -> Path:
    """Create the state directory and empty persistence files."""
    resolved_dir = state_dir.expanduser().resolve()
    if resolved_dir.exists() and not resolved_dir.is_dir():
        raise NotADirectoryError(f"State path exists and is not a directory: {resolved_dir}")

    resolved_dir.mkdir(parents=True, exist_ok=True)
    session_index_path = resolved_dir / SESSION_INDEX_FILENAME
    execution_plan_path = resolved_dir / EXECUTION_PLAN_FILENAME

    if not force:
        existing = [path for path in (session_index_path, execution_plan_path) if path.exists()]
        if existing:
            existing_list = ", ".join(str(path) for path in existing)
            raise FileExistsError(f"State file already exists: {existing_list}")

    save_session_index(SessionIndex(), session_index_path)
    save_execution_plan(ExecutionPlan(), execution_plan_path)
    return resolved_dir


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Sessions state management CLI.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    init_parser = subparsers.add_parser(
        "init", help="Initialize an orchestration state directory with empty artifacts."
    )
    init_parser.add_argument(
        "--state-dir",
        type=str,
        default=None,
        help="Directory where session_index.json and execution_plan.json should be written.",
    )
    init_parser.add_argument(
        "--force",
        action="store_true",
        help="Overwrite existing files if they are already present.",
    )

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """CLI entry point for state management commands."""
    parser = _build_parser()
    args = parser.parse_args(list(argv) if argv is not None else None)

    if args.command == "init":
        state_dir = Path(args.state_dir).expanduser() if args.state_dir else DEFAULT_STATE_DIR
        try:
            initialize_state_directory(state_dir, force=args.force)
        except (FileExistsError, NotADirectoryError, OSError, ValueError) as exc:
            print(f"Error: {exc}", file=sys.stderr)
            return 1

        print(f"Initialized sessions state at {state_dir}")
        return 0

    parser.error("Unknown command")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
