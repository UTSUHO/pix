const fs = require('fs');
const path = require('path');
const { resolveHostContext, readPublishedBody, readCurrentRelease } = require('../../host/resolve-home');
const { readSpec } = require('../../host/update-body');
const { listUncollectedRuns } = require('../../runtime/compose-agent');
const { readHostLink } = require('../../host/bridge');
const { getDefaultDistro, hasCommand, isInsideWsl } = require('../../platform/wsl');
const { loadConfig } = require('../../config/load-config');
const { mergeConfig } = require('../../config/merge-config');

/**
 * pix status — host-centric summary.
 * Shows the host release, per-target ready revisions (when reachable),
 * pending/stale state, and uncollected runs. Never reports "all updated"
 * when a backend lags behind the host release.
 */
async function execute(parsedArgs, options = {}) {
  const ctx = resolveHostContext({ ensure: false });
  const out = options.print || console.log;

  out(`Pix home: ${ctx.pixHome}`);
  out(`Host id: ${ctx.hostId || '(not initialized — run "pix update")'}`);

  const current = readCurrentRelease(ctx);
  const published = current ? readPublishedBody(ctx) : null;
  if (published) {
    out(`Host body release: ${published.manifest.bodyRevision.slice(0, 12)}`);
    out(`  Pi: ${published.manifest.pi.packageName}@${published.manifest.pi.exactVersion}`);
    for (const p of published.manifest.plugins || []) {
      out(`  Plugin ${p.id}: ${p.resolvedVersion || p.resolvedCommit || (p.sourceDigest || '').slice(0, 12)} (${p.sourceKind})`);
    }
    if (current.previousRevision) {
      out(`  Previous release (rollback): ${current.previousRevision.slice(0, 12)}`);
    }
  } else {
    out('Host body release: (none — run "pix update")');
  }

  const { spec } = readSpec(ctx);
  out(`Spec: pi=${spec.pi.packageName}@${spec.pi.range} (${spec.pi.updatePolicy || 'latest'}), ${(spec.plugins || []).length} plugin(s)`);

  // Backend state (best-effort; unreachability is reported, not fatal).
  const configs = loadConfig(process.cwd());
  const { config } = mergeConfig(configs);
  const distro = parsedArgs.distro || config.wsl?.distro || getDefaultDistro();
  out(`Backend (WSL): ${distro || 'unavailable'}`);

  if (isInsideWsl()) {
    reportLocalTarget(out, process.env.HOME, published);
    const link = readHostLink();
    out(`Host binding: ${link ? `host ${link.hostId}` : 'none (management commands will fail closed)'}`);
  } else if (distro && options.probeTarget !== false) {
    try {
      const { createTarget } = require('../../platform/target');
      const target = createTarget({ type: 'wsl', distro });
      reportLocalTarget(out, target.home, published, target);
    } catch (err) {
      out(`  Target probe unavailable: ${err.message}`);
    }
  }

  return 0;
}

function reportLocalTarget(out, home, published, target = null) {
  const root = path.join(home, '.pix');
  const runtimesDir = path.join(root, 'runtimes');
  const readEntry = (p) => (target ? safeRead(target, p) : safeReadLocal(p));

  let readyRevisions = [];
  if (target ? target.existsOnTarget(runtimesDir) : fs.existsSync(runtimesDir)) {
    // Ready revisions are derivable from releases + ready markers; we list
    // ready.json bodyRevision values without walking node_modules.
    const listCmd = target ? null : fs.readdirSync(runtimesDir);
    if (listCmd) {
      for (const entry of listCmd) {
        const ready = readEntry(path.join(runtimesDir, entry, 'ready.json'));
        if (ready) {
          try {
            readyRevisions.push(JSON.parse(ready).bodyRevision);
          } catch { /* ignore */ }
        }
      }
    }
  }

  if (!published) return;
  const current = published.manifest.bodyRevision;
  if (readyRevisions.length === 0) {
    out(`  Target runtimes: none ready — ${current.slice(0, 12)} pending`);
  } else {
    for (const rev of readyRevisions) {
      const state = rev === current ? 'ready (current)' : `ready (STALE — host has ${current.slice(0, 12)})`;
      out(`  Target runtime: ${rev.slice(0, 12)} ${state}`);
    }
    if (!readyRevisions.includes(current)) {
      out(`  NOTE: host release ${current.slice(0, 12)} is pending on this target.`);
    }
  }

  const uncollected = target ? [] : listUncollectedRuns(root);
  for (const run of uncollected) {
    out(`  UNCOLLECTED run: ${run.runId} (${run.directory})`);
  }
}

function safeReadLocal(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function safeRead(target, p) {
  try {
    return target.readFileOnTarget(p);
  } catch {
    return null;
  }
}

module.exports = { execute };
