const fs = require('fs');
const path = require('path');
const { log, warn } = require('../cli/output');
const { isProjectionNeeded, projectWorkspace, mirrorBackWorkspace, resolveProjectedPath, diffWorkspace } = require('./projection');
const {
  ensureMutagen,
  computeSessionName,
  sessionExists,
  getSessionState,
  createSession,
  resumeSession,
  pauseSession,
  terminateSession,
  waitForSession,
  buildCreateArgs,
} = require('./mutagen');

/**
 * Workspace preparation / collection, structured edition.
 *
 * prepareWorkspace returns a WorkspaceDescriptor:
 *   { workspaceId, sourceRoot, executionRoot, storageType, syncMode,
 *     hasPendingChanges, cleanupHandle }
 *
 * Hard rules implemented here:
 *  - a healthy or paused Mutagen session is RESUMED, never reseeded over;
 *  - a projection copy marked uncollected is never overwritten by a blind
 *    rsync --delete reseed (WORKSPACE_CONFLICT);
 *  - projection failure is final unless the user explicitly allows raw
 *    NTFS execution (--allow-raw-workspace);
 *  - writeback policy 'review' never auto-overwrites the Windows source:
 *    it keeps the copy and emits a baseline diff report.
 */

const STATE_FILE = '.pix-state.json';

function isSyncEnabled(config) {
  if (config.workspace?.sync?.enabled === false) return false;
  if (config.workspace?.projection === false) return false;
  return true;
}

function getSyncStrategy(config) {
  return config.workspace?.sync?.strategy || 'mutagen';
}

function getWritebackPolicy(config) {
  return config.workspace?.writeback || 'realtime';
}

function readState(projectedPath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(projectedPath, STATE_FILE), 'utf8'));
  } catch {
    return null;
  }
}

function writeState(projectedPath, state) {
  try {
    fs.writeFileSync(
      path.join(projectedPath, STATE_FILE),
      JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2) + '\n'
    );
  } catch { /* best effort */ }
}

function isDirEmpty(dirPath) {
  try {
    return fs.readdirSync(dirPath).filter((n) => n !== STATE_FILE).length === 0;
  } catch {
    return true;
  }
}

function workspaceError(code, message) {
  const err = new Error(`${code}: ${message}`);
  err.code = code;
  return err;
}

function prepareWorkspace(sourceWorkspace, config, options = {}) {
  const { dryRun = false, allowRawWorkspace = false } = options;

  if (!isProjectionNeeded(sourceWorkspace, config)) {
    return descriptor({
      sourceRoot: sourceWorkspace,
      executionRoot: sourceWorkspace,
      storageType: 'linux-local',
      syncMode: 'none',
    });
  }

  const projectedPath = resolveProjectedPath(sourceWorkspace, config, process.env.HOME);
  const workspaceId = path.basename(projectedPath);
  const priorState = readState(projectedPath);
  const copyExists = fs.existsSync(projectedPath) && !isDirEmpty(projectedPath);
  const hasUncollectedChanges = copyExists && priorState && priorState.collected === false;

  const useMutagen = isSyncEnabled(config) && getSyncStrategy(config) === 'mutagen';
  const binaryPath = useMutagen
    ? (options.mutagenBin !== undefined ? options.mutagenBin : ensureMutagen())
    : null;
  const sessionName = computeSessionName(sourceWorkspace);
  const liveSession = binaryPath && (options.mutagenOps?.sessionExists || sessionExists)(binaryPath, sessionName);

  try {
    if (binaryPath) {
      return prepareMutagen({
        sourceWorkspace, projectedPath, workspaceId, config, dryRun,
        binaryPath, sessionName, liveSession, copyExists, hasUncollectedChanges,
        mutagenOps: options.mutagenOps || null,
        projectWorkspaceImpl: options.projectWorkspaceImpl || null,
      });
    }

    if (useMutagen) {
      warn('Mutagen is not available. Falling back to rsync/cp projection (writeback policy still applies).');
    }

    return prepareProjection({
      sourceWorkspace, projectedPath, workspaceId, config, dryRun,
      copyExists, hasUncollectedChanges,
    });
  } catch (err) {
    if (err.code) throw err;
    if (allowRawWorkspace) {
      warn(`Workspace projection failed: ${err.message}`);
      warn('Continuing on the raw Windows path because --allow-raw-workspace was given. Expect slow file operations.');
      return descriptor({
        sourceRoot: sourceWorkspace,
        executionRoot: sourceWorkspace,
        storageType: 'windows-ntfs-raw',
        syncMode: 'none',
      });
    }
    throw workspaceError('WORKSPACE_PROJECTION_FAILED',
      `${err.message}. Refusing to fall back to the raw Windows path (use --allow-raw-workspace to override).`);
  }
}

