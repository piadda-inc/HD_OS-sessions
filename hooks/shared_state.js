#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');

// ==== EXCEPTIONS ===== //
class StateError extends Error {
    constructor(message) {
        super(message);
        this.name = 'StateError';
    }
}

class StashOccupiedError extends Error {
    constructor(message) {
        super(message);
        this.name = 'StashOccupiedError';
    }
}

// ==== GLOBALS ===== //

function findProjectRoot() {
    if (process.env.CLAUDE_PROJECT_DIR) {
        return process.env.CLAUDE_PROJECT_DIR;
    }
    let cur = process.cwd();
    while (cur !== path.dirname(cur)) {
        if (fs.existsSync(path.join(cur, '.claude'))) {
            return cur;
        }
        cur = path.dirname(cur);
    }
    console.error('Error: Could not find project root (no .claude directory).');
    process.exit(2);
}

const PROJECT_ROOT = findProjectRoot();
const CONFIG_FILE = path.join(PROJECT_ROOT, 'sessions', 'sessions-config.json');

// Mode description strings
const DISCUSSION_MODE_MSG = "You are now in Discussion Mode and should focus on discussing and investigating with the user (no edit-based tools)";
const ORCHESTRATION_MODE_MSG = "You are now in Orchestration Mode and may use tools to coordinate and delegate work - when you are done return immediately to Discussion Mode";

// ==== HASH FUNCTIONS ===== //

/**
 * Hash a filesystem path to a 12-character hexadecimal identifier.
 *
 * Symlinks are resolved before hashing to ensure symlink and target
 * produce identical hashes. Falls back to path.resolve() if
 * fs.realpathSync() fails.
 *
 * @param {string} absolutePath - Path to hash
 * @returns {string} 12-character lowercase hexadecimal string
 */
function hashPath(absolutePath) {
    let normalized;
    try {
        // Resolve symlinks and canonicalize path
        normalized = fs.realpathSync(absolutePath);
    } catch (err) {
        // Fallback for non-existent paths: resolve as much as possible
        // Walk up the path until we find an existing ancestor, then resolve that
        // and append the non-existent tail. This matches Python's resolve(strict=False)
        // behavior and ensures symlinks in parent directories are resolved.
        const parts = path.resolve(absolutePath).split(path.sep);
        let existing = '';
        let tail = [];

        // Find the deepest existing ancestor
        for (let i = parts.length; i > 0; i--) {
            const candidate = parts.slice(0, i).join(path.sep) || path.sep;
            try {
                existing = fs.realpathSync(candidate);
                tail = parts.slice(i);
                break;
            } catch {
                continue;
            }
        }

        // If we found an existing ancestor, append the tail
        if (existing) {
            normalized = tail.length > 0 ? path.join(existing, ...tail) : existing;
        } else {
            // No existing ancestor found (shouldn't happen on Unix/Windows)
            normalized = path.resolve(absolutePath);
        }
    }

    // Hash the normalized path string
    const hash = crypto.createHash('md5')
        .update(normalized)
        .digest('hex');

    // Return first 12 characters
    return hash.substring(0, 12);
}

/**
 * Get a unique identifier for the current project.
 *
 * Returns the hash of PROJECT_ROOT, providing a stable
 * identifier that's consistent across sessions.
 *
 * @returns {string} 12-character hexadecimal project identifier
 */
function getProjectIdentifier() {
    return hashPath(PROJECT_ROOT);
}

// Compute project identifier at module load time
const PROJECT_ID = getProjectIdentifier();

// ==== SCOPED PATH CONSTANTS ===== //
// Scoped state paths: sessions/state/<project_hash>/
const STATE_DIR = path.join(PROJECT_ROOT, 'sessions', 'state', PROJECT_ID);
const STATE_FILE = path.join(STATE_DIR, 'sessions-state.json');
const LOCK_DIR = path.join(STATE_DIR, 'sessions-state.lock');

// ==== ENUMS ===== //

const TriggerCategory = {
    ORCHESTRATION_MODE: 'orchestration_mode',
    DISCUSSION_MODE: 'discussion_mode',
    TASK_CREATION: 'task_creation',
    TASK_STARTUP: 'task_startup',
    TASK_COMPLETION: 'task_completion',
    CONTEXT_COMPACTION: 'context_compaction'
};

const GitAddPattern = {
    ASK: 'ask',
    ALL: 'all'
};

const GitCommitStyle = {
    REG: 'conventional',
    SIMP: 'simple',
    OP: 'detailed'
};

const UserOS = {
    LINUX: 'linux',
    MACOS: 'macos',
    WINDOWS: 'windows'
};

const UserShell = {
    BASH: 'bash',
    ZSH: 'zsh',
    FISH: 'fish',
    POWERSHELL: 'powershell',
    CMD: 'cmd'
};

const IconStyle = {
    NERD_FONTS: 'nerd_fonts',
    EMOJI: 'emoji',
    ASCII: 'ascii'
};

const CCTools = {
    READ: 'Read',
    WRITE: 'Write',
    EDIT: 'Edit',
    MULTIEDIT: 'MultiEdit',
    NOTEBOOKEDIT: 'NotebookEdit',
    GREP: 'Grep',
    GLOB: 'Glob',
    LS: 'LS',
    BASH: 'Bash',
    BASHOUTPUT: 'BashOutput',
    KILLBASH: 'KillBash',
    WEBSEARCH: 'WebSearch',
    WEBFETCH: 'WebFetch',
    TASK: 'Task',
    TODOWRITE: 'TodoWrite',
    EXITPLANMODE: 'ExitPlanMode'
};

const SessionsProtocol = {
    COMPACT: 'context-compaction',
    CREATE: 'task-creation',
    START: 'task-startup',
    COMPLETE: 'task-completion'
};

const Mode = {
    NO: 'discussion',
    GO: 'orchestration'
};

const TodoStatus = {
    PENDING: 'pending',
    IN_PROGRESS: 'in_progress',
    COMPLETED: 'completed'
};

const Model = {
    OPUS: 'opus',
    SONNET: 'sonnet',
    UNKNOWN: 'unknown'
};

// ==== CLASSES ===== //

class TriggerPhrases {
    constructor(data = {}) {
        // Handle backward compatibility: "implementation_mode" → "orchestration_mode"
        // Prefer new key if both exist, fallback to old key if only old exists
        this.orchestration_mode = data.orchestration_mode ||
                                   data.implementation_mode ||
                                   ['yert'];
        this.discussion_mode = data.discussion_mode || ['SILENCE'];
        this.task_creation = data.task_creation || ['mek:'];
        this.task_startup = data.task_startup || ['start^'];
        this.task_completion = data.task_completion || ['finito'];
        this.context_compaction = data.context_compaction || ['squish'];
    }

