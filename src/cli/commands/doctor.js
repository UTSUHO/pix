const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveHostContext, readPublishedBody } = require('../../host/resolve-home');
const { listUncollectedRuns } = require('../../runtime/compose-agent');
const { collectBodyGarbage } = require('../../runtime/gc');
const { readHostLink } = require('../../host/bridge');
const { isInsideWsl, getDefaultDistro } = require('../../platform/wsl');
const { resolveMutagenPath, getMutagenVersion, listPixSessions } = require('../../workspace/mutagen');
const { detectCopyTool } = require('../../workspace/projection');
const { loadConfig } = require('../../config/load-config');
const { mergeConfig } = require('../../config/merge-config');

/**
 * pix doctor — environment diagnostics with recovery guidance.
 * Checks: host layout, published release integrity, Node/Pi requirements,
 * target tooling, real filesystem placement, sync tool state, uncollected
 * runs and GC-safe cleanup candidates.
 */
async function execute(parsedArgs, options = {}) {
  const out = options.print || console.log;
  const problems = [];

  const ctx = resolveHostContext({ ensure: false });
  check(out, problems, ctx.hostId != null,
    `Host initialized (${ctx.pixHome})`,
    `Host not initialized. Run "pix update" to create ${ctx.pixHome}.`);

  const published = readPublishedBody(ctx);
  check(out, problems, published != null,
    'A body release is published',
    'No published body. Run "pix update".');

  if (published) {
    const dir = published.directory;
    check(out, problems,
      fs.existsSync(path.join(dir, 'package-lock.json')) && fs.existsSync(path.join(dir, 'node_modules')),
      `Release ${published.manifest.bodyRevision.slice(0, 12)} has lock + install`,
      `Release directory incomplete: ${dir}. Re-run "pix update".`);

    // Host Node vs Pi engines.
    const engines = published.manifest.pi.nodeRequirement;
    if (engines) {
      const semver = require('../../host/semver');
      check(out, problems, semver.satisfies(process.versions.node, engines),
        `Host Node ${process.versions.node} satisfies Pi requirement "${engines}"`,
        `Host Node ${process.versions.node} does NOT satisfy Pi requirement "${engines}". Install a compatible Node; pix does not upgrade system Node automatically.`);
    }
  }

  // Tooling.
  check(out, problems, detectCopyTool() === 'rsync',
    'rsync available for workspace projection',
    'rsync missing; projection will fall back to cp (slower, no incremental delete-align).');
  const mutagenPath = resolveMutagenPath();
  if (mutagenPath) {
    out(`  ok: mutagen ${getMutagenVersion(mutagenPath) || 'unknown'} at ${mutagenPath}`);
    const sessions = listPixSessions(mutagenPath);
    for (const s of sessions) {
      out(`  note: mutagen session "${s}" exists (stale sessions hold workspace copies; terminate if unused).`);
    }
  } else {
    out('  note: mutagen not installed; sync falls back to one-shot projection.');
  }

  // Docker (only relevant for sandbox users).
  const configs = loadConfig(process.cwd());
  const { config } = mergeConfig(configs);
  if (config.execution === 'sandbox') {
    const docker = spawnSync('docker', ['--version'], { encoding: 'utf8', shell: false, stdio: 'pipe' });
    check(out, problems, docker.status === 0,
      'docker available for sandbox backend',
      'sandbox execution configured but docker is unavailable.');
  }

  // Target-side state (local when inside WSL).
  if (isInsideWsl()) {
    const root = path.join(process.env.HOME, '.pix');
    const link = readHostLink();
    check(out, problems, link != null,
      `Host binding present (host ${link && link.hostId})`,
      'No host binding (~/.pix/host-link.json). Management commands from WSL fail closed. Deploy from the host to create it.');
    const uncollected = listUncollectedRuns(root);
    for (const run of uncollected) {
      problems.push('uncollected-run');
      out(`  PROBLEM: uncollected run ${run.runId} at ${run.directory}`);
      out('    recovery: the run directory is preserved; review and remove manually after recovering changes.');
    }
  } else {
    const distro = parsedArgs.distro || config.wsl?.distro || getDefaultDistro();
    if (!distro) {
      out('  note: no WSL distro detected from host; backend checks skipped.');
    }
  }

  // GC dry report.
  if (published) {
    const root = isInsideWsl() ? path.join(process.env.HOME, '.pix') : null;
    if (root && fs.existsSync(root)) {
      const current = readPublishedBody(ctx);
      out(`  note: GC would protect current release ${current.manifest.bodyRevision.slice(0, 12)} and referenced installs/workspaces/sessions.`);
    }
  }

  if (problems.length === 0) {
    out('No problems found.');
  } else {
    out(`${problems.length} problem(s) found.`);
    return 1;
  }
  return 0;
}

function check(out, problems, ok, okMessage, problemMessage) {
  if (ok) {
    out(`  ok: ${okMessage}`);
  } else {
    problems.push(problemMessage);
    out(`  PROBLEM: ${problemMessage}`);
  }
}

module.exports = { execute };
