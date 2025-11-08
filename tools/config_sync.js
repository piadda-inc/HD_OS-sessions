#!/usr/bin/env node

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

// === CLI ARGS ===
function parseArgs() {
  const args = {
    dryRun: true,
    fix: false,
    validate: false,
    all: true,
    target: null,
    force: false,
    json: false,
    help: false,
    manifestPath: path.join(__dirname, '..', 'config-sync-manifest.json')
  };

  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];

    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
      args.fix = false;
    } else if (arg === '--fix') {
      args.fix = true;
      args.dryRun = false;
    } else if (arg === '--validate') {
      args.validate = true;
    } else if (arg === '--all') {
      args.all = true;
      args.target = null;
    } else if (arg === '--target') {
      args.target = process.argv[++i];
      args.all = false;
    } else if (arg === '--force') {
      args.force = true;
    } else if (arg === '--json') {
      args.json = true;
    } else {
      console.error(`Unknown option: ${arg}`);
      process.exit(1);
    }
  }

  return args;
}

function showHelp() {
  console.log(`
Configuration Synchronization Tool

Usage: node config_sync.js [options]

Options:
  --dry-run          Report changes without modifying (default)
  --fix              Actually copy files to synchronize
  --validate         CI mode: exit 1 if drift detected, exit 0 if synchronized
  --all              Target all repositories (default)
  --target <name>    Target specific repository (piadda-mvp, backlog-md-python)
  --force            Override allowOverride protection (dangerous)
  --json             Output JSON instead of human-readable
  --help, -h         Show this help message

Examples:
  node config_sync.js --dry-run --all
  node config_sync.js --validate --target backlog-md-python
  node config_sync.js --fix --target piadda-mvp
  node config_sync.js --json --all
`);
}

// === UTILITIES ===
function computeChecksum(filePath) {
  try {
    const data = fs.readFileSync(filePath);
    return crypto.createHash('md5').update(data).digest('hex');
  } catch (err) {
    return null;
  }
}

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch (err) {
    return false;
  }
}

