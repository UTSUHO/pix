const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { acquireLock } = require('./locks');
const { createAdapters } = require('./adapters');
const semver = require('./semver');
const {
  MANIFEST_SCHEMA_VERSION,
  computeBodyRevision,
  sha256hex,
  validateManifest,
} = require('../runtime/manifest');
const { readPublishedBody, releaseDir } = require('./resolve-home');

const PI_PACKAGE_NAME = '@earendil-works/pi-coding-agent';

/**
 * spec.json — user intent on the maintenance host:
 * {
 *   "schemaVersion": 1,
 *   "pi": { "source": "npm", "packageName": "...", "range": "latest" | "1.2.3",
 *           "updatePolicy": "latest" | "pin" },
 *   "plugins": [
 *     { "id": "...", "sourceKind": "npm",  "packageName": "...", "range": "latest",
 *       "updatePolicy": "latest" | "pin" },
 *     { "id": "...", "sourceKind": "git",  "sourceLocator": "<url>", "ref": "main",
 *       "updatePolicy": "track" | "pin" },
 *     { "id": "...", "sourceKind": "local","sourceLocator": "<path>" }
 *   ]
 * }
 */
function defaultSpec() {
  return {
    schemaVersion: 1,
    pi: {
      source: 'npm',
      packageName: PI_PACKAGE_NAME,
      range: 'latest',
      updatePolicy: 'latest',
    },
    plugins: [],
  };
}

function readSpec(ctx) {
  try {
    const spec = JSON.parse(fs.readFileSync(ctx.specPath, 'utf8'));
    return { spec, created: false };
  } catch {
    return { spec: defaultSpec(), created: true };
  }
}

function writeSpec(ctx, spec) {
  fs.mkdirSync(path.dirname(ctx.specPath), { recursive: true });
  fs.writeFileSync(ctx.specPath, JSON.stringify(spec, null, 2) + '\n', 'utf8');
}

/**
 * Environment for npm/git child processes during a host update. The current
 * project's .npmrc / .pi / scripts must not influence the managed install:
 * npm runs with cwd=staging (never the project), a managed empty userconfig,
 * and no inherited NPM_CONFIG_* overrides.
 */
function buildManagedEnv(baseEnv = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(baseEnv)) {
    if (/^npm_config_/i.test(k)) continue;
    env[k] = v;
  }
  env.npm_config_ignore_scripts = 'true';
  return env;
}

function ensureManagedNpmrc(ctx) {
  const npmrcPath = path.join(ctx.bodyDir, 'managed-npmrc');
  if (!fs.existsSync(npmrcPath)) {
    fs.mkdirSync(ctx.bodyDir, { recursive: true });
    fs.writeFileSync(npmrcPath, '# pix managed npmrc: project-level npm config is intentionally ignored\nignore-scripts=true\n');
  }
  return npmrcPath;
}

function fileDigest(filePath) {
  return sha256hex(fs.readFileSync(filePath));
}

function readInstalledVersion(dir, packageName) {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(dir, 'node_modules', ...packageName.split('/'), 'package.json'), 'utf8')
    );
    return pkg.version || null;
  } catch {
    return null;
  }
}

function readInstalledEngines(dir, packageName) {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(dir, 'node_modules', ...packageName.split('/'), 'package.json'), 'utf8')
    );
    return pkg.engines || {};
  } catch {
    return {};
  }
}

/**
 * Resolve one spec entry to a frozen result. Returns
 * { status: 'resolved'|'skipped', resolved: {...} } — pinned entries keep
 * their previous resolved value and report skipped.
 */