    // Backward compatibility getter for old code
    get implementation_mode() {
        return this.orchestration_mode;
    }

    _coaxPhraseType(phraseType) {
        const mapping = {
            'implement': TriggerCategory.ORCHESTRATION_MODE,
            'discuss': TriggerCategory.DISCUSSION_MODE,
            'create': TriggerCategory.TASK_CREATION,
            'start': TriggerCategory.TASK_STARTUP,
            'complete': TriggerCategory.TASK_COMPLETION,
            'compact': TriggerCategory.CONTEXT_COMPACTION,
            'orchestration_mode': TriggerCategory.ORCHESTRATION_MODE,
            'discussion_mode': TriggerCategory.DISCUSSION_MODE,
            'task_creation': TriggerCategory.TASK_CREATION,
            'task_startup': TriggerCategory.TASK_STARTUP,
            'task_completion': TriggerCategory.TASK_COMPLETION,
            'context_compaction': TriggerCategory.CONTEXT_COMPACTION
        };
        if (mapping[phraseType]) return mapping[phraseType];
        throw new Error(`Unknown phrase type: ${phraseType}`);
    }

    addPhrase(category, phrase) {
        if (typeof category === 'string') category = this._coaxPhraseType(category);
        const list = this[category];
        if (!list || !Array.isArray(list)) throw new Error(`Unknown trigger category: ${category}`);
        if (list.includes(phrase)) return false;
        list.push(phrase);
        return true;
    }

    removePhrase(category, phrase) {
        if (typeof category === 'string') category = this._coaxPhraseType(category);
        const list = this[category];
        if (!list || !Array.isArray(list)) throw new Error(`Unknown trigger category: ${category}`);
        const index = list.indexOf(phrase);
        if (index > -1) {
            list.splice(index, 1);
            return true;
        }
        return false;
    }

    hasPhrase(phrase) {
        for (const key of Object.keys(TriggerCategory)) {
            const category = TriggerCategory[key];
            const list = this[category];
            if (list && list.includes(phrase)) return category;
        }
        return null;
    }

    listPhrases(category = null) {
        if (category) {
            if (typeof category === 'string') category = this._coaxPhraseType(category);
            const list = this[category];
            if (!list || !Array.isArray(list)) throw new Error(`Unknown trigger category: ${category}`);
            return { [category]: list };
        }
        const result = {};
        for (const key of Object.keys(TriggerCategory)) {
            const cat = TriggerCategory[key];
            result[cat] = this[cat];
        }
        return result;
    }
}

class GitPreferences {
    constructor(data = {}) {
        this.add_pattern = data.add_pattern || GitAddPattern.ASK;
        this.default_branch = data.default_branch || 'main';
        this.commit_style = data.commit_style || GitCommitStyle.REG;
        this.auto_merge = data.auto_merge || false;
        this.auto_push = data.auto_push || false;
        this.has_submodules = data.has_submodules || false;
    }
}

class SessionsEnv {
    constructor(data = {}) {
        this.os = data.os || UserOS.LINUX;
        this.shell = data.shell || UserShell.BASH;
        this.developer_name = data.developer_name || 'developer';
    }

    isWindows() {
        return this.os === UserOS.WINDOWS;
    }

    isUnix() {
        return this.os === UserOS.LINUX || this.os === UserOS.MACOS;
    }
}

class BlockingPatterns {
    constructor(data = {}) {
        this.implementation_only_tools = data.implementation_only_tools ||
            [CCTools.EDIT, CCTools.WRITE, CCTools.MULTIEDIT, CCTools.NOTEBOOKEDIT];
        this.bash_read_patterns = data.bash_read_patterns || [];
        this.bash_write_patterns = data.bash_write_patterns || [];
        this.extrasafe = data.extrasafe || false;
    }

    _coaxCCTool(tool) {
        // Find matching CCTools value
        for (const key of Object.keys(CCTools)) {
            if (CCTools[key] === tool) {
                return tool;
            }
        }
        throw new Error(`Unknown tool: ${tool}`);
    }

    isToolBlocked(tool) {
        if (typeof tool === 'string') tool = this._coaxCCTool(tool);
        return this.implementation_only_tools.includes(tool);
    }

    addBlockedTool(tool) {
        if (typeof tool === 'string') tool = this._coaxCCTool(tool);
        if (this.implementation_only_tools.includes(tool)) return false;
        this.implementation_only_tools.push(tool);
        return true;
    }

    removeBlockedTool(tool) {
        if (typeof tool === 'string') tool = this._coaxCCTool(tool);
        const index = this.implementation_only_tools.indexOf(tool);
        if (index > -1) {
            this.implementation_only_tools.splice(index, 1);
            return true;
        }
        return false;
    }

    addCustomPattern(pattern) {
        if (!this.bash_write_patterns.includes(pattern)) {
            this.bash_write_patterns.push(pattern);
        }
        return true;
    }

    removeCustomPattern(pattern) {
        const index = this.bash_write_patterns.indexOf(pattern);
        if (index > -1) {
            this.bash_write_patterns.splice(index, 1);
        }
        return true;
    }

    addReadonlyCommand(command) {
        if (this.bash_read_patterns.includes(command)) return true;
        this.bash_read_patterns.push(command);
        return true;
    }

    removeReadonlyCommand(command) {
        const index = this.bash_read_patterns.indexOf(command);
        if (index > -1) {
            this.bash_read_patterns.splice(index, 1);
        }
        return true;
    }
}

class ContextWarnings {
    constructor(data = {}) {
        this.warn_85 = data.warn_85 !== undefined ? data.warn_85 : true;
        this.warn_90 = data.warn_90 !== undefined ? data.warn_90 : true;
    }
}

class EnabledFeatures {
    constructor(data = {}) {
        this.branch_enforcement = data.branch_enforcement !== undefined ? data.branch_enforcement : true;
        this.task_detection = data.task_detection !== undefined ? data.task_detection : true;
        this.auto_ultrathink = data.auto_ultrathink !== undefined ? data.auto_ultrathink : true;

        // Handle migration from old use_nerd_fonts boolean to new icon_style enum
        let iconStyleValue = data.icon_style;
        if (iconStyleValue === undefined || iconStyleValue === null) {
            // Check for old boolean field
            const oldUseNerdFonts = data.use_nerd_fonts;
            if (oldUseNerdFonts !== undefined && oldUseNerdFonts !== null) {
                // Migrate: true -> NERD_FONTS, false -> ASCII
                iconStyleValue = oldUseNerdFonts ? IconStyle.NERD_FONTS : IconStyle.ASCII;
            } else {
                // No old or new field, use default
                iconStyleValue = IconStyle.NERD_FONTS;
            }
        } else if (typeof iconStyleValue === 'string') {
            // Validate the string is a valid IconStyle value
            const validValues = Object.values(IconStyle);
            if (!validValues.includes(iconStyleValue)) {
                iconStyleValue = IconStyle.NERD_FONTS;
            }
        }

        this.icon_style = iconStyleValue;
        this.context_warnings = data.context_warnings instanceof ContextWarnings
            ? data.context_warnings
            : new ContextWarnings(data.context_warnings || {});
    }

