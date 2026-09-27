const path = require('path');
const { resolveHostContext, readPublishedBody } = require('../../host/resolve-home');
const { deployToTarget, executePlanOnTarget, newRunId } = require('../../host/orchestrate');
const { createTarget } = require('../../platform/target');
const { getDefaultDistro, toWslPath } = require('../../platform/wsl');
const { isNtfsWorkspace } = require('../../platform/paths');
const { resolveProjectedPath } = require('../../workspace/projection');
const { computeProjectionId } = require('../../workspace/projection');
const { loadConfig } = require('../../config/load-config');
const { mergeConfig } = require('../../config/merge-config');
const { validateConfig } = require('../../config/schema');
const { hashProfile } = require('../../runtime/compose-agent');
const { log, warn, fatal } = require('../output');
const legacyRun = require('./run-legacy');

/**
 * pix run — host-orchestrated launch.
 *
 * current release → ensureRunner/stage → build plan → runner executes.
 * The runner (target side) performs ensureRuntime / workspace / compose /
 * execute / collect. The host never proxies pi's file I/O.
 */
async function execute(parsedArgs, options = {}) {
  if (parsedArgs.legacy) {
    warn('Running in explicit legacy mode (v0.3 pipeline). Not the managed body/workspace architecture.');
    return legacyRun.execute(parsedArgs);
  }

  const ctx = resolveHostContext({ ensure: true });
  const configs = loadConfig(process.cwd());
  const { config, warnings } = mergeConfig(configs);
  applyCliOverrides(config, parsedArgs);
  for (const message of warnings) warn(message);

  const validation = validateConfig(config);
  for (const message of validation.warnings) warn(message);
  if (!validation.valid) {
    for (const message of validation.errors) fatal(message);
  }

  const published = readPublishedBody(ctx);
  if (!published) {
    fatal('No published Pi body on this host. Run "pix update" first (use --legacy for the old pipeline).');
  }

  warnIfProfileLooksEmpty(ctx);

  const backend = config.execution === 'sandbox' ? 'sandbox' : 'direct';

  // Target selection: local when already on Linux without a configured
  // distro (dev/test), otherwise the configured/default WSL distro.
  let target;
  if (options.target) {
    target = options.target;
  } else if (process.platform === 'win32' || config.wsl?.distro || parsedArgs.distro) {
    const distro = parsedArgs.distro || config.wsl?.distro || getDefaultDistro();
    if (!distro) fatal('Could not determine WSL distro. Set wsl.distro or use --distro.');
    target = createTarget({ type: 'wsl', distro });
  } else {
    target = createTarget({ type: 'local' });
  }

  // Stage runner + release + profile + credentials (content-addressed; warm
  // runs stage zero bytes).
  const staged = deployToTarget(ctx, target, options.deploy || {});
  if (staged.runner.deployed) log(`Runner deployed: ${staged.runner.name}`);

  // Workspace identity: stable per source directory, independent of body
  // version — updating Pi must never renumber or wipe a project workspace.
  const sourceRoot = options.sourceRoot || mapSourceRoot(process.cwd(), target, config);
  const workspaceId = computeProjectionId(sourceRoot);
  const executionRoot = isNtfsWorkspace(sourceRoot) && config.workspace?.projection !== false
    ? resolveProjectedPath(sourceRoot, config, path.posix.join(target.home))
    : sourceRoot;

  const transport = process.stdout.isTTY && parsedArgs.transport !== 'pipe' ? 'tty' : 'pipe';

  const plan = {
    hostId: ctx.hostId,
    runId: newRunId(),
    backend,
    transport,
    bodyRevision: published.manifest.bodyRevision,
    profileRevision: hashProfile(ctx.profileDir),
    workspace: {
      id: workspaceId,
      sourceRoot,
      executionRoot,
    },
    session: {
      directory: path.posix.join(target.home, '.pix', 'sessions', workspaceId),
      file: null,
    },
    piArgs: parsedArgs.piArgs,
    approvedPolicy: buildApprovedPolicy(config, parsedArgs),
  };

  const result = await executePlanOnTarget(target, staged.runner, plan, {
    stdio: 'inherit',
  });

  if (result.infraError) {
    warn(`Runner infrastructure error: ${result.infraError}`);
    return 1;
  }
  return result.code ?? 0;
}

