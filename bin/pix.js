#!/usr/bin/env node

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_CONTEXT_NAME = 'pi-local';
const DEFAULT_IMAGE_NAME = 'pix-pi-sandbox';
const DEFAULT_ALLOWLIST = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_ORG_ID',
  'GOOGLE_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_ENDPOINT',
  'HUGGINGFACE_API_KEY',
  'HF_TOKEN',
  'PI_AGENT_HOME',
  'NODE_ENV',
  'DEBUG',
];

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const DOCKER_DIR = path.join(PACKAGE_ROOT, 'docker');
const DOCKERFILE_PATH = path.join(DOCKER_DIR, 'Dockerfile');

function log(...args) {
  console.error('[pix]', ...args);
}

function fatal(...args) {
  console.error('[pix]', ...args);
  process.exit(1);
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function resolveHostPiHome(userConfig, projectConfig) {
  // Prefer the newer piHome options, fall back to legacy agentHome options.
  return (
    projectConfig.piHomeHostPath ||
    userConfig.piHomeHostPath ||
    projectConfig.agentHomeHostPath ||
    userConfig.agentHomeHostPath ||
    path.join(os.homedir(), '.pi')
  );
}

function resolveUseHostPiHome(userConfig, projectConfig) {
  // Prefer the newer option, fall back to legacy option, default to true.
  if (projectConfig.useHostPiHome !== undefined) return projectConfig.useHostPiHome;
  if (userConfig.useHostPiHome !== undefined) return userConfig.useHostPiHome;
  if (projectConfig.useHostAgentHome !== undefined) return projectConfig.useHostAgentHome;
  if (userConfig.useHostAgentHome !== undefined) return userConfig.useHostAgentHome;
  return true;
}

function loadConfig(cwd) {
  const userConfigPath = path.join(os.homedir(), '.pixrc.json');
  const projectConfigPath = path.join(cwd, '.pix.json');

  const userConfig = readJsonSafe(userConfigPath) || {};
  const projectConfig = readJsonSafe(projectConfigPath) || {};

  const useHostPiHome = resolveUseHostPiHome(userConfig, projectConfig);
  const piHomeHostPath = resolveHostPiHome(userConfig, projectConfig);

  return {
    contextName: projectConfig.contextName || userConfig.contextName || DEFAULT_CONTEXT_NAME,
    imageName: projectConfig.imageName || userConfig.imageName || DEFAULT_IMAGE_NAME,
    envAllowlist: projectConfig.envAllowlist || userConfig.envAllowlist || DEFAULT_ALLOWLIST,
    requireApiKey: projectConfig.requireApiKey ?? userConfig.requireApiKey ?? !useHostPiHome,
    apiKeyEnv: projectConfig.apiKeyEnv || userConfig.apiKeyEnv || 'ANTHROPIC_API_KEY',
    dockerfilePath: projectConfig.dockerfilePath || userConfig.dockerfilePath || DOCKERFILE_PATH,
    useHostPiHome,
    piHomeHostPath,
    extraEnv: {
      ...(userConfig.extraEnv || {}),
      ...(projectConfig.extraEnv || {}),
    },
    extraComposeOptions: projectConfig.extraComposeOptions || userConfig.extraComposeOptions || [],
    extraRunOptions: projectConfig.extraRunOptions || userConfig.extraRunOptions || [],
  };
}

function parseArgs(argv) {
  const extraArgs = [];
  let rebuild = false;
  let envAll = false;
  let dryRun = false;
  let daemon = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--rebuild') {
      rebuild = true;
    } else if (arg === '--env-all') {
      envAll = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--daemon') {
      daemon = true;
    } else {
      extraArgs.push(arg);
    }
  }

  return { rebuild, envAll, dryRun, daemon, extraArgs };
}

function hasDocker() {
  const result = spawnSync('docker', ['--version'], { encoding: 'utf8', shell: false });
  return result.status === 0;
}

function contextExists(contextName) {
  const result = spawnSync('docker', ['context', 'inspect', contextName], {
    encoding: 'utf8',
    shell: false,
    stdio: 'pipe',
  });
  return result.status === 0;
}

function getCurrentContextEndpoint() {
  const result = spawnSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], {
    encoding: 'utf8',
    shell: false,
    stdio: 'pipe',
  });
  if (result.status !== 0 || !result.stdout) {
    return null;
  }
  return result.stdout.trim();
}

