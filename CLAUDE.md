# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

HD_OS-sessions is a fork of cc-sessions (by GWUDCAP) enhanced with backlog integration, orchestration capabilities, and daemon infrastructure for HD_OS development workflows. Based on the Claude Code workflow framework enforcing Discussion-Alignment-Implementation-Check (DAIC) methodology.

**Repository**: https://github.com/piadda-inc/HD_OS-sessions (fork of cc-sessions)
**Based on**: cc-sessions v0.3.6 (https://github.com/GWUDCAP/cc-sessions)
**License**: MIT

**Custom features in HD_OS-sessions**:
- **Backlog-md integration** - Full orchestration metadata system via `backlog_bridge.py`
- **Multi-agent orchestration** - Parallel execution with domain isolation and dependency tracking
- **Statusline daemon** - Background statusline updates (in development)
- **Performance tooling** - Hook benchmarking and analysis infrastructure
- **Enhanced state management** - Cross-runtime coordination (Python ↔ Node.js) with StateLock

## Development Commands

### Testing
```bash
# JavaScript tests
node run-tests.js

# Python tests (development install)
pip install -e ".[dev]"
pytest tests/ -v

# Hook regression tests
pytest tests/test_backlog_bridge_cli.py tests/test_subagent_stop_hook.py -q

# Performance benchmarking
node tools/analyze-hook-performance.js
bash tools/test-benchmark.sh
```

### Installation (Development)
```bash
# From repository root
./install.sh
```

### Manual Hook Testing
```bash
# Test hook with JSON payload
python3 - <<'PY' | env SESSIONS_STATE_DIR=/tmp/orch-state \
  BACKLOG_TASKS_DIR=$PWD/tests/fixtures/backlog_sample \
  CLAUDE_PROJECT_DIR=$PWD \
  node sessions/hooks/subagent_hooks.js
# [JSON payload generation code here]
PY
```

## Architecture Overview

### Dual-Language Implementation

**Complete feature parity** between Python and JavaScript:
- Python: `cc_sessions/python/` (hooks, api, statusline)
- JavaScript: `cc_sessions/javascript/` (hooks, api, statusline)
- Shared: agents/, protocols/, knowledge/, templates/

Both implementations share:
- Identical state/config management via `shared_state.py|.js`
- Same hook system (PreToolUse, SessionStart, PostToolUse, SubagentStop, UserMessage)
- Unified sessions API command routing

### Core State System

**Unified state file**: `sessions/sessions-state.json` (git-ignored)
- `version` - Installed package version
- `current_task` - Active task + git branch
- `mode` - discussion | implementation | bypass
- `active_protocol` - Running protocol (CREATE/START/COMPLETE/COMPACT/None)
- `todos` - Active + stashed todo lists
- `flags` - Context warnings (context_85, context_90), subagent status
- `metadata` - Kickstart progress, update detection cache
- `execution_windows` - Subagent orchestration tracking

**Configuration**: `sessions/sessions-config.json` (git-tracked, user-customizable)
- `trigger_phrases` - Customizable workflow triggers
- `blocked_actions` - Tool blocking patterns
- `git_preferences` - Commit styles, auto-merge/push, submodules
- `environment` - OS, shell, developer_name
- `features` - branch_enforcement, icon_style (nerd_fonts|emoji|ascii), etc.

**State management** (`cc_sessions/hooks/shared_state.py|.js`, ~37KB):
- Atomic file operations with 1-second timeout + force-removal
- UTF-8 encoding for Windows compatibility
- Type-safe enums: Mode, CCTools, TriggerCategory, IconStyle, GitCommitStyle, UserOS, UserShell
- Nested dataclasses: SessionsState, SessionsConfig, TriggerPhrases, GitPreferences, EnabledFeatures
- Directory task helpers: `is_directory_task()`, `get_task_file_path()`, `is_subtask()`

### DAIC Enforcement Hook

**File**: `cc_sessions/hooks/sessions_enforce.py|.js` (19-42KB)
**Hook**: PreToolUse (runs before every tool call)

**Enforcement logic**:
1. **Mode detection**: Check STATE.mode (discussion/implementation/bypass)
2. **Tool blocking**: Block Edit/Write/MultiEdit/NotebookEdit in discussion mode
3. **Bash command analysis**:
   - ~70 recognized read-only patterns (grep, find, cat, ls, git status, etc.)
   - Pipeline parsing + redirection detection (>, >>, 2>&1, etc.)
   - Intelligent argument detection for write operations
4. **Todo change detection**:
   - Compare proposed todos vs STATE.todos.active
   - Show diff with counts and numbered lists
   - Inject user's trigger phrases from config
   - Require "SHAME RITUAL" response format
   - Clear active todos and return to discussion mode
5. **CI bypass**: Auto-detect GitHub Actions (GITHUB_ACTIONS env var)

**Key patterns recognized**:
- Read-only: grep, find, cat, head, tail, ls, git (status/log/diff/show), npm list, pytest --collect-only, etc.
- Write operations: sed -i, awk with redirection, tee, file descriptor redirects

### Sessions API

**Entry point**: `cc_sessions/python/api/__main__.py` or `javascript/api/index.js`
**Router**: `api/router.py|.js` - Subsystem delegation
**Total size**: ~3294 lines across subsystems

**Subsystems**:
- `state_commands.py|.js` - State inspection, mode transitions, update management
- `config_commands.py|.js` - Trigger phrases, features, git/env settings
- `task_commands.py|.js` - Task CRUD, indexes, start/stop
- `protocol_commands.py|.js` - Protocol loading and execution
- `kickstart_commands.py|.js` - Onboarding progression
- `uninstall_commands.py|.js` - Safe removal with backups

**Command structure**: `/sessions [subsystem] [command] [args]`
**Output modes**: Human-readable + JSON (via `--json` flag)

### Protocol System

**Location**: `cc_sessions/protocols/`
**Type**: Configuration-driven templates with runtime variable substitution

**Template variables** (populated from sessions-config.json):
- `{default_branch}` - User's main branch name
- `{submodules_field}` - Git submodule frontmatter
- `{submodule_context}` - Submodule handling instructions
- `{commit_style}` - conventional | descriptive
- `{auto_merge}` - true | false
- `{auto_push}` - true | false

**Main protocols**:
1. **task-creation/** - Interactive task creation with directory structure confirmation
2. **task-startup/** - Context loading, plan proposal with todos
3. **task-completion/** - Git workflow (stage/commit/merge/push based on preferences)
4. **context-compaction/** - Mid-task context cleanup and refinement
5. **kickstart/** - 11 sequential onboarding protocols (7.5-30 min)

**Loading**: `load_protocol_file()` helper in shared_state performs template substitution

**Output markers**: `[PROPOSAL]`, `[STATUS]`, `[PLAN]`, `[SUMMARY]` - structured protocol responses

### Hook System Architecture

**Hook files** (runtime instances in `sessions/hooks/`):
- `sessions_enforce.py|.js` - PreToolUse enforcement
- `session_start.py|.js` - SessionStart initialization + update detection
- `post_tool_use.py|.js` - PostToolUse todo completion detection
- `subagent_hooks.py|.js` - SubagentStop orchestration signals
- `user_messages.py|.js` - UserMessage trigger phrase detection
- `kickstart_session_start.py|.js` - SessionStart onboarding protocol loader
- `transcript_utils.py|.js` - Conversation log parsing utilities

**Communication**: JSON via stdin/stdout
**Exit codes**:
- 0: Tool allowed
- 1: Tool blocked (hard stop)
- 2: Tool allowed with stderr feedback

**Performance**: Benchmark infrastructure in `hooks/benchmark_utils.js` for latency analysis

### Specialized Agents

**Location**: `cc_sessions/agents/` (installed to `.claude/agents/`)
**Isolation**: Each runs in separate context window
**Transcripts**: Dedicated `sessions/transcripts/[agent-name]/` directories

**Agent types**:
1. **context-gathering** - Analyzes codebase, writes context manifest to task file
2. **code-review** - Reviews implementations for quality patterns
3. **context-refinement** - Updates task context based on session discoveries
4. **logging** - Consolidates chronological work logs
5. **service-documentation** - Maintains CLAUDE.md files

**Subagent protection** (via subagent_hooks):
- DAIC reminders suppressed
- State editing blocked
- Orchestration metadata captured on completion

### Backlog Integration

**File**: `backlog_bridge.py` (~27KB)
**Purpose**: Integration with backlog-md task management system

**Key classes**:
- `BacklogBridge` - Orchestration metadata extraction + execution planning
- `OrchestrationMetadata` - Task orchestration details (stage, group, dependencies)
- `GroupStatusSummary` - Aggregated group status tracking

**Features**:
- Parses task frontmatter for orchestration metadata
- Builds execution plans from task dependencies
- Tracks execution group status across sessions
- Supports parallel execution with domain isolation

**State persistence**:
- Unified state: `sessions/sessions-state.json` (authoritative)
- Lock directory: `sessions/sessions-state.lock/` (atomic mkdir, cross-runtime)
- StateLock context manager prevents concurrent writes (Python ↔ Node.js)

### Graphiti Memory Adapters

**Adapters**: `sessions/memory/*.py` (Python) + `lib/memory/*.js` (Node) expose an identical `MemoryClient` interface with two concrete implementations:
- `GraphitiAdapter` – shells out to `graphiti_local` via JSON IPC for search/store operations.
- `NoopAdapter` – default fallback when memory is disabled, misconfigured, or graphiti is absent.

**Factory**: `get_client(config.memory)` performs provider detection. If `memory.enabled` is `false`, `memory.provider` is unknown, or the configured `graphiti_path` is missing, it returns `NoopAdapter` so hooks degrade to no-ops (no stderr noise, no crashes).

**Configuration** (`sessions/sessions-config.json → memory`):
- `enabled` (`bool`) – opt-in flag controlled by the installer prompt or `/sessions config edit`.
- `provider` (`"graphiti"` today) – keeps the adapter extensible.
- `graphiti_path` – absolute/relative path to the `graphiti_local` executable that `bin/install-memory.sh` installs alongside FalkorDB.
- `auto_search` (`bool`) – allows `SessionStart` to call `render_memory_context()` and emit a `## 📚 Relevant Memory` block when a task is loaded.
- `auto_store` (`off|task-completion|subagent|both`) – drives when `PostToolUse` invokes `maybe_store_task_completion()`.
- `search_timeout_ms`, `store_timeout_s`, `max_results`, `group_id`, `allow_code_snippets`, `sanitize_secrets` – tune Graphiti IPC behavior and result formatting.

**Hook integration**:
- `hooks/session_start.py|.js`: after restoring task state, `render_memory_context()` calls `client.search_memory(task_title)` when `auto_search` is true and writes any facts into the session context.
- `hooks/post_tool_use.py|.js`: when todos finish under a completion protocol and `auto_store` allows it, `maybe_store_task_completion()` builds an episode payload (workspace/task IDs, objectives, timestamps) and calls `client.store_episode()` asynchronously so task completion automatically records an episode.

**Installation**: `cc_sessions/install.py|.js` prompt users to configure Graphiti memory. For manual installs or headless upgrades, run `bin/install-memory.sh` to provision `graphiti_local`, FalkorDB, and its Python dependencies before enabling the feature.

**Parity + usage**: The adapter API is identical cross-language, making it safe to access memory utilities from either runtime:

```python
from sessions.memory import get_client
from shared_state import load_config

client = get_client(load_config().memory)
if client.can_search:
    facts = client.search_memory("vector index rollout")
if client.can_store:
    client.store_episode({"summary": "Added rollout safeguards",
                          "workspace_id": "hd_os_workspace",
                          "objectives": ["Add canary checks"]})
```

Node hooks and utilities call `require('lib/memory').getClient(config.memory)` with the same semantics, ensuring the adapter contracts stay in sync with Python.

### Statusline Integration

**Files**: `cc_sessions/python/statusline.py`, `javascript/statusline.js` (~18-20KB each)
**Display**: Real-time git info + task status in Claude Code statusline

**Features**:
- Three icon styles: Nerd Fonts, Emoji, ASCII (configurable via icon_style feature)
- Current branch or detached HEAD indicator
- Commits ahead/behind upstream tracking
- Task count and active task name
- DAIC mode indicator

**Terminal detection**: Auto-detects Nerd Font capability during installation (TERM_PROGRAM, LC_TERMINAL, WT_SESSION env vars)

## Key File Locations

### Package Structure
```
cc_sessions/
├── python/                    # Python implementation
│   ├── api/                   # Sessions API (~3294 lines)
│   ├── hooks/                 # Hook implementations
│   │   └── shared_state.py    # State/config management (~37KB)
│   └── statusline.py          # Statusline display (~18KB)
├── javascript/                # Node.js implementation (feature parity)
│   ├── api/                   # JS API
│   ├── hooks/                 # JS hooks
│   │   └── shared_state.js    # State/config management (~48KB)
│   └── statusline.js          # Statusline display (~20KB)
├── agents/                    # Specialized agents (5 total)
├── protocols/                 # Workflow templates (~50 files)
├── knowledge/                 # Architecture reference docs
├── templates/                 # Task file templates
├── commands/                  # Slash command wrappers
└── install.py / install.js    # Language-specific installers (~144-158KB)
```

### Runtime Files (Installed)
```
sessions/
├── hooks/                     # Installed hook instances
├── api/                       # Installed API commands
├── protocols/                 # Live protocol templates
├── tasks/                     # Task file storage
├── transcripts/               # Agent execution logs
├── sessions-state.json        # Unified runtime state (git-ignored)
├── sessions-config.json       # User preferences (git-tracked)
└── sessions-state.lock/       # File lock directory
```

## Important Implementation Details

### Atomic State Operations

**Pattern**: All state/config writes use atomic operations
1. Write to temporary file with unique suffix
2. `os.rename()` / `fs.renameSync()` (atomic on POSIX/Windows)
3. Lock acquisition via directory creation (`sessions-state.lock/`)
4. 1-second timeout with force-removal on lock failure
5. UTF-8 encoding explicitly specified (prevents Windows cp1252 issues)

**Why**: Prevents corruption from concurrent access (Python ↔ Node.js ↔ Claude Code hooks)

### Todo Change Detection Algorithm

**Location**: `sessions_enforce.py:319-376|.js:397-454`

**Flow**:
1. Extract proposed todos from tool call (TodoWrite tool)
2. Compare with STATE.todos.active (if exists)
3. If different:
   - Generate diff with counts and numbered lists
   - Inject user's trigger phrases from CONFIG.trigger_phrases.go
   - Display diff + instructions requiring "SHAME RITUAL" response
   - Clear STATE.todos.active
   - Return to discussion mode
   - Exit code 1 (block)
4. If same or no existing todos: Allow (exit code 0)

**Natural gate**: Next TodoWrite succeeds after user approval (no existing todos to compare)

### Protocol Template Substitution

**Location**: `shared_state.py|.js` - `load_protocol_file()`

**Process**:
1. Read protocol markdown file
2. Extract template variables from CONFIG (git_preferences, environment, features)
3. Build substitution map:
   - `{default_branch}` → CONFIG.git_preferences.default_branch
   - `{commit_style}` → CONFIG.git_preferences.commit_style
   - `{submodule_context}` → conditional chunk based on git_preferences.submodules
4. Replace all `{variable}` occurrences
5. Return rendered protocol text

**Conditional sections**: Entire markdown chunks appear/disappear based on config values

### Directory Task Detection

**Helpers** (in shared_state):
- `is_directory_task(task_path)` - Check if path is directory
- `get_task_file_path(task_path)` - Returns README.md for directories, path for files
- `is_subtask(task_name)` - Detects subtask naming pattern
- `is_parent_task(task_path)` - Checks if directory with subtasks exists

**Workflow differences**:
- Directory tasks: Create feature branch, plan multi-phase work, prevent merge until all subtasks complete
- File tasks: Standard single-phase workflow with auto-merge on completion

### CI Environment Detection

**Location**: `sessions_enforce.py|.js`
**Pattern**: Check for `GITHUB_ACTIONS` environment variable
**Effect**: Sets MODE to "bypass" - disables all DAIC enforcement

**Why**: Allows automated CI/CD pipelines to run without manual approval

## Testing Strategy

### Test Locations
- `test/` - Installer test fixtures
- `hooks/__tests__/` - Hook regression tests (Jest-style)
- `hooks/tests/` - Additional hook tests
- `tests/` - Python test suite

### Key Test Files
- `test/subagent_todo_isolation.test.js` - Todo validation across agents
- `test/readonly_bash_permissions.test.js` - Bash command analysis
- `test/meta_commands.test.js` - Meta-level command validation
- `hooks/__tests__/subagent_stop.test.js` - SubagentStop hook behavior
- `tests/test_backlog_bridge_cli.py` - Backlog integration
- `tests/statusline-codex.test.js` - Statusline rendering

### Running Tests
```bash
# All JavaScript tests
node run-tests.js

# Specific hook tests
pytest tests/test_subagent_stop_hook.py -v

# Performance benchmarks
node tools/analyze-hook-performance.js
```

## Release Process

**Version consistency**:
- `pyproject.toml` version field
- `package.json` version field
- Must be synchronized across both packages

**Pre-flight validation**: `scripts/prepare-release.py` runs 7 checks:
1. Version sync between Python/Node packages
2. CHANGELOG.md updated
3. No uncommitted changes
4. Working directory clean
5. All tests passing
6. No merge conflicts
7. Tag doesn't already exist

**Publishing**: `scripts/publish-release.py` - Atomic dual-package workflow
- Builds Python wheel + source distribution
- Publishes to PyPI via twine
- Publishes to npm via npm publish
- Creates git tag
- Pushes tag to remote

## Common Patterns

### Adding New Trigger Phrases

**Code location**: `shared_state.py|.js` - TriggerCategory enum, TriggerPhrases dataclass
**Config location**: `sessions-config.json` - trigger_phrases object
**API command**: `/sessions config phrases add <category> "<phrase>"`

**Categories**: go, no, create, start, complete, compact

### Adding New Feature Toggles

**Code location**: `shared_state.py|.js` - EnabledFeatures dataclass
**Config location**: `sessions-config.json` - features object
**API commands**:
- `/sessions config features show`
- `/sessions config features toggle <key>`
- `/sessions config features set <key> <value>`

**Types**: Boolean flags (true/false), Enums (e.g., icon_style: nerd_fonts|emoji|ascii)

### Adding New Agents

1. Create `cc_sessions/agents/new-agent.md` with specialized instructions
2. Update installer to copy to `.claude/agents/`
3. Add transcript directory creation in session_start hook
4. Document in CLAUDE.sessions.md and README.md

### Adding New Protocols

1. Create protocol markdown in `cc_sessions/protocols/new-protocol/`
2. Use template variables: `{default_branch}`, `{commit_style}`, etc.
3. Add conditional sections based on CONFIG values
4. Update protocol_commands.py|.js with new protocol loader
5. Add trigger phrase mapping in user_messages hook

## Known Issues

### Claude Code v2.0.9+ Compatibility

**Issue**: Versions 2.0.9+ have stderr aggregation bug causing 400 API errors during parallel tool execution

**Symptoms**:
- "400 API Error: tool use concurrency issues" with parallel tools
- Occurs when commands generate stderr + PostToolUse hooks send stderr feedback (exit code 2)

**Workaround**: Use Claude Code v2.0.8 until Anthropic fixes upstream bug

**Affected operations**:
- PostToolUse directory navigation confirmations (cd command)
- DAIC mode transitions
- Any parallel tool calls with mixed stderr sources

## Anti-Patterns

❌ **Don't edit sessions-state.json directly** - Use sessions API or state management functions
❌ **Don't bypass StateLock for state writes** - Causes corruption risk
❌ **Don't assume frozen dataclasses prevent mutation** - Use tuples for lists, MappingProxyType for dicts
❌ **Don't skip template variable substitution** - Breaks protocol adaptation
❌ **Don't modify hook exit codes without understanding tool blocking semantics** - 0=allow, 1=block, 2=allow+feedback
❌ **Don't create agents that modify files outside their domain** - Violates isolation principle

## Additional Resources

- **RELEASE.md** - Maintainer guide for version releases
- **README.md** - User-facing feature overview
- **CHANGELOG.md** - Version history and migration notes
- **docs/INSTALL.md** - Detailed installation instructions
- **docs/USAGE_GUIDE.md** - Workflow and feature documentation
- **cc_sessions/knowledge/** - Internal architecture details
- **CLAUDE.sessions.md** - Usage guidance for Claude when working in sessions-enabled repos
