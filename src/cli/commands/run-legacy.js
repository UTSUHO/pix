/**
 * Explicit legacy pipeline (v0.3 behavior), kept as a clearly-labeled
 * compatibility path: `pix --legacy`.
 *
 * Scope: direct execution in WSL with the PATH-resolved pi and the shared
 * agentDir, plus the old one-shot projection/mirror-back workspace handling.
 * Legacy sandbox mode is NOT preserved — the old mutable-tag image cannot
 * satisfy version consistency; use the managed pipeline for sandbox.
 */
const { loadConfig } = require('../../config/load-config');
const { mergeConfig } = require('../../config/merge-config');
const { validateConfig } = require('../../config/schema');
const { getDefaultDistro, hasCommand } = require('../../platform/wsl');
const { isNtfsWorkspace } = require('../../platform/paths');
const { resolveAgentDir } = require('../../runtime/resolve-runtime');
const { installGuard, removeGuard } = require('../../runtime/install-guard');
const { isProjectionNeeded } = require('../../workspace/projection');
const { prepareWorkspace, cleanupWorkspace } = require('../../workspace/sync');
const { run } = require('../../process/spawn');
const { log, warn, fatal } = require('../output');
const fs = require('fs');

async function execute(parsedArgs) {
  const sourceWorkspace = process.cwd();
  const configs = loadConfig(sourceWorkspace);
  const { config, warnings } = mergeConfig(configs);
  if (parsedArgs.execution) config.execution = parsedArgs.execution;

  for (const message of warnings) warn(message);
  const validation = validateConfig(config);
  for (const message of validation.warnings) warn(message);
  if (!validation.valid) {
    for (const message of validation.errors) fatal(message);
  }

  if (config.execution === 'sandbox') {
    fatal('Legacy sandbox mode is not supported. The managed pipeline builds version-locked images; run without --legacy.');
  }

  const distro = config.wsl?.distro || getDefaultDistro();
  if (!distro) fatal('Could not determine WSL distro.');

  const agentDir = resolveAgentDir(config);
  if (isNtfsWorkspace(agentDir)) {
    warn('Pi runtime is stored on Windows NTFS; performance may be slower.');
  }
  fs.mkdirSync(agentDir, { recursive: true });

  const mntGuardEnabled = parsedArgs.mntGuard !== false;
  try {
    if (mntGuardEnabled) installGuard(agentDir, { config });
    else removeGuard(agentDir, { config });
  } catch (err) {
    warn(`Failed to ${mntGuardEnabled ? 'install' : 'remove'} the guard extension: ${err.message}`);
  }

  let desc = null;
  if (isProjectionNeeded(sourceWorkspace, config)) {
    desc = prepareWorkspace(sourceWorkspace, config, {
      dryRun: parsedArgs.dryRun,
      allowRawWorkspace: parsedArgs.allowRawWorkspace,
    });
  } else {
    desc = { cleanupHandle: { strategy: 'none' }, executionRoot: sourceWorkspace };
  }

  if (!hasCommand('pi', distro)) {
    fatal('pi is not installed in WSL. Install it, or use the managed pipeline ("pix update" then "pix").');
  }

  try {
    if (parsedArgs.dryRun) {
      console.error(`[pix] cd ${desc.executionRoot}`);
      console.error(`[pix] PI_CODING_AGENT_DIR=${agentDir} pi ${parsedArgs.piArgs.join(' ')}`);
      return 0;
    }
    const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
    const result = await run('pi', parsedArgs.piArgs, {
      cwd: desc.executionRoot,
      env,
      shell: false,
    });
    return result.code ?? 0;
  } finally {
    try {
      cleanupWorkspace(desc, config, { dryRun: parsedArgs.dryRun });
    } catch (err) {
      warn(`Failed to clean up workspace: ${err.message}`);
    }
  }
}

module.exports = { execute };
