const fs = require('fs');
const path = require('path');
const os = require('os');
const { DEFAULTS } = require('./defaults');
const { shouldMigrate, migrateUserConfig } = require('./migrate-config');

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function loadConfig(cwd) {
  // v0.4: the host PIX_HOME config.json is the authoritative user config.
  // ~/.pixrc.json remains as a legacy fallback so existing setups keep working.
  let pixHomeConfig = null;
  try {
    const { resolvePixHome } = require('../host/resolve-home');
    pixHomeConfig = path.join(resolvePixHome(), 'config.json');
  } catch {
    pixHomeConfig = null;
  }
  const legacyUserConfigPath = path.join(os.homedir(), '.pixrc.json');
  const projectConfigPath = path.join(cwd, '.pix.json');

  const pixHomeRaw = pixHomeConfig ? readJsonSafe(pixHomeConfig) : null;
  const rawUserConfig = pixHomeRaw || readJsonSafe(legacyUserConfigPath) || {};
  const projectConfig = readJsonSafe(projectConfigPath) || {};

  // Auto-normalization only rewrites the LEGACY file it read from; the
  // PIX_HOME config is authoritative and never silently rewritten.
  const userConfig = !pixHomeRaw && shouldMigrate(rawUserConfig)
    ? migrateUserConfig(rawUserConfig, projectConfig)
    : rawUserConfig;

  return {
    user: userConfig,
    project: projectConfig,
  };
}

module.exports = { loadConfig, readJsonSafe };
