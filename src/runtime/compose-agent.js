const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { acquireLock } = require('../host/locks');
const { installGuard, removeGuard } = require('./install-guard');

function linkDir(target, linkPath) {
  // Junctions on Windows need no special privilege; symlinks elsewhere.
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(target, linkPath, type);
}

/**
 * Per-run agent composition.
 *
 * Every run gets its own PI_CODING_AGENT_DIR at <root>/runs/<runId>/agent:
 *   settings.json / models.json   copied (rendered) from the profile snapshot
 *   prompts/ skills/ themes/      copied from the profile snapshot
 *   auth.json                     copied from the credentials store (never
 *                                 part of body/manifest/digests)
 *   sessions -> <root>/sessions/<workspaceId>/   (single-writer leased)
 *   extensions/                   runtime resources + pix-mnt-guard (unless
 *                                 --no-mnt-guard), composed per run so the
 *                                 immutable body is never modified
 *
 * Runtime /settings changes stay in the run directory as change proposals;
 * they never write back to the host profile automatically.
 */

const PROFILE_ITEMS = ['settings.json', 'models.json', 'prompts', 'skills', 'themes'];

/** Content digest of the profile directory — profileRevision. */
function hashProfile(profileDir) {
  const hash = crypto.createHash('sha256');
  for (const item of PROFILE_ITEMS) {
    const full = path.join(profileDir, item);
    if (!fs.existsSync(full)) continue;
    hash.update(item);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      for (const file of walk(full)) {
        hash.update(path.relative(full, file).split(path.sep).join('/'));
        hash.update(fs.readFileSync(file));
      }
    } else {
      hash.update(fs.readFileSync(full));
    }
  }
  return hash.digest('hex');
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out.sort();
}

