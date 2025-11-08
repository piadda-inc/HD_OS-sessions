#!/usr/bin/env node

// ===== IMPORTS ===== //

/// ===== STDLIB ===== ///
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
///-///

/// ===== 3RD-PARTY ===== ///
///-///

/// ===== LOCAL ===== ///
const {
    loadState,
    editState,
    Mode,
    PROJECT_ROOT,
    SessionsProtocol,
    listOpenTasks,
    TaskState,
    StateError
} = require('./shared_state.js');
///-///

//-//

// ===== GLOBALS ===== //

/// ===== CI DETECTION ===== ///
function isCIEnvironment() {
    // Check if running in a CI environment (GitHub Actions)
    const ciIndicators = [
        'GITHUB_ACTIONS',         // GitHub Actions
        'GITHUB_WORKFLOW',        // GitHub Actions workflow
        'CI',                     // Generic CI indicator (set by GitHub Actions)
        'CONTINUOUS_INTEGRATION', // Generic CI (alternative)
    ];
    return ciIndicators.some(indicator => process.env[indicator]);
}

// Skip post tool use hook in CI environments
if (isCIEnvironment()) {
    process.exit(0);
}
///-///

// Read stdin synchronously
let inputData = {};
try {
    const stdin = fs.readFileSync(0, 'utf-8');
    inputData = JSON.parse(stdin);
} catch (e) {
    // If no stdin or invalid JSON, use empty
    inputData = {};
}

const toolName = inputData.tool_name || "";
const toolInput = inputData.tool_input || {};
const cwd = inputData.cwd || "";
let mod = false;

let stateCache = null;
function getState() {
    if (!stateCache) {
        stateCache = loadState();
    }
    return stateCache;
}
//-//

/*
╔════════════════════════════════════════════════════════════════════════════════════════╗
║ ██████╗  █████╗ ██████╗██████╗  ██████╗ █████╗  █████╗ ██╗       ██╗ ██╗██████╗██████╗ ║
║ ██╔══██╗██╔══██╗██╔═══╝╚═██╔═╝  ╚═██╔═╝██╔══██╗██╔══██╗██║       ██║ ██║██╔═══╝██╔═══╝ ║
║ ██████╔╝██║  ██║██████╗  ██║      ██║  ██║  ██║██║  ██║██║       ██║ ██║██████╗█████╗  ║
║ ██╔═══╝ ██║  ██║╚═══██║  ██║      ██║  ██║  ██║██║  ██║██║       ██║ ██║╚═══██║██╔══╝  ║
║ ██║     ╚█████╔╝██████║  ██║      ██║  ╚█████╔╝╚█████╔╝███████╗  ╚████╔╝██████║██████╗ ║
║ ╚═╝      ╚════╝ ╚═════╝  ╚═╝      ╚═╝   ╚════╝  ╚════╝ ╚══════╝   ╚═══╝ ╚═════╝╚═════╝ ║
╚════════════════════════════════════════════════════════════════════════════════════════╝
Handles post-tool execution cleanup and state management:
- Cleans up subagent context flags and transcript directories after Task tool completion
- Auto-returns to discussion mode when all todos are marked complete
- Enforces todo-based execution boundaries in implementation mode
- Provides directory navigation feedback after cd commands
*/

// ===== EXECUTION ===== //

//!> Claude compass (directory position reminder)
if (toolName === "Bash") {
    const command = toolInput.command || "";
    if (command.includes("cd ")) {
        console.error(`[You are in: ${cwd}]`);
        mod = true;
    }
}
//!<

//!> Subagent cleanup
if (toolName === "Task" && getState().flags.subagent) {
    // Release files before cleanup
    const {ExecutionWindowManager} = require('./shared_state.js');
    const state = getState();
    const window = state.execution_windows?.getActiveWindow();

    if (window && window.tasks && window.tasks.length > 0) {
        // Find task that was in progress
        const inProgressTask = window.tasks.find(t => t.status === "In Progress");
        const taskFile = inProgressTask?.path || window.tasks[0]?.path;

        if (taskFile) {
            try {
                ExecutionWindowManager.releaseFilesFromSubagent(taskFile);
                console.error(`[File Release] Released files from task ${taskFile}`);
            } catch (error) {
                // Silently continue if release fails
            }
        }
    }

    editState(s => {
        s.flags.subagent = false;
    });
    stateCache = null;
    // Clean up agent transcript directory
    const subagentType = toolInput.subagent_type || "shared";
    const agentDir = path.join(PROJECT_ROOT, 'sessions', 'transcripts', subagentType);
    if (fs.existsSync(agentDir)) {
        try {
            fs.rmSync(agentDir, { recursive: true, force: true });
        } catch (error) {
            // Ignore errors
        }
    }
    process.exit(0);
}
//!<

