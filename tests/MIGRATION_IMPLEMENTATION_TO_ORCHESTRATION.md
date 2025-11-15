# Backward Compatibility Migration: "implementation" → "orchestration"

## Overview

HD_OS-sessions renamed "implementation mode" to "orchestration mode" for better semantic alignment with the framework's purpose. This document describes the backward-compatible migration logic implemented to prevent breaking existing installations.

## Problem Statement

After the rename, existing installations with old state/config files would crash when loading:
- `sessions-state.json` containing `"mode": "implementation"`
- `sessions-config.json` containing `"implementation_mode"` trigger phrases

## Solution

Implemented transparent migration logic in Python state loaders that automatically converts old values to new format.

## Implementation Details

### 1. State Mode Migration

**File**: `hooks/shared_state.py`, `cc_sessions/python/hooks/shared_state.py`
**Location**: `SessionsState.from_dict()` method (~line 588)

```python
# Handle backward compatibility: "implementation" → "orchestration"
mode_str = d.get("mode", Mode.NO)
if mode_str == "implementation":  # Backward compatibility
    mode_str = "orchestration"
mode = Mode(mode_str)
```

**Behavior**:
- Old value `"implementation"` automatically converted to `"orchestration"`
- New value `"orchestration"` passes through unchanged
- `"discussion"` mode unaffected
- Migration is transparent to user (no action required)

### 2. Config Trigger Phrases Migration

**File**: `hooks/shared_state.py`, `cc_sessions/python/hooks/shared_state.py`
**Location**: `SessionsConfig.from_dict()` method (~line 355)

```python
# Handle backward compatibility: "implementation_mode" → "orchestration_mode"
trigger_data = d.get("trigger_phrases", {}).copy()  # Copy to avoid mutating input
if "implementation_mode" in trigger_data:
    if "orchestration_mode" not in trigger_data:
        # Migrate old key to new key
        trigger_data["orchestration_mode"] = trigger_data["implementation_mode"]
    # Remove old key regardless (if both present, new key wins)
    trigger_data.pop("implementation_mode")
```

**Behavior**:
- Old key `implementation_mode` migrated to `orchestration_mode`
- If both keys present, `orchestration_mode` takes precedence
- Old key always removed from parsed data
- Migration creates copy to avoid mutating input dictionary

### 3. Serialization (Write-Back)

**Important**: Migration only happens during **deserialization** (reading files). When state/config is written back:
- Always uses new format: `"mode": "orchestration"`
- Always uses new key: `"orchestration_mode"`
- Old formats never re-introduced

This ensures gradual migration: once files are updated, they use new format permanently.

## Test Coverage

**Test file**: `tests/test_implementation_migration.py`

### Test Scenarios (8 total, all passing)

1. **Old state file with "implementation" mode** - Migrates to "orchestration"
2. **Old config file with "implementation_mode" trigger** - Migrates to "orchestration_mode"
3. **New state file with "orchestration" mode** - Passes through unchanged
4. **New config file with "orchestration_mode" trigger** - Passes through unchanged
5. **Discussion mode** - Unaffected by migration
6. **Migration preserves other state data** - Task, todos, flags intact
7. **Migration preserves other config data** - Git prefs, environment intact
8. **Both old and new keys present** - New key wins, old key removed

### Running Tests

```bash
cd /home/heliosuser/sessions
python3 -m pytest tests/test_implementation_migration.py -v
```

Expected output: `8 passed in 0.06s`

## Migration Timeline

1. **Old installations**: Load with `"implementation"` → auto-migrate to `"orchestration"`
2. **First write-back**: State/config files updated with new format
3. **Subsequent loads**: Use new format directly (no migration needed)
4. **Future releases**: Migration logic can be removed after grace period (recommend 6-12 months)

## Verification

Real-world migration scenarios validated:

```python
# Scenario 1: Old state file
old_state = {"mode": "implementation", ...}
state = SessionsState.from_dict(old_state)
assert state.mode.value == "orchestration"  # ✓

# Scenario 2: Old config file
old_config = {"trigger_phrases": {"implementation_mode": ["yert"], ...}}
config = SessionsConfig.from_dict(old_config)
assert config.trigger_phrases.orchestration_mode == ["yert"]  # ✓

# Scenario 3: Round-trip preserves new format
state_dict = state.to_dict()
assert state_dict["mode"] == "orchestration"  # ✓
```

## Files Modified

1. **hooks/shared_state.py** - Runtime state management
   - `SessionsState.from_dict()` - Mode migration
   - `SessionsConfig.from_dict()` - Trigger phrases migration

2. **cc_sessions/python/hooks/shared_state.py** - Source template
   - Identical changes mirrored from hooks/shared_state.py

3. **tests/test_implementation_migration.py** - Test coverage (new file)

## No Breaking Changes

- Existing installations continue working (auto-migrate)
- New installations use new format natively
- Migration is one-way (old format not re-introduced)
- No user action required
- No data loss or corruption

## Future Work

After adequate grace period (6-12 months), migration logic can be removed by:
1. Removing backward compatibility checks from `from_dict()` methods
2. Removing test file `test_implementation_migration.py`
3. Adding version check to reject ancient state files

Until then, migration logic ensures smooth transition for all users.
