const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const HOST_SCHEMA_VERSION = 1;

/**
 * Resolve the Pix home directory on the maintenance host (Windows in
 * production; overridable everywhere for tests and development).
 *   PIX_HOME env > %USERPROFILE%\.pix (win32) > ~/.pix (other platforms)
 */
function resolvePixHome(env = process.env, platform = process.platform) {
  if (env.PIX_HOME) return env.PIX_HOME;
  if (platform === 'win32') {
    const base = env.USERPROFILE || os.homedir();
    return path.join(base, '.pix');
  }
  return path.join(os.homedir(), '.pix');
}

function hostJsonPath(pixHome) {
  return path.join(pixHome, 'host.json');
}

function readHostJson(pixHome) {
  try {
    return JSON.parse(fs.readFileSync(hostJsonPath(pixHome), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Build the HostContext. Does not create anything unless `ensure: true`.
 */
function resolveHostContext(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const pixHome = resolvePixHome(env, platform);

  const ctx = {
    schemaVersion: HOST_SCHEMA_VERSION,
    pixHome,
    hostId: null,
    mode: 'host',
    platform,
    configPath: path.join(pixHome, 'config.json'),
    hostJsonPath: hostJsonPath(pixHome),
    profileDir: path.join(pixHome, 'profile'),
    bodyDir: path.join(pixHome, 'body'),
    specPath: path.join(pixHome, 'body', 'spec.json'),
    currentPath: path.join(pixHome, 'body', 'current.json'),
    releasesDir: path.join(pixHome, 'body', 'releases'),
    stagingDir: path.join(pixHome, 'body', 'staging'),
    credentialsDir: path.join(pixHome, 'credentials'),
    stateDir: path.join(pixHome, 'state'),
    projectsStateDir: path.join(pixHome, 'state', 'projects'),
    sessionsStateDir: path.join(pixHome, 'state', 'sessions'),
    runsStateDir: path.join(pixHome, 'state', 'runs'),
    locksDir: path.join(pixHome, 'locks'),
    backupsDir: path.join(pixHome, 'backups'),
  };

  const hostJson = readHostJson(pixHome);
  if (hostJson && hostJson.hostId) {
    ctx.hostId = hostJson.hostId;
    ctx.mode = hostJson.mode || 'host';
  }

  if (options.ensure) {
    ensureHostLayout(ctx, env);
  }

  return ctx;
}

/**
 * Create the managed directory layout and host.json if absent.
 * Never overwrites an existing host.json (hostId is stable identity).
 */
function ensureHostLayout(ctx, env = process.env) {
  for (const dir of [
    ctx.pixHome,
    ctx.profileDir,
    ctx.bodyDir,
    ctx.releasesDir,
    ctx.stagingDir,
    ctx.credentialsDir,
    ctx.projectsStateDir,
    ctx.sessionsStateDir,
    ctx.runsStateDir,
    ctx.locksDir,
    ctx.backupsDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (!readHostJson(ctx.pixHome)) {
    const hostJson = {
      schemaVersion: HOST_SCHEMA_VERSION,
      hostId: crypto.randomBytes(8).toString('hex'),
      mode: 'host',
      createdBy: env.PIX_VERSION || 'unknown',
    };
    fs.writeFileSync(ctx.hostJsonPath, JSON.stringify(hostJson, null, 2) + '\n', 'utf8');
    ctx.hostId = hostJson.hostId;
  } else {
    ctx.hostId = readHostJson(ctx.pixHome).hostId;
  }

  return ctx;
}

function readCurrentRelease(ctx) {
  try {
    return JSON.parse(fs.readFileSync(ctx.currentPath, 'utf8'));
  } catch {
    return null;
  }
}

function releaseDir(ctx, bodyRevision) {
  return path.join(ctx.releasesDir, bodyRevision);
}

function readReleaseManifest(ctx, bodyRevision) {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(releaseDir(ctx, bodyRevision), 'manifest.json'), 'utf8')
    );
  } catch {
    return null;
  }
}

/**
 * Read the currently published body manifest (current.json -> releases/<rev>/manifest.json).
 * Returns null when nothing has been published yet.
 */
function readPublishedBody(ctx) {
  const current = readCurrentRelease(ctx);
  if (!current || !current.bodyRevision) return null;
  const manifest = readReleaseManifest(ctx, current.bodyRevision);
  if (!manifest) return null;
  return { current, manifest, directory: releaseDir(ctx, current.bodyRevision) };
}

module.exports = {
  HOST_SCHEMA_VERSION,
  resolvePixHome,
  resolveHostContext,
  ensureHostLayout,
  readHostJson,
  readCurrentRelease,
  readReleaseManifest,
  readPublishedBody,
  releaseDir,
};