    static fromDict(data) {
        return new EnabledFeatures(data);
    }
}

class MemoryConfig {
    constructor(data = {}) {
        this.enabled = data.enabled ?? false;
        this.provider = data.provider || 'graphiti';
        this.graphiti_path = data.graphiti_path || '';
        this.auto_search = data.auto_search !== undefined ? data.auto_search : true;
        this.auto_store = data.auto_store || 'off';
        this.search_timeout_ms = data.search_timeout_ms ?? 1500;
        this.store_timeout_s = data.store_timeout_s ?? 2.0;
        this.max_results = data.max_results ?? 5;
        this.group_id = data.group_id || 'hd_os_workspace';
        this.allow_code_snippets = data.allow_code_snippets !== undefined ? data.allow_code_snippets : true;
        this.sanitize_secrets = data.sanitize_secrets !== undefined ? data.sanitize_secrets : true;
    }

    toDict() {
        return {
            enabled: this.enabled,
            provider: this.provider,
            graphiti_path: this.graphiti_path,
            auto_search: this.auto_search,
            auto_store: this.auto_store,
            search_timeout_ms: this.search_timeout_ms,
            store_timeout_s: this.store_timeout_s,
            max_results: this.max_results,
            group_id: this.group_id,
            allow_code_snippets: this.allow_code_snippets,
            sanitize_secrets: this.sanitize_secrets
        };
    }
}

class SessionsConfig {
    constructor(data = {}) {
        this.trigger_phrases = new TriggerPhrases(data.trigger_phrases);
        this.blocked_actions = new BlockingPatterns(data.blocked_actions);
        this.git_preferences = new GitPreferences(data.git_preferences);
        this.environment = new SessionsEnv(data.environment);
        this.features = EnabledFeatures.fromDict(data.features);
        this.memory = new MemoryConfig(data.memory);
    }

    static fromDict(data) {
        return new SessionsConfig(data);
    }

    toDict() {
        return {
            trigger_phrases: { ...this.trigger_phrases },
            blocked_actions: { ...this.blocked_actions },
            git_preferences: { ...this.git_preferences },
            environment: { ...this.environment },
            features: {
                branch_enforcement: this.features.branch_enforcement,
                task_detection: this.features.task_detection,
                auto_ultrathink: this.features.auto_ultrathink,
                icon_style: this.features.icon_style,
                context_warnings: {
                    warn_85: this.features.context_warnings.warn_85,
                    warn_90: this.features.context_warnings.warn_90
                }
            },
            memory: this.memory.toDict()
        };
    }
}

class TaskState {
    constructor(data = {}) {
        this.name = data.name || null;
        this.file = data.file || null;
        this.branch = data.branch || null;
        this.status = data.status || null;
        this.created = data.created || null;
        this.started = data.started || null;
        this.updated = data.updated || null;
        this.dependencies = data.dependencies || null;
        this.submodules = data.submodules || null;
    }

    get filePath() {
        if (!this.file) return null;
        const filePath = path.join(PROJECT_ROOT, 'sessions', 'tasks', this.file);
        if (fs.existsSync(filePath)) return filePath;
        return null;
    }

    get taskState() {
        return { ...this };
    }

    static loadTask(options = {}) {
        const { path: taskPath, file } = options;
        if (!file && !taskPath) throw new Error('Either file or path must be provided.');

        const tasksRoot = path.join(PROJECT_ROOT, 'sessions', 'tasks');
        let fullPath = taskPath;
        if (file && !taskPath) fullPath = path.join(tasksRoot, file);
        if (!fs.existsSync(fullPath)) throw new Error(`Task file ${fullPath} does not exist.`);

        const content = fs.readFileSync(fullPath, 'utf8');
        const fmStart = content.indexOf('---');
        if (fmStart !== 0) throw new StateError(`Task file ${fullPath} missing frontmatter.`);

        const fmEnd = content.indexOf('---', fmStart + 3);
        if (fmEnd === -1) throw new StateError(`Task file ${fullPath} missing frontmatter end.`);

        const fmContent = content.substring(fmStart + 3, fmEnd).trim();
        const data = {};

        for (const line of fmContent.split('\n')) {
            if (!line.includes(':')) continue;
            const [key, ...valueParts] = line.split(':');
            const cleanKey = key.trim();
            const value = valueParts.join(':').trim();

            if (cleanKey === 'submodules' || cleanKey === 'modules') {
                const cleanValue = value.replace(/[\[\]]/g, '');
                data.submodules = cleanValue.split(',').map(s => s.trim()).filter(s => s);
            } else if (cleanKey === 'task') {
                // Handle legacy "task:" field by mapping to "name"
                data.name = value || null;
            } else {
                data[cleanKey] = value || null;
            }
        }

        if (!file && taskPath) {
            try {
                const rel = path.relative(tasksRoot, taskPath);
                data.file = rel;
            } catch {
                data.file = path.basename(taskPath);
            }
        } else {
            data.file = file;
        }

        return new TaskState(data);
    }

    clearTask() {
        this.name = null;
        this.file = null;
        this.branch = null;
        this.status = null;
        this.created = null;
        this.started = null;
        this.updated = null;
        this.submodules = null;
    }
}

class CCTodo {
    constructor(data = {}) {
        if (typeof data === 'string') {
            this.content = data;
            this.status = TodoStatus.PENDING;
            this.activeForm = null;
        } else {
            this.content = data.content || '';
            this.status = data.status || TodoStatus.PENDING;
            this.activeForm = data.activeForm || null;
        }
    }
}

class SessionsFlags {
    constructor(data = {}) {
        this.context_85 = data.context_85 || false;
        this.context_90 = data.context_90 || false;
        this.subagent = data.subagent || false;
        this.subagent_session_id = data.subagent_session_id || null;
        this.noob = data.noob !== undefined ? data.noob : true;
        this.bypass_mode = data.bypass_mode || false;
    }

    clearFlags() {
        this.context_85 = false;
        this.context_90 = false;
        this.subagent = false;
        this.subagent_session_id = null;
        this.bypass_mode = false;
    }

    setSubagent(sessionId) {
        this.subagent = true;
        this.subagent_session_id = sessionId || null;
    }

