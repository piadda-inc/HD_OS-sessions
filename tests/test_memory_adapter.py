#!/usr/bin/env python3
"""
Tests for the Python memory adapter implementations.

These tests write a temporary graphiti_local shim that echoes the IPC payload
back to a capture file so we can assert on sanitization, timeouts, and the
fire-and-forget behaviour required by the specification.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from hooks.shared_state import MemoryConfig  # type: ignore

from sessions.memory import get_client  # type: ignore
from sessions.memory.graphiti_adapter import GraphitiAdapter  # type: ignore
from sessions.memory.noop_adapter import NoopAdapter  # type: ignore

GRAPHITI_SHIM = """#!/usr/bin/env python3
import json, os, sys, time
from pathlib import Path

def main():
    raw = sys.stdin.read()
    if not raw:
        return
    payload = json.loads(raw)
    op = payload.get("operation", "").lower()
    delay = float(os.environ.get(f"GRAPHITI_IPC_DELAY_{op.upper()}", os.environ.get("GRAPHITI_IPC_DELAY", "0") or 0))
    if delay:
        time.sleep(delay)
    capture = os.environ.get("GRAPHITI_IPC_CAPTURE")
    if capture:
        Path(capture).write_text(json.dumps(payload))
    if os.environ.get(f"GRAPHITI_IPC_FAIL_{op.upper()}") or os.environ.get("GRAPHITI_IPC_FAIL"):
        sys.exit(2)
    if op == "search":
        response = {"facts": [{"fact": f"Result for {payload.get('data', {}).get('query', '')}", "episode_name": "Fixture"}]}
    else:
        response = {"ok": True}
    sys.stdout.write(json.dumps(response))

if __name__ == "__main__":
    main()
"""


@pytest.fixture
def graphiti_shim(tmp_path: Path) -> Path:
    """Create an executable shim that mimics the graphiti_local CLI."""
    shim = tmp_path / "graphiti_local.py"
    shim.write_text(GRAPHITI_SHIM)
    shim.chmod(0o755)
    return shim


def make_config(shim: Path, **overrides) -> MemoryConfig:
    kwargs = {
        "enabled": True,
        "provider": "graphiti",
        "graphiti_path": str(shim),
        "auto_search": True,
        "auto_store": "task-completion",
        "search_timeout_ms": 1500,
        "store_timeout_s": 2.0,
        "max_results": 5,
        "group_id": "unit-test",
        "allow_code_snippets": True,
        "sanitize_secrets": True,
    }
    kwargs.update(overrides)
    return MemoryConfig(**kwargs)


def test_get_client_returns_noop_when_disabled():
    client = get_client(MemoryConfig(enabled=False))
    assert isinstance(client, NoopAdapter)
    assert client.can_search is False
    assert client.search_memory("anything") == []
    assert client.store_episode({"episode_id": "noop"}) is False


def test_graphiti_search_returns_results_and_sanitizes_metadata(graphiti_shim: Path, tmp_path: Path, monkeypatch):
    capture_file = tmp_path / "search_capture.json"
    monkeypatch.setenv("GRAPHITI_IPC_CAPTURE", str(capture_file))
    adapter = GraphitiAdapter(make_config(graphiti_shim))

    results = adapter.search_memory("api integration", metadata={"api_key": "sk-unit"})

    assert results and results[0]["fact"].startswith("Result for api integration")
    payload = json.loads(capture_file.read_text())
    assert payload["operation"] == "search"
    assert payload["data"]["metadata"]["api_key"] == "[REDACTED]"


def test_graphiti_search_times_out_quickly(graphiti_shim: Path, monkeypatch):
    monkeypatch.setenv("GRAPHITI_IPC_DELAY_SEARCH", "2")
    adapter = GraphitiAdapter(make_config(graphiti_shim))
    start = time.perf_counter()
    results = adapter.search_memory("slow query")
    duration = time.perf_counter() - start
    assert results == []
    assert duration < 2.0


def test_store_episode_is_fire_and_forget(graphiti_shim: Path, tmp_path: Path, monkeypatch):
    capture_file = tmp_path / "store_capture.json"
    monkeypatch.setenv("GRAPHITI_IPC_CAPTURE", str(capture_file))
    monkeypatch.setenv("GRAPHITI_IPC_DELAY_STORE", "1.5")
    adapter = GraphitiAdapter(make_config(graphiti_shim))

    payload = {
        "episode_id": "ep-123",
        "workspace_id": "workspace",
        "task_id": "task-1",
        "summary": "did work",
        "objectives": ["one", "two"],
        "timestamps": {"completed_at": "now"},
        "api_key": "sk-secret",
    }

    start = time.perf_counter()
    assert adapter.store_episode(payload) is True
    duration = time.perf_counter() - start
    assert duration < 0.5, "store_episode should not block on IPC completion"

    for _ in range(50):
        if capture_file.exists():
            break
        time.sleep(0.05)
    else:
        pytest.fail("store IPC never executed")

    captured = json.loads(capture_file.read_text())
    assert captured["operation"] == "store"
    assert captured["data"]["episode"]["api_key"] == "[REDACTED]"


def test_graphiti_adapter_handles_missing_binary(tmp_path: Path):
    bogus_path = tmp_path / "missing_graphiti"
    adapter = GraphitiAdapter(make_config(bogus_path))
    assert adapter.search_memory("anything") == []
    assert adapter.store_episode({"episode_id": "noop"}) is False