function resolveEntry(entry, previous, adapters) {
  const policy = entry.updatePolicy || 'latest';
  if (policy === 'pin') {
    if (!previous) {
      const err = new Error(`Entry "${entry.id || entry.packageName}" is pinned but has no previously resolved version.`);
      err.code = 'UPDATE_FAILED';
      throw err;
    }
    return { status: 'skipped', resolved: previous };
  }

  const kind = entry.sourceKind || entry.source || 'npm';
  if (kind === 'npm') {
    const { exactVersion, packageIntegrity } = adapters.npm.resolve(
      entry.packageName,
      entry.range || 'latest'
    );
    return {
      status: 'resolved',
      resolved: {
        id: entry.id || entry.packageName,
        sourceKind: 'npm',
        sourceLocator: entry.packageName,
        resolvedVersion: exactVersion,
        packageIntegrity,
        updatePolicy: policy,
      },
    };
  }
  if (kind === 'git') {
    const { resolvedCommit } = adapters.git.resolveCommit(entry.sourceLocator, entry.ref || 'HEAD');
    return {
      status: 'resolved',
      resolved: {
        id: entry.id,
        sourceKind: 'git',
        sourceLocator: entry.sourceLocator,
        resolvedCommit,
        updatePolicy: policy,
      },
    };
  }
  if (kind === 'local') {
    const { sourceDigest } = adapters.local.hashDirectory(entry.sourceLocator);
    return {
      status: 'resolved',
      resolved: {
        id: entry.id,
        sourceKind: 'local',
        sourceLocator: entry.sourceLocator,
        sourceDigest,
        updatePolicy: 'snapshot',
      },
    };
  }
  const err = new Error(`Unsupported source kind "${kind}" for "${entry.id || entry.packageName}".`);
  err.code = 'UPDATE_FAILED';
  throw err;
}

/**
 * The Windows host update transaction.
 *
 *   spec → resolve → staging → validate → release → current
 *
 * Never touches WSL/Docker. Never activates a partially built candidate:
 * any component failure leaves current.json untouched. Returns a structured
 * UpdateResult distinguishing changed / skipped / failed per component.
 *
 * @param {object} ctx   HostContext (from resolve-home, ensured)
 * @param {object} options { piOnly, pluginsOnly, dryRun, nodeVersion }
 * @param {object} deps  { adapters, execFile, platform, env, pixVersion }
 */
