const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Directory-based mutual exclusion lock using Node built-in fs primitives.
 * mkdir is atomic on all supported filesystems; owner.json records the holder
 * so a stale lock (holder process dead) can be reclaimed. A lock held by a
 * live process is never removed on a timeout basis.
 */

function isProcessAlive(pid, platform = process.platform) {
  if (!pid || typeof pid !== 'number') return false;
  if (platform === 'win32') {
    // process.kill(pid, 0) works on Windows for liveness in modern Node.
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return err.code === 'EPERM';
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function readOwner(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Acquire the lock at lockPath. Returns { release, owner }.
 * Throws Error with code 'LOCK_HELD' when a live process holds it.
 */
function acquireLock(locksDir, name, options = {}) {
  const lockPath = path.join(locksDir, `${name}.lock`);
  fs.mkdirSync(locksDir, { recursive: true });

  const owner = {
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: new Date().toISOString(),
    purpose: options.purpose || name,
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(lockPath);
      fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify(owner, null, 2));
      let released = false;
      return {
        owner,
        path: lockPath,
        release() {
          if (released) return;
          released = true;
          fs.rmSync(lockPath, { recursive: true, force: true });
        },
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const existing = readOwner(lockPath);
      if (existing && isProcessAlive(existing.pid, options.platform)) {
        const e = new Error(
          `Lock "${name}" is held by pid ${existing.pid} (${existing.purpose || 'unknown'}, since ${existing.startedAt || 'unknown'}).`
        );
        e.code = 'LOCK_HELD';
        e.owner = existing;
        throw e;
      }
      // Stale lock: holder is gone (or owner metadata unreadable). Reclaim once.
      fs.rmSync(lockPath, { recursive: true, force: true });
    }
  }

  const e = new Error(`Failed to acquire lock "${name}".`);
  e.code = 'LOCK_HELD';
  throw e;
}

module.exports = { acquireLock, isProcessAlive };