    clearSubagent() {
        this.subagent = false;
        this.subagent_session_id = null;
    }

    isSubagentStale(currentSessionId) {
        if (!this.subagent) return false;
        if (!this.subagent_session_id) return true;  // Legacy state without tracking
        if (!currentSessionId) return true;  // Can't verify, assume stale for safety
        return this.subagent_session_id !== currentSessionId;
    }
}

class SessionsTodos {
    constructor(data = {}) {
        this.active = (data.active || []).map(t => new CCTodo(t));
        this.stashed = (data.stashed || []).map(t => new CCTodo(t));
    }

    storeTodos(todos, over = true) {
        if (this.active.length > 0) {
            if (!over) return false;
            this.clearActive();
        }
        try {
            for (const t of todos) {
                this.active.push(new CCTodo(t));
            }
            return true;
        } catch (e) {
            console.error(`Error loading todos: ${e}`);
            return false;
        }
    }

    allComplete() {
        return this.active.length > 0 &&
               this.active.every(t => t.status === TodoStatus.COMPLETED);
    }

    stashActive(force = true) {
        if (!this.stashed.length || force) {
            const n = this.active.length;
            this.stashed = [...this.active];
            this.active = [];
            return n;
        }
        throw new StashOccupiedError('Stash already occupied. Use force=true to overwrite.');
    }

    clearActive() {
        const n = this.active.length;
        this.active = [];
        return n;
    }

    clearStashed() {
        const n = this.stashed.length;
        this.stashed = [];
        return n;
    }

    restoreStashed() {
        if (!this.stashed.length) return 0;
        if (this.active.length && !this.allComplete()) return 0;
        const n = this.stashed.length;
        this.active = [];
        this.active.push(...this.stashed);
        this.stashed = [];
        return n;
    }

    toList(which) {
        const todos = which === 'active' ? this.active : this.stashed;
        return todos.map(t => ({
            content: t.content,
            status: t.status,
            activeForm: t.activeForm
        }));
    }

    listContent(which) {
        const todos = which === 'active' ? this.active : this.stashed;
        return todos.map(t => t.content);
    }

    toDict() {
        /**Return complete todos structure with both active and stashed.*/
        const result = { active: this.toList('active') };
        if (this.stashed && this.stashed.length > 0) {
            result.stashed = this.toList('stashed');
        }
        return result;
    }
}

class APIPerms {
    constructor(data = {}) {
        this.startup_load = data.startup_load || false;
        this.completion = data.completion || false;
        this.todos_clear = data.todos_clear || false;
    }
}

function _getPackageVersion() {
    /**Get the installed cc-sessions package version.*/
    try {
        const packagePath = require('path').join(__dirname, '..', '..', 'package.json');
        if (require('fs').existsSync(packagePath)) {
            const packageData = require(packagePath);
            return packageData.version || 'unknown';
        }
    } catch {
        return 'unknown';
    }
    return 'unknown';
}

class SessionsState {
    constructor(data = {}) {
        this.version = data.version || _getPackageVersion();
        this.current_task = new TaskState(data.current_task || {});
        this.active_protocol = data.active_protocol || null;
        this.api = new APIPerms(data.api || {});
        this.mode = data.mode || Mode.NO;
        this.todos = new SessionsTodos(data.todos || {});
        this.model = data.model || Model.OPUS;
        this.flags = new SessionsFlags(data.flags || {});
        this.metadata = data.metadata || {};
        this.execution_windows = new ExecutionWindowsState();
    }

    static _coerceTodo(x) {
        if (typeof x === 'string') {
            return new CCTodo(x);
        }
        let status = x.status || TodoStatus.PENDING;
        if (typeof status === 'string') {
            status = status; // Already a string, use as-is
        }
        return new CCTodo({
            content: x.content || '',
            status: status,
            activeForm: x.activeForm || null
        });
    }

    static fromDict(data) {
        // Try to get package version
        let pkgVersion = 'unknown';
        try {
            const packagePath = require('path').join(__dirname, '..', '..', '..', 'package.json');
            if (require('fs').existsSync(packagePath)) {
                const packageData = require(packagePath);
                pkgVersion = packageData.version || 'unknown';
            }
        } catch {
            pkgVersion = 'unknown';
        }

        // Handle active_protocol enum conversion
        let activeProtocol = data.active_protocol;
        if (activeProtocol && typeof activeProtocol === 'string') {
            // Validate it's a valid protocol value
            const validProtocols = Object.values(SessionsProtocol);
            if (!validProtocols.includes(activeProtocol)) {
                activeProtocol = null;
            }
        }

        // Handle API permissions
        const apiData = data.api || {};
        const apiPerms = new APIPerms(apiData);

        // Handle todos with proper coercion
        const todosData = data.todos || {};
        const activeTodos = (todosData.active || []).map(t => SessionsState._coerceTodo(t));
        const stashedTodos = (todosData.stashed || []).map(t => SessionsState._coerceTodo(t));

        // Handle flags with legacy format support

        const flagsData = data.flags || {};
        const context85 = flagsData.context_85 ||
                          (flagsData.context_warnings && flagsData.context_warnings['85%']) ||
                          false;
        const context90 = flagsData.context_90 ||
                          (flagsData.context_warnings && flagsData.context_warnings['90%']) ||
                          false;

        // Handle mode with backward compatibility for "implementation" → "orchestration"
        let mode = data.mode || Mode.NO;
        if (mode === 'implementation') {
            mode = 'orchestration';  // Auto-migrate old value
        }

        const state = new SessionsState();
        state.version = data.version || pkgVersion;
        state.current_task = new TaskState(data.current_task || {});
        state.active_protocol = activeProtocol;
        state.api = apiPerms;
        state.mode = mode;
        state.todos = new SessionsTodos({});
        state.todos.active = activeTodos;
        state.todos.stashed = stashedTodos;
        state.model = data.model || Model.OPUS;
        state.flags = new SessionsFlags({
            context_85: context85,
            context_90: context90,
            subagent: flagsData.subagent || false,
            noob: flagsData.noob !== undefined ? flagsData.noob : true,
            bypass_mode: flagsData.bypass_mode || false
        });
        state.metadata = data.metadata || {};

        // Handle execution_windows
        if (data.execution_windows) {
            state.execution_windows = new ExecutionWindowsState();
            state.execution_windows.updateFrom(data.execution_windows);
        }

        return state;
    }

    toDict() {
        return {
            version: this.version,
            current_task: { ...this.current_task },
            active_protocol: this.active_protocol,
            api: { ...this.api },
            mode: this.mode,
            todos: {
                active: this.todos.toList('active'),
                stashed: this.todos.toList('stashed')
            },
            model: this.model,
            flags: { ...this.flags },
            metadata: { ...this.metadata },
            execution_windows: this.execution_windows?.toDict() || null
        };
    }
}

