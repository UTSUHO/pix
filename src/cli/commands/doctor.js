const { loadConfig } = require('../../config/load-config');
const { mergeConfig } = require('../../config/merge-config');
const { validateConfig } = require('../../config/schema');
const { getDefaultDistro, listDistros, isWslAvailable, hasCommand, isInsideWsl } = require('../../platform/wsl');
const { isNtfsWorkspace, expandTilde } = require('../../platform/paths');
const { resolveAgentDir } = require('../../runtime/resolve-runtime');
const { imageExists } = require('../../docker/image');
const { detectCopyTool } = require('../../workspace/projection');
const { isSyncEnabled } = require('../../workspace/sync');
const {
  resolveMutagenPath,
  getMutagenVersion,
  listPixSessions,
} = require('../../workspace/mutagen');
const { log, warn } = require('../output');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function checkDocker() {
  const result = spawnSync('docker', ['--version'], { encoding: 'utf8', shell: false, stdio: 'pipe' });
  return result.status === 0;
}

function checkWslIntegration(distro) {
  if (isInsideWsl()) {
    const result = spawnSync('docker', ['--version'], { encoding: 'utf8', shell: false, stdio: 'pipe' });
    return result.status === 0;
  }

  const { runWsl } = require('../../platform/wsl');
  const result = runWsl(distro, ['bash', '-lic', 'docker --version'], { encoding: 'utf8', shell: false, stdio: 'pipe' });
  return result.status === 0;
}

function hasRsync() {
  return detectCopyTool() === 'rsync';
}

function getPiVersionWsl(distro) {
  if (!hasCommand('pi', distro)) return null;

  if (isInsideWsl()) {
    const result = spawnSync('pi', ['--version'], { encoding: 'utf8', shell: false, stdio: 'pipe' });
    if (result.status !== 0 || !result.stdout) return null;
    return result.stdout.trim() || null;
  }

  const { runWsl } = require('../../platform/wsl');
  const result = runWsl(distro, ['bash', '-lic', 'pi --version'], { encoding: 'utf8', shell: false, stdio: 'pipe' });
  if (result.status !== 0 || !result.stdout) return null;
  return result.stdout.trim() || null;
}

function getPiVersionDocker(imageName) {
  if (!imageExists(imageName)) return null;
  const result = spawnSync('docker', ['run', '--rm', imageName, 'pi', '--version'], {
    encoding: 'utf8',
    shell: false,
    stdio: 'pipe',
  });
  if (result.status !== 0 || !result.stdout) return null;
  return result.stdout.trim() || null;
}

function canMountRuntime(agentDir, imageName) {
  if (!imageExists(imageName)) return null;
  const result = spawnSync(
    'docker',
    ['run', '--rm', '--mount', `type=bind,src=${agentDir},dst=${agentDir}`, imageName, 'true'],
    { encoding: 'utf8', shell: false, stdio: 'pipe' }
  );
  return result.status === 0;
}

