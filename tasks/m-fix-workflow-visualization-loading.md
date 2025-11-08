---
name: m-fix-workflow-visualization-loading
branch: fix/workflow-visualization-loading
status: pending
created: 2025-11-04
submodules:
  - core-ui
---

# Fix Workflow Visualization Loading in core-ui

## Problem/Goal
Workflow visualization is not loading correctly in the core-ui application. Users cannot see the visual representation of workflows, which is critical for the workflow builder UX. Need to investigate and fix the root cause of the loading failure.

## Success Criteria
- [ ] Identify root cause of visualization loading failure
- [ ] Visualization loads and displays correctly
- [ ] No console errors related to workflow rendering
- [ ] Tested in development environment

## Context Manifest

### Current Architecture

**Visualization Components:**
- `core-ui/components/workflow/react-flow-canvas.tsx` - Main React Flow visualization component using `@xyflow/react@12.9.2`
- `core-ui/components/workflow/nodes/base-node.tsx` - Custom node implementations
- `core-ui/components/layout/workflow-layout.tsx` - Layout wrapper for workflow UI

**State Management:**
- `core-ui/lib/stores/workflow-store.ts` - Zustand store managing nodes, edges, tasks, selection state
- Store supports local state and store-backed modes
- Initial state starts with empty nodes/edges arrays

**Integration Points:**
- `core-ui/app/page.tsx` - Main page wrapping visualization in ReactFlowProvider
- `core-ui/components/chat/chat-interface.tsx` - Chat interface (receives NLtoIR JSON responses)

### Root Cause Analysis

**The Problem:**
When user clicks "send" in chat, NLtoIR API returns workflow JSON with nodes array. This JSON is NOT currently being loaded into ReactFlow visualization. The ReactFlowCanvas component renders but displays empty canvas because:

1. `app/page.tsx` initializes canvas with `useStore={true}` but no `initialNodes`
2. Store starts with empty nodes array
3. Chat response JSON is not being converted to ReactFlow format
4. Workflow data is not being loaded into Zustand store

**Missing Integration:**
- No workflow converter (NLtoIR IR → ReactFlow node format)
- ChatInterface doesn't handle workflow JSON responses
- No automatic node layout/positioning
- Layout uses right sidebar panels; user wants bottom panels

### Required Changes

1. **Workflow Converter**: Map IR node types to ReactFlow nodes
   - IR node types: `Action.run`, `Decision.condition`, `End`, etc.
   - ReactFlow node types: `input`, `output`, `process`, `function`
   - Auto-position nodes in top-to-bottom flow layout

2. **Chat Integration**: ChatInterface must load workflow JSON
   - Parse response JSON
   - Convert to ReactFlow format
   - Load into Zustand store via `setNodes`/`setEdges`

3. **Layout Refactoring**: Bottom panels instead of right sidebar
   - Move Tasks, Properties, Console panels to bottom
   - Adjust WorkflowLayout to support bottom panel slot
   - Resize canvas to accommodate bottom panels

4. **UI Updates**: Tasks, Properties, Console tabs in bottom panel
   - Create BottomPanel component
   - Implement tab switching

### Key Files to Modify
- `core-ui/app/page.tsx` - Layout structure
- `core-ui/components/chat/chat-interface.tsx` - Handle workflow responses
- `core-ui/components/layout/workflow-layout.tsx` - Add bottom panel support
- `core-ui/lib/utils/` - Add workflow converter utility
- Create new: `core-ui/components/panels/bottom-panel.tsx`

## User Notes
<!-- Any specific notes or requirements from the developer -->

## Work Log
<!-- Updated as work progresses -->
- [YYYY-MM-DD] Started task, initial research
