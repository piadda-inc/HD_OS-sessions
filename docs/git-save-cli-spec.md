# git-save CLI Specification

## Overview

The `git-save` command provides deterministic, AI-friendly git commit automation integrated with backlog.md task management and cc-sessions DAIC workflow.

## Command Signature

```bash
python3 /path/to/backlog_bridge.py git-save <task-id-or-path> [options]
```

### Arguments

**Positional**:
- `<task-id-or-path>` (required): Task identifier or relative path
  - Examples: `task-055`, `task-055-Finalize-git-save-CLI-contract.md`
  - Resolved relative to backlog tasks directory

**Options**:
- `--dry-run`: Preview commit without executing (default: true on first use)
- `--force`: Skip interactive confirmations (for automation)
- `--no-push`: Commit locally without pushing to remote
- `--test-results PATH`: Path to test results JSON (for test gate)
- `--daic-mode MODE`: Override detected DAIC mode (Discussion|Implementation|Check)
- `--verbose`: Enable detailed logging

### Context Input (stdin, optional)

The command accepts optional JSON context on stdin for richer gate evaluation:

```json
{
  "daic_mode": "Implementation",
  "tests_passed": true,
  "test_output_file": "/path/to/test-results.json",
  "force_commit": false,
  "commit_message_override": null
}
```

## Output Format

All output is JSON on stdout (for machine parsing) with optional human-readable summary on stderr (if --verbose).

### Success Response

```json
{
  "success": true,
  "task_id": "task-055",
  "task_title": "Finalize git-save CLI contract",
  "action": "committed",
  "commit": {
    "hash": "abc123f",
    "message": "feat(git-automation): complete task-055 - Finalize git-save CLI contract",
    "author": "Adrian <adrian@example.com>",
    "timestamp": "2025-11-07T17:30:00Z",
    "files_changed": [
      {"path": "sessions/docs/git-save-cli-spec.md", "additions": 150, "deletions": 0}
    ],
    "stats": {"files": 1, "additions": 150, "deletions": 0}
  },
  "push": {
    "attempted": true,
    "success": true,
    "remote": "origin",
    "branch": "feature/git-automation"
  },
  "gates": [
    {"name": "task_exists", "status": "pass", "message": "Task file loaded successfully"},
    {"name": "daic_mode", "status": "pass", "message": "DAIC mode is Implementation"},
    {"name": "protected_branch", "status": "pass", "message": "Branch feature/git-automation is not protected"},
    {"name": "merge_conflicts", "status": "pass", "message": "No merge conflicts detected"},
    {"name": "submodule_consistency", "status": "pass", "message": "All submodules are clean"},
    {"name": "has_changes", "status": "pass", "message": "2 files have uncommitted changes"},
    {"name": "staged_changes", "status": "pass", "message": "No staged-but-uncommitted changes"},
    {"name": "tests_required", "status": "skip", "message": "Tests not required by configuration"},
    {"name": "allowlist", "status": "pass", "message": "All files match allowlist patterns"},
    {"name": "blocklist", "status": "pass", "message": "No blocked files detected"}
  ],
  "dry_run": false
}
```

### Skip Response (gates failed or no changes)

```json
{
  "success": true,
  "task_id": "task-055",
  "action": "skipped",
  "reason": "no_changes",
  "gates": [
    {"name": "has_changes", "status": "fail", "message": "No uncommitted changes detected"}
  ],
  "dry_run": false
}
```

### Error Response

```json
{
  "success": false,
  "error": {
    "code": "PROTECTED_BRANCH",
    "message": "Cannot commit to protected branch 'main'",
    "details": {
      "current_branch": "main",
      "protected_branches": ["main", "master"]
    }
  },
  "gates": [
    {"name": "protected_branch", "status": "fail", "message": "Branch main is protected"}
  ]
}
```

### Dry-Run Response