/** Materialize an immutable profile snapshot; reused while content is unchanged. */
function ensureProfileSnapshot(rootDir, profileDir, profileRevision) {
  const snapshotDir = path.join(rootDir, 'profiles', profileRevision);
  const marker = path.join(snapshotDir, '.ready');
  if (fs.existsSync(marker)) return snapshotDir;

  const staging = `${snapshotDir}.staging-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  for (const item of PROFILE_ITEMS) {
    const src = path.join(profileDir, item);
    if (!fs.existsSync(src)) continue;
    fs.cpSync(src, path.join(staging, item), { recursive: true });
  }
  fs.writeFileSync(marker.replace(snapshotDir, staging), `profileRevision=${profileRevision}\n`);
  fs.rmSync(snapshotDir, { recursive: true, force: true });
  fs.renameSync(staging, snapshotDir);
  return snapshotDir;
}

/**
 * Rewrite profile-relative path references in settings/models to absolute
 * paths inside the composed run directory. Only values that point at items
 * actually present in the profile snapshot are rewritten; everything else
 * (URLs, arbitrary user strings, prompts) is left untouched.
 */
function renderJsonPaths(value, mapRelativeTo) {
  if (Array.isArray(value)) {
    return value.map((v) => renderJsonPaths(v, mapRelativeTo));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = renderJsonPaths(v, mapRelativeTo);
    return out;
  }
  if (typeof value === 'string' && !value.startsWith('/') && !/^[a-zA-Z]:/.test(value) && !/^\w+:\/\//.test(value)) {
    const candidate = path.join(mapRelativeTo, value);
    if ((value.startsWith('extensions/') || value.startsWith('prompts/') || value.startsWith('skills/') || value.startsWith('themes/'))
        && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return value;
}

/**
 * Compose the per-run agent directory.
 *
 * @param {object} input {
 *   rootDir, runId, workspaceId,
 *   profileRevision, profileSourceDir (host profile, already on target fs),
 *   runtime (RuntimeDescriptor from ensureRuntime),
 *   credentialsDir (may be null), mntGuard (bool), guardConfig,
 * }
 * @returns {object} AgentDescriptor { agentDir, sessionDir, runDir, leaseRelease }
 */
function composeRunAgent(input) {
  const { rootDir, runId, workspaceId, runtime } = input;
  const runDir = path.join(rootDir, 'runs', runId);
  const agentDir = path.join(runDir, 'agent');
  fs.mkdirSync(agentDir, { recursive: true });

  // Profile snapshot (immutable, content-addressed).
  const snapshot = ensureProfileSnapshot(rootDir, input.profileSourceDir, input.profileRevision);

  for (const item of ['settings.json', 'models.json']) {
    const src = path.join(snapshot, item);
    if (!fs.existsSync(src)) continue;
    const parsed = JSON.parse(fs.readFileSync(src, 'utf8'));
    const rendered = renderJsonPaths(parsed, snapshot);
    fs.writeFileSync(path.join(agentDir, item), JSON.stringify(rendered, null, 2) + '\n');
  }
  for (const item of ['prompts', 'skills', 'themes']) {
    const src = path.join(snapshot, item);
    if (fs.existsSync(src)) {
      fs.cpSync(src, path.join(agentDir, item), { recursive: true });
    }
  }

  // Credentials: copied per run, never digested into body/profile revisions.
  if (input.credentialsDir) {
    const authSrc = path.join(input.credentialsDir, 'auth.json');
    if (fs.existsSync(authSrc)) {
      fs.copyFileSync(authSrc, path.join(agentDir, 'auth.json'));
    }
  }

  // Sessions: stable per-workspace directory, single-writer lease.
  const sessionDir = path.join(rootDir, 'sessions', workspaceId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const lease = acquireLease(path.join(rootDir, 'locks'), `session-${workspaceId}`, runId);
  linkDir(sessionDir, path.join(agentDir, 'sessions'));

  // Extensions: sealed runtime resources + guard, composed into THIS run.
  const extensionsDir = path.join(agentDir, 'extensions');
  fs.mkdirSync(extensionsDir, { recursive: true });
  if (runtime && runtime.resourcesRoot && fs.existsSync(runtime.resourcesRoot)) {
    for (const entry of fs.readdirSync(runtime.resourcesRoot)) {
      fs.cpSync(path.join(runtime.resourcesRoot, entry), path.join(extensionsDir, entry), { recursive: true });
    }
  }
  if (input.mntGuard !== false) {
    installGuard(agentDir, { config: input.guardConfig || null });
  } else {
    removeGuard(agentDir, { config: input.guardConfig || null });
  }

  return {
    agentDir,
    runDir,
    sessionDir,
    leaseRelease: lease.release,
  };
}

function acquireLease(locksDir, name, runId) {
  try {
    return acquireLock(locksDir, name, { purpose: `run ${runId}` });
  } catch (err) {
    if (err.code === 'LOCK_HELD') {
      const e = new Error(
        `SESSION_LOCKED: workspace session is already owned by another run (pid ${err.owner && err.owner.pid}). Stop it before starting a new backend on the same session.`
      );
      e.code = 'SESSION_LOCKED';
      throw e;
    }
    throw err;
  }
}

/**
 * Collect run state after exit. Change proposals in the run agent dir are
 * preserved for explicit review; nothing is auto-applied to the host profile.
 */
function collectRunState(rootDir, runId, result, deps = {}) {
  const runDir = path.join(rootDir, 'runs', runId);
  const resultPath = path.join(runDir, 'result.json');
  const record = {
    runId,
    exitCode: result.code ?? null,
    signal: result.signal || null,
    infraError: result.infraError || null,
    collected: true,
    collectedAt: new Date().toISOString(),
  };
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(resultPath, JSON.stringify(record, null, 2) + '\n');
  return record;
}

/** Mark a run uncollected (crash/interrupt) so GC and doctor keep its data. */
function markRunUncollected(rootDir, runId, reason) {
  const runDir = path.join(rootDir, 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, 'UNCOLLECTED'),
    JSON.stringify({ runId, reason: String(reason), at: new Date().toISOString() }) + '\n'
  );
}

function listUncollectedRuns(rootDir) {
  const runsDir = path.join(rootDir, 'runs');
  if (!fs.existsSync(runsDir)) return [];
  return fs.readdirSync(runsDir)
    .filter((d) => fs.existsSync(path.join(runsDir, d, 'UNCOLLECTED')))
    .map((d) => ({ runId: d, directory: path.join(runsDir, d) }));
}

module.exports = {
  PROFILE_ITEMS,
  hashProfile,
  ensureProfileSnapshot,
  renderJsonPaths,
  composeRunAgent,
  collectRunState,
  markRunUncollected,
  listUncollectedRuns,
};
