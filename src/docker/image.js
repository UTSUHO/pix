const path = require('path');
const { spawnSync } = require('child_process');
const { log } = require('../cli/output');
const { isInsideWsl, toWslPath } = require('../platform/wsl');
const { normalizeSlashes } = require('../platform/paths');

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

function ensureImage(config, options = {}) {
  const imageName = config.container?.image || 'pix-pi-sandbox';
  const dockerfilePath =
    config.dockerfilePath || path.posix.join(resolvePackageRoot(), 'docker', 'Dockerfile');
  const { rebuild = false } = options;

  if (rebuild || !imageExists(imageName)) {
    buildImage(dockerfilePath, imageName);
  }

  return imageName;
}

module.exports = { imageExists, buildImage, ensureImage };
