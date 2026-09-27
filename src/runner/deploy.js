const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Runner deployment. The runner is published from the SAME pix package the
 * host runs — users never install a second global pix inside WSL.
 *
 * Runners live at <targetHome>/.pix/runners/<pixVersion>-<digest>/ and are
 * content-addressed: an unchanged package deploys zero bytes on warm runs.
 */

const RUNNER_INCLUDE = ['bin', 'src', 'assets', 'docker', 'package.json'];

function hashFileTree(root, relativePaths) {
  const entries = [];
  for (const rel of relativePaths) {
    const full = path.join(root, rel);
    if (!fs.existsSync(full)) continue;
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      for (const f of walkFiles(full)) {
        entries.push(f);
      }
    } else {
      entries.push(full);
    }
  }
  entries.sort();
  const hash = crypto.createHash('sha256');
  for (const file of entries) {
    hash.update(path.relative(root, file).split(path.sep).join('/'));
    hash.update('\0');
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function walkFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, withFileTypes())) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function withFileTypes() {
  return { withFileTypes: true };
}

function runnerDigest(packageRoot) {
  return hashFileTree(packageRoot, RUNNER_INCLUDE).slice(0, 12);
}

function runnerName(pixVersion, digest) {
  return `${pixVersion}-${digest}`;
}

/**
 * Ensure the runner is deployed on the target.
 *
 * @param {object} options { packageRoot, pixVersion, targetHome }
 * @param {object} deps    transport: { existsOnTarget(absPath):bool,
 *                          removeOnTarget(absPath), copyTreeToTarget(srcDir, destDir) }
 * @returns {object} RunnerDescriptor { name, directory, entrypoint, deployed }
 */
function ensureRunner(options, deps) {
  const { packageRoot, pixVersion, targetHome } = options;
  const digest = runnerDigest(packageRoot);
  const name = runnerName(pixVersion, digest);
  const directory = path.posix.join(targetHome, '.pix', 'runners', name);
  const entrypoint = path.posix.join(directory, 'bin', 'pix-runner.js');
  const marker = path.posix.join(directory, '.pix-runner-ready');

  if (deps.existsOnTarget(marker)) {
    return { name, directory, entrypoint, digest, deployed: false };
  }

  const staging = `${directory}.staging-${process.pid}`;
  deps.removeOnTarget(staging);
  deps.copyTreeToTarget(packageRoot, staging, RUNNER_INCLUDE);
  deps.writeFileOnTarget(marker.replace(directory, staging), `digest=${digest}\n`);
  deps.removeOnTarget(directory);
  deps.renameOnTarget(staging, directory);

  // D10: a deploy that did not actually land must fail loudly, never report
  // success and let the runner spawn die with MODULE_NOT_FOUND.
  if (!deps.existsOnTarget(marker) || !deps.existsOnTarget(entrypoint)) {
    deps.removeOnTarget(directory);
    const err = new Error(
      `RUNTIME_DEPLOY_FAILED: runner deploy verification failed for ${directory} ` +
      '(marker or entrypoint missing after rename)'
    );
    err.code = 'RUNTIME_DEPLOY_FAILED';
    throw err;
  }
  return { name, directory, entrypoint, digest, deployed: true };
}

/** Local filesystem transport — used when pix already runs on the target (Linux dev, tests). */
function createLocalTransport() {
  return {
    existsOnTarget(p) {
      return fs.existsSync(p);
    },
    removeOnTarget(p) {
      fs.rmSync(p, { recursive: true, force: true });
    },
    writeFileOnTarget(p, content) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    },
    copyTreeToTarget(srcDir, destDir, include) {
      for (const rel of include) {
        const src = path.join(srcDir, rel);
        if (!fs.existsSync(src)) continue;
        const dest = path.join(destDir, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.cpSync(src, dest, { recursive: true });
      }
    },
    renameOnTarget(from, to) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
    },
  };
}

module.exports = { RUNNER_INCLUDE, runnerDigest, runnerName, ensureRunner, createLocalTransport };