/**
 * ExecutionWindowTask - Tracks task state in an execution window with ownership and collision detection
 */
class ExecutionWindowTask {
    /**
     * @param {string} path - Task file path
     * @param {string} branch - Git branch name
     */
    constructor(path, branch) {
        // Core task metadata
        this.path = path;
        this.status = "Pending";  // "Pending" | "In Progress" | "Done"
        this.branch = branch;
        this.dependencies = [];
        this.hash = null;         // SHA256 of task file content
        this.mtime = null;        // ISO8601 modification time

        // Subagent ownership
        this.assigned_to = null;           // string | null - Subagent ID
        this.assigned_files = [];          // string[] - Files this subagent is working on
        this.assigned_at = null;           // string | null - ISO8601 timestamp

        // Collision detection
        this.conflict_detected = false;    // boolean
        this.conflict_with = null;         // string | null - Other subagent ID
        this.conflict_files = [];          // string[] - Files in conflict
        this.conflict_at = null;           // string | null - ISO8601 timestamp
    }

    /**
     * Convert to plain object for JSON storage
     * @returns {Object} Serializable dictionary
     */
    toDict() {
        return {
            path: this.path,
            status: this.status,
            branch: this.branch,
            dependencies: Array.from(this.dependencies),
            hash: this.hash,
            mtime: this.mtime,
            assigned_to: this.assigned_to,
            assigned_files: Array.from(this.assigned_files),
            assigned_at: this.assigned_at,
            conflict_detected: this.conflict_detected,
            conflict_with: this.conflict_with,
            conflict_files: Array.from(this.conflict_files),
            conflict_at: this.conflict_at
        };
    }

    /**
     * Update task from a plain object (deserialization)
     * @param {Object} dict - Dictionary containing task data
     */
    updateFrom(dict) {
        // Core fields
        if (dict.path !== undefined) this.path = dict.path;
        if (dict.status !== undefined) this.status = dict.status;
        if (dict.branch !== undefined) this.branch = dict.branch;
        if (dict.dependencies !== undefined) this.dependencies = dict.dependencies;
        if (dict.hash !== undefined) this.hash = dict.hash;
        if (dict.mtime !== undefined) this.mtime = dict.mtime;

        // Ownership tracking (only update if present)
        if (dict.assigned_to !== undefined) this.assigned_to = dict.assigned_to;
        if (dict.assigned_files !== undefined) this.assigned_files = Array.isArray(dict.assigned_files) ? dict.assigned_files : [];
        if (dict.assigned_at !== undefined) this.assigned_at = dict.assigned_at;

        // Collision detection (only update if present)
        if (dict.conflict_detected !== undefined) this.conflict_detected = dict.conflict_detected;
        if (dict.conflict_with !== undefined) this.conflict_with = dict.conflict_with;
        if (dict.conflict_files !== undefined) this.conflict_files = Array.isArray(dict.conflict_files) ? dict.conflict_files : [];
        if (dict.conflict_at !== undefined) this.conflict_at = dict.conflict_at;
    }

    /**
     * Assign files to a subagent
     * @param {string} subagentId - Unique subagent identifier
     * @param {string[]} files - Array of file paths
     */
    setAssignment(subagentId, files) {
        // Guard against re-assignment
        if (this.assigned_to && this.assigned_to !== subagentId) {
            this.markConflict(subagentId, files);
            throw new Error(`Task ${this.path} already assigned to ${this.assigned_to}, cannot reassign to ${subagentId}`);
        }

        this.assigned_to = subagentId;
        this.assigned_files = Array.from(files);  // Clone array
        this.assigned_at = new Date().toISOString();
    }

    /**
     * Clear assignment when task completes
     */
    clearAssignment() {
        this.assigned_to = null;
        this.assigned_files = [];
        this.assigned_at = null;
    }

    /**
     * Mark a collision with another subagent
     * @param {string} otherSubagentId - Conflicting subagent ID
     * @param {string[]} conflictingFiles - Files in conflict
     */
    markConflict(otherSubagentId, conflictingFiles) {
        this.conflict_detected = true;
        this.conflict_with = otherSubagentId;
        this.conflict_files = Array.from(conflictingFiles);  // Clone array
        this.conflict_at = new Date().toISOString();
    }

    /**
     * Clear conflict flag
     */
    clearConflict() {
        this.conflict_detected = false;
        this.conflict_with = null;
        this.conflict_files = [];
        this.conflict_at = null;
    }
}

/**
 * ExecutionWindowsState - Manages execution window state with active window tracking
 */
class ExecutionWindowsState {
    constructor() {
        this.tasks = [];  // Array of ExecutionWindowTask objects
        this.active_window_id = null;  // Currently active execution window
    }

    /**
     * Convert to plain object for JSON storage
     * @returns {Object} Serializable dictionary
     */
    toDict() {
        return {
            tasks: this.tasks.map(t => t.toDict()),
            active_window_id: this.active_window_id
        };
    }

    /**
     * Update from a plain object (deserialization)
     * @param {Object} dict - Dictionary containing execution windows data
     */
    updateFrom(dict) {
        if (dict.tasks) {
            this.tasks = dict.tasks.map(taskData => {
                const task = new ExecutionWindowTask(taskData.path, taskData.branch);
                task.updateFrom(taskData);
                return task;
            });
        }
        if (dict.active_window_id !== undefined) {
            this.active_window_id = dict.active_window_id;
        }
    }

    /**
     * Get the active window (simplified: returns this for now)
     * @returns {ExecutionWindowsState|null}
     */
    getActiveWindow() {
        // For now, treat the entire state as a single window
        return this;
    }

    /**
     * Add or update a task in the execution window
     * @param {ExecutionWindowTask} task
     */
    addTask(task) {
        const existing = this.tasks.find(t => t.path === task.path);
        if (existing) {
            existing.updateFrom(task.toDict());
        } else {
            this.tasks.push(task);
        }
    }

    /**
     * Remove a task from the execution window
     * @param {string} taskPath
     */
    removeTask(taskPath) {
        this.tasks = this.tasks.filter(t => t.path !== taskPath);
    }
}

/**
 * ExecutionWindowManager - Static class for managing execution windows and file assignments
 */
class ExecutionWindowManager {
    /**
     * Check if files can be assigned without collision
     * @param {string[]} files - Array of file paths to check
     * @returns {{ok: boolean, conflicts: Array<{file: string, owner: string, task: string}>}}
     */
    static canAssignFiles(files) {
        const state = loadState();
        const window = state.execution_windows?.getActiveWindow();
        if (!window) return {ok: true, conflicts: []};

        const conflicts = [];
        for (const file of files) {
            for (const task of window.tasks) {
                if (task.assigned_files && task.assigned_files.includes(file)) {
                    conflicts.push({
                        file: file,
                        owner: task.assigned_to,
                        task: task.path
                    });
                }
            }
        }

        return {
            ok: conflicts.length === 0,
            conflicts: conflicts
        };
    }

