"""Data models for orchestration state artifacts.

This module defines strongly typed dataclasses for managing session and execution
state in the cc-sessions orchestration framework. These models are serialized to
JSON for consumption by Node.js hooks.

Design principles:
- Frozen instances for immutability (frozen=True)
- Collections converted to immutable types in __post_init__:
  * Lists -> tuples (task_ids, depends_on)
  * Dicts -> MappingProxyType (context_refs)
- Default factories for mutable defaults
- Explicit type hints for strict mypy checking
- to_dict/from_dict helpers for JSON serialization
- Deterministic ordering (session entries by created_at, groups maintain definition order)
- Descriptive ValueError for invalid states

Critical: frozen=True alone does NOT prevent mutation of nested collections.
Always use dataclasses.replace() to "update" instances.
"""
from dataclasses import dataclass, field
from enum import Enum
from types import MappingProxyType
from typing import Any, Dict, List, Mapping, Optional, Set, Tuple


class GroupStatus(Enum):
    """Status of an execution group.

    Attributes:
        PENDING: Group is queued but not yet started
        RUNNING: Group is currently executing
        COMPLETED: Group finished successfully
        BLOCKED: Group is blocked by unmet dependencies
        FAILED: Group execution failed
    """

    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    BLOCKED = "blocked"
    FAILED = "failed"


