const fs = require('fs');
const path = require('path');

/**
 * Cache garbage collection for the target-side body stores.
 *
 * Hard rules:
 *  - never delete workspaces, sessions, credentials or uncollected runs;
 *  - never delete installs referenced by an existing runtime;
 *  - keep the runtime(s) for the current bodyRevision and at least one
 *    previous revision (rollback);
 *  - interrupted staging directories are safe to remove.
 */
function collectBodyGarbage(rootDir, options = {}) {
  const currentRevision = options.currentBodyRevision || null;
  const keepRevisions = new Set([currentRevision, options.previousBodyRevision].filter(Boolean));

  const removed = { runtimes: [], installs: [], staging: [], runs: [] };
  const runtimesDir = path.join(rootDir, 'runtimes');
  const installsDir = path.join(rootDir, 'installs');

  const liveRevisions = new Set();
  if (fs.existsSync(runtimesDir)) {
    for (const entry of fs.readdirSync(runtimesDir)) {
      const full = path.join(runtimesDir, entry);
      if (entry.startsWith('.staging-')) {
        fs.rmSync(full, { recursive: true, force: true });
        removed.staging.push(full);
        continue;
      }
      let revision = null;
      try {
        revision = JSON.parse(fs.readFileSync(path.join(full, 'ready.json'), 'utf8')).bodyRevision;
      } catch { /* not ready */ }
      if (revision) liveRevisions.add(revision);
      if (!revision || !keepRevisions.has(revision)) {
        fs.rmSync(full, { recursive: true, force: true });
        removed.runtimes.push(full);
      }
    }
  }

  // Installs referenced by surviving runtimes are protected.
  const referencedInstalls = new Set();
  if (fs.existsSync(runtimesDir)) {
    for (const entry of fs.readdirSync(runtimesDir)) {
      try {
        const ready = JSON.parse(fs.readFileSync(path.join(runtimesDir, entry, 'ready.json'), 'utf8'));
        if (ready.installId) referencedInstalls.add(ready.installId);
      } catch { /* ignore */ }
    }
  }
  if (fs.existsSync(installsDir)) {
    for (const entry of fs.readdirSync(installsDir)) {
      const full = path.join(installsDir, entry);
      if (entry.startsWith('.staging-')) {
        fs.rmSync(full, { recursive: true, force: true });
        removed.staging.push(full);
        continue;
      }
      if (!referencedInstalls.has(entry)) {
        fs.rmSync(full, { recursive: true, force: true });
        removed.installs.push(full);
      }
    }
  }

  // Old runs: only collected ones may be removed; UNCOLLECTED runs stay.
  const runsDir = path.join(rootDir, 'runs');
  const keepRuns = options.keepRuns ?? 20;
  if (fs.existsSync(runsDir)) {
    const collected = fs.readdirSync(runsDir)
      .filter((d) => fs.existsSync(path.join(runsDir, d, 'result.json')))
      .filter((d) => !fs.existsSync(path.join(runsDir, d, 'UNCOLLECTED')))
      .sort();
    const excess = collected.slice(0, Math.max(0, collected.length - keepRuns));
    for (const d of excess) {
      const full = path.join(runsDir, d);
      fs.rmSync(full, { recursive: true, force: true });
      removed.runs.push(full);
    }
  }

  return removed;
}

module.exports = { collectBodyGarbage };
