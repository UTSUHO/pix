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
  const userConfigPath = path.join(os.homedir(), '.pixrc.json');
  const projectConfigPath = path.join(cwd, '.pix.json');

  const rawUserConfig = readJsonSafe(userConfigPath) || {};
  const projectConfig = readJsonSafe(projectConfigPath) || {};

  const userConfig = shouldMigrate(rawUserConfig)
    ? migrateUserConfig(rawUserConfig, projectConfig)
    : rawUserConfig;

  return {
    user: userConfig,
    project: projectConfig,
  };
}

module.exports = { loadConfig, readJsonSafe };