@dataclass(frozen=True)
class SessionIndexEntry:
    """Represents a single session in the orchestration index.

    This tracks individual session lifecycle information for orchestration purposes.

    Attributes:
        session_id: Unique identifier for the session
        task_id: Associated task identifier
        created_at: ISO 8601 timestamp when session was created
        updated_at: ISO 8601 timestamp when session was last updated (None if never updated)
        status: Current session status (pending, running, completed, etc.)
        group_id: Execution group identifier associated with the session
        subagent_type: Subagent personality used for the session
    """

    session_id: str
    task_id: str
    created_at: str
    updated_at: Optional[str] = None
    status: str = "pending"
    group_id: Optional[str] = None
    subagent_type: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert entry to dict for JSON serialization.

        Returns:
            Dictionary representation with all fields
        """
        return {
            "session_id": self.session_id,
            "task_id": self.task_id,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "status": self.status,
            "group_id": self.group_id,
            "subagent_type": self.subagent_type,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "SessionIndexEntry":
        """Reconstruct entry from dict.

        Args:
            data: Dictionary containing entry fields

        Returns:
            SessionIndexEntry instance
        """
        return cls(
            session_id=data["session_id"],
            task_id=data["task_id"],
            created_at=data["created_at"],
            updated_at=data.get("updated_at"),
            status=data.get("status", "pending"),
            group_id=data.get("group_id"),
            subagent_type=data.get("subagent_type"),
        )


@dataclass(frozen=True)
class SessionIndex:
    """Container for all session index entries.

    Maintains a sorted collection of session entries for efficient lookups
    and audit trails.

    Attributes:
        entries: Tuple of session index entries (immutable, default empty tuple)
    """

    entries: Tuple[SessionIndexEntry, ...] = field(default_factory=tuple)

    def __post_init__(self) -> None:
        """Convert entries to immutable tuple if passed as list."""
        if not isinstance(self.entries, tuple):
            object.__setattr__(self, "entries", tuple(self.entries))

    def sorted_entries(self) -> List[SessionIndexEntry]:
        """Return entries sorted by creation timestamp.

        Returns:
            List of entries ordered by created_at (oldest first)
        """
        return sorted(self.entries, key=lambda e: e.created_at)

    def to_dict(self) -> Dict[str, Any]:
        """Convert index to dict for JSON serialization.

        Returns:
            Dictionary with entries list
        """
        return {
            "entries": [entry.to_dict() for entry in self.entries],
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "SessionIndex":
        """Reconstruct index from dict.

        Args:
            data: Dictionary containing entries list

        Returns:
            SessionIndex instance
        """
        entries = tuple(SessionIndexEntry.from_dict(e) for e in data.get("entries", []))
        return cls(entries=entries)


@dataclass(frozen=True)
class ExecutionGroup:
    """Represents a group of tasks to be executed together.

    Groups can be parallel (all tasks run concurrently) or sequential.
    Each group tracks its execution state and metadata.

    Attributes:
        group_id: Unique identifier for this group
        task_ids: Tuple of task IDs in this group (immutable)
        parallel: Whether tasks run in parallel (True) or sequential (False)
        agent_type: Type of agent to use (default, codex, etc.)
        sandbox: Sandbox mode (read-only, workspace-write, danger-full-access)
        bootstrap_stage: Which bootstrap stage this group belongs to (1 or 2)
        phase: Macro execution phase this group belongs to (1 or 2)
        stage: Stage/parallel group identifier within the phase
        depends_on: Tuple of upstream group IDs that must complete before this group can run
        estimated_duration: Estimated duration in seconds (None if unknown)
        context_refs: Immutable map of task_id to context package path
        status: Current group status
        started_at: ISO 8601 timestamp when group started
        completed_at: ISO 8601 timestamp when group completed
    """

    group_id: str
    task_ids: Tuple[str, ...]
    parallel: bool
    agent_type: str = "default"
    sandbox: str = "read-only"
    bootstrap_stage: int = 1
    phase: int = 1
    stage: int = 1
    depends_on: Tuple[str, ...] = field(default_factory=tuple)
    estimated_duration: Optional[int] = None
    context_refs: Mapping[str, str] = field(default_factory=lambda: MappingProxyType({}))
    status: GroupStatus = GroupStatus.PENDING
    started_at: Optional[str] = None
    completed_at: Optional[str] = None

    def __post_init__(self) -> None:
        """Convert mutable collections to immutable types."""
        # Convert task_ids to tuple if passed as list
        if not isinstance(self.task_ids, tuple):
            object.__setattr__(self, "task_ids", tuple(self.task_ids))

        # Convert context_refs to MappingProxyType if passed as dict
        if not isinstance(self.context_refs, MappingProxyType):
            object.__setattr__(self, "context_refs", MappingProxyType(dict(self.context_refs)))

        # Normalize depends_on to tuple and validate
        if not isinstance(self.depends_on, tuple):
            object.__setattr__(self, "depends_on", tuple(self.depends_on))

        normalized_deps: List[str] = []
        seen: Set[str] = set()
        for dep in self.depends_on:
            if not isinstance(dep, str) or not dep.strip():
                raise ValueError("ExecutionGroup depends_on entries must be non-empty strings")
            dep_id = dep.strip()
            if dep_id == self.group_id:
                raise ValueError("ExecutionGroup cannot depend on itself")
            if dep_id in seen:
                raise ValueError(f"Duplicate dependency detected: {dep_id}")
            seen.add(dep_id)
            normalized_deps.append(dep_id)
        object.__setattr__(self, "depends_on", tuple(normalized_deps))

        if self.phase < 1:
            raise ValueError("ExecutionGroup phase must be >= 1")
        if self.stage < 1:
            raise ValueError("ExecutionGroup stage must be >= 1")

    def to_dict(self) -> Dict[str, Any]:
        """Convert group to dict for JSON serialization.

        Returns:
            Dictionary representation with all fields
        """
        return {
            "group_id": self.group_id,
            "task_ids": list(self.task_ids),
            "parallel": self.parallel,
            "agent_type": self.agent_type,
            "sandbox": self.sandbox,
            "bootstrap_stage": self.bootstrap_stage,
            "phase": self.phase,
            "stage": self.stage,
            "depends_on": list(self.depends_on),
            "estimated_duration": self.estimated_duration,
            "context_refs": dict(self.context_refs),
            "status": self.status.value,  # Convert enum to string
            "started_at": self.started_at,
            "completed_at": self.completed_at,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "ExecutionGroup":
        """Reconstruct group from dict.

        Args:
            data: Dictionary containing group fields

        Returns:
            ExecutionGroup instance
        """
        # Convert status string back to enum
        status_str = data.get("status", "pending")
        status = GroupStatus(status_str)

        return cls(
            group_id=data["group_id"],
            task_ids=data["task_ids"],
            parallel=data["parallel"],
            agent_type=data.get("agent_type", "default"),
            sandbox=data.get("sandbox", "read-only"),
            bootstrap_stage=data.get("bootstrap_stage", 1),
            phase=data.get("phase", 1),
            stage=data.get("stage", 1),
            depends_on=tuple(data.get("depends_on", ())),
            estimated_duration=data.get("estimated_duration"),
            context_refs=data.get("context_refs", {}),
            status=status,
            started_at=data.get("started_at"),
            completed_at=data.get("completed_at"),
        )


@dataclass(frozen=True)
class ExecutionPlan:
    """Container for all execution groups in a plan.

    Maintains groups in definition order and validates uniqueness of group IDs.

    Attributes:
        groups: List of execution groups (default empty list)

    Raises:
        ValueError: If duplicate group IDs are detected
    """

    groups: List[ExecutionGroup] = field(default_factory=list)

    def __post_init__(self) -> None:
        """Validate plan integrity after initialization."""
        # Check for duplicate group IDs
        group_ids = [g.group_id for g in self.groups]
        if len(group_ids) != len(set(group_ids)):
            duplicates = [gid for gid in group_ids if group_ids.count(gid) > 1]
            raise ValueError(f"Duplicate group ID detected: {duplicates[0]}")

    def to_dict(self) -> Dict[str, Any]:
        """Convert plan to dict for JSON serialization.

        Returns:
            Dictionary with groups list in definition order
        """
        return {
            "groups": [group.to_dict() for group in self.groups],
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "ExecutionPlan":
        """Reconstruct plan from dict.

        Args:
            data: Dictionary containing groups list

        Returns:
            ExecutionPlan instance

        Raises:
            ValueError: If duplicate group IDs are detected
        """
        groups = [ExecutionGroup.from_dict(g) for g in data.get("groups", [])]
        return cls(groups=groups)