    /**
     * Assign files to subagent working on task
     * @param {string} taskFile - Path to task file
     * @param {string} subagentId - Unique subagent identifier
     * @param {string[]} files - Array of file paths to assign
     */
    static assignFilesToSubagent(taskFile, subagentId, files) {
        editState(s => {
            const window = s.execution_windows?.getActiveWindow();
            if (!window) return;

            const task = window.tasks.find(t => t.path === taskFile);
            if (!task) return;

            // RE-CHECK FOR COLLISION INSIDE LOCK (fix TOCTOU race)
            for (const file of files) {
                for (const otherTask of window.tasks) {
                    if (otherTask !== task &&
                        otherTask.assigned_files &&
                        otherTask.assigned_files.includes(file)) {
                        // Collision detected inside lock - mark it
                        task.markConflict(otherTask.assigned_to, [file]);
                        throw new Error(`File ${file} already assigned to ${otherTask.assigned_to}`);
                    }
                }
            }

            task.setAssignment(subagentId, files);
        });
    }

    /**
     * Release file assignments when task completes
     * @param {string} taskFile - Path to completed task
     */
    static releaseFilesFromSubagent(taskFile) {
        editState(s => {
            const window = s.execution_windows?.getActiveWindow();
            if (!window) return;

            const task = window.tasks.find(t => t.path === taskFile);
            if (!task) return;

            task.clearAssignment();
            task.clearConflict();  // Clear stale conflict metadata
        });
    }
}

// ==== FUNCTIONS ===== //

// ==== HELPERS ===== //
/**
 * Walk up directory tree to find .git directory.
 * @param {string} dirPath - Directory to start search from (NOT a file path)
 * @returns {string|null} Path to git repo root, or null if not found
 */
function findGitRepo(dirPath) {
    let current = path.resolve(dirPath);

    while (true) {
        if (fs.existsSync(path.join(current, '.git'))) {
            return current;
        }
        if (current === PROJECT_ROOT || current === path.dirname(current)) {
            break;
        }
        current = path.dirname(current);
    }
    return null;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function sleepSync(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        // Busy wait for sync sleep
    }
}

// ==== STATE PROTECTION ===== //
function atomicWrite(filePath, obj) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    const tempFile = `${filePath}.tmp.${process.pid}`;
    try {
        fs.writeFileSync(tempFile, JSON.stringify(obj, null, 2), 'utf-8');
        // Force flush to disk
        const fd = fs.openSync(tempFile, 'r+');
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        // Atomic rename
        fs.renameSync(tempFile, filePath);
    } catch (e) {
        // Clean up temp file on error
        try {
            fs.unlinkSync(tempFile);
        } catch {}
        throw e;
    }
}

function acquireLock(timeout = 1.0, pollMs = 50, staleTimeout = 30.0, lockDir = LOCK_DIR) {
    const lockInfoFile = path.join(lockDir, 'lock_info.json');
    const start = Date.now() / 1000;

    while (true) {
        // Check for stale lock first
        if (fs.existsSync(lockDir)) {
            try {
                // Try to read lock info
                if (fs.existsSync(lockInfoFile)) {
                    const lockInfo = JSON.parse(fs.readFileSync(lockInfoFile, 'utf8'));
                    const lockPid = lockInfo.pid;
                    const lockTime = lockInfo.timestamp || 0;

                    // CRITICAL FIX: Detect re-entry (nested lock from same process)
                    if (lockPid === process.pid) {
                        throw new Error(
                            `Lock re-entry detected: Process ${process.pid} already owns lock at ${lockDir}. ` +
                            'Nested acquireLock() calls are not supported and can cause data corruption.'
                        );
                    }

                    // Check if lock is stale (older than staleTimeout)
                    const now = Date.now() / 1000;
                    if (now - lockTime > staleTimeout) {
                        console.error(`Removing stale lock (age: ${(now - lockTime).toFixed(1)}s)`);
                        try {
                            fs.rmSync(lockDir, { recursive: true, force: true });
                        } catch {}
                    }
                    // Check if owning process is dead (same machine only)
                    else if (lockPid && lockPid !== process.pid) {
                        try {
                            // Check if process exists (works on Unix)
                            process.kill(lockPid, 0);
                        } catch {
                            // Process doesn't exist, remove stale lock
                            console.error(`Removing lock from dead process ${lockPid}`);
                            try {
                                fs.rmSync(lockDir, { recursive: true, force: true });
                            } catch {}
                        }
                    }
                }
            } catch (err) {
                // Re-throw re-entry errors immediately
                if (err.message && err.message.includes('Lock re-entry detected')) {
                    throw err;
                }
                // Malformed lock info, try to remove after timeout
                if ((Date.now() / 1000) - start > timeout) {
                    console.error('Removing malformed lock');
                    try {
                        fs.rmSync(lockDir, { recursive: true, force: true });
                    } catch {}
                }
            }
        }

        // Try to acquire lock
        try {
            // Ensure parent directory exists before creating lock
            const parentDir = path.dirname(lockDir);
            if (!fs.existsSync(parentDir)) {
                fs.mkdirSync(parentDir, { recursive: true });
            }
            fs.mkdirSync(lockDir, { recursive: false }); // atomic lock acquire
            // Write lock info atomically
            const lockInfo = {
                pid: process.pid,
                timestamp: Date.now() / 1000,
                host: os.hostname()
            };
            fs.writeFileSync(lockInfoFile, JSON.stringify(lockInfo), 'utf-8');
            return true;
        } catch (err) {
            // Only retry on lock contention (EEXIST), bubble up other errors
            if (err.code !== 'EEXIST') {
                throw err;  // Permission denied, disk full, etc. - fail fast
            }
            if ((Date.now() / 1000) - start > timeout) {
                // Timeout expired - could not acquire lock
                throw new Error(
                    `Could not acquire lock ${lockDir} within ${timeout}s timeout. ` +
                    'Lock may be held by another process or stale.'
                );
            }
            sleepSync(pollMs);
        }
    }
}

function releaseLock(lockDir = LOCK_DIR) {
    try {
        fs.rmSync(lockDir, { recursive: true, force: true });
    } catch {
        // Ignore errors
    }
}