```json
{
  "success": true,
  "task_id": "task-055",
  "action": "dry_run",
  "preview": {
    "would_commit": true,
    "commit_message": "feat(git-automation): complete task-055 - Finalize git-save CLI contract",
    "files_to_stage": [
      "sessions/docs/git-save-cli-spec.md"
    ],
    "would_push": true,
    "target_remote": "origin",
    "target_branch": "feature/git-automation"
  },
  "gates": [
    {"name": "task_exists", "status": "pass", "message": "Task file loaded successfully"},
    {"name": "daic_mode", "status": "pass", "message": "DAIC mode is Implementation"},
    {"name": "protected_branch", "status": "pass", "message": "Branch feature/git-automation is not protected"},
    {"name": "merge_conflicts", "status": "pass", "message": "No merge conflicts detected"},
    {"name": "submodule_consistency", "status": "pass", "message": "All submodules are clean"},
    {"name": "has_changes", "status": "pass", "message": "1 file has uncommitted changes"},
    {"name": "staged_changes", "status": "pass", "message": "No staged-but-uncommitted changes"},
    {"name": "tests_required", "status": "skip", "message": "Tests not required by configuration"},
    {"name": "allowlist", "status": "pass", "message": "All files match allowlist patterns"},
    {"name": "blocklist", "status": "pass", "message": "No blocked files detected"}
  ],
  "dry_run": true
}
```

## Gate Evaluation

Gates are evaluated **sequentially** in order. Each gate depends on the state established by previous gates. All must pass for commit to proceed.

**Note**: Gates are NOT evaluated in parallel - they run one after another, building on previous checks.

| Gate | Check | Pass Condition | Fail Action |
|------|-------|----------------|-------------|
| **task_exists** | Task file is valid | Task loads successfully | Error |
| **daic_mode** | DAIC mode allows commits | Mode is Implementation or Check | Skip with warning |
| **protected_branch** | Branch is not protected | Current branch not in protected list | Error |
| **merge_conflicts** | No unresolved merge conflicts | `git status` shows no conflicts | Error |
| **submodule_consistency** | Submodules are clean | All submodules committed, no dirty state | Error |
| **has_changes** | Uncommitted changes exist | `git status --porcelain` returns content | Skip silently |
| **staged_changes** | No staged-but-uncommitted deltas | Working tree matches index | Skip with warning |
| **tests_required** | Tests must pass (if configured) | tests_passed=true in context | Error |
| **allowlist** | Files match allowlist patterns | All staged files match patterns | Error |
| **blocklist** | No blocked files | No staged files match block patterns | Error |

## Exit Codes

- `0`: Success (committed or skipped with valid reason)
- `1`: Error (invalid arguments, git failure, gate failure)
- `2`: Configuration error (invalid config, missing dependencies)

## Examples

### Basic Usage

```bash
# Dry-run (preview only)
python3 backlog_bridge.py git-save task-055 --dry-run

# Actual commit
python3 backlog_bridge.py git-save task-055

# Commit without pushing
python3 backlog_bridge.py git-save task-055 --no-push

# With context
echo '{"daic_mode": "Implementation", "tests_passed": true}' | \
  python3 backlog_bridge.py git-save task-055
```

### Integration with Hooks

```javascript
// In post_tool_use.js
const result = execSync(
  `python3 ${backlogBridgePath} git-save "${taskPath}"`,
  {
    input: JSON.stringify({
      daic_mode: STATE.mode,
      tests_passed: STATE.last_test_result
    }),
    encoding: 'utf-8'
  }
);

const response = JSON.parse(result);

if (response.success && response.action === 'committed') {
  console.error(`[Auto-Commit] ${response.commit.hash}: ${response.commit.message}`);
} else if (response.action === 'skipped') {
  console.error(`[Auto-Commit] Skipped: ${response.reason}`);
} else {
  console.error(`[Auto-Commit] Error: ${response.error.message}`);
}
```

## Configuration

Configuration is loaded from (in precedence order):
1. Project `sessions/sessions-config.json` (git_regime section)
2. Global `~/.config/cc-sessions/config.json` (git_regime section)
3. Built-in defaults

See `sessions-config-schema.md` for full configuration reference.

## Implementation Notes

- **Idempotent**: Running multiple times with same state produces same result
- **Atomic**: Either commits successfully or leaves repo unchanged
- **Observable**: All state transitions emit structured events
- **Fail-safe**: Errors never corrupt git history
- **Machine-wide**: Works in any project with cc-sessions installed

## Version

- **Schema Version**: 1.0.0
- **Minimum cc-sessions**: 1.0.0
- **Minimum backlog.md**: 1.0.0
