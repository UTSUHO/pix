const fs = require('fs');
const path = require('path');
const { log } = require('../cli/output');

const GUARD_FILE_NAME = 'pix-mnt-guard.ts';
const VERSION_MARKER = /^\/\/ pix-mnt-guard v(\d+)\s*$/m;

function guardSourcePath() {
  return path.join(__dirname, '..', '..', 'assets', 'extensions', GUARD_FILE_NAME);
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
 * Install (or upgrade) the /mnt guard extension into the shared pi runtime.
 * Returns { installed: boolean, path: string, reason?: string }.
 */
function installGuard(agentDir, options = {}) {
  const { dryRun = false } = options;
  const src = guardSourcePath();
  const dest = guardDestPath(agentDir);

  const srcContent = fs.readFileSync(src, 'utf8');
  const srcVersion = readVersion(srcContent);

  if (fs.existsSync(dest)) {
    const destContent = fs.readFileSync(dest, 'utf8');
    if (!isOurGuardFile(destContent)) {
      // A user-maintained file with the same name: never overwrite.
      return { installed: false, path: dest, reason: 'unmanaged file with the same name exists' };
    }
    if (readVersion(destContent) >= srcVersion && destContent === srcContent) {
      return { installed: false, path: dest, reason: 'up to date' };
    }
  }

  if (dryRun) {
    return { installed: true, path: dest, reason: 'dry-run' };
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, srcContent);
  log(`Installed pi extension: ${dest} (v${srcVersion})`);
  return { installed: true, path: dest };
}

/**
 * Remove the guard extension, but only if it is a file pix itself installed.
 */
function removeGuard(agentDir, options = {}) {
  const { dryRun = false } = options;
  const dest = guardDestPath(agentDir);

  if (!fs.existsSync(dest)) {
    return { removed: false, path: dest };
  }

  const content = fs.readFileSync(dest, 'utf8');
  if (!isOurGuardFile(content)) {
    return { removed: false, path: dest, reason: 'unmanaged file, left untouched' };
  }

  if (dryRun) {
    return { removed: true, path: dest, reason: 'dry-run' };
  }

  fs.unlinkSync(dest);
  log(`Removed pi extension: ${dest}`);
  return { removed: true, path: dest };
}

function guardStatus(agentDir) {
  const dest = guardDestPath(agentDir);
  if (!fs.existsSync(dest)) {
    return { installed: false, path: dest, version: 0 };
  }
  const content = fs.readFileSync(dest, 'utf8');
  return { installed: true, path: dest, version: readVersion(content), managed: isOurGuardFile(content) };
}

module.exports = { installGuard, removeGuard, guardStatus, guardDestPath, GUARD_FILE_NAME };
