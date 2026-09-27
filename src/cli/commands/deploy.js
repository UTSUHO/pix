const { resolveHostContext } = require('../../host/resolve-home');
const { deployToTarget } = require('../../host/orchestrate');
const { createTarget } = require('../../platform/target');
const { getDefaultDistro } = require('../../platform/wsl');
const { loadConfig } = require('../../config/load-config');
const { mergeConfig } = require('../../config/merge-config');
const { log, warn } = require('../output');

/**
 * pix deploy — stage the CURRENTLY published host release onto a backend
 * (runner + release + profile + credentials + host link). Never picks new
 * versions: deployment only materializes what `pix update` published.
 */
async function execute(parsedArgs, options = {}) {
  const ctx = resolveHostContext({ ensure: true });
  const configs = loadConfig(process.cwd());
  const { config } = mergeConfig(configs);

  const targetName = parsedArgs.target || 'wsl';
  if (!['wsl', 'docker', 'local'].includes(targetName)) {
    warn(`Unknown deploy target "${targetName}". Use wsl, docker or local.`);
    return 2;
  }

  // docker deploys through the WSL target as well (the image build happens
  // runner-side at exec time, from the same staged release).
  const targetType = targetName === 'local' ? 'local' : 'wsl';

  let target;
  try {
    if (targetType === 'local') {
      target = createTarget({ type: 'local', ...(options.localTarget || {}) });
    } else {
      const distro = parsedArgs.distro || config.wsl?.distro || getDefaultDistro();
      if (!distro) {
        warn('Could not determine WSL distro. Set wsl.distro or use --distro.');
        return 2;
      }
      target = createTarget({ type: 'wsl', distro, ...(options.wslTarget || {}) });
    }
  } catch (err) {
    warn(`RUNTIME_DEPLOY_FAILED: ${err.message}`);
    return 75;
  }

  try {
    const result = deployToTarget(ctx, target, options.deploy || {});
    log(`Target: ${target.type}${target.distro ? ` (${target.distro})` : ''} home=${target.home}`);
    log(`Runner: ${result.runner.name} (${result.runner.deployed ? 'deployed' : 'up to date'})`);
    log(`Body: ${result.bodyRevision.slice(0, 12)} (${result.releaseStaged ? 'staged' : 'already present'})`);
    log(`Profile: ${result.profileRevision.slice(0, 12)} (${result.profileStaged ? 'staged' : 'already present'})`);
    log(`Credentials: ${result.credentialsStaged ? 'staged' : 'none to stage'}`);
    return 0;
  } catch (err) {
    warn(err.message || String(err));
    return err.code === 'RUNTIME_DEPLOY_FAILED' ? 75 : 1;
  }
}

module.exports = { execute };
