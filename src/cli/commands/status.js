const { loadConfig } = require('../../config/load-config');
const { mergeConfig } = require('../../config/merge-config');
const { getDefaultDistro, hasCommand, isInsideWsl } = require('../../platform/wsl');
const { classifyPath, isNtfsWorkspace } = require('../../platform/paths');
const { resolveRuntimeRoot, resolveAgentDir } = require('../../runtime/resolve-runtime');
const { imageExists } = require('../../docker/image');
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

  const distro = config.wsl?.distro || getDefaultDistro() || 'unknown';
  const workspace = cwd;
  const runtimeRoot = resolveRuntimeRoot(config, process.env.HOME);
  const agentDir = resolveAgentDir(config, process.env.HOME);
  const piAvailable = hasCommand('pi', distro);
  const dockerAvailable = checkDocker();
  const imageName = config.container?.image || 'pix-pi-sandbox';
  const imageAvailable = dockerAvailable && imageExists(imageName);

  console.log(`Execution: ${config.execution}`);
  console.log(`WSL distro: ${distro}`);
  console.log(`Runtime root: ${runtimeRoot}`);
  console.log(`Pi agent dir: ${agentDir}`);
  console.log(`Pi available: ${piAvailable ? 'yes' : 'no'}`);
  if (piAvailable) {
    console.log(`Pi version (WSL): ${getPiVersionWsl(distro)}`);
  }
  console.log(`Docker available: ${dockerAvailable ? 'yes' : 'no'}`);
  console.log(`Sandbox image: ${imageName} (${imageAvailable ? 'present' : 'missing'})`);
  if (imageAvailable) {
    console.log(`Pi version (image): ${getPiVersionDocker(imageName)}`);
  }
  console.log(`Workspace path: ${workspace}`);
  console.log(`Workspace storage: ${getWorkspaceStorageType(workspace)}`);

  if (isNtfsWorkspace(agentDir)) {
    console.log('Warning: agent dir is on Windows NTFS; Direct/Sandbox performance may suffer.');
  }
  if (isNtfsWorkspace(workspace)) {
    console.log('Warning: workspace is on Windows NTFS; Sandbox file operations may be slower.');
  }

  return 0;
}

module.exports = { execute };
