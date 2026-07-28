const fs = require('fs');
const { loadConfig } = require('../../config/load-config');
const { mergeConfig } = require('../../config/merge-config');
const { validateConfig } = require('../../config/schema');
const { getDefaultDistro, hasCommand } = require('../../platform/wsl');
const { isNtfsWorkspace } = require('../../platform/paths');
const { resolveAgentDir } = require('../../runtime/resolve-runtime');
const {
  isProjectionNeeded,
} = require('../../workspace/projection');
const { prepareWorkspace, cleanupWorkspace } = require('../../workspace/sync');
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
  if (parsedArgs.noProjection) {
    config.workspace = config.workspace || {};
    config.workspace.projection = false;
  }
  if (parsedArgs.mirrorBack) {
    config.workspace = config.workspace || {};
    config.workspace.mirrorBack = true;
  }

  if (parsedArgs.noMirrorBack) {
    config.workspace = config.workspace || {};
    config.workspace.mirrorBack = false;
  }

  if (parsedArgs.sync !== null) {
    config.workspace = config.workspace || {};
    config.workspace.sync = config.workspace.sync || {};
    config.workspace.sync.enabled = parsedArgs.sync;
  }
  if (parsedArgs.syncStrategy) {
    config.workspace = config.workspace || {};
    config.workspace.sync = config.workspace.sync || {};
    config.workspace.sync.strategy = parsedArgs.syncStrategy;
  }
  if (parsedArgs.syncKeepAlive) {
    config.workspace = config.workspace || {};
    config.workspace.sync = config.workspace.sync || {};
    config.workspace.sync.keepAlive = parsedArgs.syncKeepAlive;
  }
  if (parsedArgs.syncMode) {
    config.workspace = config.workspace || {};
    config.workspace.sync = config.workspace.sync || {};
    config.workspace.sync.mode = parsedArgs.syncMode;
  }
}

async function execute(parsedArgs) {
  const sourceWorkspace = process.cwd();
  const configs = loadConfig(sourceWorkspace);
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

  const agentDir = resolveAgentDir(config);

  if (isNtfsWorkspace(agentDir)) {
    warn('Pi runtime is stored on Windows NTFS.');
    warn('Direct/Sandbox shared runtime performance may be slower.');
    warn('Recommended: set wsl.runtimeRoot to a path under /home/<user>.');
  }

  ensureRuntimeDir(agentDir);

  let effectiveWorkspace = sourceWorkspace;
  const projectionNeeded = isProjectionNeeded(sourceWorkspace, config);
  let syncStrategy = 'none';

  if (projectionNeeded) {
    try {
      const result = prepareWorkspace(sourceWorkspace, config, {
        dryRun: parsedArgs.dryRun,
      });
      effectiveWorkspace = result.effectiveWorkspace;
      syncStrategy = result.strategy;
    } catch (err) {
      warn(`Failed to prepare workspace: ${err.message}`);
      warn('Falling back to the original Windows path.');
      effectiveWorkspace = sourceWorkspace;
      syncStrategy = 'none';
    }
  } else if (isNtfsWorkspace(sourceWorkspace)) {
    warn('Workspace is stored on Windows NTFS and projection is disabled.');
    warn('Sandbox file operations may be slower.');
    warn('Recommended: enable workspace.projection or move the repository under /home/<user>/projects.');
  }

  const execution = config.execution;

  try {
    if (execution === 'direct') {
      if (!hasCommand('pi', distro)) {
        fatal('pi is not installed in WSL. Install it before using --direct.');
      }
      return await directExecutor.execute(effectiveWorkspace, agentDir, parsedArgs.piArgs, {
        dryRun: parsedArgs.dryRun,
      });
    }

    if (execution === 'sandbox') {
      return await sandboxExecutor.execute(effectiveWorkspace, agentDir, parsedArgs.piArgs, config, {
        dryRun: parsedArgs.dryRun,
        rebuild: parsedArgs.rebuild,
        envAll: parsedArgs.envAll,
      });
    }

    fatal(`Unknown execution policy: ${execution}`);
  } finally {
    if (projectionNeeded && effectiveWorkspace !== sourceWorkspace) {
      try {
        cleanupWorkspace(effectiveWorkspace, sourceWorkspace, config, {
          dryRun: parsedArgs.dryRun,
        }, syncStrategy);
      } catch (err) {
        warn(`Failed to clean up workspace: ${err.message}`);
      }
    }
  }
}

module.exports = { execute };
