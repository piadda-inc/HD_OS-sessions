from __future__ import annotations

from typing import Any, Dict, List

from .base import MemoryClient


class NoopAdapter(MemoryClient):
    """Fallback adapter when memory is disabled or unavailable."""

    can_search = False
    can_store = False

    def search_memory(self, query: str, *, metadata: Dict[str, Any] | None = None) -> List[Dict[str, Any]]:
        return []

    def store_episode(self, episode: Dict[str, Any]) -> bool:
        return False
