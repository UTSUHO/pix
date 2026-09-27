const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ensureRunner } = require('../runner/deploy');
const { buildExecutionPlan } = require('../runner/plan');
const { hashProfile, PROFILE_ITEMS } = require('../runtime/compose-agent');
const { writeHostLink } = require('./bridge');

/**
 * Host-side orchestration: stage the published body/profile/credentials onto
 * a target, deploy the runner, hand over an execution plan, and launch it.
 * The host decides versions; the target only materializes them.
 */

const RELEASE_ITEMS = ['package.json', 'package-lock.json', 'manifest.json', 'resources', 'vendor'];

function stageRelease(ctx, target, bodyRevision) {
  const srcDir = path.join(ctx.releasesDir, bodyRevision);
  const destDir = path.posix.join(target.home, '.pix', 'releases', bodyRevision);
  const marker = path.posix.join(destDir, '.ready');
  if (target.existsOnTarget(marker)) return { staged: false, directory: destDir };

  const include = RELEASE_ITEMS.filter((rel) => fs.existsSync(path.join(srcDir, rel)));
  target.removeOnTarget(destDir);
  target.copyTreeToTarget(srcDir, destDir, include);
  target.writeFileOnTarget(marker, `bodyRevision=${bodyRevision}\n`);
  return { staged: true, directory: destDir };
}

function stageProfile(ctx, target, profileRevision) {
  const destDir = path.posix.join(target.home, '.pix', 'profiles', profileRevision);
  const marker = path.posix.join(destDir, '.ready');
  if (target.existsOnTarget(marker)) return { staged: false, directory: destDir };

  const include = PROFILE_ITEMS.filter((rel) => fs.existsSync(path.join(ctx.profileDir, rel)));
  target.removeOnTarget(destDir);
  if (include.length) {
    target.copyTreeToTarget(ctx.profileDir, destDir, include);
  } else {
    target.writeFileOnTarget(path.posix.join(destDir, '.keep'), '');
  }
  target.writeFileOnTarget(marker, `profileRevision=${profileRevision}\n`);
  return { staged: true, directory: destDir };
}

function stageCredentials(ctx, target) {
  const authSrc = path.join(ctx.credentialsDir, 'auth.json');
  if (!fs.existsSync(authSrc)) return { staged: false };
  const dest = path.posix.join(target.home, '.pix', 'credentials', 'auth.json');
  target.writeFileOnTarget(dest, fs.readFileSync(authSrc, 'utf8'));
  return { staged: true };
}

/** Record host binding on the target so the WSL shim can forward management commands. */
function stageHostLink(ctx, target, options = {}) {
  const link = {
    hostId: ctx.hostId,
    windowsPixHome: ctx.pixHome,
    windowsNode: options.windowsNode || process.execPath,
    windowsPixEntry: options.windowsPixEntry || path.resolve(__dirname, '..', '..', 'bin', 'pix.js'),
  };
  target.writeFileOnTarget(
    path.posix.join(target.home, '.pix', 'host-link.json'),
    JSON.stringify({ schemaVersion: 1, ...link }, null, 2) + '\n'
  );
  return link;
}

function deployToTarget(ctx, target, options = {}) {
  const packageRoot = options.packageRoot || path.resolve(__dirname, '..', '..');
  const pixVersion = options.pixVersion || require('../../package.json').version;

  const published = require('./resolve-home').readPublishedBody(ctx);
  if (!published) {
    const err = new Error('No published body on the host. Run "pix update" first.');
    err.code = 'RUNTIME_DEPLOY_FAILED';
    throw err;
  }
  const bodyRevision = published.manifest.bodyRevision;

  const runner = ensureRunner({ packageRoot, pixVersion, targetHome: target.home }, target);
  const release = stageRelease(ctx, target, bodyRevision);
  const profileRevision = hashProfile(ctx.profileDir);
  const profile = stageProfile(ctx, target, profileRevision);
  const credentials = stageCredentials(ctx, target);
  const hostLink = stageHostLink(ctx, target, options);

  return {
    runner,
    bodyRevision,
    manifest: published.manifest,
    releaseDir: release.directory,
    releaseStaged: release.staged,
    profileRevision,
    profileStaged: profile.staged,
    credentialsStaged: credentials.staged,
    hostLink,
  };
}

/**
 * Send the plan to the target (runner init via stdin JSON — a dedicated
 * control channel before pi starts, never pi's prompt stdin), then exec.
 */
async function executePlanOnTarget(target, runner, plan, options = {}) {
  const validPlan = buildExecutionPlan(plan);
  const runnerEnv = { ...process.env, PIX_TARGET_ROOT: path.posix.join(target.home, '.pix') };

  const initResult = await target.spawnRunner(runner.entrypoint, ['init', '--run-id', validPlan.runId], {
    stdio: ['pipe', 'inherit', 'inherit'],
    env: runnerEnv,
    input: JSON.stringify(validPlan),
  });
  if (initResult.code !== 0) {
    return { code: initResult.code ?? 1, signal: initResult.signal, infraError: 'runner init failed' };
  }

  const planPath = path.posix.join(target.home, '.pix', 'runs', validPlan.runId, 'plan.json');
  const execResult = await target.spawnRunner(runner.entrypoint, ['exec', '--plan', planPath], {
    stdio: options.stdio || 'inherit',
    env: runnerEnv,
  });
  return execResult;
}

function newRunId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

module.exports = {
  RELEASE_ITEMS,
  stageRelease,
  stageProfile,
  stageCredentials,
  stageHostLink,
  deployToTarget,
  executePlanOnTarget,
  newRunId,
  writeHostLink,
};
