const fs = require('fs');
const { loadConfig } = require('../../config/load-config');
const { mergeConfig } = require('../../config/merge-config');
const { validateConfig } = require('../../config/schema');
const { getDefaultDistro, hasCommand } = require('../../platform/wsl');
const { isNtfsWorkspace } = require('../../platform/paths');
const { resolveAgentDir } = require('../../runtime/resolve-runtime');
const { log, warn, fatal } = require('../output');
const directExecutor = require('../../executors/direct-executor');
const sandboxExecutor = require('../../executors/sandbox-executor');

function ensureRuntimeDir(agentDir) {
  try {
    fs.mkdirSync(agentDir, { recursive: true });
  } catch (err) {
    fatal(`Failed to create runtime directory ${agentDir}: ${err.message}`);
  }
}

function applyCliOverrides(config, parsedArgs) {
  if (parsedArgs.execution) {
    config.execution = parsedArgs.execution;
  }
  if (parsedArgs.distro) {
    config.wsl = config.wsl || {};
    config.wsl.distro = parsedArgs.distro;
  }
}

async function execute(parsedArgs) {
  const cwd = process.cwd();
  const configs = loadConfig(cwd);
  const { config, warnings } = mergeConfig(configs);
  applyCliOverrides(config, parsedArgs);

  for (const message of warnings) {
    warn(message);
  }

  const validation = validateConfig(config);
  for (const message of validation.warnings) {
    warn(message);
  }
  if (!validation.valid) {
    for (const message of validation.errors) {
      fatal(message);
    }
  }

  const distro = config.wsl?.distro || getDefaultDistro();
  if (!distro) {
    fatal('Could not determine WSL distro. Set wsl.distro in ~/.pixrc.json or use --distro.');
  }

  const workspace = cwd;
  const agentDir = resolveAgentDir(config);

  if (isNtfsWorkspace(workspace)) {
    warn('Workspace is stored on Windows NTFS.');
    warn('Sandbox file operations may be slower.');
    warn('Recommended: move the repository under /home/<user>/projects.');
  }

  if (isNtfsWorkspace(agentDir)) {
    warn('Pi runtime is stored on Windows NTFS.');
    warn('Direct/Sandbox shared runtime performance may be slower.');
    warn('Recommended: set wsl.runtimeRoot to a path under /home/<user>.');
  }

  ensureRuntimeDir(agentDir);

  const execution = config.execution;

  if (execution === 'direct') {
    if (!hasCommand('pi', distro)) {
      fatal('pi is not installed in WSL. Install it before using --direct.');
    }
    return directExecutor.execute(workspace, agentDir, parsedArgs.piArgs, {
      dryRun: parsedArgs.dryRun,
    });
  }

  if (execution === 'sandbox') {
    return sandboxExecutor.execute(workspace, agentDir, parsedArgs.piArgs, config, {
      dryRun: parsedArgs.dryRun,
      rebuild: parsedArgs.rebuild,
      envAll: parsedArgs.envAll,
    });
  }

  fatal(`Unknown execution policy: ${execution}`);
}

module.exports = { execute };