// ==== LEGACY MIGRATION ===== //
/**
 * Migrate legacy state from sessions/sessions-state.json to scoped location.
 *
 * This function is called on first state load. It checks for legacy state at
 * PROJECT_ROOT/sessions/sessions-state.json and migrates it to the scoped
 * location at sessions/state/<project_hash>/sessions-state.json.
 *
 * Migration behavior:
 * - Skip if legacy file doesn't exist
 * - Skip if new scoped state already exists
 * - Acquire legacy lock before moving
 * - Use atomic rename (not copy+delete)
 * - Remove legacy lock after migration
 * - Log migration to stderr
 */
function migrateLegacyStateIfNeeded() {
    const legacyStateFile = path.join(PROJECT_ROOT, 'sessions', 'sessions-state.json');
    const legacyLockDir = path.join(PROJECT_ROOT, 'sessions', 'sessions-state.lock');

    // Skip if no legacy state exists
    if (!fs.existsSync(legacyStateFile)) {
        return;
    }

    // Skip if new scoped state already exists (already migrated)
    if (fs.existsSync(STATE_FILE)) {
        return;
    }

    console.error(`Migrating state from ${legacyStateFile} to ${STATE_FILE}`);

    // Acquire legacy lock to prevent concurrent access during migration
    // CRITICAL: Use same lock acquisition logic as acquireLock() to handle
    // stale locks and retry properly - DO NOT just skip migration on EEXIST
    try {
        acquireLock(5.0, 50, 30.0, legacyLockDir);  // Use legacy lock path
    } catch (err) {
        // Could not acquire lock - either held by another process or stale
        // Re-throw to prevent creating blank scoped state
        console.error(`Cannot acquire legacy lock for migration: ${err.message}`);
        throw new Error(`Legacy state migration blocked: ${err.message}`);
    }

    try {
        // Double-check target doesn't exist (race condition check)
        if (fs.existsSync(STATE_FILE)) {
            console.error('State already migrated by another process');
            return;
        }

        // Ensure target directory exists
        fs.mkdirSync(STATE_DIR, { recursive: true });

        // Atomic rename from legacy to scoped location
        fs.renameSync(legacyStateFile, STATE_FILE);
        console.error('Migration complete');
    } catch (err) {
        if (err.code === 'EEXIST') {
            // Target was created between checks - migration already done
            console.error('State already migrated by another process');
        } else if (err.code === 'ENOENT') {
            // Source was removed between checks - migration already done
            console.error('Legacy state already migrated');
        } else {
            // Unexpected error - re-throw
            throw err;
        }
    } finally {
        // Release legacy lock
        releaseLock(legacyLockDir);
    }
}

// ==== GEIPI ===== //
function loadState() {
    // Check for legacy state migration on first load
    migrateLegacyStateIfNeeded();

    if (!fs.existsSync(STATE_FILE)) {
        const initial = new SessionsState();
        atomicWrite(STATE_FILE, initial.toDict());
        return initial;
    }

    try {
        const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        return SessionsState.fromDict(data);
    } catch (e) {
        // Corrupt file: back it up once and start fresh
        const backup = STATE_FILE.replace('.json', '.bad.json');
        try {
            fs.renameSync(STATE_FILE, backup);
        } catch {}
        const fresh = new SessionsState();
        atomicWrite(STATE_FILE, fresh.toDict());
        return fresh;
    }
}

function loadConfig() {
    if (!fs.existsSync(CONFIG_FILE)) {
        const initial = new SessionsConfig();
        atomicWrite(CONFIG_FILE, initial.toDict());
        return initial;
    }

    try {
        const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));

        // Check if migration is needed from use_nerd_fonts to icon_style
        let needsMigration = false;
        if (data.features && 'use_nerd_fonts' in data.features && !('icon_style' in data.features)) {
            needsMigration = true;
        }

        // Check if migration is needed from implementation_mode to orchestration_mode
        if (data.trigger_phrases && 'implementation_mode' in data.trigger_phrases) {
            needsMigration = true;
            // Remove old key from data before creating config
            if (!data.trigger_phrases.orchestration_mode) {
                data.trigger_phrases.orchestration_mode = data.trigger_phrases.implementation_mode;
            }
            delete data.trigger_phrases.implementation_mode;
        }

        const config = SessionsConfig.fromDict(data);

        // If migration happened, write back the config to remove old field
        if (needsMigration) {
            atomicWrite(CONFIG_FILE, config.toDict());
        }

        return config;
    } catch (e) {
        // Corrupt file: back it up once and start fresh
        const backup = CONFIG_FILE.replace('.json', '.bad.json');
        try {
            fs.renameSync(CONFIG_FILE, backup);
        } catch {}
        const fresh = new SessionsConfig();
        atomicWrite(CONFIG_FILE, fresh.toDict());
        return fresh;
    }
}

function editState(callback) {
    // Acquire lock, reload (so we operate on latest), yield, then save atomically
    let acquired = false;
    try {
        acquired = acquireLock();
        if (!acquired) {
            throw new Error('Failed to acquire lock for state edit');
        }

        const state = loadState();
        callback(state);
        atomicWrite(STATE_FILE, state.toDict());
    } catch (e) {
        console.error(`Error in editState: ${e}`);
        throw e;
    } finally {
        if (acquired) {
            releaseLock();
        }
    }
}

function editConfig(callback) {
    // Acquire lock, reload (so we operate on latest), yield, then save atomically
    let acquired = false;
    try {
        acquired = acquireLock();
        if (!acquired) {
            throw new Error('Failed to acquire lock for config edit');
        }

        const config = loadConfig();
        callback(config);
        atomicWrite(CONFIG_FILE, config.toDict());
    } catch (e) {
        console.error(`Error in editConfig: ${e}`);
        throw e;
    } finally {
        if (acquired) {
            releaseLock();
        }
    }
}

// Legacy compatibility - saveState and saveConfig (not used, but kept for compatibility)
function saveState(state) {
    atomicWrite(STATE_FILE, state.toDict());
}

function saveConfig(config) {
    atomicWrite(CONFIG_FILE, config.toDict());
}

function _normalizeTaskPath(taskPath) {
    /**
     * Normalize task path to relative string from sessions/tasks/.
     * Strips absolute path prefix if present.
     */
    let pathStr = String(taskPath);
    const tasksRoot = path.join(PROJECT_ROOT, 'sessions', 'tasks');

    // If path is absolute, make it relative to tasks root
    if (pathStr.startsWith(tasksRoot)) {
        try {
            pathStr = path.relative(tasksRoot, pathStr);
        } catch (e) {
            // Keep original if error
        }
    }
    // Also handle paths starting with 'sessions/tasks/'
    if (pathStr.startsWith('sessions/tasks/')) {
        pathStr = pathStr.slice('sessions/tasks/'.length);
    }
    // Normalize path separators to forward slashes for consistency
    return pathStr.replace(/\\/g, '/');
}