function ensureContext(contextName) {
  if (contextExists(contextName)) {
    log(`Using existing Docker context: ${contextName}`);
    return;
  }

  const endpoint = getCurrentContextEndpoint();
  const createArgs = ['context', 'create', contextName];
  if (endpoint) {
    createArgs.push('--docker', `host=${endpoint}`);
    log(`Creating Docker context: ${contextName} (endpoint: ${endpoint})`);
  } else {
    log(`Creating Docker context: ${contextName}`);
  }

  const result = spawnSync('docker', createArgs, {
    stdio: 'inherit',
    shell: false,
  });
  if (result.status !== 0) {
    fatal(`Failed to create Docker context: ${contextName}`);
  }
}

function toDockerHostPath(inputPath) {
  // Docker Desktop on Windows with WSL2 backend can fail to mount paths that
  // contain escaped backslashes in the compose file. Convert Windows paths to
  // forward-slash form, which Docker accepts for bind mounts.
  if (process.platform !== 'win32') {
    return inputPath;
  }

  let normalized = path.normalize(inputPath).replace(/\\/g, '/');

  // Convert C:/... to /host_mnt/c/... which is the path Docker Desktop WSL2
  // uses internally for Windows drives. This is more reliable than C:/... in
  // bind mounts from a compose file.
  const driveMatch = normalized.match(/^([a-zA-Z]):\/(.*)$/);
  if (driveMatch) {
    normalized = `/host_mnt/${driveMatch[1].toLowerCase()}/${driveMatch[2]}`;
  }

  return normalized;
}

function buildComposeConfig(cwd, config, inheritedEnv, extraEnv) {
  const buildArgs = {};
  for (const [key, value] of Object.entries(inheritedEnv)) {
    if (key.toUpperCase().startsWith('NPM_') || key.toUpperCase().startsWith('NODE_')) {
      buildArgs[key] = String(value);
    }
  }

  // Compose key-only references read from the docker process environment,
  // avoiding writing secrets into the temporary compose file.
  const environment = [];
  for (const key of Object.keys(inheritedEnv)) {
    environment.push(key);
  }
  for (const [key, value] of Object.entries(extraEnv)) {
    environment.push(`${key}=${value}`);
  }

  const piHomeVolume = config.useHostPiHome
    ? `${toDockerHostPath(config.piHomeHostPath)}:/root/.pi`
    : `${config.contextName}-pi-home:/root/.pi`;

  const composeConfig = {
    services: {
      pi: {
        build: {
          context: toDockerHostPath(path.dirname(config.dockerfilePath)),
          dockerfile: path.basename(config.dockerfilePath),
          args: buildArgs,
        },
        image: config.imageName,
        stdin_open: true,
        tty: true,
        environment,
        volumes: [`${toDockerHostPath(cwd)}:/workspace`, piHomeVolume],
        working_dir: '/workspace',
        entrypoint: ['pi'],
      },
    },
  };

  if (!config.useHostPiHome) {
    composeConfig.volumes = {
      [`${config.contextName}-pi-home`]: {},
    };
  }

  return composeConfig;
}

function writeTempCompose(composeConfig) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pix-'));
  const composePath = path.join(tmpDir, 'docker-compose.yml');
  fs.writeFileSync(composePath, JSON.stringify(composeConfig, null, 2));
  return { tmpDir, composePath };
}

function collectEnvVars(config, envAll) {
  const inheritedEnv = {};

  if (envAll) {
    Object.assign(inheritedEnv, process.env);
  } else {
    for (const key of config.envAllowlist) {
      if (process.env[key] !== undefined) {
        inheritedEnv[key] = process.env[key];
      }
    }
  }

  return inheritedEnv;
}

function runCommand(cmd, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, options);
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });
}

function containerExists(contextName, containerName) {
  const result = spawnSync(
    'docker',
    ['--context', contextName, 'ps', '-a', '--format', '{{.Names}}', '--filter', `name=${containerName}`],
    { encoding: 'utf8', shell: false, stdio: 'pipe' }
  );
  if (result.status !== 0) return false;
  return result.stdout.trim().split('\n').includes(containerName);
}

function containerIsRunning(contextName, containerName) {
  const result = spawnSync(
    'docker',
    ['--context', contextName, 'ps', '--format', '{{.Names}}', '--filter', `name=${containerName}`],
    { encoding: 'utf8', shell: false, stdio: 'pipe' }
  );
  if (result.status !== 0) return false;
  return result.stdout.trim().split('\n').includes(containerName);
}

function execOptions() {
  return process.stdin.isTTY ? ['-it'] : ['-i'];
}

