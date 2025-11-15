#!/usr/bin/env python3
"""
Tests for backward-compatible migration from "implementation" to "orchestration" mode.

Following TDD RED-GREEN-REFACTOR cycle:
1. RED: Write failing tests showing migration requirements
2. GREEN: Implement minimal migration logic
3. REFACTOR: Clean up implementation
"""

import json
import pytest
import tempfile
from pathlib import Path
import sys

# Add hooks directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent / "hooks"))

from shared_state import SessionsState, SessionsConfig, Mode, TriggerCategory


class TestImplementationToOrchestrationMigration:
    """Test backward compatibility for implementation → orchestration rename."""

    def test_old_state_file_with_implementation_mode(self):
        """Test that old sessions-state.json with "implementation" mode loads correctly."""
        # RED: This test should fail until we implement migration logic
        old_state_data = {
            "version": "0.3.6",
            "mode": "implementation",  # OLD value
            "current_task": {},
            "active_protocol": None,
            "api": {},
            "todos": {"active": [], "stashed": []},
            "model": "sonnet",
            "flags": {},
            "metadata": {}
        }

        # Should auto-migrate "implementation" → "orchestration"
        state = SessionsState.from_dict(old_state_data)

        assert state.mode == Mode.GO  # "orchestration"
        assert state.mode.value == "orchestration"

    def test_old_config_file_with_implementation_mode_trigger(self):
        """Test that old sessions-config.json with implementation_mode trigger migrates."""
        # RED: This test should fail until we implement migration logic
        old_config_data = {
            "trigger_phrases": {
                "implementation_mode": ["yert", "go time"],  # OLD key
                "discussion_mode": ["SILENCE"],
                "task_creation": ["mek:"],
                "task_startup": ["start^"],
                "task_completion": ["finito"],
                "context_compaction": ["squish"]
            },
            "git_preferences": {},
            "environment": {},
            "blocked_actions": {},
            "features": {}
        }

        # Should auto-migrate "implementation_mode" → "orchestration_mode"
        config = SessionsConfig.from_dict(old_config_data)

        assert hasattr(config.trigger_phrases, "orchestration_mode")
        assert config.trigger_phrases.orchestration_mode == ["yert", "go time"]
        assert config.trigger_phrases.discussion_mode == ["SILENCE"]

    def test_new_state_file_with_orchestration_mode_unchanged(self):
        """Test that new sessions-state.json with "orchestration" mode works unchanged."""
        new_state_data = {
            "version": "0.3.6",
            "mode": "orchestration",  # NEW value
            "current_task": {},
            "active_protocol": None,
            "api": {},
            "todos": {"active": [], "stashed": []},
            "model": "sonnet",
            "flags": {},
            "metadata": {}
        }

        state = SessionsState.from_dict(new_state_data)

        assert state.mode == Mode.GO
        assert state.mode.value == "orchestration"

    def test_new_config_file_with_orchestration_mode_trigger_unchanged(self):
        """Test that new sessions-config.json with orchestration_mode trigger works unchanged."""
        new_config_data = {
            "trigger_phrases": {
                "orchestration_mode": ["yert", "go time"],  # NEW key
                "discussion_mode": ["SILENCE"],
                "task_creation": ["mek:"],
                "task_startup": ["start^"],
                "task_completion": ["finito"],
                "context_compaction": ["squish"]
            },
            "git_preferences": {},
            "environment": {},
            "blocked_actions": {},
            "features": {}
        }

        config = SessionsConfig.from_dict(new_config_data)

        assert config.trigger_phrases.orchestration_mode == ["yert", "go time"]
        assert config.trigger_phrases.discussion_mode == ["SILENCE"]

    def test_discussion_mode_unchanged(self):
        """Test that discussion mode still works (no migration needed)."""
        state_data = {
            "version": "0.3.6",
            "mode": "discussion",
            "current_task": {},
            "active_protocol": None,
            "api": {},
            "todos": {"active": [], "stashed": []},
            "model": "sonnet",
            "flags": {},
            "metadata": {}
        }

        state = SessionsState.from_dict(state_data)

        assert state.mode == Mode.NO  # "discussion"
        assert state.mode.value == "discussion"

    def test_migration_preserves_other_state_data(self):
        """Test that migration doesn't corrupt other state fields."""
        old_state_data = {
            "version": "0.3.6",
            "mode": "implementation",  # OLD value to migrate
            "current_task": {
                "name": "test-task",
                "file": "test-task.md",
                "branch": "task/test-task"
            },
            "active_protocol": "task-startup",
            "api": {"startup_load": True},
            "todos": {
                "active": [
                    {"content": "Todo 1", "status": "pending"},
                    {"content": "Todo 2", "status": "completed"}
                ]
            },
            "model": "opus",
            "flags": {"context_85": True},
            "metadata": {"custom_field": "custom_value"}
        }

        state = SessionsState.from_dict(old_state_data)

        # Mode should be migrated
        assert state.mode == Mode.GO

        # Other data should be preserved
        assert state.current_task.name == "test-task"
        assert state.current_task.file == "test-task.md"
        assert state.current_task.branch == "task/test-task"
        assert state.api.startup_load is True
        assert len(state.todos.active) == 2
        assert state.metadata["custom_field"] == "custom_value"

    def test_migration_preserves_other_config_data(self):
        """Test that migration doesn't corrupt other config fields."""
        old_config_data = {
            "trigger_phrases": {
                "implementation_mode": ["yert"],  # OLD key to migrate
                "discussion_mode": ["SILENCE"],
                "task_creation": ["mek:"],
                "task_startup": ["start^"],
                "task_completion": ["finito"],
                "context_compaction": ["squish"]
            },
            "git_preferences": {
                "default_branch": "develop",
                "commit_style": "detailed",
                "auto_merge": True
            },
            "environment": {
                "os": "macos",
                "shell": "zsh",
                "developer_name": "Alice"
            },
            "blocked_actions": {},
            "features": {
                "branch_enforcement": False,
                "icon_style": "emoji"
            }
        }

        config = SessionsConfig.from_dict(old_config_data)

        # Trigger phrases should be migrated
        assert config.trigger_phrases.orchestration_mode == ["yert"]

        # Other data should be preserved
        assert config.git_preferences.default_branch == "develop"
        assert config.environment.os == "macos"  # os is a UserOS enum
        assert config.environment.developer_name == "Alice"
        assert config.features.branch_enforcement is False

    def test_both_old_and_new_trigger_keys_present_prefers_new(self):
        """Test that if both implementation_mode and orchestration_mode exist, new key wins."""
        mixed_config_data = {
            "trigger_phrases": {
                "implementation_mode": ["old1", "old2"],  # OLD key (should be ignored)
                "orchestration_mode": ["new1", "new2"],  # NEW key (should win)
                "discussion_mode": ["SILENCE"],
                "task_creation": ["mek:"],
                "task_startup": ["start^"],
                "task_completion": ["finito"],
                "context_compaction": ["squish"]
            },
            "git_preferences": {},
            "environment": {},
            "blocked_actions": {},
            "features": {}
        }

        config = SessionsConfig.from_dict(mixed_config_data)

        # New key should take precedence
        assert config.trigger_phrases.orchestration_mode == ["new1", "new2"]


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
