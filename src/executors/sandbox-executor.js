const path = require('path');
const { run } = require('../process/spawn');
const { ensureImage } = require('../docker/image');
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

function buildDockerArgs(workspace, agentDir, piArgs, config, options) {
  const imageName = config.container?.image || 'pix-pi-sandbox';
  const network = config.container?.network || 'bridge';
  const workspaceAccess = config.container?.workspaceAccess || 'read-write';
  const extraRunOptions = config.container?.extraRunOptions || [];
  const { dryRun = false, rebuild = false, envAll = false } = options;

  const args = [
    'run',
    '--rm',
    '-it',
    '--workdir',
    '/workspace',
  ];

  if (network) {
    args.push('--network', network);
  }

  const readOnly = workspaceAccess === 'read-only' ? ',readonly' : '';
  args.push('--mount', `type=bind,src=${workspace},dst=/workspace${readOnly}`);
  args.push('--mount', `type=bind,src=${agentDir},dst=${agentDir}`);

  const env = collectEnvVars(config, envAll);
  for (const [key, value] of Object.entries(env)) {
    args.push('--env', `${key}=${value}`);
  }

  args.push('--env', `PI_CODING_AGENT_DIR=${agentDir}`);

  args.push(...extraRunOptions);
  args.push(imageName);
  args.push('pi');
  args.push(...piArgs);

  return args;
}

async function execute(workspace, agentDir, piArgs, config, options = {}) {
  const { dryRun = false, rebuild = false } = options;
  const imageName = config.container?.image || 'pix-pi-sandbox';

  if (!dryRun) {
    ensureImage(config, { rebuild });
  }

  const dockerArgs = buildDockerArgs(workspace, agentDir, piArgs, config, options);

  if (dryRun) {
    console.log('docker', dockerArgs.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' '));
    return 0;
  }

  log('Launching pi in Docker sandbox...');
  const result = await run('docker', dockerArgs, {
    env: process.env,
    shell: false,
  });

  return result.code ?? 0;
}

module.exports = { execute, buildDockerArgs };