function prepareMutagen(ctx) {
  const {
    sourceWorkspace, projectedPath, workspaceId, config, dryRun,
    binaryPath, sessionName, liveSession, copyExists, hasUncollectedChanges,
  } = ctx;
  const ops = {
    resumeSession, createSession, waitForSession, buildCreateArgs,
    ...(ctx.mutagenOps || {}),
  };
  const doProject = ctx.projectWorkspaceImpl || projectWorkspace;

  if (dryRun) {
    const args = ops.buildCreateArgs(sessionName, projectedPath, sourceWorkspace, config);
    console.error(`[pix] ${binaryPath} ${args.join(' ')}`);
    return descriptor({
      workspaceId,
      sourceRoot: sourceWorkspace,
      executionRoot: projectedPath,
      storageType: 'wsl-ext4-projected',
      syncMode: 'mutagen',
      hasPendingChanges: hasUncollectedChanges,
    });
  }

  if (liveSession) {
    // A known session owns this copy: resume, NEVER reseed over it.
    log(`Resuming existing Mutagen session: ${sessionName}`);
    ops.resumeSession(binaryPath, sessionName);
  } else {
    if (hasUncollectedChanges) {
      throw workspaceError('WORKSPACE_CONFLICT',
        `Projected workspace ${projectedPath} has uncollected changes from a previous run and no live sync session. ` +
        'Refusing to reseed over it. Recover it first (see pix doctor), or remove the directory explicitly.');
    }
    // No live session owns the copy: it is either a cleanly collected cache or
    // stale content. Reseeding from the Windows source is mandatory here —
    // with conflict-resolved sync modes the replica is authoritative, so
    // creating a session over a STALE copy would revert newer Windows edits.
    log(`Seeding projected workspace for Mutagen sync: ${projectedPath}`);
    doProject(sourceWorkspace, config, { dryRun });
    log(`Creating Mutagen session: ${sessionName}`);
    ops.createSession(binaryPath, sessionName, projectedPath, sourceWorkspace, config);
  }

  log('Waiting for Mutagen session to reach watching state...');
  ops.waitForSession(binaryPath, sessionName);
  log('Mutagen sync is active');
  writeState(projectedPath, { sourceRoot: sourceWorkspace, strategy: 'mutagen', session: sessionName, collected: false });

  return descriptor({
    workspaceId,
    sourceRoot: sourceWorkspace,
    executionRoot: projectedPath,
    storageType: 'wsl-ext4-projected',
    syncMode: config.workspace?.sync?.mode || 'two-way-safe',
    hasPendingChanges: hasUncollectedChanges,
  });
}

function prepareProjection(ctx) {
  const { sourceWorkspace, projectedPath, workspaceId, config, dryRun, copyExists, hasUncollectedChanges } = ctx;

  if (hasUncollectedChanges && getWritebackPolicy(config) !== 'realtime') {
    throw workspaceError('WORKSPACE_CONFLICT',
      `Projected workspace ${projectedPath} has uncollected changes. Refusing to reseed over it. ` +
      'Review the previous diff report, or remove the directory explicitly.');
  }

  log('Using workspace projection (one-shot rsync/cp)');
  const effectiveWorkspace = projectWorkspace(sourceWorkspace, config, { dryRun });
  writeState(projectedPath, { sourceRoot: sourceWorkspace, strategy: 'projection', collected: false });

  return descriptor({
    workspaceId,
    sourceRoot: sourceWorkspace,
    executionRoot: effectiveWorkspace,
    storageType: 'wsl-ext4-projected',
    syncMode: 'projection',
    hasPendingChanges: false,
  });
}

