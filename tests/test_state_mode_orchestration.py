"""
Tests for state mode command with orchestration mode terminology.

These tests verify that:
1. All three mode names work (orchestration, go, implementation)
2. Help text shows orchestration as canonical
3. JSON responses use actual mode value ("orchestration")
4. Error messages are updated
"""

import pytest
import sys
from pathlib import Path

# Add repository root for package imports and api directory for direct module access
repo_root = Path(__file__).parent.parent
sys.path.insert(0, str(repo_root))
sys.path.insert(0, str(repo_root / "api"))

from state_commands import handle_mode_command  # type: ignore
import state_commands as state_commands_module
import hooks.shared_state as shared_state_module
from hooks.shared_state import Mode, load_state, edit_state  # type: ignore


@pytest.fixture(autouse=True)
def isolated_state_env(tmp_path, monkeypatch):
    """Provide each test with its own isolated sessions state file."""
    fake_root = tmp_path / "project"
    sessions_dir = fake_root / "sessions"
    sessions_dir.mkdir(parents=True, exist_ok=True)

    state_file = sessions_dir / "sessions-state.json"
    config_file = sessions_dir / "sessions-config.json"
    lock_dir = state_file.with_suffix(".lock")

    monkeypatch.setattr(shared_state_module, "PROJECT_ROOT", fake_root)
    monkeypatch.setattr(shared_state_module, "STATE_FILE", state_file)
    monkeypatch.setattr(shared_state_module, "LOCK_DIR", lock_dir)
    monkeypatch.setattr(shared_state_module, "CONFIG_FILE", config_file)

    # Ensure the patched paths exist by loading the default state once
    patched_state = shared_state_module.load_state()
    monkeypatch.setattr(state_commands_module, "STATE", patched_state)
    yield


@pytest.fixture
def reset_mode():
    """Reset mode to discussion before each test."""
    with edit_state() as s:
        s.mode = Mode.NO
        s.flags.bypass_mode = False
    yield
    # Cleanup
    with edit_state() as s:
        s.mode = Mode.NO
        s.flags.bypass_mode = False


def test_orchestration_mode_name_works(reset_mode):
    """Test that 'orchestration' is accepted as a mode name."""
    # Should accept 'orchestration' as canonical name
    result = handle_mode_command(['orchestration'], json_output=True, from_slash=True)

    assert result['mode'] == 'orchestration', "JSON should use orchestration mode value"
    assert 'Orchestration Mode' in result['message']

    # Verify state was updated
    state = load_state()
    assert state.mode == Mode.GO


def test_go_alias_still_works(reset_mode):
    """Test that 'go' alias still works."""
    result = handle_mode_command(['go'], json_output=True, from_slash=True)

    assert result['mode'] == 'orchestration', "JSON should use orchestration mode value"
    assert 'Orchestration Mode' in result['message']

    state = load_state()
    assert state.mode == Mode.GO


def test_implementation_backward_compat(reset_mode):
    """Test that 'implementation' still works for backward compatibility."""
    result = handle_mode_command(['implementation'], json_output=True, from_slash=True)

    assert result['mode'] == 'orchestration', "JSON should use orchestration mode value even for legacy name"
    assert 'Orchestration Mode' in result['message']

    state = load_state()
    assert state.mode == Mode.GO


def test_help_text_shows_orchestration_canonical(reset_mode):
    """Test that help text shows orchestration as canonical mode name."""
    # Invalid mode should show help
    result = handle_mode_command(['invalid'], json_output=False, from_slash=True)

    assert 'orchestration' in result.lower(), "Help should mention orchestration"
    assert 'mode orchestration' in result.lower(), "Help should show 'mode orchestration' usage"
    # Check that orchestration comes before implementation in help text
    orch_pos = result.lower().find('orchestration')
    impl_pos = result.lower().find('implementation')
    assert orch_pos < impl_pos, "orchestration should appear before implementation (alias)"


def test_json_response_uses_actual_mode_value(reset_mode):
    """Test that JSON response uses actual Mode enum value, not hardcoded string."""
    # Switch to orchestration mode
    handle_mode_command(['orchestration'], json_output=False, from_slash=True)

    # Query current mode via JSON
    result = handle_mode_command([], json_output=True, from_slash=False)

    # Should return actual mode value from enum
    state = load_state()
    assert result['mode'] == state.mode.value, "JSON should use actual mode enum value"
    assert result['mode'] == 'orchestration', "Mode value should be 'orchestration'"


def test_already_in_orchestration_message(reset_mode):
    """Test message when already in orchestration mode."""
    # Switch to orchestration
    handle_mode_command(['orchestration'], json_output=False, from_slash=True)

    # Try to switch again
    result = handle_mode_command(['orchestration'], json_output=False, from_slash=True)

    assert 'Already in orchestration mode' in result


def test_mode_switch_message_uses_orchestration(reset_mode):
    """Test that mode switch message uses orchestration terminology."""
    result = handle_mode_command(['orchestration'], json_output=False, from_slash=True)

    assert 'discussion → orchestration' in result or 'Orchestration Mode' in result
    assert 'coordinate and delegate' in result.lower() or 'orchestration' in result.lower()


def test_cli_command_can_switch(reset_mode):
    """Test that orchestration mode can be activated directly from the CLI."""
    result = handle_mode_command(['orchestration'], json_output=False, from_slash=False)

    assert 'orchestration' in result.lower()
    state = load_state()
    assert state.mode == Mode.GO


def test_all_three_names_produce_same_result(reset_mode):
    """Test that orchestration, go, and implementation all produce identical state."""
    modes_to_test = ['orchestration', 'go', 'implementation']

    for mode_name in modes_to_test:
        # Reset to discussion
        with edit_state() as s:
            s.mode = Mode.NO

        # Switch to mode
        result = handle_mode_command([mode_name], json_output=True, from_slash=True)

        # All should result in same state
        state = load_state()
        assert state.mode == Mode.GO, f"Mode {mode_name} should set mode to GO"
        assert result['mode'] == 'orchestration', f"JSON for {mode_name} should return 'orchestration'"


def test_error_message_mentions_orchestration(reset_mode):
    """Test that error messages use orchestration terminology."""
    result = handle_mode_command(['invalid'], json_output=False, from_slash=True)

    assert 'orchestration' in result.lower(), "Error should mention orchestration mode"
    assert 'Unknown mode: invalid' in result


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
