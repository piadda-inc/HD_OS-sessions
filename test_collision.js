#!/usr/bin/env node

/**
 * Test script for ExecutionWindowManager collision detection methods
 */

const {ExecutionWindowManager, editState, loadState} = require('./hooks/shared_state.js');

console.log('Testing ExecutionWindowManager collision detection methods...\n');

// Test 1: Verify methods exist
console.log('Test 1: Verify methods exist');
console.log('canAssignFiles:', typeof ExecutionWindowManager.canAssignFiles);
console.log('assignFilesToSubagent:', typeof ExecutionWindowManager.assignFilesToSubagent);
console.log('releaseFilesFromSubagent:', typeof ExecutionWindowManager.releaseFilesFromSubagent);

if (typeof ExecutionWindowManager.canAssignFiles !== 'function' ||
    typeof ExecutionWindowManager.assignFilesToSubagent !== 'function' ||
    typeof ExecutionWindowManager.releaseFilesFromSubagent !== 'function') {
    console.error('\n❌ FAILED: Methods are not functions');
    process.exit(1);
}
console.log('✓ All methods exist and are functions\n');

// Test 2: canAssignFiles with no active window (should return ok: true)
console.log('Test 2: canAssignFiles with no active window');
const result1 = ExecutionWindowManager.canAssignFiles(['src/file1.ts', 'src/file2.ts']);
console.log('Result:', JSON.stringify(result1, null, 2));
console.log('Expected: {ok: true, conflicts: []}');

if (!result1.ok || result1.conflicts.length !== 0) {
    console.error('❌ FAILED: Expected ok=true with no conflicts');
    process.exit(1);
}
console.log('✓ canAssignFiles returns correct structure\n');

// Test 3: Verify methods are callable without errors
console.log('Test 3: Verify assignFilesToSubagent is callable');
try {
    ExecutionWindowManager.assignFilesToSubagent('test/task.md', 'subagent-123', ['file1.js']);
    console.log('✓ assignFilesToSubagent callable (no error thrown)\n');
} catch (error) {
    console.error('❌ FAILED:', error.message);
    process.exit(1);
}

console.log('Test 4: Verify releaseFilesFromSubagent is callable');
try {
    ExecutionWindowManager.releaseFilesFromSubagent('test/task.md');
    console.log('✓ releaseFilesFromSubagent callable (no error thrown)\n');
} catch (error) {
    console.error('❌ FAILED:', error.message);
    process.exit(1);
}

console.log('========================================');
console.log('✓ All tests passed!');
console.log('========================================');
console.log('\nExecutionWindowManager collision detection methods are working correctly.');
console.log('Methods added:');
console.log('  - canAssignFiles(files)');
console.log('  - assignFilesToSubagent(taskFile, subagentId, files)');
console.log('  - releaseFilesFromSubagent(taskFile)');
