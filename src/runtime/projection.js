const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  computeRuntimeId,
  computeInstallId,
  validateManifest,
  RUNNER_PROTOCOL_VERSION,
} = require('./manifest');
const { createAdapters } = require('../host/adapters');

const MNT_PREFIX = '/mnt/';

function linkDir(target, linkPath) {
  // Junctions on Windows need no special privilege and require absolute
  // targets; symlinks elsewhere prefer relative targets.
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(target, linkPath, type);
}

function runtimeError(code, message, extra = {}) {
  const err = new Error(`${code}: ${message}`);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

/**
 * Ensure a body execution copy exists on the target platform.
 *
 * Layout on the target (rootDir defaults to ~/.pix):
 *   installs/<installId>/          reusable dependency install (node_modules)
 *     ready.json
 *   runtimes/<runtimeId>/
 *     manifest.json
 *     install -> ../../installs/<installId>   (symlink, same Linux fs)
 *     resources/                     sealed non-dependency resources
 *     ready.json                     written LAST, only after full verification
 *
 * Ready-hit path reads only small metadata — it never walks node_modules,
 * never reinstalls, never copies the body, never resolves package versions.
 *
 * @param {object} manifest  published body manifest (from the host release)
 * @param {object} target    { rootDir, platform: {os, arch, libc, nodeVersion,
 *                            nodeAbi, packageManagerVersion, environmentFingerprint},
 *                            releaseDir }  releaseDir = host release directory
 *                            containing package.json + package-lock.json + resources/
 * @param {object} deps      { adapters, execFile, nodeExecutable }
 */
function ensureRuntime(manifest, target, deps = {}) {
  const validation = validateManifest(manifest);
  if (!validation.valid) {
    throw runtimeError('RUNTIME_DEPLOY_FAILED', `invalid manifest: ${validation.errors.join('; ')}`);
  }

  const rootDir = target.rootDir;
  const platform = target.platform;
  const installFlags = (manifest.lock && manifest.lock.installFlags) || ['ci', '--ignore-scripts'];
  const installFlagsDigest = crypto.createHash('sha256').update(installFlags.join(' ')).digest('hex');

  const keyInput = {
    bodyRevision: manifest.bodyRevision,
    os: platform.os,
    arch: platform.arch,
    libc: platform.libc || null,
    nodeVersion: platform.nodeVersion,
    nodeAbi: platform.nodeAbi || null,
    packageManagerVersion: platform.packageManagerVersion || manifest.lock.packageManagerVersion || null,
    dependencyLockDigest: manifest.lock.digest,
    installFlagsDigest,
    environmentFingerprint: platform.environmentFingerprint || null,
    runnerProtocolVersion: RUNNER_PROTOCOL_VERSION,
  };
  const runtimeId = computeRuntimeId(keyInput);
  const installId = computeInstallId(keyInput);

  const runtimeDir = path.join(rootDir, 'runtimes', runtimeId);
  const readyPath = path.join(runtimeDir, 'ready.json');

  // --- ready hit -----------------------------------------------------------
  if (fs.existsSync(readyPath)) {
    assertNotRedirectedToWindows(runtimeDir);
    const ready = JSON.parse(fs.readFileSync(readyPath, 'utf8'));
    if (ready.bodyRevision !== manifest.bodyRevision) {
      throw runtimeError('RUNTIME_VERSION_MISMATCH',
        `ready runtime bodyRevision ${ready.bodyRevision} != expected ${manifest.bodyRevision}`,
        { expected: manifest.bodyRevision, actual: ready.bodyRevision });
    }
    // The body must not silently redirect onto a Windows filesystem, on the
    // warm path either: verify both the recorded install dir and the link.
    for (const candidate of [ready.installDir, path.join(runtimeDir, 'install')]) {
      if (candidate && fs.existsSync(candidate)) {
        assertNotRedirectedToWindows(candidate);
      }
    }
    return describe(runtimeDir, ready, { readyHit: true, installId, runtimeId });
  }

  // --- miss: staged deploy ---------------------------------------------------
  const adapters = deps.adapters || createAdapters(deps);
  const releaseDir = target.releaseDir;
  if (!releaseDir || !fs.existsSync(path.join(releaseDir, 'package-lock.json'))) {
    throw runtimeError('RUNTIME_DEPLOY_FAILED', 'host release directory missing lockfile; run "pix update" on the host first');
  }

  checkCrossPlatformLock(releaseDir, manifest);

  const installDir = ensureInstall({
    rootDir, installId, releaseDir, manifest, adapters, deps,
  });

  const txId = crypto.randomBytes(6).toString('hex');
  const staging = path.join(rootDir, 'runtimes', `.staging-${txId}`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  try {
    // Link the shared install into the runtime (same filesystem).
    linkDir(process.platform === 'win32' ? installDir : path.relative(staging, installDir), path.join(staging, 'install'));

    // Seal non-dependency resources into the runtime.
    const resourcesRoot = path.join(staging, 'resources');
    fs.mkdirSync(resourcesRoot, { recursive: true });
    for (const res of manifest.resources || []) {
      const src = path.join(releaseDir, res.relativePath);
      const dest = path.join(resourcesRoot, res.id);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(src, dest, { recursive: true });
    }

    // Verify: actual installed Pi version must equal the manifest version.
    const piEntry = resolvePiEntrypoint(installDir, manifest.pi.packageName);
    const installedVersion = readPackageVersion(installDir, manifest.pi.packageName);
    if (installedVersion !== manifest.pi.exactVersion) {
      throw runtimeError('RUNTIME_VERSION_MISMATCH',
        `installed Pi ${installedVersion || 'missing'} != manifest ${manifest.pi.exactVersion}`,
        { expected: manifest.pi.exactVersion, actual: installedVersion });
    }
    for (const plugin of manifest.plugins || []) {
      if (plugin.sourceKind !== 'npm') continue;
      const v = readPackageVersion(installDir, plugin.sourceLocator);
      if (v !== plugin.resolvedVersion) {
        throw runtimeError('RUNTIME_VERSION_MISMATCH',
          `plugin "${plugin.id}" installed ${v || 'missing'} != manifest ${plugin.resolvedVersion}`,
          { expected: plugin.resolvedVersion, actual: v, pluginId: plugin.id });
      }
    }

    const descriptor = {
      runtimeId,
      installId,
      bodyRevision: manifest.bodyRevision,
      nodeExecutable: deps.nodeExecutable || 'node',
      piEntrypoint: piEntry,
      resourcesRoot: path.join(runtimeDir, 'resources'),
      installDir,
      storageType: 'linux-local',
      verifiedAt: new Date().toISOString(),
    };

    // Commit: manifest first, ready marker LAST.
    fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    fs.writeFileSync(path.join(staging, 'ready.json'), JSON.stringify({ ...descriptor, resourcesRoot: path.join(staging, 'resources') }, null, 2) + '\n');

    fs.rmSync(runtimeDir, { recursive: true, force: true });
    fs.renameSync(staging, runtimeDir);
    assertNotRedirectedToWindows(runtimeDir);

    return describe(runtimeDir, { ...descriptor }, { readyHit: false, installId, runtimeId });
  } catch (err) {
    // Interrupted staging is never ready; leave it for diagnosis, marked.
    try {
      fs.writeFileSync(path.join(staging, 'FAILED'), String(err.message || err));
    } catch { /* ignore */ }
    if (err.code) throw err;
    throw runtimeError('RUNTIME_DEPLOY_FAILED', err.message || String(err));
  }
}

/**
 * Verify the lock contains what the target platform needs: every
 * optionalDependency declared by the Pi package must be present in the lock.
 * A lock missing platform-conditional entries is a HOST release problem —
 * the target must never re-resolve versions or rewrite the lock.
 */
function checkCrossPlatformLock(releaseDir, manifest) {
  const lock = JSON.parse(fs.readFileSync(path.join(releaseDir, 'package-lock.json'), 'utf8'));
  const packages = lock.packages || {};
  let piPkgJson = null;
  try {
    piPkgJson = JSON.parse(fs.readFileSync(
      path.join(releaseDir, 'node_modules', ...manifest.pi.packageName.split('/'), 'package.json'), 'utf8'
    ));
  } catch { /* release built without node_modules layout; skip deep check */ }
  const optional = (piPkgJson && piPkgJson.optionalDependencies) || {};
  const missing = [];
  for (const dep of Object.keys(optional)) {
    if (!packages[`node_modules/${dep}`]) missing.push(dep);
  }
  if (missing.length) {
    throw runtimeError('RUNTIME_DEPLOY_FAILED',
      `host lock is missing platform/optional dependencies: ${missing.join(', ')}. Fix the release on the host (pix update); the target will not re-resolve versions.`,
      { reason: 'lock-incomplete', missing });
  }
}

/** Reuse an existing ready install, or build it with a frozen npm ci. */
function ensureInstall({ rootDir, installId, releaseDir, manifest, adapters, deps }) {
  const installDir = path.join(rootDir, 'installs', installId);
  const readyPath = path.join(installDir, 'ready.json');
  if (fs.existsSync(readyPath)) {
    assertNotRedirectedToWindows(installDir);
    return installDir;
  }

  const txId = crypto.randomBytes(6).toString('hex');
  const staging = path.join(rootDir, 'installs', `.staging-${txId}`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  fs.copyFileSync(path.join(releaseDir, 'package.json'), path.join(staging, 'package.json'));
  fs.copyFileSync(path.join(releaseDir, 'package-lock.json'), path.join(staging, 'package-lock.json'));

  const env = { ...(deps.env || process.env), npm_config_ignore_scripts: 'true' };
  try {
    adapters.npm.ciInstall(staging, env);
  } catch (err) {
    throw runtimeError('RUNTIME_DEPLOY_FAILED', `frozen install failed: ${err.message}`);
  }
  fs.writeFileSync(readyPath.replace(installDir, staging), JSON.stringify({ installId, createdAt: new Date().toISOString() }) + '\n');
  fs.rmSync(installDir, { recursive: true, force: true });
  fs.renameSync(staging, installDir);
  assertNotRedirectedToWindows(installDir);
  return installDir;
}

/**
 * Resolve the Pi CLI entrypoint from the installed package's own metadata
 * (bin field), never a hardcoded upstream path.
 */
function resolvePiEntrypoint(installDir, packageName) {
  const pkgJsonPath = path.join(installDir, 'node_modules', ...packageName.split('/'), 'package.json');
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  } catch {
    throw runtimeError('RUNTIME_DEPLOY_FAILED', `package ${packageName} not present in install`);
  }
  let binRel = null;
  if (typeof pkg.bin === 'string') binRel = pkg.bin;
  else if (pkg.bin && typeof pkg.bin === 'object') binRel = pkg.bin.pi || Object.values(pkg.bin)[0];
  if (!binRel) {
    throw runtimeError('RUNTIME_DEPLOY_FAILED', `package ${packageName} exposes no CLI entrypoint`);
  }
  const entry = path.join(installDir, 'node_modules', ...packageName.split('/'), binRel);
  if (!fs.existsSync(entry)) {
    throw runtimeError('RUNTIME_DEPLOY_FAILED', `CLI entrypoint missing: ${entry}`);
  }
  return entry;
}

function readPackageVersion(installDir, packageName) {
  try {
    return JSON.parse(fs.readFileSync(
      path.join(installDir, 'node_modules', ...packageName.split('/'), 'package.json'), 'utf8'
    )).version || null;
  } catch {
    return null;
  }
}

/**
 * The body must live on the target's local filesystem. A path that resolves
 * (through any number of symlinks) onto a Windows drive is rejected — string
 * prefix checks alone are not enough.
 */
function assertNotRedirectedToWindows(dirPath) {
  const real = fs.realpathSync(dirPath);
  if (real.startsWith(MNT_PREFIX) || real === MNT_PREFIX.slice(0, -1)) {
    throw runtimeError('RUNTIME_DEPLOY_FAILED',
      `runtime path resolves onto a Windows filesystem: ${real}. Runtimes must be stored on the Linux filesystem.`);
  }
}

function describe(runtimeDir, ready, extra) {
  return {
    runtimeId: extra.runtimeId,
    installId: extra.installId,
    bodyRevision: ready.bodyRevision,
    nodeExecutable: ready.nodeExecutable,
    piEntrypoint: ready.piEntrypoint,
    resourcesRoot: path.join(runtimeDir, 'resources'),
    installDir: ready.installDir,
    storageType: ready.storageType || 'linux-local',
    readyHit: extra.readyHit,
  };
}

module.exports = { ensureRuntime, resolvePiEntrypoint, checkCrossPlatformLock, assertNotRedirectedToWindows };
