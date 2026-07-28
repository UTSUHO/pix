const { log, warn } = require('../cli/output');
const { isProjectionNeeded, projectWorkspace, mirrorBackWorkspace, resolveProjectedPath } = require('./projection');
const {
  ensureMutagen,
  computeSessionName,
  sessionExists,
  createSession,
  resumeSession,
  pauseSession,
  terminateSession,
  waitForSession,
  buildCreateArgs,
} = require('./mutagen');

function isSyncEnabled(config) {
  if (config.workspace?.sync?.enabled === false) return false;
  if (config.workspace?.projection === false) return false;
  return true;
}

function getSyncStrategy(config) {
  return config.workspace?.sync?.strategy || 'mutagen';
}

function prepareWorkspace(sourceWorkspace, config, options = {}) {
  const { dryRun = false } = options;

  if (!isProjectionNeeded(sourceWorkspace, config)) {
    return { effectiveWorkspace: sourceWorkspace, strategy: 'none' };
  }

  const projectedPath = resolveProjectedPath(sourceWorkspace, config, process.env.HOME);

  if (!isSyncEnabled(config) || getSyncStrategy(config) !== 'mutagen') {
    log('Using workspace projection (sync disabled or strategy is not mutagen)');
    const effectiveWorkspace = projectWorkspace(sourceWorkspace, config, { dryRun });
    return { effectiveWorkspace, strategy: 'projection' };
  }

  const binaryPath = ensureMutagen();
  if (!binaryPath) {
    warn('Mutagen is not available. Falling back to rsync/cp projection.');
    const effectiveWorkspace = projectWorkspace(sourceWorkspace, config, { dryRun });
    return { effectiveWorkspace, strategy: 'projection' };
  }

  const sessionName = computeSessionName(sourceWorkspace);

  if (dryRun) {
    const args = buildCreateArgs(sessionName, projectedPath, sourceWorkspace, config);
    console.log([binaryPath, ...args].map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' '));
    return { effectiveWorkspace: projectedPath, strategy: 'mutagen' };
  }

  // Seed the WSL replica with the current Windows source before making it authoritative.
  log(`Seeding projected workspace for Mutagen sync: ${projectedPath}`);
  projectWorkspace(sourceWorkspace, config, { dryRun });

  try {
    if (sessionExists(binaryPath, sessionName)) {
      log(`Resuming existing Mutagen session: ${sessionName}`);
      resumeSession(binaryPath, sessionName);
    } else {
      log(`Creating Mutagen session: ${sessionName}`);
      // Alpha = WSL replica (authoritative), Beta = Windows source.
      createSession(binaryPath, sessionName, projectedPath, sourceWorkspace, config);
    }

    log('Waiting for Mutagen session to reach watching state...');
    waitForSession(binaryPath, sessionName);
    log('Mutagen sync is active');

    return { effectiveWorkspace: projectedPath, strategy: 'mutagen' };
  } catch (err) {
    warn(`Mutagen sync failed: ${err.message}`);
    try {
      terminateSession(binaryPath, sessionName);
    } catch {
      // ignore cleanup failure
    }
    warn('Falling back to rsync/cp projection.');
    return { effectiveWorkspace: projectedPath, strategy: 'projection' };
  }
}

function cleanupWorkspace(effectiveWorkspace, sourceWorkspace, config, options = {}, strategy) {
  const { dryRun = false } = options;

  if (strategy === 'none' || !effectiveWorkspace || effectiveWorkspace === sourceWorkspace) {
    return;
  }

  if (strategy === 'projection') {
    mirrorBackWorkspace(effectiveWorkspace, sourceWorkspace, config, { dryRun });
    return;
  }

  if (strategy !== 'mutagen') return;

  const binaryPath = ensureMutagen();
  if (!binaryPath) return;

  const sessionName = computeSessionName(sourceWorkspace);
  const keepAlive = config.workspace?.sync?.keepAlive || 'terminate';

  if (dryRun) {
    const action = keepAlive === 'terminate' ? 'terminate' : keepAlive;
    console.log(`${binaryPath} sync ${action} ${sessionName}`);
    return;
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
  } catch (err) {
    warn(`Failed to clean up Mutagen session ${sessionName}: ${err.message}`);
  }
}

module.exports = {
  isSyncEnabled,
  getSyncStrategy,
  prepareWorkspace,
  cleanupWorkspace,
};
