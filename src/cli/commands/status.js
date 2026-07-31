const { loadConfig } = require('../../config/load-config');
const { mergeConfig } = require('../../config/merge-config');
const { getDefaultDistro, hasCommand, isInsideWsl } = require('../../platform/wsl');
const { classifyPath, isNtfsWorkspace } = require('../../platform/paths');
const { resolveRuntimeRoot, resolveAgentDir } = require('../../runtime/resolve-runtime');
const { guardStatus } = require('../../runtime/install-guard');
const { imageExists } = require('../../docker/image');
const { isProjectionNeeded, resolveProjectedPath } = require('../../workspace/projection');
const { isSyncEnabled } = require('../../workspace/sync');
const {
  resolveMutagenPath,
  getMutagenVersion,
  computeSessionName,
  sessionExists,
  getSessionState,
} = require('../../workspace/mutagen');
const { spawnSync } = require('child_process');

function checkDocker() {
  const result = spawnSync('docker', ['--version'], { encoding: 'utf8', shell: false, stdio: 'pipe' });
  return result.status === 0;
}

function getWorkspaceStorageType(workspace) {
  if (isNtfsWorkspace(workspace)) return 'Windows NTFS (slow)';
  const cls = classifyPath(workspace);
  if (cls === 'wsl' || cls === 'linux') return 'WSL filesystem';
  return 'unknown';
}

function getPiVersionWsl(distro) {
  if (!hasCommand('pi', distro)) return 'not installed';

  if (isInsideWsl()) {
    const result = spawnSync('pi', ['--version'], { encoding: 'utf8', shell: false, stdio: 'pipe' });
    if (result.status !== 0 || !result.stdout) return 'unknown';
    return result.stdout.trim() || 'unknown';
  }

  const { runWsl } = require('../../platform/wsl');
  const result = runWsl(distro, ['bash', '-lic', 'pi --version'], { encoding: 'utf8', shell: false, stdio: 'pipe' });
  if (result.status !== 0 || !result.stdout) return 'unknown';
  return result.stdout.trim() || 'unknown';
}

function getPiVersionDocker(imageName) {
  if (!imageExists(imageName)) return 'image missing';
  const result = spawnSync('docker', ['run', '--rm', imageName, 'pi', '--version'], {
    encoding: 'utf8',
    shell: false,
    stdio: 'pipe',
  });
  if (result.status !== 0 || !result.stdout) return 'unknown';
  return result.stdout.trim() || 'unknown';
}

function execute(parsedArgs) {
  const cwd = process.cwd();
  const configs = loadConfig(cwd);
  const { config } = mergeConfig(configs);

  if (parsedArgs.distro) {
    config.wsl = config.wsl || {};
    config.wsl.distro = parsedArgs.distro;
  }

  if (parsedArgs.noProjection) {
    config.workspace = config.workspace || {};
    config.workspace.projection = false;
  }

  if (parsedArgs.mirrorBack) {
    config.workspace = config.workspace || {};
    config.workspace.mirrorBack = true;
  }

  if (parsedArgs.noMirrorBack) {
    config.workspace = config.workspace || {};
    config.workspace.mirrorBack = false;
  }

  const distro = config.wsl?.distro || getDefaultDistro() || 'unknown';
  const sourceWorkspace = cwd;
  const runtimeRoot = resolveRuntimeRoot(config, process.env.HOME);
  const agentDir = resolveAgentDir(config, process.env.HOME);
  const piAvailable = hasCommand('pi', distro);
  const dockerAvailable = checkDocker();
  const imageName = config.container?.image || 'pix-pi-sandbox';
  const imageAvailable = dockerAvailable && imageExists(imageName);
  const projectionNeeded = isProjectionNeeded(sourceWorkspace, config);
  const projectedWorkspace = projectionNeeded
    ? resolveProjectedPath(sourceWorkspace, config, process.env.HOME)
    : null;

  console.log(`Execution: ${config.execution}`);
  console.log(`WSL distro: ${distro}`);
  console.log(`Runtime root: ${runtimeRoot}`);
  console.log(`Pi agent dir: ${agentDir}`);
  const mntGuardEnabled = config.security?.mntGuard !== false;
  const guard = guardStatus(agentDir);
  console.log(`Mnt guard: ${mntGuardEnabled ? 'enabled' : 'disabled'}${guard.installed ? ` (installed v${guard.version})` : ' (not installed)'}`);
  console.log(`Pi available: ${piAvailable ? 'yes' : 'no'}`);
  if (piAvailable) {
    console.log(`Pi version (WSL): ${getPiVersionWsl(distro)}`);
  }
  console.log(`Docker available: ${dockerAvailable ? 'yes' : 'no'}`);
  console.log(`Sandbox image: ${imageName} (${imageAvailable ? 'present' : 'missing'})`);
  if (imageAvailable) {
    console.log(`Pi version (image): ${getPiVersionDocker(imageName)}`);
  }
  console.log(`Workspace source: ${sourceWorkspace}`);
  if (projectedWorkspace) {
    console.log(`Projected workspace: ${projectedWorkspace}`);
    console.log(`Workspace storage: WSL filesystem (projected)`);
    console.log(`Mirror-back: ${config.workspace?.mirrorBack ? 'yes' : 'no'}`);
  } else {
    console.log(`Workspace storage: ${getWorkspaceStorageType(sourceWorkspace)}`);
  }

  const sync = config.workspace?.sync || {};
  console.log(`Sync enabled: ${sync.enabled !== false ? 'yes' : 'no'}`);
  if (sync.enabled !== false) {
    console.log(`Sync strategy: ${sync.strategy || 'mutagen'}`);
    console.log(`Sync mode: ${sync.mode || 'two-way-resolved'}`);
    console.log(`Sync keep-alive: ${sync.keepAlive || 'terminate'}`);
  }

  const mutagenPath = resolveMutagenPath();
  const mutagenAvailable = mutagenPath !== null;
  console.log(`Mutagen available: ${mutagenAvailable ? 'yes' : 'no'}`);
  if (mutagenAvailable) {
    console.log(`Mutagen path: ${mutagenPath}`);
    console.log(`Mutagen version: ${getMutagenVersion(mutagenPath) || 'unknown'}`);
    if (projectedWorkspace) {
      const sessionName = computeSessionName(sourceWorkspace);
      const exists = sessionExists(mutagenPath, sessionName);
      console.log(`Mutagen session: ${sessionName} (${exists ? getSessionState(mutagenPath, sessionName) || 'present' : 'not active'})`);
    }
  }

  if (isNtfsWorkspace(agentDir)) {
    console.log('Warning: agent dir is on Windows NTFS; Direct/Sandbox performance may suffer.');
  }
  if (isNtfsWorkspace(sourceWorkspace) && !projectionNeeded) {
    console.log('Warning: workspace is on Windows NTFS and projection is disabled; Sandbox file operations may be slower.');
  }

  return 0;
}

module.exports = { execute };