async function updateHostBody(ctx, options = {}, deps = {}) {
  const adapters = deps.adapters || createAdapters(deps);
  const platform = deps.platform || process.platform;
  const env = buildManagedEnv(deps.env || process.env);
  env.npm_config_userconfig = ensureManagedNpmrc(ctx);
  const nodeVersion = options.nodeVersion || deps.nodeVersion || process.version;
  const pixVersion = deps.pixVersion || require('../../package.json').version;

  const result = {
    pi: { status: 'skipped' },
    plugins: [],
    release: null,
    warnings: [],
  };

  const lock = acquireLock(ctx.locksDir, 'body-update', { purpose: 'pix update', platform });
  let stagingPath = null;

  try {
    const { spec, created } = readSpec(ctx);
    if (created) writeSpec(ctx, spec);

    const published = readPublishedBody(ctx);
    const previousManifest = published ? published.manifest : null;

    // --- resolve -----------------------------------------------------------
    const piPrevious = previousManifest
      ? {
          id: previousManifest.pi.packageName,
          sourceKind: 'npm',
          sourceLocator: previousManifest.pi.packageName,
          resolvedVersion: previousManifest.pi.exactVersion,
          packageIntegrity: previousManifest.pi.packageIntegrity,
          updatePolicy: spec.pi.updatePolicy || 'latest',
        }
      : null;

    const piOutcome = options.pluginsOnly
      ? { status: 'skipped', resolved: piPrevious, reason: '--plugins-only' }
      : resolveEntry({ id: spec.pi.packageName, ...spec.pi, sourceKind: 'npm' }, piPrevious, adapters);
    result.pi = {
      status: piOutcome.status === 'resolved' ? 'resolved' : 'skipped',
      reason: piOutcome.reason,
      from: piPrevious ? piPrevious.resolvedVersion : null,
      to: piOutcome.resolved ? piOutcome.resolved.resolvedVersion : null,
    };
    if (!piOutcome.resolved) {
      const err = new Error('No previously published Pi version available to keep.');
      err.code = 'UPDATE_FAILED';
      throw err;
    }

    const previousPlugins = new Map(
      ((previousManifest && previousManifest.plugins) || []).map((p) => [p.id, p])
    );
    const pluginSpecs = options.piOnly ? [] : spec.plugins || [];
    const keptPlugins = options.piOnly
      ? (previousManifest ? previousManifest.plugins : [])
      : [];

    const resolvedPlugins = [...keptPlugins];
    for (const pluginSpec of pluginSpecs) {
      const previous = previousPlugins.get(pluginSpec.id) || null;
      try {
        const outcome = resolveEntry(pluginSpec, previous, adapters);
        resolvedPlugins.push(outcome.resolved);
        result.plugins.push({
          id: pluginSpec.id,
          status: outcome.status === 'resolved' ? 'resolved' : 'skipped',
          from: previous ? previous.resolvedVersion || previous.resolvedCommit || previous.sourceDigest : null,
          to: outcome.resolved.resolvedVersion || outcome.resolved.resolvedCommit || outcome.resolved.sourceDigest,
        });
      } catch (err) {
        result.plugins.push({ id: pluginSpec.id, status: 'failed', error: err.message });
        const e = new Error(`Plugin "${pluginSpec.id}" failed to resolve: ${err.message}`);
        e.code = 'UPDATE_FAILED';
        throw e;
      }
    }

    // Dropped plugins (in previous manifest but no longer in spec) are noted.
    for (const p of previousPlugins.values()) {
      if (!resolvedPlugins.some((rp) => rp.id === p.id)) {
        result.plugins.push({ id: p.id, status: 'removed' });
      }
    }

    const piResolved = piOutcome.resolved;
    const npmPlugins = resolvedPlugins.filter((p) => p.sourceKind === 'npm');
    const localPlugins = resolvedPlugins.filter((p) => p.sourceKind === 'local');
    const gitPlugins = resolvedPlugins.filter((p) => p.sourceKind === 'git');
    if (gitPlugins.length > 0) {
      // Git plugins resolve to commits but need a pack/seal step to be part of
      // a frozen npm-style install; not supported in this slice.
      result.warnings.push(
        `Git-sourced plugins resolved but packaging is not yet supported: ${gitPlugins.map((p) => p.id).join(', ')}`
      );
      const e = new Error(`UNSUPPORTED_PLUGIN_SOURCE: git packaging not implemented for ${gitPlugins.map((p) => p.id).join(', ')}`);
      e.code = 'UPDATE_FAILED';
      throw e;
    }

    // --- staging -----------------------------------------------------------
    const txId = crypto.randomBytes(6).toString('hex');
    stagingPath = path.join(ctx.stagingDir, txId);
    fs.mkdirSync(stagingPath, { recursive: true });

    const dependencies = { [piResolved.sourceLocator]: piResolved.resolvedVersion };
    for (const p of npmPlugins) dependencies[p.sourceLocator] = p.resolvedVersion;
    fs.writeFileSync(
      path.join(stagingPath, 'package.json'),
      JSON.stringify({ name: 'pix-managed-body', private: true, version: '0.0.0', dependencies }, null, 2) + '\n'
    );

    adapters.npm.generateLock(stagingPath, env);
    adapters.npm.ciInstall(stagingPath, env);

    // --- validate ----------------------------------------------------------
    const actualPiVersion = readInstalledVersion(stagingPath, piResolved.sourceLocator);
    if (actualPiVersion !== piResolved.resolvedVersion) {
      const e = new Error(
        `Installed Pi version mismatch: expected ${piResolved.resolvedVersion}, got ${actualPiVersion || 'missing'}`
      );
      e.code = 'UPDATE_FAILED';
      throw e;
    }

    const engines = readInstalledEngines(stagingPath, piResolved.sourceLocator);
    if (engines.node && !semver.satisfies(nodeVersion, engines.node)) {
      const e = new Error(
        `Pi ${actualPiVersion} requires Node "${engines.node}", host Node is ${nodeVersion}. Pix does not upgrade system Node automatically.`
      );
      e.code = 'UPDATE_FAILED';
      e.requiredNode = engines.node;
      throw e;
    }

    for (const p of npmPlugins) {
      const actual = readInstalledVersion(stagingPath, p.sourceLocator);
      if (actual !== p.resolvedVersion) {
        const e = new Error(`Plugin "${p.id}" install mismatch: expected ${p.resolvedVersion}, got ${actual || 'missing'}`);
        e.code = 'UPDATE_FAILED';
        e.pluginId = p.id;
        throw e;
      }
    }

    // Seal local plugin snapshots into the candidate resources directory.
    const resources = [];
    for (const p of localPlugins) {
      const dest = path.join(stagingPath, 'resources', p.id);
      const { sourceDigest, fileCount } = adapters.local.sealSnapshot(p.sourceLocator, dest);
      if (sourceDigest !== p.sourceDigest) {
        const e = new Error(`Local plugin "${p.id}" changed while sealing (digest mismatch).`);
        e.code = 'UPDATE_FAILED';
        throw e;
      }
      resources.push({ id: p.id, relativePath: path.join('resources', p.id), contentDigest: sourceDigest, fileCount });
    }

    const lockDigest = fileDigest(path.join(stagingPath, 'package-lock.json'));
    const npmVersion = adapters.npm.version();

    // --- release -----------------------------------------------------------
    const manifestCore = {
      pi: {
        packageName: piResolved.sourceLocator,
        exactVersion: piResolved.resolvedVersion,
        packageIntegrity: piResolved.packageIntegrity || null,
        nodeRequirement: engines.node || null,
      },
      plugins: resolvedPlugins,
      lock: {
        relativePath: 'package-lock.json',
        digest: lockDigest,
        packageManager: 'npm',
        packageManagerVersion: npmVersion,
        installFlags: ['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
      },
      resources: resources.length ? resources : null,
      recipe: { installer: 'npm-ci', ignoreScripts: true },
    };
    const bodyRevision = computeBodyRevision(manifestCore);

    const manifest = {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      bodyRevision,
      ...manifestCore,
      createdBy: { pixVersion },
    };
    const validation = validateManifest(manifest);
    if (!validation.valid) {
      const e = new Error(`Generated manifest is invalid: ${validation.errors.join('; ')}`);
      e.code = 'UPDATE_FAILED';
      throw e;
    }

    const previousRevision = previousManifest ? previousManifest.bodyRevision : null;
    const finalDir = releaseDir(ctx, bodyRevision);

    if (options.dryRun) {
      result.release = { bodyRevision, activated: false, dryRun: true, previousRevision };
      return result;
    }

    if (!fs.existsSync(finalDir)) {
      fs.writeFileSync(path.join(stagingPath, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
      // Same-volume rename: staging -> immutable release directory.
      fs.renameSync(stagingPath, finalDir);
      stagingPath = null;
    }
    // (If the release directory already exists, the candidate content is
    // identical by construction of bodyRevision; discard staging below.)

    // Single commit point: write pointer to a temp file, then rename.
    const currentTmp = `${ctx.currentPath}.tmp`;
    fs.writeFileSync(
      currentTmp,
      JSON.stringify({ bodyRevision, previousRevision, activatedAt: new Date().toISOString() }, null, 2) + '\n'
    );
    fs.renameSync(currentTmp, ctx.currentPath);

    result.pi.status = result.pi.status === 'resolved'
      ? (piPrevious && piPrevious.resolvedVersion === piResolved.resolvedVersion ? 'unchanged' : 'changed')
      : result.pi.status;
    for (const r of result.plugins) {
      if (r.status === 'resolved') r.status = r.from === r.to ? 'unchanged' : 'changed';
    }
    result.release = { bodyRevision, activated: true, previousRevision, directory: finalDir };
    return result;
  } finally {
    if (stagingPath && fs.existsSync(stagingPath)) {
      // Keep failed candidates for diagnosis but clearly not as active installs.
      try {
        fs.writeFileSync(path.join(stagingPath, 'FAILED'), `Candidate failed; safe to remove.\n`);
      } catch { /* ignore */ }
    }
    lock.release();
  }
}

module.exports = {
  PI_PACKAGE_NAME,
  defaultSpec,
  readSpec,
  writeSpec,
  buildManagedEnv,
  updateHostBody,
};
