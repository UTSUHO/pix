const fs = require('fs');
const os = require('os');
const path = require('path');
const { DEFAULTS } = require('./defaults');

const MIGRATION_KEYS = ['wsl', 'execution', 'workspace', 'container', 'envAllowlist'];

function getUserConfigPath() {
  return path.join(os.homedir(), '.pixrc.json');
}

function normalizeConfig(rawUserConfig = {}, rawProjectConfig = {}) {
  const result = {};

  for (const key of MIGRATION_KEYS) {
    const userVal = rawUserConfig[key];
    const projectVal = rawProjectConfig[key];

    if (projectVal !== undefined) {
      result[key] = projectVal;
    } else if (userVal !== undefined) {
      result[key] = userVal;
    } else {
      result[key] = DEFAULTS[key];
    }
  }

  return result;
}

function shouldMigrate(rawUserConfig) {
  if (!rawUserConfig || Object.keys(rawUserConfig).length === 0) {
    return true;
  }

  for (const key of MIGRATION_KEYS) {
    if (rawUserConfig[key] === undefined) {
      return true;
    }
  }

  return false;
}

function migrateUserConfig(rawUserConfig = {}, rawProjectConfig = {}) {
  const normalized = normalizeConfig(rawUserConfig, rawProjectConfig);
  const configPath = getUserConfigPath();

  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(configPath, JSON.stringify(normalized, null, 2) + '\n', 'utf8');

  return normalized;
}

module.exports = {
  getUserConfigPath,
  normalizeConfig,
  shouldMigrate,
  migrateUserConfig,
};
