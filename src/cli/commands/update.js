const { resolveHostContext } = require('../../host/resolve-home');
const { updateHostBody } = require('../../host/update-body');
const { log, warn } = require('../output');

/**
 * pix update — Windows host maintenance command.
 *
 * Updates the managed Pi core and managed plugins on the HOST and publishes
 * an immutable release. Never bootstraps into WSL, never touches Docker:
 * backend copies go stale and are reported as pending by `pix status`.
 */
async function execute(parsedArgs, options = {}) {
  const ctx = resolveHostContext({ ensure: true });

  if (parsedArgs.piOnly && parsedArgs.pluginsOnly) {
    warn('--pi-only and --plugins-only are mutually exclusive.');
    return 2;
  }

  log(`Host: ${ctx.pixHome} (id ${ctx.hostId})`);

  try {
    const result = await updateHostBody(ctx, {
      piOnly: parsedArgs.piOnly,
      pluginsOnly: parsedArgs.pluginsOnly,
      dryRun: parsedArgs.dryRun,
    }, options.deps || {});

    for (const message of result.warnings || []) warn(message);

    reportComponent('pi', result.pi);
    for (const plugin of result.plugins) {
      reportComponent(`plugin:${plugin.id}`, plugin);
    }

    if (result.release) {
      if (result.release.dryRun) {
        log(`Dry run: release ${result.release.bodyRevision.slice(0, 12)} would be published (not activated).`);
      } else if (result.release.activated) {
        log(`Published release: ${result.release.bodyRevision.slice(0, 12)}`);
        if (result.release.previousRevision) {
          log(`Previous release:  ${result.release.previousRevision.slice(0, 12)} (kept for rollback)`);
        }
        log('Backend copies (WSL/Docker) are now pending until the next "pix run" or "pix deploy".');
      }
    } else {
      log('Nothing changed; current release unchanged.');
    }
    return 0;
  } catch (err) {
    if (err.code === 'LOCK_HELD') {
      warn(`Another update is in progress: ${err.message}`);
      return 70;
    }
    warn(`UPDATE_FAILED: ${err.message}`);
    warn('The current release was NOT changed.');
    return 71;
  }
}

function reportComponent(name, r) {
  switch (r.status) {
    case 'changed':
      log(`${name}: updated ${r.from || '(none)'} -> ${r.to}`);
      break;
    case 'unchanged':
      log(`${name}: already at ${r.to}`);
      break;
    case 'skipped':
      log(`${name}: skipped${r.reason ? ` (${r.reason})` : ' (pinned)'}`);
      break;
    case 'removed':
      log(`${name}: removed from spec`);
      break;
    case 'failed':
      warn(`${name}: FAILED ${r.error || ''}`);
      break;
    default:
      log(`${name}: ${r.status}${r.to ? ` -> ${r.to}` : ''}`);
  }
}

module.exports = { execute };
