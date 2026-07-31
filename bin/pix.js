#!/usr/bin/env node

const { spawnSync, spawn } = require('child_process');
const path = require('path');

const { isWindows, isInsideWsl, getDefaultDistro, toWslPath, hasCommand } = require('../src/platform/wsl');
const { parseArgs } = require('../src/cli/parse-args');
const { fatal } = require('../src/cli/output');
const runCommand = require('../src/cli/commands/run');
const statusCommand = require('../src/cli/commands/status');
const doctorCommand = require('../src/cli/commands/doctor');
const migrateCommand = require('../src/cli/commands/migrate');
const installShellEnvCommand = require('../src/cli/commands/install-shell-env');

function printHelp() {
  console.log(`Usage: pix [options] [command] [pi-args...]

Commands:
  status              Show pix configuration and environment status
  doctor              Diagnose pix environment issues
  migrate             Migrate Windows .pi/agent to the WSL canonical runtime
  install-shell-env   Add PI_CODING_AGENT_DIR to shell rc file

Options:
  --direct                  Force WSL direct execution
  --sandbox                 Force Docker sandbox execution
  --distro <name>           Use the specified WSL distro
  --dry-run                 Print the command that would run instead of executing it
  --rebuild                 Force rebuild the sandbox Docker image
  --env-all                 Forward all environment variables into the container
  --no-projection           Disable workspace projection for this run
  --mirror-back             Mirror projected workspace back to Windows source after exit (default)
  --no-mirror-back          Disable mirror-back for this run
  --sync                    Enable Mutagen continuous sync (default)
  --no-sync                 Disable Mutagen continuous sync; use rsync/cp projection
  --sync-strategy <name>    Sync strategy: mutagen or projection
  --sync-keep-alive <mode>  Mutagen session cleanup: terminate, pause, or running
  --sync-mode <mode>        Mutagen sync mode: two-way-safe, two-way-resolved, one-way-safe, one-way-replica
  --mnt-guard               Install the /mnt guard pi extension (default)
  --no-mnt-guard            Remove the /mnt guard pi extension for this setup
  --source <path>           Source .pi/agent directory for migrate
  --win-user <name>         Windows username for migrate source detection
  --include-extensions      Migrate extension source during migrate
  --shell <shell>           Shell for install-shell-env (bash, zsh, fish)
  --help, -h                Show this help message

Any other arguments are passed through to pi.

Configuration:
  ~/.pixrc.json     User configuration
  .pix.json         Project configuration (overrides user config)
`);
}

function reinvokeInWsl(argv) {
  const distro = process.env.PIX_DISTRO || getDefaultDistro();
  if (!distro) {
    fatal('Could not determine default WSL distro. Set PIX_DISTRO or configure wsl.distro.');
  }

  const cwd = process.cwd();
  const wslCwd = toWslPath(cwd, distro);
  if (!wslCwd) {
    fatal(`Failed to convert current directory to WSL path: ${cwd}`);
  }

  const entry = __filename;
  const wslEntry = toWslPath(entry, distro);
  if (!wslEntry) {
    fatal(`Failed to convert pix entry path to WSL path: ${entry}`);
  }

  const packageRoot = path.resolve(__dirname, '..');
  const packageRootWsl = toWslPath(packageRoot, distro);
  if (!packageRootWsl) {
    fatal(`Failed to convert package root to WSL path: ${packageRoot}`);
  }

  if (!hasCommand('node', distro)) {
    fatal(`node is not available in WSL distro "${distro}". Install Node.js in WSL to use pix.`);
  }

  const command = `export PIX_PACKAGE_ROOT="${packageRootWsl}" && cd "${wslCwd}" && exec node "${wslEntry}" ${argv.map((a) => quoteShellArg(a)).join(' ')}`;
  const args = ['-d', distro, '--', 'bash', '-lic', command];

  return new Promise((resolve, reject) => {
    const child = spawn('wsl.exe', args, { stdio: 'inherit', shell: false });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
}

function quoteShellArg(arg) {
  if (/^[a-zA-Z0-9_\-./:=]+$/.test(arg)) return arg;
  return `"${arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return 0;
  }

  if (isWindows() && !isInsideWsl()) {
    const result = await reinvokeInWsl(argv);
    return result.code ?? 0;
  }

  const parsed = parseArgs(argv);

  if (parsed.command === 'status') {
    return statusCommand.execute(parsed);
  }

  if (parsed.command === 'doctor') {
    return doctorCommand.execute(parsed);
  }

  if (parsed.command === 'migrate') {
    return migrateCommand.execute(parsed);
  }

  if (parsed.command === 'install-shell-env') {
    return installShellEnvCommand.execute(parsed);
  }

  return runCommand.execute(parsed);
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    fatal(err.message || err);
  });
