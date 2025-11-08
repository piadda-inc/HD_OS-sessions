"""Shared telemetry utilities for orchestration hooks (Python side)."""
from __future__ import annotations

import json
import os
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, MutableMapping

LOG_LEVELS = {
    "error": 40,
    "warn": 30,
    "warning": 30,
    "info": 20,
    "debug": 10,
}

DEFAULT_MAX_BYTES = 5 * 1024 * 1024
DEFAULT_MAX_BACKUPS = 3


def _resolve_level_name(value: str | None) -> str:
    if not value:
        return "info"
    lowered = value.lower()
    return lowered if lowered in LOG_LEVELS else "info"


def _level_value(name: str) -> int:
    return LOG_LEVELS.get(_resolve_level_name(name), LOG_LEVELS["info"])


def _min_level() -> int:
    env_level = os.getenv("ORCH_LOG_LEVEL", "info")
    return _level_value(env_level)


def _max_bytes() -> int:
    raw = os.getenv("ORCH_LOG_MAX_BYTES")
    if raw:
        try:
            return max(int(raw), 0)
        except ValueError:
            pass
    return DEFAULT_MAX_BYTES


def _max_backups() -> int:
    raw = os.getenv("ORCH_LOG_MAX_BACKUPS")
    if raw:
        try:
            return max(int(raw), 1)
        except ValueError:
            pass
    return DEFAULT_MAX_BACKUPS


def resolve_log_path() -> Path:
    """Return the configured log path."""
    env_path = os.getenv("ORCH_LOG_PATH")
    if env_path:
        return Path(env_path).expanduser()
    return Path(__file__).resolve().parent / "orchestration.log"


def _ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def _rotate_logs(log_path: Path) -> None:
    max_bytes = _max_bytes()
    if max_bytes == 0:
        return

    try:
        size = log_path.stat().st_size
    except FileNotFoundError:
        return

    if size < max_bytes:
        return

    max_backups = _max_backups()
    for idx in range(max_backups, 0, -1):
        src = log_path.with_name(f"{log_path.name}.{idx}")
        dst = log_path.with_name(f"{log_path.name}.{idx + 1}")
        if src.exists():
            if idx == max_backups:
                src.unlink(missing_ok=True)
            else:
                src.replace(dst)

    backup = log_path.with_name(f"{log_path.name}.1")
    try:
        log_path.replace(backup)
    except FileNotFoundError:
        return


def _should_log(level_name: str) -> bool:
    return _level_value(level_name) >= _min_level()


def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _serialize_entry(entry: Dict[str, Any]) -> str:
    return json.dumps(entry, separators=(",", ":"))


def log_event(
    *,
    event: str,
    component: str,
    level: str = "info",
    hook: str | None = None,
    **fields: Any,
) -> Dict[str, Any] | None:
    """Persist a structured telemetry entry."""
    level_name = _resolve_level_name(level)
    if not _should_log(level_name):
        return None

    payload: Dict[str, Any] = {
        "ts": _timestamp(),
        "level": level_name,
        "component": component,
        "event": event,
    }
    if hook:
        payload["hook"] = hook

    for key, value in fields.items():
        if value is None:
            continue
        if key == "latency_ms":
            try:
                payload[key] = round(float(value), 3)
            except (TypeError, ValueError):
                continue
        else:
            payload[key] = value

    log_path = resolve_log_path()
    _ensure_parent(log_path)
    _rotate_logs(log_path)
    with log_path.open("a", encoding="utf-8") as handle:
        handle.write(_serialize_entry(payload))
        handle.write("\n")
    return payload


@contextmanager
def event_timer(
    *,
    event: str,
    component: str,
    level: str = "info",
    hook: str | None = None,
    **base_fields: Any,
) -> Iterator[Callable[[MutableMapping[str, Any] | None], None]]:
    """Context manager that logs an event with latency_ms."""
    start = time.perf_counter()
    captured: Dict[str, Any] = {}

    def finalize(extra: MutableMapping[str, Any] | None = None) -> None:
        if extra:
            captured.update(extra)

    try:
        yield finalize
    except Exception as exc:  # pragma: no cover - re-raised for visibility
        duration = (time.perf_counter() - start) * 1000
        payload = dict(base_fields)
        payload.update(captured)
        payload["latency_ms"] = duration
        payload["error"] = str(exc)
        log_event(event=event, component=component, hook=hook, level="error", **payload)
        raise
    else:
        duration = (time.perf_counter() - start) * 1000
        payload = dict(base_fields)
        payload.update(captured)
        payload["latency_ms"] = duration
        log_event(event=event, component=component, hook=hook, level=level, **payload)


__all__ = [
    "event_timer",
    "log_event",
    "resolve_log_path",
]
