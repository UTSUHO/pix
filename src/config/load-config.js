const fs = require('fs');
const path = require('path');
const os = require('os');

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

  return {
    user: readJsonSafe(userConfigPath) || {},
    project: readJsonSafe(projectConfigPath) || {},
  };
}

module.exports = { loadConfig, readJsonSafe };