async function runWithCompose(config, composePath, extraArgs, options = {}) {
  const { rebuild = false, dryRun = false, daemon = false } = options;

  const containerName = `pix-${config.contextName}-pi-daemon`;

  if (daemon) {
    if (dryRun) {
      console.log('docker', ['--context', config.contextName, 'compose', '-f', composePath, '-p', `pix-${config.contextName}`, 'up', '-d', 'pi'].join(' '));
      console.log('docker', ['--context', config.contextName, 'exec', ...execOptions(), containerName, 'pi', ...extraArgs].join(' '));
      console.log('---');
      console.log(fs.readFileSync(composePath, 'utf8'));
      return 0;
    }

    if (containerIsRunning(config.contextName, containerName)) {
      log(`Attaching to running daemon container: ${containerName}`);
      return runCommand('docker', ['--context', config.contextName, 'exec', ...execOptions(), containerName, 'pi', ...extraArgs], {
        stdio: 'inherit',
        shell: false,
      });
    }

    if (containerExists(config.contextName, containerName)) {
      log(`Starting existing daemon container: ${containerName}`);
      const startResult = spawnSync('docker', ['--context', config.contextName, 'start', containerName], {
        stdio: 'inherit',
        shell: false,
      });
      if (startResult.status !== 0) {
        fatal(`Failed to start daemon container: ${containerName}`);
      }
      return runCommand('docker', ['--context', config.contextName, 'exec', ...execOptions(), containerName, 'pi', ...extraArgs], {
        stdio: 'inherit',
        shell: false,
      });
    }

    log(`Creating daemon container: ${containerName}`);
    const composeArgs = [
      '--context',
      config.contextName,
      'compose',
      '-f',
      composePath,
      '-p',
      `pix-${config.contextName}`,
      ...config.extraComposeOptions,
    ];

    composeArgs.push('up', '-d', '--no-deps', '--no-recreate');
    if (rebuild) {
      composeArgs.push('--build');
    }
    composeArgs.push('pi');

    const upResult = spawnSync('docker', composeArgs, {
      stdio: 'inherit',
      shell: false,
      env: { ...process.env, DOCKER_CONTEXT: config.contextName },
    });
    if (upResult.status !== 0) {
      fatal(`Failed to create daemon container: ${containerName}`);
    }

    // Rename the compose-created container to our stable daemon name.
    const projectContainerName = `pix-${config.contextName}-pi-1`;
    if (containerExists(config.contextName, projectContainerName)) {
      spawnSync('docker', ['--context', config.contextName, 'rename', projectContainerName, containerName], {
        stdio: 'ignore',
        shell: false,
      });
    }

    return runCommand('docker', ['--context', config.contextName, 'exec', ...execOptions(), containerName, 'pi', ...extraArgs], {
      stdio: 'inherit',
      shell: false,
    });
  }

  const composeArgs = [
    '--context',
    config.contextName,
    'compose',
    '-f',
    composePath,
    '-p',
    `pix-${config.contextName}`,
    ...config.extraComposeOptions,
  ];

  composeArgs.push('run', '--rm');
  if (rebuild) {
    composeArgs.push('--build');
  }
  composeArgs.push(...config.extraRunOptions, 'pi', ...extraArgs);

  if (dryRun) {
    console.log('docker', composeArgs.join(' '));
    console.log('---');
    console.log(fs.readFileSync(composePath, 'utf8'));
    return 0;
  }

  log('Launching pi in Docker...');
  return runCommand('docker', composeArgs, {
    stdio: 'inherit',
    shell: false,
    env: { ...process.env, DOCKER_CONTEXT: config.contextName },
  });
}

async function main() {
  const cwd = process.cwd();
  const config = loadConfig(cwd);
  const { rebuild, envAll, dryRun, daemon, extraArgs } = parseArgs(process.argv.slice(2));

  if (!hasDocker()) {
    fatal('Docker is not available. Please install Docker and ensure it is in your PATH.');
  }

  if (config.requireApiKey && !envAll && !process.env[config.apiKeyEnv]) {
    fatal(
      `Missing required environment variable: ${config.apiKeyEnv}. ` +
        `Set it in your shell, or use --env-all to forward all environment variables.`
    );
  }

  ensureContext(config.contextName);

  if (config.useHostPiHome) {
    fs.mkdirSync(config.piHomeHostPath, { recursive: true });
  }

  const inheritedEnv = collectEnvVars(config, envAll);
  const composeConfig = buildComposeConfig(cwd, config, inheritedEnv, config.extraEnv);
  const { tmpDir, composePath } = writeTempCompose(composeConfig);

  try {
    const code = await runWithCompose(config, composePath, extraArgs, { rebuild, dryRun, daemon });
    return code;
  } finally {
    try {
      if (!daemon) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch {
      // ignore cleanup errors
    }
  }
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    fatal(err.message || err);
  });