function readManifest(manifestPath) {
  if (!fileExists(manifestPath)) {
    console.error(`ERROR: Manifest not found at ${manifestPath}`);
    process.exit(1);
  }

  try {
    const data = fs.readFileSync(manifestPath, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    console.error(`ERROR: Failed to read manifest: ${err.message}`);
    process.exit(1);
  }
}

// === COMPARISON ===
function compareFile(canonicalPath, targetPath, fileType) {
  // For allow-different files, we just report they're different
  if (fileType === 'allow_different') {
    return { status: 'different', action: 'skip' };
  }

  // Check canonical file exists
  if (!fileExists(canonicalPath)) {
    return {
      status: 'error',
      action: 'skip',
      error: 'Canonical file not found'
    };
  }

  // Check if target exists
  if (!fileExists(targetPath)) {
    return { status: 'missing', action: 'copy' };
  }

  // For presence-only files, existence is enough
  if (fileType === 'presence') {
    return { status: 'synced', action: 'skip' };
  }

  // For exact files, compare checksums
  const canonicalChecksum = computeChecksum(canonicalPath);
  const targetChecksum = computeChecksum(targetPath);

  if (canonicalChecksum === null) {
    return {
      status: 'error',
      action: 'skip',
      error: 'Cannot read canonical file'
    };
  }

  if (targetChecksum === null) {
    return {
      status: 'error',
      action: 'skip',
      error: 'Cannot read target file'
    };
  }

  if (canonicalChecksum === targetChecksum) {
    return { status: 'synced', action: 'skip' };
  } else {
    return { status: 'outdated', action: 'copy' };
  }
}

// === SYNC OPERATIONS ===
function syncFile(canonicalPath, targetPath, dryRun) {
  if (dryRun) {
    return { success: true, message: 'Dry-run: would copy' };
  }

  try {
    // Ensure target directory exists
    const targetDir = path.dirname(targetPath);
    if (!fileExists(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    // Copy file
    fs.copyFileSync(canonicalPath, targetPath);
    return { success: true, message: 'Copied successfully' };
  } catch (err) {
    return { success: false, message: `Copy failed: ${err.message}` };
  }
}

// === REPORTING ===
function generateReport(results, format, args) {
  if (format === 'json') {
    return generateJsonReport(results);
  } else {
    return generateHumanReport(results, args);
  }
}

function generateJsonReport(results) {
  const output = [];

  for (const targetName in results) {
    const result = results[targetName];

    const jsonOutput = {
      canonical: result.canonical,
      target: targetName,
      stats: result.stats,
      files: result.files.map(f => ({
        path: f.path,
        status: f.status,
        action: f.action,
        error: f.error || undefined
      })),
      summary: {
        needs_sync: result.needsSync,
        actions: result.actions
      }
    };

    output.push(jsonOutput);
  }

  return JSON.stringify(output, null, 2);
}

function generateHumanReport(results, args) {
  let report = [];

  if (!args.validate) {
    report.push('Synchronizing configurations...');
    report.push('');
  }

  for (const targetName in results) {
    const result = results[targetName];

    report.push(`Canonical: ${result.canonical}`);
    report.push(`Target: ${targetName}`);
    report.push('');

    // Stats by file type
    report.push('Status by file type:');
    for (const type in result.stats) {
      const stats = result.stats[type];
      if (type === 'allow_different') {
        report.push(`  allow-different: ${stats.total} (intentionally different)`);
      } else {
        const synced = stats.synced || 0;
        const total = stats.total || 0;
        const outdated = stats.outdated || 0;
        const missing = stats.missing || 0;

        let parts = [`${synced}/${total} synchronized`];
        if (outdated > 0) parts.push(`${outdated} outdated`);
        if (missing > 0) parts.push(`${missing} missing`);

        report.push(`  ${type}: ${parts.join(', ')}`);
      }
    }
    report.push('');

    // Files needing sync
    const needsSyncFiles = result.files.filter(f => f.needsSync);
    if (needsSyncFiles.length > 0) {
      report.push('Files needing sync:');
      for (const file of needsSyncFiles) {
        let symbol = '?';
        if (file.status === 'missing') symbol = '✗';
        else if (file.status === 'outdated') symbol = '⚠';
        else if (file.status === 'error') symbol = '!';

        let msg = `  ${symbol} ${file.path} (${file.status.toUpperCase()})`;
        if (file.error) msg += ` - ${file.error}`;
        report.push(msg);
      }
      report.push('');
    }

    // Summary
    if (result.needsSync > 0) {
      report.push(`Summary: ${result.needsSync} file${result.needsSync === 1 ? '' : 's'} need synchronization`);
      if (args.dryRun) {
        report.push('Run with --fix to synchronize');
      }
    } else {
      report.push('Summary: All files synchronized');
    }

    report.push('');
  }

  return report.join('\n');
}

// === MAIN ===
function main() {
  const args = parseArgs();

  if (args.help) {
    showHelp();
    process.exit(0);
  }

  const manifest = readManifest(args.manifestPath);

  // Determine which targets to process
  const targetsToProcess = [];
  if (args.all) {
    targetsToProcess.push(...Object.keys(manifest.targets));
  } else if (args.target) {
    if (!manifest.targets[args.target]) {
      console.error(`ERROR: Target "${args.target}" not found in manifest`);
      console.error(`Available targets: ${Object.keys(manifest.targets).join(', ')}`);
      process.exit(1);
    }
    targetsToProcess.push(args.target);
  }

  const results = {};
  let hasErrors = false;
  let hasDrift = false;

  // Process each target
  for (const targetName of targetsToProcess) {
    const targetPath = manifest.targets[targetName];

    // Verify target exists
    if (!fileExists(targetPath)) {
      console.error(`ERROR: Target repository not found: ${targetPath}`);
      process.exit(1);
    }

    const result = {
      canonical: manifest.canonical_source,
      target: targetPath,
      stats: {
        exact: { total: 0, synced: 0, outdated: 0, missing: 0 },
        presence: { total: 0, synced: 0, outdated: 0, missing: 0 },
        allow_different: { total: 0 }
      },
      files: [],
      needsSync: 0,
      actions: []
    };

    // Process each file
    for (const file of manifest.files) {
      // Skip if this target is not in the file's targets
      if (!file.targets.includes(targetName)) {
        continue;
      }

      const fileType = (file.type || 'exact').replace('-', '_');

      // Update stats
      if (result.stats[fileType]) {
        result.stats[fileType].total++;
      }

      const canonicalPath = path.join(manifest.canonical_source, file.path);
      const targetFilePath = path.join(targetPath, file.path);

      const comparison = compareFile(canonicalPath, targetFilePath, fileType);

      const fileResult = {
        path: file.path,
        status: comparison.status,
        action: comparison.action,
        error: comparison.error,
        needsSync: comparison.action === 'copy'
      };

      result.files.push(fileResult);

      // Update stats
      if (fileType !== 'allow_different') {
        if (comparison.status === 'synced') {
          result.stats[fileType].synced++;
        } else if (comparison.status === 'outdated') {
          result.stats[fileType].outdated++;
        } else if (comparison.status === 'missing') {
          result.stats[fileType].missing++;
        } else if (comparison.status === 'error') {
          hasErrors = true;
        }
      }

      // Track if sync needed
      if (fileResult.needsSync) {
        result.needsSync++;
        hasDrift = true;

        // Perform sync if in fix mode
        if (args.fix) {
          const syncResult = syncFile(canonicalPath, targetFilePath, false);
          if (syncResult.success) {
            result.actions.push(`Copied ${file.path}`);
          } else {
            result.actions.push(`Failed to copy ${file.path}: ${syncResult.message}`);
            hasErrors = true;
          }
        }
      }
    }

    if (!args.fix && result.needsSync > 0) {
      result.actions.push(`${result.needsSync} file${result.needsSync === 1 ? '' : 's'} need synchronization`);
    }

    results[targetName] = result;
  }

  // Generate and output report
  const report = generateReport(results, args.json ? 'json' : 'human', args);
  console.log(report);

  // Exit codes
  if (hasErrors) {
    process.exit(1);
  }

  if (args.validate && hasDrift) {
    process.exit(1);
  }

  process.exit(0);
}

main();
