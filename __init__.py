"""Sessions orchestration framework for cc-sessions."""

from __future__ import annotations

import pkgutil
from pathlib import Path

__path__ = pkgutil.extend_path(__path__, __name__)  # type: ignore  # noqa: F821

_DATA_DIR = Path(__file__).resolve().parent / "sessions"
if _DATA_DIR.exists():
    __path__.append(str(_DATA_DIR))
