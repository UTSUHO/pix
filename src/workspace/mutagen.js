const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { log, warn } = require('../cli/output');
const { normalizeSlashes } = require('../platform/paths');

function findSystemMutagen() {
  const result = spawnSync('sh', ['-c', 'command -v mutagen'], {
    encoding: 'utf8',
    shell: false,
    stdio: 'pipe',
  });
  if (result.status === 0 && result.stdout && result.stdout.trim().length > 0) {
    return result.stdout.trim();
  }
  return null;
}

function resolveMutagenPath() {
  return findSystemMutagen();
}

function ensureMutagen() {
  return resolveMutagenPath();
}

function isMutagenAvailable() {
  return resolveMutagenPath() !== null;
}

function getMutagenVersion(binaryPath) {
  if (!binaryPath) return null;
  const result = spawnSync(binaryPath, ['version'], {
    encoding: 'utf8',
    shell: false,
    stdio: 'pipe',
  });
  if (result.status === 0 && result.stdout) {
    return result.stdout.trim();
  }
  return null;
}

function computeSessionName(sourcePath) {
  const normalized = normalizeSlashes(sourcePath);
  const hash = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 8);
  return `pix-${hash}`;
}

function runMutagen(binaryPath, args, options = {}) {
  return spawnSync(binaryPath, args, {
    encoding: 'utf8',
    shell: false,
    stdio: 'pipe',
    ...options,
  });
}

function buildCreateArgs(name, alphaPath, betaPath, config) {
  const baseExcludes = config.workspace?.exclude || ['node_modules', '.pnpm-store'];
  const syncExcludes = config.workspace?.sync?.exclude || [];
  const excludes = [...new Set([...baseExcludes, ...syncExcludes])];
  const syncMode = config.workspace?.sync?.mode || 'two-way-resolved';

  const args = [
    'sync',
    'create',
    alphaPath,
    betaPath,
    '--name',
    name,
    '--sync-mode',
    syncMode,
  ];

  for (const pattern of excludes) {
    args.push('--ignore', pattern);
  }

  return args;
}

function sessionExists(binaryPath, name) {
  const result = runMutagen(binaryPath, ['sync', 'list', name]);
  return result.status === 0 && result.stdout && result.stdout.includes(name);
}

function getSessionState(binaryPath, name) {
  const result = runMutagen(binaryPath, ['sync', 'list', name, '--template', '{{range .}}{{.Status}}{{end}}']);
  if (result.status === 0 && result.stdout) {
    return result.stdout.trim();
  }
  return null;
}

function createSession(binaryPath, name, alphaPath, betaPath, config) {
  const args = buildCreateArgs(name, alphaPath, betaPath, config);
  const result = runMutagen(binaryPath, args, { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`Failed to create Mutagen session ${name}`);
  }
}

function resumeSession(binaryPath, name) {
  runMutagen(binaryPath, ['sync', 'resume', name], { stdio: 'pipe' });
}

function pauseSession(binaryPath, name) {
  runMutagen(binaryPath, ['sync', 'pause', name], { stdio: 'pipe' });
}

function terminateSession(binaryPath, name) {
  runMutagen(binaryPath, ['sync', 'terminate', name], { stdio: 'pipe' });
}

function listSessions(binaryPath) {
  const result = runMutagen(binaryPath, ['sync', 'list', '--template', '{{range .}}{{.Name}}{{"\\n"}}{{end}}']);
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function listPixSessions(binaryPath) {
  return listSessions(binaryPath).filter((name) => name.startsWith('pix-'));
}

function waitForSession(binaryPath, name, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = getSessionState(binaryPath, name);
    if (state && state.toLowerCase() === 'watching') return true;
    if (state && (state.toLowerCase().includes('error') || state.toLowerCase().includes('conflict'))) {
      throw new Error(`Mutagen session ${name} entered error/conflict state: ${state}`);
    }
    const now = Date.now();
    while (Date.now() - now < 200) {
      // busy wait
    }
  }
  throw new Error(`Timeout waiting for Mutagen session ${name} to reach watching state`);
}

module.exports = {
  resolveMutagenPath,
  ensureMutagen,
  isMutagenAvailable,
  getMutagenVersion,
  computeSessionName,
  buildCreateArgs,
  sessionExists,
  getSessionState,
  createSession,
  resumeSession,
  pauseSession,
  terminateSession,
  listSessions,
  listPixSessions,
  waitForSession,
};
