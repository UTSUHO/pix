const os = require('os');
const path = require('path');
const { expandTilde, normalizeSlashes } = require('../platform/paths');

function resolveRuntimeRoot(config, homeDir = os.homedir()) {
  const raw = config.wsl?.runtimeRoot || '~/.pix/runtime';
  return normalizeSlashes(expandTilde(raw, homeDir));
}

function resolveAgentDir(config, homeDir = os.homedir()) {
  return path.posix.join(resolveRuntimeRoot(config, homeDir), 'agent');
}

module.exports = { resolveRuntimeRoot, resolveAgentDir };
