const fs = require('fs');
const os = require('os');
const path = require('path');
const { log } = require('../cli/output');
const { expandTilde, normalizeSlashes } = require('../platform/paths');

const GUARD_FILE_NAME = 'pix-mnt-guard.ts';
const VERSION_MARKER = /^\/\/ pix-mnt-guard v(\d+)\s*$/m;

function bundledGuardPath() {
  return path.join(__dirname, '..', '..', 'assets', 'extensions', GUARD_FILE_NAME);
}

function userTemplatePath(homeDir = os.homedir()) {
  return path.join(homeDir, '.pix', 'extensions', GUARD_FILE_NAME);
}

function guardDestPath(agentDir) {
  return path.join(agentDir, 'extensions', GUARD_FILE_NAME);
}

function readVersion(content) {
  const match = VERSION_MARKER.exec(content);
  return match ? Number(match[1]) : 0;
}

function isOurGuardFile(content) {
  return VERSION_MARKER.test(content);
}

/**
 * Resolve which template to install from, highest priority first:
 *   1. security.mntGuardSource (user config only; project config is filtered out)
 *   2. ~/.pix/extensions/pix-mnt-guard.ts (user-modified template, see `pix init-guard`)
 *   3. the template bundled with the running pix package (default)
 */
function resolveGuardSource(config, homeDir = os.homedir()) {
  const explicit = config?.security?.mntGuardSource;
  if (explicit) {
    const resolved = normalizeSlashes(expandTilde(explicit, homeDir));
    if (!fs.existsSync(resolved)) {
      throw new Error(`security.mntGuardSource does not exist: ${resolved}`);
    }
    return { source: resolved, origin: 'config' };
  }

  const userTemplate = userTemplatePath(homeDir);
  if (fs.existsSync(userTemplate)) {
    return { source: userTemplate, origin: 'user-template' };
  }

  return { source: bundledGuardPath(), origin: 'bundled' };
}

/**
 * Install (or refresh) the /mnt guard extension into the shared pi runtime.
 * The installed file is a cache of the resolved template: it is (re)written
 * whenever its content differs from the template, and left alone otherwise.
 * A same-named file NOT installed by pix (no version marker, content unknown)
 * is never overwritten.
 */
function installGuard(agentDir, options = {}) {
  const { dryRun = false, config = null } = options;
  const { source, origin } = resolveGuardSource(config);
  const dest = guardDestPath(agentDir);

  const srcContent = fs.readFileSync(source, 'utf8');

  if (fs.existsSync(dest)) {
    const destContent = fs.readFileSync(dest, 'utf8');
    if (destContent === srcContent) {
      return { installed: false, path: dest, source, origin, reason: 'up to date' };
    }
    if (!isOurGuardFile(destContent)) {
      return { installed: false, path: dest, source, origin, reason: 'unmanaged file with the same name exists' };
    }
  }

  if (dryRun) {
    return { installed: true, path: dest, source, origin, reason: 'dry-run' };
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, srcContent);
  log(`Installed pi extension: ${dest} (from ${origin}: ${source})`);
  return { installed: true, path: dest, source, origin };
}

/**
 * Remove the guard extension (used by --no-mnt-guard so pi will not
 * auto-discover it). Only removes files pix itself installed: anything with
 * our version marker, or content identical to the currently resolved template.
 */
function removeGuard(agentDir, options = {}) {
  const { dryRun = false, config = null } = options;
  const dest = guardDestPath(agentDir);

  if (!fs.existsSync(dest)) {
    return { removed: false, path: dest };
  }

  const content = fs.readFileSync(dest, 'utf8');
  let managed = isOurGuardFile(content);
  if (!managed) {
    try {
      const { source } = resolveGuardSource(config);
      managed = content === fs.readFileSync(source, 'utf8');
    } catch {
      managed = false;
    }
  }

  if (!managed) {
    return { removed: false, path: dest, reason: 'unmanaged file, left untouched' };
  }

  if (dryRun) {
    return { removed: true, path: dest, reason: 'dry-run' };
  }

  fs.unlinkSync(dest);
  log(`Removed pi extension: ${dest}`);
  return { removed: true, path: dest };
}

function guardStatus(agentDir, config = null) {
  const dest = guardDestPath(agentDir);
  let template = null;
  try {
    template = resolveGuardSource(config);
  } catch {
    template = null;
  }
  if (!fs.existsSync(dest)) {
    return { installed: false, path: dest, version: 0, template };
  }
  const content = fs.readFileSync(dest, 'utf8');
  return { installed: true, path: dest, version: readVersion(content), managed: isOurGuardFile(content), template };
}

module.exports = {
  installGuard,
  removeGuard,
  guardStatus,
  resolveGuardSource,
  guardDestPath,
  bundledGuardPath,
  userTemplatePath,
  GUARD_FILE_NAME,
};
