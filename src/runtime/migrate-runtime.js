const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { expandTilde, normalizeSlashes } = require('../platform/paths');

const MIGRATABLE_ITEMS = [
  'settings.json',
  'models.json',
  'auth.json',
  'sessions',
  'skills',
  'prompts',
  'themes',
];

const SKIP_ITEMS = [
  'npm',
  'git',
  'node_modules',
  'bin',
  'tools',
  'trust.json',
  'cache',
  'logs',
  'locks',
];

function getWindowsUsername() {
  const fromEnv = process.env.WINUSER || process.env.USERNAME;
  if (fromEnv && fromEnv !== 'root') {
    return fromEnv;
  }

  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Write-Output $env:USERNAME'], {
    encoding: 'utf8',
    shell: false,
    stdio: 'pipe',
  });

  if (result.status === 0 && result.stdout) {
    const name = result.stdout.trim();
    if (name) return name;
  }

  return null;
}

function resolveWindowsAgentDir(winUser) {
  const user = winUser || getWindowsUsername();
  if (!user) return null;
  return `/mnt/c/Users/${user}/.pi/agent`;
}

function resolveTargetAgentDir(config, homeDir) {
  const runtimeRoot = normalizeSlashes(expandTilde(config.wsl?.runtimeRoot || '~/.pix/runtime', homeDir));
  return path.posix.join(runtimeRoot, 'agent');
}

function migrate(sourceDir, targetDir, options = {}) {
  const { includeExtensions = false, dryRun = false } = options;

  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Source directory does not exist: ${sourceDir}`);
  }

  if (!dryRun) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  const results = [];

  for (const entry of entries) {
    const name = entry.name;
    const src = path.posix.join(sourceDir, name);
    const dst = path.posix.join(targetDir, name);

    if (name === 'extensions') {
      if (includeExtensions) {
        results.push({ item: name, action: 'migrate', src, dst });
        if (!dryRun) {
          fs.cpSync(src, dst, { recursive: true, force: true });
        }
      } else {
        results.push({ item: name, action: 'skip', reason: 'use --include-extensions to migrate custom extension source' });
      }
      continue;
    }

    if (SKIP_ITEMS.includes(name)) {
      results.push({ item: name, action: 'skip', reason: 'platform-specific runtime artifacts' });
      continue;
    }

    if (MIGRATABLE_ITEMS.includes(name)) {
      results.push({ item: name, action: 'migrate', src, dst });
      if (!dryRun) {
        if (entry.isDirectory()) {
          fs.cpSync(src, dst, { recursive: true, force: true });
        } else {
          fs.copyFileSync(src, dst);
        }
      }
      continue;
    }

    results.push({ item: name, action: 'ignore', reason: 'unknown item' });
  }

  return results;
}

module.exports = {
  MIGRATABLE_ITEMS,
  SKIP_ITEMS,
  getWindowsUsername,
  resolveWindowsAgentDir,
  resolveTargetAgentDir,
  migrate,
};