/**
 * First-run safeguard: the managed pipeline reads profile + credentials from
 * the host PIX_HOME. If they are empty while legacy data exists, pi would
 * start with no settings/models/auth — point at the importer instead.
 */
function warnIfProfileLooksEmpty(ctx) {
  const fs = require('fs');
  const profileItems = ['settings.json', 'models.json', 'prompts', 'skills', 'themes'];
  const hasProfile = profileItems.some((item) => fs.existsSync(path.join(ctx.profileDir, item)));
  const hasAuth = fs.existsSync(path.join(ctx.credentialsDir, 'auth.json'));
  if (hasProfile || hasAuth) return;

  const legacyHints = [];
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (home && fs.existsSync(path.join(home, '.pi', 'agent'))) {
    legacyHints.push(path.join(home, '.pi', 'agent'));
  }
  if (process.platform === 'win32') {
    try {
      const { detectWslLegacyViaUnc } = require('./migrate');
      legacyHints.push(...detectWslLegacyViaUnc(config0Distro()));
    } catch { /* best effort */ }
  }

  warn('Host profile and credentials are empty — pi will start with no settings, models or auth.');
  if (legacyHints.length) {
    warn('Existing pi data found at:');
    for (const hint of legacyHints) warn(`  ${hint}`);
  }
  warn('Import it with:  pix migrate --to-host            (dry-run report)');
  warn('                 pix migrate --to-host --apply --include-auth');

  function config0Distro() {
    try {
      const { getDefaultDistro } = require('../../platform/wsl');
      return getDefaultDistro();
    } catch {
      return null;
    }
  }
}

function buildApprovedPolicy(config, parsedArgs) {
  // Only approved, already-merged policy reaches the runner. The runner never
  // loads another config hierarchy.
  const env = {};
  for (const key of config.envAllowlist || []) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return {
    workspace: config.workspace || {},
    env,
    mntGuard: parsedArgs.mntGuard !== false,
    guardConfig: config.security ? { security: config.security } : null,
    rebuild: parsedArgs.rebuild === true,
    containerConfig: {
      container: config.container || {},
      envAllowlist: config.envAllowlist || [],
    },
  };
}

function mapSourceRoot(cwd, target, config) {
  if (target.type === 'wsl' && process.platform === 'win32') {
    const mapped = toWslPath(cwd, target.distro);
    if (!mapped) fatal(`Failed to convert current directory to a WSL path: ${cwd}`);
    return mapped;
  }
  return cwd;
}

function applyCliOverrides(config, parsedArgs) {
  if (parsedArgs.execution) config.execution = parsedArgs.execution;
  if (parsedArgs.noProjection) {
    config.workspace = config.workspace || {};
    config.workspace.projection = false;
  }
  if (parsedArgs.noMirrorBack) {
    config.workspace = config.workspace || {};
    config.workspace.mirrorBack = false;
  }
  if (parsedArgs.mirrorBack) {
    config.workspace = config.workspace || {};
    config.workspace.mirrorBack = true;
  }
  if (parsedArgs.writeback) {
    config.workspace = config.workspace || {};
    config.workspace.writeback = parsedArgs.writeback;
  }
  if (parsedArgs.sync !== null) {
    config.workspace = config.workspace || {};
    config.workspace.sync = config.workspace.sync || {};
    config.workspace.sync.enabled = parsedArgs.sync;
  }
  if (parsedArgs.syncStrategy) {
    config.workspace = config.workspace || {};
    config.workspace.sync = config.workspace.sync || {};
    config.workspace.sync.strategy = parsedArgs.syncStrategy;
  }
  if (parsedArgs.syncKeepAlive) {
    config.workspace = config.workspace || {};
    config.workspace.sync = config.workspace.sync || {};
    config.workspace.sync.keepAlive = parsedArgs.syncKeepAlive;
  }
  if (parsedArgs.syncMode) {
    config.workspace = config.workspace || {};
    config.workspace.sync = config.workspace.sync || {};
    config.workspace.sync.mode = parsedArgs.syncMode;
  }
}

module.exports = { execute, buildApprovedPolicy, applyCliOverrides };
