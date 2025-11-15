from __future__ import annotations

from typing import Any, Dict, Optional, Protocol, runtime_checkable


@runtime_checkable
class MemoryConfigProtocol(Protocol):
    enabled: bool
    provider: str
    graphiti_path: str
    auto_search: bool
    auto_store: str
    search_timeout_ms: int
    store_timeout_s: float
    max_results: int
    group_id: str
    allow_code_snippets: bool
    sanitize_secrets: bool


class MemoryClient:
    """Interface for memory providers."""

    can_search: bool = False
    can_store: bool = False

    def search_memory(self, query: str, *, metadata: Optional[Dict[str, Any]] = None) -> list[Dict[str, Any]]:
        raise NotImplementedError

    def store_episode(self, episode: Dict[str, Any]) -> bool:
        raise NotImplementedError
