# Implementation Plan: Fix Execute Button & Move Console to First Panel

**Status:** Ready for Implementation
**Priority:** High
**Estimated Time:** 45-60 minutes
**Context:** Frontend console logging + workflow execution debugging

---

## Problem Statement

1. **Execute button is disabled** - Button appears greyed out, won't respond to clicks
2. **Console panel is hidden** - It's the 3rd tab (Tasks → Properties → Console), not visible by default
3. **No real-time feedback** - User can't see execution progress, API errors, or workflow status
4. **Silent failures** - Clicking Execute does nothing, no error messages

## Why This Matters

- User experience: Can't debug workflow issues without DevTools
- Testing: Can't see if workflow actually executed or why it failed
- DX: Real-time console would show API requests, responses, errors instantly

---

## Architecture Overview

```
frontend (core-ui)
├── components/
│   ├── panels/bottom-panel.tsx
│   │   └── Tabs: [Console, Tasks, Properties]  ← Move Console first
│   │
│   ├── workflow/
│   │   ├── execute-button.tsx
│   │   │   └── Disabled state logic
│   │   └── react-flow-canvas.tsx
│   │       └── Workflow state management
│   │
│   └── workflow-visualization/
│       └── console.tsx
│           └── Display real-time logs
│
├── lib/
│   ├── api/
│   │   ├── client.ts (existing)
│   │   └── hooks.ts ← CREATE useExecuteWorkflow
│   │
│   └── store/
│       ├── workflow.ts (existing - workflow state)
│       └── console.ts (might need to create for log state)
│
└── app/page.tsx

backend (api)
└── POST /api/workflows/{workflow_id}/execute
    ├── Request: { input_context?, dry_run? }
    └── Response: { execution_id, workflow_id, status, logs, output }
```

---

## Implementation Steps

### **PHASE 1: Move Console to First Panel** (5-10 minutes)

**File:** `core-ui/components/panels/bottom-panel.tsx`

**What to do:**
1. Find the `<Tabs>` component in the file
2. Look at the order of `<TabsContent>` children:
   - Current: `<TabsContent value="tasks">` → `<TabsContent value="properties">` → `<TabsContent value="console">`
   - Target: `<TabsContent value="console">` → `<TabsContent value="tasks">` → `<TabsContent value="properties">`
3. Find the `<Tabs>` opening tag and set `defaultValue="console"`

**Code Example (what to change):**
```typescript
// BEFORE
<Tabs defaultValue="tasks" className="...">
  <TabsList>
    <TabsTrigger value="tasks">Tasks</TabsTrigger>
    <TabsTrigger value="properties">Properties</TabsTrigger>
    <TabsTrigger value="console">Console</TabsTrigger>
  </TabsList>

  <TabsContent value="tasks">...</TabsContent>
  <TabsContent value="properties">...</TabsContent>
  <TabsContent value="console">...</TabsContent>
</Tabs>

// AFTER
<Tabs defaultValue="console" className="...">
  <TabsList>
    <TabsTrigger value="console">Console</TabsTrigger>
    <TabsTrigger value="tasks">Tasks</TabsTrigger>
    <TabsTrigger value="properties">Properties</TabsTrigger>
  </TabsList>

  <TabsContent value="console">...</TabsContent>
  <TabsContent value="tasks">...</TabsContent>
  <TabsContent value="properties">...</TabsContent>
</Tabs>
```

**Verification:**
- [ ] Console tab appears first in UI
- [ ] Console tab is selected/active on page load
- [ ] Click other tabs and back to Console works

---

### **PHASE 2: Debug Execute Button Disabled State** (10-15 minutes)

**File:** `core-ui/components/workflow/execute-button.tsx`

**What to investigate:**
1. Find the `<button>` element
2. Look for the `disabled` attribute or prop
3. Find what makes it disabled (usually a condition like `!workflow` or `workflow.nodes.length === 0`)

**Common Patterns:**
```typescript
// Pattern 1: Based on store state
const { workflow } = useStore();
const isDisabled = !workflow || !workflow.nodes || workflow.nodes.length === 0;
<button disabled={isDisabled}>Execute</button>

// Pattern 2: Hardcoded
<button disabled={true}>Execute</button>

// Pattern 3: Based on loading state
<button disabled={isLoading || !workflow}>Execute</button>
```

**Root Cause Analysis:**
The button is disabled because:
1. **Most likely:** No workflow is loaded in the store yet
2. **Solution:** User must click "Load Demo" button FIRST to load a workflow
3. **Then:** Execute button will become enabled