function descriptor(fields) {
  return {
    workspaceId: fields.workspaceId || null,
    sourceRoot: fields.sourceRoot,
    executionRoot: fields.executionRoot,
    storageType: fields.storageType,
    syncMode: fields.syncMode,
    hasPendingChanges: fields.hasPendingChanges || false,
    // cleanupHandle lets the runner finalize without re-deriving context.
    cleanupHandle: {
      strategy: fields.syncMode === 'none' ? 'none' : fields.syncMode === 'projection' ? 'projection' : 'mutagen',
      executionRoot: fields.executionRoot,
      sourceRoot: fields.sourceRoot,
    },
  };
}

/**
 * Finalize the workspace after the run. Mirrors the strategy recorded in the
 * descriptor's cleanupHandle.
 *
 * writeback policy:
 *  - realtime: mutagen keeps syncing; on terminate the copy is collected.
 *              projection + mirrorBack=true mirrors back (legacy explicit).
 *  - review:   NEVER auto-overwrites. Keeps the copy, writes a diff report.
 */
function cleanupWorkspace(desc, config, options = {}) {
  const { dryRun = false, reportPath = null } = options;
  if (!desc || !desc.cleanupHandle || desc.cleanupHandle.strategy === 'none') return null;
  const { strategy, executionRoot, sourceRoot } = desc.cleanupHandle;
  const writeback = getWritebackPolicy(config);

  if (strategy === 'projection') {
    if (writeback === 'review') {
      const report = diffWorkspace(executionRoot, sourceRoot, config.workspace?.exclude || []);
      warn('Writeback policy is "review": the Windows source was NOT modified.');
      log(`Diff summary: ${report.added.length} added, ${report.modified.length} modified, ${report.deleted.length} deleted.`);
      log(`Execution copy kept at: ${executionRoot}`);
      if (reportPath && !dryRun) {
        fs.mkdirSync(path.dirname(reportPath), { recursive: true });
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
        log(`Diff report: ${reportPath}`);
      }
      return { collected: false, report };
    }
    if (config.workspace?.mirrorBack) {
      mirrorBackWorkspace(executionRoot, sourceRoot, config, { dryRun });
    }
    writeState(executionRoot, { collected: true });
    return { collected: true };
  }

  if (strategy !== 'mutagen') return null;

  const binaryPath = ensureMutagen();
  if (!binaryPath) return null;

  const sessionName = computeSessionName(sourceRoot);
  const keepAlive = config.workspace?.sync?.keepAlive || 'terminate';

  if (dryRun) {
    const action = keepAlive === 'terminate' ? 'terminate' : keepAlive;
    console.error(`[pix] ${binaryPath} sync ${action} ${sessionName}`);
    return { collected: false };
  }

  try {
    if (keepAlive === 'pause') {
      log(`Pausing Mutagen session: ${sessionName}`);
      pauseSession(binaryPath, sessionName);
    } else if (keepAlive === 'running') {
      log(`Leaving Mutagen session running: ${sessionName}`);
    } else {
      log(`Terminating Mutagen session: ${sessionName}`);
      terminateSession(binaryPath, sessionName);
    }
    writeState(executionRoot, { collected: true });
    return { collected: true };
  } catch (err) {
    warn(`Failed to clean up Mutagen session ${sessionName}: ${err.message}`);
    writeState(executionRoot, { collected: false });
    return { collected: false, error: err.message };
  }
}

module.exports = {
  isSyncEnabled,
  getSyncStrategy,
  getWritebackPolicy,
  prepareWorkspace,
  cleanupWorkspace,
  readState,
  writeState,
};
