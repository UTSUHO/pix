const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { isNtfsWorkspace, normalizeSlashes, expandTilde } = require('../platform/paths');
const { log, warn } = require('../cli/output');

function detectCopyTool() {
  const result = spawnSync('sh', ['-c', 'command -v rsync'], {
    encoding: 'utf8',
    shell: false,
    stdio: 'pipe',
  });
  if (result.status === 0 && result.stdout && result.stdout.trim().length > 0) {
    return 'rsync';
  }
  return 'cp';
}

function isProjectionNeeded(sourcePath, config) {
  if (config.workspace?.projection === false) return false;
  return isNtfsWorkspace(sourcePath);
}

function resolveProjectionRoot(config, homeDir) {
  const raw = config.workspace?.projectionRoot || '~/.pix/workspaces';
  return normalizeSlashes(expandTilde(raw, homeDir));
}

function computeProjectionId(sourcePath) {
  const normalized = normalizeSlashes(sourcePath);
  const base = path.posix.basename(normalized) || 'workspace';
  const hash = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 8);
  return `${base}-${hash}`;
}

function resolveProjectedPath(sourcePath, config, homeDir) {
  const projectionRoot = resolveProjectionRoot(config, homeDir);
  const projectionId = computeProjectionId(sourcePath);
  return path.posix.join(projectionRoot, projectionId);
}

function buildRsyncArgs(sourcePath, targetPath, excludes) {
  const args = ['-a', '--delete'];
  for (const exclude of excludes || []) {
    args.push('--exclude', exclude);
  }
  args.push(`${sourcePath}/`, `${targetPath}/`);
  return args;
}

function buildCpCommand(sourcePath, targetPath) {
  return `cp -a "${sourcePath}/." "${targetPath}/"`;
}

function runCopy(sourcePath, targetPath, tool, excludes, dryRun) {
  if (dryRun) {
    if (tool === 'rsync') {
      console.log(['rsync', ...buildRsyncArgs(sourcePath, targetPath, excludes)].map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' '));
    } else {
      console.log(buildCpCommand(sourcePath, targetPath));
    }
    return { status: 0 };
  }

  if (tool === 'rsync') {
    return spawnSync('rsync', buildRsyncArgs(sourcePath, targetPath, excludes), {
      stdio: 'inherit',
      shell: false,
    });
  }

  // cp fallback: clear target and do a full copy
  fs.rmSync(targetPath, { recursive: true, force: true });
  fs.mkdirSync(targetPath, { recursive: true });
  return spawnSync('cp', ['-a', `${sourcePath}/.`, `${targetPath}/`], {
    stdio: 'inherit',
    shell: false,
  });
}

function projectWorkspace(sourcePath, config, options = {}) {
  const { dryRun = false } = options;
  const tool = detectCopyTool();
  const targetPath = resolveProjectedPath(sourcePath, config, process.env.HOME);
  const excludes = config.workspace?.exclude || ['node_modules', '.pnpm-store'];

  if (!dryRun) {
    fs.mkdirSync(path.posix.dirname(targetPath), { recursive: true });
  }

  log(`Projecting workspace to WSL filesystem: ${targetPath}`);
  log(`Using copy tool: ${tool}`);

  const result = runCopy(sourcePath, targetPath, tool, excludes, dryRun);

  if (result.status !== 0) {
    throw new Error(`Failed to project workspace from ${sourcePath} to ${targetPath}`);
  }

  return targetPath;
}

function mirrorBackWorkspace(projectedPath, sourcePath, config, options = {}) {
  const { dryRun = false } = options;

  if (!config.workspace?.mirrorBack) return;

  const tool = detectCopyTool();
  warn('Mirror-back is enabled. Changes in the projected workspace will overwrite the Windows source directory.');

  log(`Mirroring workspace back to: ${sourcePath}`);

  const result = runCopy(projectedPath, sourcePath, tool, [], dryRun);

  if (result.status !== 0) {
    throw new Error(`Failed to mirror workspace back from ${projectedPath} to ${sourcePath}`);
  }
}

module.exports = {
  detectCopyTool,
  isProjectionNeeded,
  resolveProjectedPath,
  projectWorkspace,
  mirrorBackWorkspace,
};