**What to look for:**
- [ ] Find `useStore()` or similar state hook
- [ ] Check if `workflow` has `nodes` array
- [ ] Check if nodes are populated after "Load Demo" button is clicked
- [ ] The disabled condition should be: `!workflow || workflow.nodes.length === 0`

**Expected Fix:**
The button is CORRECTLY disabled when no workflow is loaded. The issue is:
- User doesn't know to click "Load Demo" first
- We need console logs to show status
- After "Load Demo" is clicked, button should enable automatically

---

### **PHASE 3: Create useExecuteWorkflow Hook** (15-20 minutes)

**File:** `core-ui/lib/api/hooks.ts` (CREATE if doesn't exist, or ADD to existing)

**What to implement:**
A custom React hook that:
1. Takes a workflow ID
2. Makes POST request to `/api/workflows/{id}/execute`
3. Logs all steps to console (start, request, response, errors)
4. Returns execution state and logs

**Code to write:**

```typescript
// core-ui/lib/api/hooks.ts

import { useState, useCallback } from 'react';
import { useStore } from '@/lib/store/workflow'; // Adjust import based on your store

export interface ExecuteWorkflowRequest {
  input_context?: Record<string, unknown>;
  dry_run?: boolean;
}

export interface ExecuteWorkflowResponse {
  execution_id: string;
  workflow_id: string;
  status: string;
  started_at: string;
  completed_at?: string | null;
  logs: { entries: unknown[] };
  output?: unknown;
  error?: string;
}

export function useExecuteWorkflow() {
  const { workflow } = useStore();
  const [isLoading, setIsLoading] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [executionId, setExecutionId] = useState<string | null>(null);

  const addLog = useCallback((message: string, level: 'INFO' | 'ERROR' | 'SUCCESS' | 'WARN' = 'INFO') => {
    const timestamp = new Date().toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    const levelEmoji = {
      INFO: 'ℹ️',
      ERROR: '❌',
      SUCCESS: '✅',
      WARN: '⚠️',
    }[level];

    const logMessage = `[${timestamp}] ${levelEmoji} ${message}`;
    setLogs(prev => [...prev, logMessage]);
    console.log(logMessage); // Also log to browser console for debugging
  }, []);

  const execute = useCallback(
    async (dryRun = false): Promise<ExecuteWorkflowResponse | null> => {
      // Validation
      if (!workflow || !workflow.id) {
        addLog('No workflow loaded. Please load a workflow first.', 'ERROR');
        return null;
      }

      if (!workflow.nodes || workflow.nodes.length === 0) {
        addLog('Workflow has no nodes. Please load a valid workflow.', 'ERROR');
        return null;
      }

      setIsLoading(true);
      setLogs([]); // Clear previous logs

      try {
        addLog(`Starting ${dryRun ? 'DRY RUN' : 'EXECUTION'}...`, 'INFO');
        addLog(`Workflow: ${workflow.id}`, 'INFO');
        addLog(`Nodes: ${workflow.nodes.length}`, 'INFO');

        // Make API request
        const url = `/api/workflows/${workflow.id}/execute`;
        const requestBody: ExecuteWorkflowRequest = { dry_run: dryRun };

        addLog(`Sending request to ${url}`, 'INFO');

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        });

        // Log response status
        addLog(`Response status: ${response.status} ${response.statusText}`, 'INFO');

        if (!response.ok) {
          const errorData = await response.json();
          addLog(
            `API Error: ${errorData.detail || JSON.stringify(errorData)}`,
            'ERROR'
          );
          return null;
        }

        const result: ExecuteWorkflowResponse = await response.json();

        // Log execution details
        setExecutionId(result.execution_id);
        addLog(`Execution ID: ${result.execution_id}`, 'SUCCESS');
        addLog(`Status: ${result.status}`, 'INFO');
        addLog(`Started: ${result.started_at}`, 'INFO');

        if (result.completed_at) {
          addLog(`Completed: ${result.completed_at}`, 'SUCCESS');
        }

        // Log any backend logs
        if (result.logs?.entries && result.logs.entries.length > 0) {
          addLog(`Backend logs (${result.logs.entries.length} entries):`, 'INFO');
          // Could expand this to show individual log entries
        }

        if (result.error) {
          addLog(`Execution error: ${result.error}`, 'ERROR');
        }

        if (result.output) {
          addLog(`Execution output available`, 'SUCCESS');
        }

        return result;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        addLog(`Network/Client error: ${errorMessage}`, 'ERROR');
        return null;
      } finally {
        setIsLoading(false);
      }
    },
    [workflow, addLog]
  );

  const clearLogs = useCallback(() => {
    setLogs([]);
  }, []);

  return {
    execute,
    addLog,
    clearLogs,
    logs,
    isLoading,
    executionId,
    hasWorkflow: !!workflow && !!workflow.nodes && workflow.nodes.length > 0,
  };
}
```

**What this hook does:**
- ✅ Validates workflow exists and has nodes
- ✅ Sends POST request with proper error handling
- ✅ Logs every step with timestamps and emoji indicators
- ✅ Returns execution ID and status
- ✅ Provides `addLog` method for custom messages
- ✅ Tracks loading state for UI feedback

---

### **PHASE 4: Wire Console Component to Logs** (10-15 minutes)

**File:** `core-ui/components/workflow-visualization/console.tsx`

**What to do:**
1. Find or create the Console component (displays the console logs)
2. Make it accept logs from the hook
3. Display them with proper formatting (timestamps, colors, emojis)
4. Auto-scroll to latest log

**Code Example:**

```typescript
// core-ui/components/workflow-visualization/console.tsx

'use client';

import { useRef, useEffect } from 'react';

interface ConsoleProps {
  logs: string[];
  isLoading?: boolean;
}

export function Console({ logs, isLoading }: ConsoleProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  return (
    <div
      ref={scrollRef}
      className="flex flex-col h-full overflow-y-auto bg-gray-900 text-gray-100 font-mono text-sm p-4 space-y-1"
    >
      {logs.length === 0 ? (
        <div className="text-gray-500 italic">
          Logs will appear here when you execute a workflow...
        </div>
      ) : (
        logs.map((log, idx) => (
          <div key={idx} className="whitespace-pre-wrap break-words">
            {log}
          </div>
        ))
      )}

      {isLoading && (
        <div className="text-blue-400 animate-pulse">
          ⏳ Waiting for execution...
        </div>
      )}
    </div>
  );
}
```

---

### **PHASE 5: Update Execute Button to Use Hook** (5-10 minutes)

**File:** `core-ui/components/workflow/execute-button.tsx`

**What to change:**
1. Import `useExecuteWorkflow` hook
2. Call the hook to get `execute`, `isLoading`, `hasWorkflow`
3. Update button disabled state to use `hasWorkflow`
4. Add click handler that calls `execute()`
5. Add loading indicator while executing

**Code Example:**

```typescript
// core-ui/components/workflow/execute-button.tsx

'use client';

import { useExecuteWorkflow } from '@/lib/api/hooks';

export function ExecuteButton() {
  const { execute, isLoading, hasWorkflow } = useExecuteWorkflow();

  const handleClick = async () => {
    await execute(false); // false = not a dry run
  };

  return (
    <button
      onClick={handleClick}
      disabled={!hasWorkflow || isLoading}
      data-testid="execute-workflow-button"
      className="inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 h-9 px-4 py-2 gap-2"
    >
      <span>{isLoading ? '⏳' : '▶'}</span>
      <span>{isLoading ? 'Executing...' : 'Execute'}</span>
    </button>
  );
}
```

---

### **PHASE 6: Connect Console to Execute Button** (5 minutes)

**File:** `core-ui/app/page.tsx` (or wherever the layout is)

**What to do:**
1. Get logs from `useExecuteWorkflow` hook
2. Pass logs to Console component
3. Pass isLoading to Console component

**Code Pattern:**

```typescript
'use client';

import { useExecuteWorkflow } from '@/lib/api/hooks';
import { Console } from '@/components/workflow-visualization/console';
import { ExecuteButton } from '@/components/workflow/execute-button';

export default function Home() {
  const { logs, isLoading } = useExecuteWorkflow();

  return (
    <ReactFlowProvider>
      <WorkflowLayout
        topbar={
          <div className="flex items-center gap-4">
            {/* ... */}
            <ExecuteButton />
          </div>
        }
        // ... other props
        bottomPanel={<BottomPanel logs={logs} isLoading={isLoading} />}
      />
    </ReactFlowProvider>
  );
}
```

Then in BottomPanel:

```typescript
interface BottomPanelProps {
  logs?: string[];
  isLoading?: boolean;
}

export function BottomPanel({ logs = [], isLoading }: BottomPanelProps) {
  return (
    <Tabs defaultValue="console">
      {/* ... triggers ... */}
      <TabsContent value="console">
        <Console logs={logs} isLoading={isLoading} />
      </TabsContent>
      {/* ... other tabs ... */}
    </Tabs>
  );
}
```

---

## Testing Checklist

### **Before Starting:**
- [ ] Docker containers running: `docker compose ps`
- [ ] Frontend accessible: http://localhost:3000
- [ ] Backend accessible: http://localhost:8000/health

### **Phase 1 (Console Panel):**
- [ ] Console tab visible on page load
- [ ] Console tab is first in the list
- [ ] Can switch between Console/Tasks/Properties tabs
- [ ] Console tab remains selected after page reload (if using localStorage)

### **Phase 2 (Execute Button):**
- [ ] Execute button visible in topbar
- [ ] Execute button is DISABLED when page loads (no workflow)
- [ ] Click "Load Demo" button
- [ ] Execute button becomes ENABLED after loading demo

### **Phase 3-4 (Hook & Logging):**
- [ ] Click Execute button
- [ ] Logs appear in Console panel in real-time
- [ ] See messages like:
  - `[HH:MM:SS] ℹ️ Starting EXECUTION...`
  - `[HH:MM:SS] ℹ️ Workflow: auto-reorder-v1`
  - `[HH:MM:SS] ℹ️ Nodes: 5`
  - `[HH:MM:SS] ℹ️ Sending request to /api/workflows/auto-reorder-v1/execute`
  - `[HH:MM:SS] ℹ️ Response status: 202 Accepted`
  - `[HH:MM:SS] ✅ Execution ID: exec-abc123def456`
  - `[HH:MM:SS] ℹ️ Status: running`

### **Error Cases:**
- [ ] No workflow loaded → See error message in console
- [ ] Network error → See network error in console
- [ ] Backend error (500) → See detailed error message in console

### **Performance:**
- [ ] Console doesn't lag even with many logs
- [ ] Auto-scroll works smoothly
- [ ] UI responsive while executing

---

## API Contract (Backend Reference)

**Endpoint:** `POST /api/workflows/{workflow_id}/execute`

**Request:**
```json
{
  "input_context": {},
  "dry_run": false
}
```

**Success Response (202 Accepted):**
```json
{
  "execution_id": "exec-a1b2c3d4e5f6",
  "workflow_id": "auto-reorder-v1",
  "status": "running",
  "started_at": "2025-11-04T20:45:00Z",
  "completed_at": null,
  "logs": {
    "entries": [
      {
        "timestamp": "2025-11-04T20:45:00Z",
        "level": "INFO",
        "message": "Workflow execution started"
      }
    ]
  },
  "output": null
}
```

**Error Response (500):**
```json
{
  "detail": "Workflow executor not initialized. Check workflow engine configuration."
}
```

---

## Known Issues & Workarounds

1. **Execute button disabled after load:**
   - Load Demo button must be clicked FIRST
   - Once demo loads, Execute becomes enabled
   - Console will show status

2. **No logs appearing:**
   - Check browser DevTools Console (F12) for JS errors
   - Check backend logs: `docker compose logs backend --tail=20`
   - Verify API endpoint is correct

3. **Execution seems stuck:**
   - Backend might be processing
   - Workflow execution can take 10-30 seconds
   - Look for timeout messages in console

---

## File Summary

| File | Action | Complexity |
|------|--------|-----------|
| `bottom-panel.tsx` | Move Console to first tab | Very Easy |
| `execute-button.tsx` | Wire up hook | Easy |
| `console.tsx` | Display logs with formatting | Easy |
| `hooks.ts` | Create useExecuteWorkflow | Medium |
| `page.tsx` | Connect hook to layout | Easy |

---

## Success Criteria

✅ **All must pass:**
1. Console panel visible and active on page load
2. Execute button disabled until workflow loaded
3. Execute button enabled after "Load Demo"
4. Clicking Execute sends API request
5. Real-time logs appear in Console panel
6. Successful execution shows completion message
7. Failed execution shows error message
8. All emojis and timestamps displayed correctly

---

## Next Steps After Implementation

1. Test with different workflow types
2. Add dry-run mode testing
3. Handle edge cases (missing fields, invalid workflows)
4. Consider adding execution history panel
5. Add ability to export console logs
6. Monitor backend resource usage during execution

---

**Good luck! Ask for clarification if anything is unclear.** 🚀