function execute(parsedArgs) {
  const cwd = process.cwd();
  const configs = loadConfig(cwd);
  const { config, warnings: configWarnings } = mergeConfig(configs);

  if (parsedArgs.distro) {
    config.wsl = config.wsl || {};
    config.wsl.distro = parsedArgs.distro;
  }

  const issues = [];
  const checks = [];

  const validation = validateConfig(config);
  for (const message of validation.warnings) {
    warn(message);
  }
  if (!validation.valid) {
    for (const message of validation.errors) {
      issues.push(message);
    }
  }

  if (!Array.isArray(config.envAllowlist) || config.envAllowlist.length === 0) {
    issues.push('envAllowlist is empty or invalid.');
  }

  const wslAvailable = isWslAvailable();
  checks.push(`WSL installed: ${wslAvailable ? 'yes' : 'no'}`);
  if (!wslAvailable) {
    issues.push('WSL is not installed or wsl.exe is not in PATH.');
  }

  const distro = config.wsl?.distro || getDefaultDistro();
  const distros = listDistros();
  checks.push(`WSL distro: ${distro || 'not found'} (${distros.length} distros available)`);
  if (!distro) {
    issues.push('No default WSL distro found. Install a distro or set wsl.distro.');
  } else if (!distros.includes(distro)) {
    issues.push(`Configured distro "${distro}" is not available.`);
  }

  const dockerAvailable = checkDocker();
  checks.push(`Docker available: ${dockerAvailable ? 'yes' : 'no'}`);
  if (!dockerAvailable) {
    issues.push('Docker is not available. Ensure Docker Desktop is running and docker is in PATH.');
  }

  if (distro && dockerAvailable) {
    const integration = checkWslIntegration(distro);
    checks.push(`WSL Docker integration: ${integration ? 'enabled' : 'disabled'}`);
    if (!integration) {
      issues.push('Docker integration is not enabled for the WSL distro.');
    }
  }

  const sourceWorkspace = cwd;
  const agentDir = resolveAgentDir(config, process.env.HOME);
  checks.push(`Workspace source: ${sourceWorkspace}`);
  checks.push(`Agent dir: ${agentDir}`);

  if (isNtfsWorkspace(sourceWorkspace)) {
    if (config.workspace?.projection !== false) {
      checks.push('Workspace projection: enabled');
    } else {
      issues.push('Workspace is on Windows NTFS and projection is disabled. Sandbox file operations may be slower.');
    }
  }
  if (isNtfsWorkspace(agentDir)) {
    issues.push('Agent dir is on Windows NTFS. Direct/Sandbox shared runtime performance may suffer.');
  }

  if (config.workspace?.projection !== false && isNtfsWorkspace(sourceWorkspace)) {
    const projectionRoot = expandTilde(config.workspace?.projectionRoot || '~/.pix/workspaces', process.env.HOME);
    checks.push(`Projection root: ${projectionRoot}`);
    checks.push(`rsync available: ${hasRsync() ? 'yes' : 'no (will use cp)'}`);

    if (isNtfsWorkspace(projectionRoot)) {
      issues.push('Projection root is on Windows NTFS. This defeats the purpose of workspace projection.');
    }

    try {
      fs.mkdirSync(projectionRoot, { recursive: true });
      fs.accessSync(projectionRoot, fs.constants.R_OK | fs.constants.W_OK);
      checks.push('Projection root writable: yes');
    } catch {
      issues.push(`Projection root is not readable/writable: ${projectionRoot}`);
    }
  }

  if (isSyncEnabled(config)) {
    const mutagenPath = resolveMutagenPath();
    checks.push(`Mutagen available: ${mutagenPath ? 'yes' : 'no (install Mutagen to enable continuous sync)'}`);
    if (mutagenPath) {
      checks.push(`Mutagen version: ${getMutagenVersion(mutagenPath) || 'unknown'}`);
      try {
        const staleSessions = listPixSessions(mutagenPath);
        checks.push(`Stale pix Mutagen sessions: ${staleSessions.length}`);
        if (staleSessions.length > 0) {
          warn(`Found ${staleSessions.length} stale pix Mutagen session(s): ${staleSessions.join(', ')}`);
        }
      } catch (err) {
        warn(`Failed to list Mutagen sessions: ${err.message}`);
      }
    }
  }

  try {
    fs.accessSync(agentDir, fs.constants.R_OK | fs.constants.W_OK);
    checks.push(`Runtime read-write: yes`);
  } catch {
    issues.push(`Runtime directory is not readable/writable: ${agentDir}`);
    checks.push(`Runtime read-write: no`);
  }

  const piAvailable = distro ? hasCommand('pi', distro) : false;
  checks.push(`pi command: ${piAvailable ? 'available' : 'missing'}`);
  if (!piAvailable) {
    issues.push('pi is not installed in WSL. Direct mode will not work.');
  }

  const imageName = config.container?.image || 'pix-pi-sandbox';
  const imageAvailable = dockerAvailable && imageExists(imageName);
  checks.push(`Sandbox image: ${imageName} (${imageAvailable ? 'present' : 'missing'})`);
  if (!imageAvailable) {
    issues.push('Sandbox image is missing. Run pix --sandbox --rebuild to build it.');
  }

  if (piAvailable && imageAvailable) {
    const wslVersion = getPiVersionWsl(distro);
    const dockerVersion = getPiVersionDocker(imageName);
    checks.push(`Pi version (WSL): ${wslVersion || 'unknown'}`);
    checks.push(`Pi version (image): ${dockerVersion || 'unknown'}`);
    if (wslVersion && dockerVersion && wslVersion !== dockerVersion) {
      issues.push(`Direct and Sandbox pi versions differ: ${wslVersion} vs ${dockerVersion}`);
    }
  }

  if (imageAvailable) {
    const mountable = canMountRuntime(agentDir, imageName);
    checks.push(`Docker can mount runtime: ${mountable === null ? 'n/a' : mountable ? 'yes' : 'no'}`);
    if (mountable === false) {
      issues.push('Docker cannot mount the runtime directory.');
    }
  }

  for (const message of configWarnings) {
    warn(message);
  }

  console.log('Checks:');
  for (const check of checks) {
    console.log(`  ${check}`);
  }

  if (issues.length) {
    console.log('\nIssues:');
    for (const issue of issues) {
      console.log(`  - ${issue}`);
    }
    return 1;
  }

  console.log('\nNo issues detected.');
  return 0;
}

module.exports = { execute };
