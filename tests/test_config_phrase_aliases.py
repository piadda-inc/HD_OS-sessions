#!/usr/bin/env python3
"""
Test: config_commands.py phrase category aliasing

Verifies that legacy "implementation_mode" category works as an alias
for "orchestration_mode" in all phrase operations (list/add/remove).
"""

import sys
import os
import json
import tempfile
import shutil
from pathlib import Path

# Setup mock project directory
mock_project_root = Path(tempfile.mkdtemp(prefix='cc-sessions-alias-test-'))
os.environ['CLAUDE_PROJECT_DIR'] = str(mock_project_root)
(mock_project_root / 'sessions').mkdir(parents=True, exist_ok=True)

# Initialize with a test config
config_file_path = mock_project_root / 'sessions' / 'sessions-config.json'
test_config = {
    "trigger_phrases": {
        "orchestration_mode": ["yert"],
        "discussion_mode": ["SILENCE"],
        "task_creation": ["mek:"],
        "task_startup": ["start^"],
        "task_completion": ["finito"],
        "context_compaction": ["squish"]
    },
    "git_preferences": {"default_branch": "main"},
    "environment": {"developer_name": "Test User", "os": "linux", "shell": "bash"},
    "features": {},
    "blocked_actions": {"implementation_only_tools": [], "bash_read_patterns": [], "bash_write_patterns": []}
}
config_file_path.write_text(json.dumps(test_config, indent=2))

# Now import the module (after env setup) from runtime sources
repo_root = Path(__file__).parent.parent
sys.path.insert(0, str(repo_root / 'api'))
from config_commands import handle_phrases_command

def test_list_implementation_mode_shows_orchestration_mode_phrases():
    """Alias: list implementation_mode shows orchestration_mode phrases"""
    result = handle_phrases_command(['list', 'implementation_mode'], json_output=False, from_slash=False)

    # Should show orchestration_mode phrases
    assert 'orchestration_mode' in result
    assert 'yert' in result
    print("✓ test_list_implementation_mode_shows_orchestration_mode_phrases")

def test_add_phrase_using_implementation_mode():
    """Alias: add phrase using implementation_mode"""
    # Add a phrase using the alias
    add_result = handle_phrases_command(['add', 'implementation_mode', 'test-alias-phrase'], json_output=False, from_slash=False)
    assert 'Added' in add_result
    assert 'orchestration_mode' in add_result

    # Verify it was added to orchestration_mode
    list_result = handle_phrases_command(['list', 'orchestration_mode'], json_output=False, from_slash=False)
    assert 'test-alias-phrase' in list_result

    # Cleanup: remove the test phrase
    handle_phrases_command(['remove', 'orchestration_mode', 'test-alias-phrase'], json_output=False, from_slash=False)
    print("✓ test_add_phrase_using_implementation_mode")

def test_remove_phrase_using_implementation_mode():
    """Alias: remove phrase using implementation_mode"""
    # First add a phrase
    handle_phrases_command(['add', 'orchestration_mode', 'test-remove-phrase'], json_output=False, from_slash=False)

    # Remove using the alias
    remove_result = handle_phrases_command(['remove', 'implementation_mode', 'test-remove-phrase'], json_output=False, from_slash=False)
    assert 'Removed' in remove_result
    assert 'orchestration_mode' in remove_result

    # Verify it was removed
    list_result = handle_phrases_command(['list', 'orchestration_mode'], json_output=False, from_slash=False)
    assert 'test-remove-phrase' not in list_result
    print("✓ test_remove_phrase_using_implementation_mode")

def test_help_text_documents_implementation_mode_alias():
    """Alias: help text documents implementation_mode alias"""
    help_result = handle_phrases_command(['help'], json_output=False, from_slash=True)

    # Help should mention the alias
    assert 'implementation_mode' in help_result
    assert 'aliases' in help_result
    assert 'backward compatibility' in help_result
    print("✓ test_help_text_documents_implementation_mode_alias")

def test_both_canonical_and_alias_work_identically():
    """Alias: both canonical and alias work identically"""
    # Add using canonical name
    handle_phrases_command(['add', 'orchestration_mode', 'canonical-test'], json_output=False, from_slash=False)

    # List using alias - should see the same phrase
    alias_list_result = handle_phrases_command(['list', 'implementation_mode'], json_output=False, from_slash=False)
    assert 'canonical-test' in alias_list_result

    # Remove using canonical name
    handle_phrases_command(['remove', 'orchestration_mode', 'canonical-test'], json_output=False, from_slash=False)
    print("✓ test_both_canonical_and_alias_work_identically")

if __name__ == '__main__':
    try:
        test_list_implementation_mode_shows_orchestration_mode_phrases()
        test_add_phrase_using_implementation_mode()
        test_remove_phrase_using_implementation_mode()
        test_help_text_documents_implementation_mode_alias()
        test_both_canonical_and_alias_work_identically()
        print("\nAll config phrase alias tests passed!")
    finally:
        # Cleanup
        shutil.rmtree(mock_project_root, ignore_errors=True)
