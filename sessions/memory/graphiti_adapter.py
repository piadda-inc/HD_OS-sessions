from __future__ import annotations

import atexit
import json
import re
import shlex
import subprocess
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

from .base import MemoryClient, MemoryConfigProtocol


class GraphitiAdapter(MemoryClient):
    """Graphiti memory client that communicates via JSON IPC."""

    _SECRET_KEY_MARKERS = ("key", "token", "secret", "password")
    def __init__(self, config: MemoryConfigProtocol):
        self.config = config
        command = getattr(config, "graphiti_path", "") or "graphiti_local"
        if isinstance(command, str):
            self._command = shlex.split(command) if " " in command else [command]
        else:
            self._command = [str(command)]

        self._search_timeout = max(0.1, getattr(config, "search_timeout_ms", 1500) / 1000.0)
        self._store_timeout = max(0.1, float(getattr(config, "store_timeout_s", 2.0)))
        self._command_available = self._detect_command()
        self.can_search = bool(self._command) and self._command_available
        self.can_store = bool(self._command) and self._command_available
        self._store_threads: Set[threading.Thread] = set()
        self._store_threads_lock = threading.Lock()
        atexit.register(self._drain_store_threads)

    def _detect_command(self) -> bool:
        if not self._command:
            return False
        first = self._command[0]
        if not first:
            return False
        if any(sep in first for sep in ("/", "\\")):
            return Path(first).expanduser().exists()
        return True

    def _sanitize(self, payload: Any) -> Any:
        if not getattr(self.config, "sanitize_secrets", True):
            return payload

        if isinstance(payload, dict):
            clean: Dict[str, Any] = {}
            for key, value in payload.items():
                if any(marker in key.lower() for marker in self._SECRET_KEY_MARKERS):
                    clean[key] = "[REDACTED]"
                else:
                    clean[key] = self._sanitize(value)
            return clean
        if isinstance(payload, list):
            return [self._sanitize(item) for item in payload]
        if isinstance(payload, str):
            masked = re.sub(r"sk-[A-Za-z0-9]{8,}", "[REDACTED]", payload)
            masked = re.sub(r"(?i)(api[_-]?key|token|password)\s*[:=]\s*[^\s]+", r"\1: [REDACTED]", masked)
            return masked
        return payload

    def _run_ipc(self, operation: str, data: Dict[str, Any], timeout: float) -> Optional[Dict[str, Any]]:
        payload = {"operation": operation, "data": data}
        try:
            proc = subprocess.run(
                self._command,
                input=json.dumps(payload),
                capture_output=True,
                text=True,
                timeout=timeout,
                check=False,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired, PermissionError):
            return None
        if proc.returncode != 0:
            return None
        output = proc.stdout.strip()
        if not output:
            return None
        try:
            return json.loads(output)
        except json.JSONDecodeError:
            return None

    def search_memory(self, query: str, *, metadata: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        if not self.can_search or not query:
            return []
        request = {
            "query": query,
            "group_id": getattr(self.config, "group_id", "hd_os_workspace"),
            "max_results": getattr(self.config, "max_results", 5),
            "allow_code_snippets": getattr(self.config, "allow_code_snippets", True),
        }
        if metadata:
            request["metadata"] = metadata
        sanitized = self._sanitize(request)
        response = self._run_ipc("search", sanitized, timeout=self._search_timeout)
        if not response:
            return []
        facts = response.get("facts")
        if isinstance(facts, list):
            max_results = request["max_results"]
            return facts[:max_results]
        return []

    def _store_worker(self, payload: Dict[str, Any]) -> None:
        try:
            self._run_ipc("store", payload, timeout=self._store_timeout)
        except Exception:
            pass
        finally:
            with self._store_threads_lock:
                self._store_threads.discard(threading.current_thread())

    def store_episode(self, episode: Dict[str, Any]) -> bool:
        if not self.can_store or not episode:
            return False
        payload = self._sanitize({"episode": episode})
        worker = threading.Thread(target=self._store_worker, args=(payload,), daemon=False)
        # Track non-daemon workers so we can join briefly on shutdown and avoid data loss.
        with self._store_threads_lock:
            self._store_threads.add(worker)
        worker.start()
        return True

    def _drain_store_threads(self) -> None:
        # Wait with a timeout so outstanding writes flush without hanging shutdown forever.
        with self._store_threads_lock:
            threads = list(self._store_threads)
        for thread in threads:
            try:
                thread.join(timeout=self._store_timeout)
            except RuntimeError:
                continue