function isDirectoryTask(taskPath) {
    /**
     * Check if a task is part of a directory task (contains a /).
     *
     * @param {string} taskPath - Relative path from sessions/tasks/
     *
     * @example
     * 'h-task/01-subtask.md' → true (subtask)
     * 'h-task/README.md' → true (parent)
     * 'h-task' → true (directory reference)
     * 'simple-task.md' → false (regular file task)
     */
    const pathStr = _normalizeTaskPath(taskPath);
    // If the string contains a slash, it's a directory task or subtask
    if (pathStr.includes('/')) {
        return true;
    }
    // Otherwise check if it's a directory with README.md
    const tasksRoot = path.join(PROJECT_ROOT, 'sessions', 'tasks');
    const taskDir = path.join(tasksRoot, pathStr);
    try {
        const stat = fs.statSync(taskDir);
        if (stat.isDirectory()) {
            const readmePath = path.join(taskDir, 'README.md');
            return fs.existsSync(readmePath);
        }
    } catch (e) {
        return false;
    }
    return false;
}

function isSubtask(taskPath) {
    /**
     * Check if a task path points to a subtask file (not the parent README.md).
     *
     * @param {string} taskPath - Relative path from sessions/tasks/
     *
     * @example
     * 'h-task/01-subtask.md' → true
     * 'h-task/README.md' → false
     * 'h-task' → false
     * 'h-task/' → false
     * 'simple-task.md' → false
     */
    const pathStr = _normalizeTaskPath(taskPath);
    if (!pathStr.includes('/')) {
        return false;
    }
    // It's a subtask if it has a slash but isn't the README.md
    return !pathStr.endsWith('README.md') && !pathStr.endsWith('/');
}

function isParentTask(taskPath) {
    /**
     * Check if a task path points to a directory task's parent README.md.
     *
     * @param {string} taskPath - Relative path from sessions/tasks/
     *
     * @returns {boolean} True if it's a directory task but NOT a subtask
     */
    return isDirectoryTask(taskPath) && !isSubtask(taskPath);
}

function getTaskFilePath(taskPath) {
    /**
     * Get the actual .md file path for a task (handles both directory and file tasks).
     */
    if (isDirectoryTask(taskPath)) {
        return path.join(taskPath, 'README.md');
    }
    return taskPath;
}

function listOpenTasks() {
    // No active task - list available tasks
    const tasksDir = path.join(PROJECT_ROOT, 'sessions', 'tasks');
    const taskFiles = [];

    if (fs.existsSync(tasksDir)) {
        // Get all .md files in the tasks directory (excluding TEMPLATE.md)
        const entries = fs.readdirSync(tasksDir);
        for (const entry of entries) {
            const fullPath = path.join(tasksDir, entry);
            const stat = fs.statSync(fullPath);

            if (stat.isFile() && entry.endsWith('.md') && entry !== 'TEMPLATE.md') {
                taskFiles.push(fullPath);
            }
        }

        // Get task directories with README.md files
        for (const entry of entries) {
            const fullPath = path.join(tasksDir, entry);
            const stat = fs.statSync(fullPath);

            if (stat.isDirectory() && entry !== 'done') {
                const readmePath = path.join(fullPath, 'README.md');
                if (fs.existsSync(readmePath)) {
                    taskFiles.push(fullPath);
                }

                // Get subtask files
                const subEntries = fs.readdirSync(fullPath);
                for (const subEntry of subEntries) {
                    if (subEntry.endsWith('.md') &&
                        subEntry !== 'TEMPLATE.md' &&
                        subEntry !== 'README.md') {
                        taskFiles.push(path.join(fullPath, subEntry));
                    }
                }
            }
        }
    }

    let taskStartupHelp = "";
    const config = loadConfig();

    if (taskFiles.length > 0) {
        taskStartupHelp += "No active task set. Available tasks:\n";
        for (const taskFile of taskFiles.sort()) {
            const filePath = getTaskFilePath(taskFile);

            if (!fs.existsSync(filePath)) continue;

            // Read first few lines to get task info
            const content = fs.readFileSync(filePath, 'utf8');
            const lines = content.split('\n').slice(0, 10);

            const taskName = isDirectoryTask(taskFile)
                ? `${path.basename(taskFile)}/`
                : path.basename(taskFile);

            let status = null;
            for (const line of lines) {
                if (line.startsWith('status:')) {
                    status = line.split(':')[1].trim();
                    break;
                }
            }

            if (!status) continue;
            taskStartupHelp += `  • ${taskName} (${status})\n`;
        }

        taskStartupHelp += `\nTo select a task:\n`;
        taskStartupHelp += `- Type in one of your startup commands: ${JSON.stringify(config.trigger_phrases.task_startup)}\n`;
        taskStartupHelp += `- Include the task file you would like to start using '@'\n`;
        taskStartupHelp += `- Hit Enter to activate task startup\n`;
    } else {
        taskStartupHelp += "No tasks found.\n\n";
        taskStartupHelp += `To create your first task:\n`;
        taskStartupHelp += `- Type one of your task creation commands: ${JSON.stringify(config.trigger_phrases.task_creation)}\n`;
        taskStartupHelp += `- Write a brief explanation of the task you need to complete\n`;
        taskStartupHelp += `- Answer any questions Claude has for you\n`;
    }

    return taskStartupHelp + "\n";
}

// Export everything
module.exports = {
    // Constants
    PROJECT_ROOT,
    STATE_DIR,
    STATE_FILE,
    LOCK_DIR,
    CONFIG_FILE,
    DISCUSSION_MODE_MSG,
    ORCHESTRATION_MODE_MSG,
    PROJECT_ID,

    // Enums
    TriggerCategory,
    GitAddPattern,
    GitCommitStyle,
    UserOS,
    UserShell,
    IconStyle,
    CCTools,
    SessionsProtocol,
    Mode,
    TodoStatus,
    Model,

    // Classes
    TriggerPhrases,
    GitPreferences,
    SessionsEnv,
    BlockingPatterns,
    ContextWarnings,
    EnabledFeatures,
    SessionsConfig,
    TaskState,
    CCTodo,
    SessionsFlags,
    SessionsTodos,
    APIPerms,
    SessionsState,
    ExecutionWindowTask,
    ExecutionWindowsState,
    ExecutionWindowManager,

    // Functions
    findGitRepo,
    atomicWrite,
    acquireLock,
    releaseLock,
    loadState,
    saveState,
    editState,
    loadConfig,
    saveConfig,
    editConfig,
    listOpenTasks,
    isDirectoryTask,
    getTaskFilePath,
    isSubtask,
    isParentTask,
    hashPath,
    getProjectIdentifier
};
