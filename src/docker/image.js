const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { log } = require('../cli/output');

/**
 * Manifest-driven sandbox images.
 *
 * The image tag and labels carry the body identity:
 *   tag:    pix-pi-sandbox:<bodyRevision-short>
 *   labels: pix.body-revision, pix.lock-digest, pix.recipe-digest
 * "Image exists" is never accepted as "image is correct" — labels must match
 * the currently published manifest, and runs record the actual image ID.
 */

function recipeDigest() {
  const dockerfile = path.join(__dirname, '..', '..', 'docker', 'Dockerfile');
  return crypto.createHash('sha256').update(fs.readFileSync(dockerfile)).digest('hex');
}

function imageNameFor(manifest, config) {
  const base = (config && config.container && config.container.image) || 'pix-pi-sandbox';
  const baseName = base.split(':')[0];
  return `${baseName}:${manifest.bodyRevision.slice(0, 12)}`;
}

function expectedLabels(manifest) {
  return {
    'pix.body-revision': manifest.bodyRevision,
    'pix.lock-digest': manifest.lock.digest,
    'pix.recipe-digest': recipeDigest(),
  };
}

function imageExists(imageName) {
  const result = spawnSync('docker', ['images', '--format', '{{.Repository}}:{{.Tag}}', imageName], {
    encoding: 'utf8',
    shell: false,
    stdio: 'pipe',
  });
  if (result.status !== 0 || !result.stdout) return false;
  return result.stdout.trim().split(/\r?\n/).filter(Boolean)
    .some((line) => line === imageName || line.startsWith(`${imageName}:`));
}

function inspectImage(imageName) {
  const result = spawnSync('docker', ['image', 'inspect', imageName], {
    encoding: 'utf8',
    shell: false,
    stdio: 'pipe',
  });
  if (result.status !== 0 || !result.stdout) return null;
  try {
    const parsed = JSON.parse(result.stdout);
    return Array.isArray(parsed) ? parsed[0] : parsed;
  } catch {
    return null;
  }
}

function getImageId(imageName) {
  const info = inspectImage(imageName);
  return info && info.Id ? info.Id : null;
}

/** Labels on the actual image must equal the manifest-derived expectations. */
function imageMatchesManifest(imageName, manifest) {
  const info = inspectImage(imageName);
  if (!info) return false;
  const labels = (info.Config && info.Config.Labels) || {};
  const expected = expectedLabels(manifest);
  return Object.entries(expected).every(([k, v]) => labels[k] === v);
}

/**
 * Assemble the Docker build context from a host release. Exported for tests.
 */
function prepareBuildContext(releaseDir, contextDir) {
  fs.copyFileSync(
    path.join(__dirname, '..', '..', 'docker', 'Dockerfile'),
    path.join(contextDir, 'Dockerfile')
  );
  fs.copyFileSync(
    path.join(__dirname, '..', '..', 'docker', 'entrypoint.js'),
    path.join(contextDir, 'entrypoint.js')
  );
  fs.copyFileSync(path.join(releaseDir, 'package.json'), path.join(contextDir, 'package.json'));
  fs.copyFileSync(path.join(releaseDir, 'package-lock.json'), path.join(contextDir, 'package-lock.json'));
  // resources/ must ALWAYS exist in the context: the Dockerfile copies it
  // unconditionally, and a release without plugins has none on disk.
  const resourcesDir = path.join(releaseDir, 'resources');
  fs.mkdirSync(path.join(contextDir, 'resources'), { recursive: true });
  if (fs.existsSync(resourcesDir)) {
    fs.cpSync(resourcesDir, path.join(contextDir, 'resources'), { recursive: true });
  }
  // Same for vendored offline package inputs (referenced by the lock).
  fs.mkdirSync(path.join(contextDir, 'vendor'), { recursive: true });
  const vendorDir = path.join(releaseDir, 'vendor');
  if (fs.existsSync(vendorDir)) {
    fs.cpSync(vendorDir, path.join(contextDir, 'vendor'), { recursive: true });
  }
}

/**
 * Build the image from the host release: the build context receives the
 * frozen package.json + package-lock.json (+ sealed resources), and the
 * Dockerfile performs the platform-correct install INSIDE the image.
 */
function buildImage(imageName, manifest, releaseDir, options = {}) {
  // BuildKit names build-history entries after the build CONTEXT directory
  // basename. A random mkdtemp name shows up as "pix-docker-context-xxxx"
  // (or <none>) in Docker Desktop; a stable name groups all pix builds.
  const contextDir = path.join(require('os').tmpdir(), 'pix-container');
  fs.rmSync(contextDir, { recursive: true, force: true });
  fs.mkdirSync(contextDir, { recursive: true });
  try {
    prepareBuildContext(releaseDir, contextDir);

    const labels = expectedLabels(manifest);
    const args = ['build', '-t', imageName];
    for (const [k, v] of Object.entries(labels)) {
      args.push('--label', `${k}=${v}`);
    }
    args.push(contextDir);

    log(`Building Docker image: ${imageName} (body ${manifest.bodyRevision.slice(0, 12)})`);
    const result = spawnSync('docker', args, { stdio: 'inherit', shell: false });
    if (result.status !== 0) {
      const err = new Error(`RUNTIME_DEPLOY_FAILED: docker build failed for ${imageName}`);
      err.code = 'RUNTIME_DEPLOY_FAILED';
      throw err;
    }
  } finally {
    fs.rmSync(contextDir, { recursive: true, force: true });
  }
  return imageName;
}

function ensureImage(config, options = {}) {
  const { rebuild = false, manifest, releaseDir } = options;
  if (!manifest) {
    throw new Error('ensureImage requires the published body manifest');
  }
  const imageName = imageNameFor(manifest, config);

  if (!rebuild && imageExists(imageName) && imageMatchesManifest(imageName, manifest)) {
    return imageName;
  }
  if (!releaseDir) {
    throw new Error('ensureImage needs the host releaseDir to build a manifest-matched image');
  }
  return buildImage(imageName, manifest, releaseDir);
}

module.exports = {
  recipeDigest,
  imageNameFor,
  expectedLabels,
  imageExists,
  inspectImage,
  getImageId,
  imageMatchesManifest,
  buildImage,
  prepareBuildContext,
  ensureImage,
};