//!> Todo completion
if (toolName === "TodoWrite") {
    const state = getState();
    if (state.mode === Mode.GO && state.todos.allComplete()) {
        // Check if all complete (names already verified to match if active_todos existed)
        console.error("[DAIC: Todos Complete] All todos completed.\n\n");

        if (state.active_protocol === SessionsProtocol.COMPLETE) {
            editState(s => {
                s.mode = Mode.NO;
                s.active_protocol = null;
                s.current_task.clearTask();
                s.todos.active = [];
            });
            stateCache = null;
            console.error(listOpenTasks());
            process.exit(0);
        }

        if (state.active_protocol !== null) {
            editState(s => {
                s.active_protocol = null;
            });
            stateCache = null;
        }

        if (state.todos.stashed && state.todos.stashed.length > 0) {
            let numRestored = 0;
            let restored = [];
            editState(s => {
                numRestored = s.todos.restoreStashed();
                restored = s.todos.active.map(t => t.content);
                // Enable the todos clear command for this context
                s.api.todos_clear = true;
            });
            stateCache = null;
            mod = true;
            if (numRestored > 0) {
                // Detect OS for correct sessions command
                const isWindows = process.platform === "win32";
                const sessionsCmd = isWindows ? "sessions/bin/sessions.bat" : "sessions/bin/sessions";

                console.error(`Your previous ${numRestored} todos have been restored:\n\n${JSON.stringify(restored, null, 2)}\n\nIf these todos are no longer relevant, you should clear them using: ${sessionsCmd} todos clear\nNote: You can only use this command immediately - it will be disabled after any other tool use.\n\n`);
            }
        } else {
            editState(s => {
                s.todos.active = [];
                s.mode = Mode.NO;
            });
            stateCache = null;
            console.error("You have returned to discussion mode. You may now discuss next steps with the user.\n\n");
            mod = true;
        }
    }
}
//!<

//!> Implementation mode + no Todos enforcement
{
    const state = getState();
    if (state.mode === Mode.GO &&
        !state.flags.subagent &&
        (!state.todos.active || state.todos.active.length === 0) &&
        state.current_task.name) {
        // In implementation mode but no todos - show reminder only during task-based work
        console.error("[Reminder] You're in implementation mode without approved todos. " +
            "If you proposed todos that were approved, add them. " +
            "If the user asked you to do something without todo proposal/approval that is **reasonably complex or multi-step**, translate *only the remaining work* to todos and add them (all 'pending'). ");
        mod = true;
    }
}
//!<

//!> Task file auto-update detection
if (["Edit", "Write", "MultiEdit"].includes(toolName)) {
    const state = getState();
    if (state.current_task.name && state.current_task.file) {
        // Extract file path from tool input
        const filePathStr = toolInput.file_path;
        if (filePathStr) {
            const filePath = path.resolve(filePathStr);
            const taskPath = path.resolve(path.join(PROJECT_ROOT, 'sessions', 'tasks', state.current_task.file));

            // Check if the edited file is the current task file
            if (filePath === taskPath) {
                try {
                    // Task file was edited - re-parse frontmatter to detect changes
                    const updatedTask = TaskState.loadTask({ path: taskPath });

                    // Update session state with any changes from the re-parsed frontmatter
                    if (updatedTask) {
                        editState(s => {
                            // Update relevant fields from the re-parsed task
                            if (updatedTask.status !== state.current_task.status) {
                                s.current_task.status = updatedTask.status;
                            }
                            if (updatedTask.updated !== state.current_task.updated) {
                                s.current_task.updated = updatedTask.updated;
                            }
                            if (updatedTask.branch !== state.current_task.branch) {
                                s.current_task.branch = updatedTask.branch;
                            }
                            if (updatedTask.submodules !== state.current_task.submodules) {
                                s.current_task.submodules = updatedTask.submodules;
                            }
                            // Update other relevant fields as needed
                            if (updatedTask.started !== state.current_task.started) {
                                s.current_task.started = updatedTask.started;
                            }
                            if (updatedTask.dependencies !== state.current_task.dependencies) {
                                s.current_task.dependencies = updatedTask.dependencies;
                            }
                        });
                        stateCache = null;
                    }
                } catch (error) {
                    // File might be temporarily invalid during editing
                    // or frontmatter might be malformed - silently skip
                }
            }
        }
    }
}
}
//!<

//!> Disable windowed API permissions after any tool use (except the windowed command itself)
{
    const state = getState();
    if (state.api.todos_clear && toolName === "Bash") {
    // Check if this is the todos clear command
    const command = toolInput.command || '';
    // Check for either Unix or Windows version of the command
    if (!command.includes('sessions/bin/sessions todos clear') && !command.includes('sessions/bin/sessions.bat todos clear')) {
        // Not the todos clear command, disable the permission
        editState(s => {
            s.api.todos_clear = false;
        });
        stateCache = null;
    }
} else if (state.api.todos_clear) {
    // Any other tool was used, disable the permission
    editState(s => {
        s.api.todos_clear = false;
    });
    stateCache = null;
}
}
//!<

//-//

if (mod) {
    process.exit(2);  // Exit code 2 feeds stderr back to Claude
}
process.exit(0);
