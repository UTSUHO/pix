const { run } = require('../process/spawn');
const { ensureImage, imageMatchesManifest, getImageId } = require('../docker/image');
const { log } = require('../cli/output');

function collectEnvVars(config, envAll) {
  const env = {};
  if (envAll) {
    Object.assign(env, process.env);
  } else {
    for (const key of config.envAllowlist || []) {
      if (process.env[key] !== undefined) {
        env[key] = process.env[key];
      }
    }
  }
  return env;
}

/**
 * Build the sandbox docker run argv.
 *
 * Mount boundary (hard rules):
 *   /opt/pix/body    — inside the image, read-only program area
 *   /workspace       — the WSL Linux-local workspace copy (rw or ro)
 *   /run/pix-agent   — THIS run's agent dir (config/state), rw
 * Never: Windows master install, global profile, whole HOME, docker.sock,
 * or any host management channel.
 */
function buildDockerArgs(runtime, runCtx, config, options = {}) {
  const imageName = options.imageName;
  const network = config.container?.network || 'bridge';
  const workspaceAccess = config.container?.workspaceAccess || 'read-write';
  const extraRunOptions = config.container?.extraRunOptions || [];
  const transport = runCtx.transport || 'tty';

  const args = ['run', '--rm'];

  // TTY branch: interactive terminal. Pipe branch: no -t (protocol stdout
  // must never flow through a pty); keep -i so stdin scripts reach pi.
  if (transport === 'tty') {
    args.push('-it');
  } else {
    args.push('-i');
  }

  args.push('--workdir', '/workspace');

  if (network) {
    args.push('--network', network);
  }

  // Non-privileged user matching the workspace owner when provided.
  if (runCtx.runAsUser) {
    args.push('--user', runCtx.runAsUser);
  }

  const readOnly = workspaceAccess === 'read-only' ? ',readonly' : '';
  args.push('--mount', `type=bind,src=${runCtx.workspaceRoot},dst=/workspace${readOnly}`);
  args.push('--mount', `type=bind,src=${runCtx.agentDir},dst=/run/pix-agent`);

  const env = collectEnvVars(config, options.envAll);
  env.PI_CODING_AGENT_DIR = '/run/pix-agent';
  for (const [key, value] of Object.entries(env)) {
    args.push('--env', `${key}=${value}`);
  }

  args.push(...extraRunOptions);
  args.push(imageName);
  args.push(...runCtx.piArgs);

  return args;
}

/**
 * Sandbox executor. The image must match the published body manifest —
 * a pre-existing tag is never accepted as proof of version. Docker failures
 * are final: no fallback to direct.
 */
async function execute(runtime, runCtx, config, options = {}) {
  const { dryRun = false, rebuild = false, manifest } = options;
  if (!manifest) {
    const err = new Error('RUNTIME_DEPLOY_FAILED: sandbox requires the published body manifest');
    err.code = 'RUNTIME_DEPLOY_FAILED';
    throw err;
  }

  const imageName = ensureImage(config, { rebuild, manifest, releaseDir: options.releaseDir });

  if (!imageMatchesManifest(imageName, manifest)) {
    const err = new Error(
      `RUNTIME_VERSION_MISMATCH: image ${imageName} does not match body revision ${manifest.bodyRevision}. Rebuild with --rebuild.`
    );
    err.code = 'RUNTIME_VERSION_MISMATCH';
    throw err;
  }

  const imageId = getImageId(imageName);
  const dockerArgs = buildDockerArgs(runtime, runCtx, config, { ...options, imageName });

  if (dryRun) {
    console.error(`[pix] docker ${dockerArgs.join(' ')}`);
    return { code: 0, signal: null, imageId };
  }

  log(`Launching pi in Docker sandbox (image ${imageName}${imageId ? `, id ${imageId.slice(0, 19)}` : ''})...`);
  const result = await run('docker', dockerArgs, {
    env: process.env,
    shell: false,
  });
  return { ...result, imageId };
}

module.exports = { execute, buildDockerArgs, collectEnvVars };
