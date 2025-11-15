"""Memory adapter factory and interface definitions."""

from __future__ import annotations

from typing import Optional

from .base import MemoryClient, MemoryConfigProtocol
from .graphiti_adapter import GraphitiAdapter
from .noop_adapter import NoopAdapter


def get_client(config: Optional[MemoryConfigProtocol]) -> MemoryClient:
    """Factory that returns the appropriate adapter based on config."""
    if not config or not getattr(config, "enabled", False):
        return NoopAdapter()

    provider = getattr(config, "provider", "").lower()
    if provider == "graphiti":
        graphiti_path = getattr(config, "graphiti_path", "") or "graphiti_local"
        if not graphiti_path:
            return NoopAdapter()
        return GraphitiAdapter(config)

    return NoopAdapter()


__all__ = ["MemoryClient", "get_client", "GraphitiAdapter", "NoopAdapter"]
