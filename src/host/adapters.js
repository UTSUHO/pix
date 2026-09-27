const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

/**
 * Source adapters for Pi core and managed plugins. Every adapter takes an
 * injectable `deps.execFile` so tests can simulate npm/git without network.
 * Adapters never resolve "latest" on a target machine — resolution happens
 * only here, on the maintenance host, and the result is frozen into the
 * release manifest.
 */

function defaultExecFile(cmd, args, options = {}) {
  const stdout = execFileSync(cmd, args, {
    encoding: 'utf8',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  return { status: 0, stdout: stdout || '' };
}

/**
 * Locate npm's real entry point. On Windows `npm` on PATH is only npm.cmd,
 * and modern Node refuses to exec .cmd/.bat without a shell (EINVAL since
 * CVE-2024-27980), so a plain argv spawn fails with ENOENT/EINVAL. npm.cmd
 * itself just runs `node "<dir>/node_modules/npm/bin/npm-cli.js" %*`; when
 * that entry exists next to the running node.exe, invoke it directly.
 */
function resolveNpmCommand() {
  if (process.platform !== 'win32') return { command: 'npm', prefixArgs: [] };
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (fs.existsSync(npmCli)) return { command: process.execPath, prefixArgs: [npmCli] };
  return { command: 'npm', prefixArgs: [] };
}

/**
 * npm adapter: resolves exact versions + integrity, reads engines, and can
 * drive lock generation / frozen installs in a candidate directory.
 */
function createNpmAdapter(deps = {}) {
  const execFile = deps.execFile || defaultExecFile;
  // Windows npm is npm.cmd; modern Node refuses to spawn .cmd without a
  // shell (EINVAL, CVE-2024-27980). Prefer the npm-cli.js next to node.exe.
  const npmCmd = deps.npmBin
    ? { command: deps.npmBin, prefixArgs: [] }
    : resolveNpmCommand();

  function npmExec(args, options = {}) {
    return execFile(npmCmd.command, [...npmCmd.prefixArgs, ...args], options);
  }

  function view(args, options = {}) {
    const result = npmExec(['view', ...args], options);
    if (result.status !== 0) {
      throw new Error(`npm view ${args.join(' ')} failed`);
    }
    return result.stdout.trim();
  }

  return {
    kind: 'npm',
    resolve(packageName, range = 'latest') {
      const version = view([`${packageName}@${range}`, 'version']);
      // `npm view pkg@range version` may print multiple lines for ranges;
      // take the last (highest) resolved version.
      const exactVersion = version.split(/\r?\n/).filter(Boolean).pop();
      let integrity = null;
      try {
        integrity = view([`${packageName}@${exactVersion}`, 'dist.integrity']) || null;
      } catch {
        integrity = null;
      }
      return { exactVersion, packageIntegrity: integrity };
    },
    engines(packageName, version) {
      try {
        const raw = view([`${packageName}@${version}`, 'engines', '--json']);
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch {
        return {};
      }
    },
    /** Generate a lockfile without installing (candidate dir, controlled env). */
    generateLock(candidateDir, env) {
      const result = npmExec(
        ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'],
        { cwd: candidateDir, env }
      );
      if (result.status !== 0) throw new Error('npm lockfile generation failed');
    },
    /** Frozen install from an existing consistent lock. Never resolves versions. */
    ciInstall(candidateDir, env, extraFlags = []) {
      const result = npmExec(
        ['ci', '--ignore-scripts', '--no-audit', '--no-fund', ...extraFlags],
        { cwd: candidateDir, env }
      );
      if (result.status !== 0) throw new Error('npm ci failed');
    },
    version() {
      const result = npmExec(['--version']);
      return result.status === 0 ? result.stdout.trim() : null;
    },
  };
}

/** git adapter: resolves tags/branches to commit IDs. Never pulls into user dirs. */
function createGitAdapter(deps = {}) {
  const execFile = deps.execFile || defaultExecFile;
  const gitBin = deps.gitBin || 'git';
  return {
    kind: 'git',
    resolveCommit(locator, ref = 'HEAD') {
      const result = execFile(gitBin, ['ls-remote', locator, ref]);
      if (result.status !== 0 || !result.stdout.trim()) {
        throw new Error(`git ls-remote ${locator} ${ref} failed`);
      }
      const commit = result.stdout.split(/\s+/)[0];
      return { resolvedCommit: commit };
    },
  };
}

/** local adapter: seals a source snapshot with a content digest. Never mutates the source. */
function createLocalAdapter() {
  function hashDirectory(root) {
    const files = [];
    (function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '.git') continue;
          walk(full);
        } else if (entry.isFile()) {
          const rel = path.relative(root, full).split(path.sep).join('/');
          const digest = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
          files.push({ path: rel, digest });
        }
      }
    })(root);
    const sourceDigest = crypto
      .createHash('sha256')
      .update(files.map((f) => `${f.path}:${f.digest}`).join('\n'))
      .digest('hex');
    return { sourceDigest, files };
  }

  function sealSnapshot(sourceDir, destDir) {
    const { sourceDigest, files } = hashDirectory(sourceDir);
    fs.rmSync(destDir, { recursive: true, force: true });
    for (const f of files) {
      const dest = path.join(destDir, f.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(sourceDir, f.path), dest);
    }
    return { sourceDigest, fileCount: files.length };
  }

  return { kind: 'local', hashDirectory, sealSnapshot };
}

function createAdapters(deps = {}) {
  return {
    npm: createNpmAdapter(deps),
    git: createGitAdapter(deps),
    local: createLocalAdapter(deps),
  };
}

module.exports = { createNpmAdapter, createGitAdapter, createLocalAdapter, createAdapters, defaultExecFile, resolveNpmCommand };
