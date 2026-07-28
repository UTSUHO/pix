const { DEFAULTS } = require('./defaults');

const VALID_EXECUTION = new Set(['direct', 'sandbox']);
const VALID_NETWORKS = new Set(['bridge', 'none', 'host']);
const VALID_SYNC_STRATEGIES = new Set(['mutagen', 'projection']);
const VALID_SYNC_KEEP_ALIVE = new Set(['terminate', 'pause', 'running']);
const VALID_SYNC_MODES = new Set(['two-way-safe', 'two-way-resolved', 'one-way-safe', 'one-way-replica']);

function validateConfig(config) {
  const errors = [];
  const warnings = [];

  if (!VALID_EXECUTION.has(config.execution)) {
    errors.push(`Invalid execution policy "${config.execution}". Must be "direct" or "sandbox".`);
  }

  if (config.wsl && config.wsl.runtimeRoot && typeof config.wsl.runtimeRoot !== 'string') {
    errors.push('wsl.runtimeRoot must be a string.');
  }

  if (config.container) {
    if (config.container.network && !VALID_NETWORKS.has(config.container.network)) {
      errors.push(`Invalid container.network "${config.container.network}".`);
    }

    if (config.container.workspaceAccess && !['read-write', 'read-only'].includes(config.container.workspaceAccess)) {
      errors.push(`Invalid container.workspaceAccess "${config.container.workspaceAccess}".`);
    }

    if (!Array.isArray(config.container.extraRunOptions)) {
      errors.push('container.extraRunOptions must be an array.');
    }
  }

  if (!Array.isArray(config.envAllowlist)) {
    errors.push('envAllowlist must be an array.');
  }

  if (config.workspace) {
    if (config.workspace.projection !== undefined && typeof config.workspace.projection !== 'boolean') {
      errors.push('workspace.projection must be a boolean.');
    }

    if (config.workspace.projectionRoot !== undefined && typeof config.workspace.projectionRoot !== 'string') {
      errors.push('workspace.projectionRoot must be a string.');
    }

    if (config.workspace.mirrorBack !== undefined && typeof config.workspace.mirrorBack !== 'boolean') {
      errors.push('workspace.mirrorBack must be a boolean.');
    }

    if (config.workspace.exclude !== undefined && !Array.isArray(config.workspace.exclude)) {
      errors.push('workspace.exclude must be an array.');
    }

    if (config.workspace.sync !== undefined) {
      const sync = config.workspace.sync;
      if (typeof sync !== 'object' || Array.isArray(sync)) {
        errors.push('workspace.sync must be an object.');
      } else {
        if (sync.enabled !== undefined && typeof sync.enabled !== 'boolean') {
          errors.push('workspace.sync.enabled must be a boolean.');
        }
        if (sync.strategy !== undefined && !VALID_SYNC_STRATEGIES.has(sync.strategy)) {
          errors.push(`Invalid workspace.sync.strategy "${sync.strategy}". Must be "mutagen" or "projection".`);
        }
        if (sync.keepAlive !== undefined && !VALID_SYNC_KEEP_ALIVE.has(sync.keepAlive)) {
          errors.push(`Invalid workspace.sync.keepAlive "${sync.keepAlive}". Must be "terminate", "pause", or "running".`);
        }
        if (sync.mode !== undefined && !VALID_SYNC_MODES.has(sync.mode)) {
          errors.push(`Invalid workspace.sync.mode "${sync.mode}". Must be one of: ${Array.from(VALID_SYNC_MODES).join(', ')}.`);
        }
        if (sync.exclude !== undefined && !Array.isArray(sync.exclude)) {
          errors.push('workspace.sync.exclude must be an array.');
        }
      }
    }
  }

  if (!config.wsl || !config.wsl.distro) {
    warnings.push('No WSL distro configured. Pix will use the default WSL distro.');
  }

  return { valid: errors.length === 0, errors, warnings };
}

module.exports = { validateConfig };
