const crypto = require('crypto');

const MANIFEST_SCHEMA_VERSION = 1;
const RUNNER_PROTOCOL_VERSION = 1;

/**
 * Deterministic serialization: object keys sorted recursively, arrays kept in
 * order, undefined dropped. Used for every digest that must be stable across
 * processes and platforms.
 */
function canonicalSerialize(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalSerialize(item)).join(',')}]`;
  }
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  const body = keys
    .map((k) => `${JSON.stringify(k)}:${canonicalSerialize(value[k])}`)
    .join(',');
  return `{${body}}`;
}

function sha256hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function digestObject(value) {
  return sha256hex(canonicalSerialize(value));
}

function shortDigest(value, len = 12) {
  return digestObject(value).slice(0, len);
}

/**
 * bodyRevision identifies the published Pi body: resolved Pi package, resolved
 * plugins, the full dependency lock digest, sealed resource digests and the
 * release recipe. Fields that would make every release unique for no reason
 * (timestamps, absolute install paths, the revision itself, audit notes) are
 * excluded by construction — callers must pass only the core object.
 */
function computeBodyRevision(core) {
  return digestObject({
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    pi: core.pi,
    plugins: core.plugins || [],
    lock: core.lock ? { digest: core.lock.digest } : null,
    resources: core.resources || null,
    recipe: core.recipe || null,
  });
}

/**
 * runtimeId identifies a materialized execution copy for one target platform.
 * It intentionally excludes workspace identity and run identity so one body
 * can serve many projects.
 */
function computeRuntimeId(input) {
  return digestObject({
    bodyRevision: input.bodyRevision,
    os: input.os,
    arch: input.arch,
    libc: input.libc || null,
    nodeVersion: input.nodeVersion,
    nodeAbi: input.nodeAbi || null,
    packageManagerVersion: input.packageManagerVersion || null,
    dependencyLockDigest: input.dependencyLockDigest,
    installFlagsDigest: input.installFlagsDigest || null,
    environmentFingerprint: input.environmentFingerprint || null,
    runnerProtocolVersion: input.runnerProtocolVersion ?? RUNNER_PROTOCOL_VERSION,
  });
}

/**
 * installId keys a reusable local dependency installation. It contains only
 * what changes the dependency tree or its build: lock, platform, node, package
 * manager, install flags and native-build-affecting source. Non-dependency
 * resources (local extension snapshots without native builds, profile data)
 * never change it.
 */
function computeInstallId(input) {
  return digestObject({
    dependencyLockDigest: input.dependencyLockDigest,
    os: input.os,
    arch: input.arch,
    libc: input.libc || null,
    nodeVersion: input.nodeVersion,
    nodeAbi: input.nodeAbi || null,
    packageManagerVersion: input.packageManagerVersion || null,
    installFlagsDigest: input.installFlagsDigest || null,
    nativeSourceDigests: input.nativeSourceDigests || null,
  });
}

function validateManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { valid: false, errors: ['manifest must be an object'] };
  }
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    errors.push(`Unsupported schemaVersion: ${manifest.schemaVersion}`);
  }
  if (typeof manifest.bodyRevision !== 'string' || manifest.bodyRevision.length === 0) {
    errors.push('manifest.bodyRevision is required.');
  }
  if (!manifest.pi || typeof manifest.pi !== 'object') {
    errors.push('manifest.pi is required.');
  } else {
    if (typeof manifest.pi.packageName !== 'string') errors.push('manifest.pi.packageName is required.');
    if (typeof manifest.pi.exactVersion !== 'string') errors.push('manifest.pi.exactVersion is required.');
  }
  if (!Array.isArray(manifest.plugins)) {
    errors.push('manifest.plugins must be an array.');
  } else {
    for (const [i, p] of manifest.plugins.entries()) {
      if (!p || typeof p.id !== 'string') errors.push(`manifest.plugins[${i}].id is required.`);
      if (p && typeof p.sourceLocator === 'string' && /(token|key|secret|password)=/i.test(p.sourceLocator)) {
        errors.push(`manifest.plugins[${i}].sourceLocator must not contain credentials.`);
      }
    }
  }
  if (!manifest.lock || typeof manifest.lock.digest !== 'string') {
    errors.push('manifest.lock.digest is required.');
  }
  return { valid: errors.length === 0, errors };
}

module.exports = {
  MANIFEST_SCHEMA_VERSION,
  RUNNER_PROTOCOL_VERSION,
  canonicalSerialize,
  sha256hex,
  digestObject,
  shortDigest,
  computeBodyRevision,
  computeRuntimeId,
  computeInstallId,
  validateManifest,
};
