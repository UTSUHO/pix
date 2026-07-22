const os = require('os');
const path = require('path');

function expandTilde(input, homeDir = os.homedir()) {
  if (typeof input !== 'string') return input;
  if (input === '~') return homeDir;
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(homeDir, input.slice(2));
  }
  return input;
}

function normalizeSlashes(input) {
  return input.replace(/\\/g, '/');
}

function isMntPath(input) {
  const normalized = normalizeSlashes(input);
  return normalized.startsWith('/mnt/');
}

function classifyPath(input) {
  if (typeof input !== 'string') return 'unknown';
  const normalized = normalizeSlashes(input);

  if (normalized.startsWith('//wsl$') || normalized.startsWith('//wsl.localhost')) {
    return 'wsl-unc';
  }

  if (/^[a-zA-Z]:/.test(input) || normalized.startsWith('/mnt/')) {
    return 'windows';
  }

  if (normalized.startsWith('/home/') || normalized.startsWith('/root/') || normalized.startsWith('/tmp/')) {
    return 'wsl';
  }

  if (normalized.startsWith('/')) {
    return 'linux';
  }

  return 'unknown';
}

function isNtfsWorkspace(input) {
  return isMntPath(input);
}

function isWslUncPath(input) {
  return classifyPath(input) === 'wsl-unc';
}

module.exports = {
  expandTilde,
  normalizeSlashes,
  isMntPath,
  classifyPath,
  isNtfsWorkspace,
  isWslUncPath,
};
