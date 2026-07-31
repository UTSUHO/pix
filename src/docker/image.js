const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { log } = require('../cli/output');
const { isInsideWsl, toWslPath } = require('../platform/wsl');
const { normalizeSlashes, expandTilde } = require('../platform/paths');

function resolvePackageRoot() {
  if (process.env.PIX_PACKAGE_ROOT) {
    return normalizeSlashes(process.env.PIX_PACKAGE_ROOT);
  }

  const fromEntry = path.resolve(__dirname, '..', '..');
  if (isInsideWsl() && /^[a-zA-Z]:/.test(fromEntry)) {
    return toWslPath(fromEntry);
  }

  return fromEntry;
}

function imageExists(imageName) {
  const result = spawnSync('docker', ['images', '--format', '{{.Repository}}:{{.Tag}}', imageName], {
    encoding: 'utf8',
    shell: false,
    stdio: 'pipe',
  });

  if (result.status !== 0 || !result.stdout) {
    return false;
  }

  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  return lines.some((line) => line === imageName || line.startsWith(`${imageName}:`));
}

function buildImage(dockerfilePath, imageName) {
  const dockerDir = path.posix.dirname(dockerfilePath);

  log(`Building Docker image: ${imageName}`);
  const result = spawnSync(
    'docker',
    ['build', '-t', imageName, '-f', dockerfilePath, dockerDir],
    {
      stdio: 'inherit',
      shell: false,
    }
  );

  if (result.status !== 0) {
    throw new Error(`Failed to build Docker image: ${imageName}`);
  }
}

function resolveDockerfilePath(config) {
  const custom = config.container?.dockerfile || config.dockerfilePath;
  if (custom) {
    const resolved = normalizeSlashes(
      expandTilde(custom).startsWith('/') ? expandTilde(custom) : path.posix.resolve(process.cwd(), expandTilde(custom))
    );
    if (!fs.existsSync(resolved)) {
      throw new Error(`Custom Dockerfile not found: ${resolved}`);
    }
    return resolved;
  }
  return path.posix.join(resolvePackageRoot(), 'docker', 'Dockerfile');
}

function ensureImage(config, options = {}) {
  const imageName = config.container?.image || 'pix-pi-sandbox';
  const dockerfilePath = resolveDockerfilePath(config);
  const { rebuild = false } = options;

  if ((rebuild || !imageExists(imageName)) === false) {
    return imageName;
  }

  if (config.container?.dockerfile && !rebuild) {
    log('Using custom Dockerfile; pass --rebuild if the existing image is stale.');
  }

  buildImage(dockerfilePath, imageName);

  return imageName;
}

module.exports = { imageExists, buildImage, ensureImage, resolveDockerfilePath };
