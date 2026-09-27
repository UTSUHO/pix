#!/usr/bin/env node

const { isWindows, isInsideWsl } = require('../src/platform/wsl');
const { parseArgs, HOST_COMMANDS } = require('../src/cli/parse-args');
const { fatal, warn } = require('../src/cli/output');
const bridge = require('../src/host/bridge');

function printHelp() {
  console.log(`Usage: pix [options] [command] [pi-args...]

Commands:
  (default)           Launch pi via the managed pipeline (host-orchestrated)
  update              Update the managed Pi core + plugins on THIS host and
                      publish an immutable release (never enters WSL/Docker)
  deploy              Stage the current release onto a backend (--target wsl|docker|local)
  status              Show host release, backend copies and pending state
  doctor              Diagnose environment issues
  migrate             Migrate runtimes (legacy Windows->WSL; --to-host for the new layout)
  install-shell-env   Manage the pix block in your shell rc file
  init-guard          Copy the default guard template for customization

Options:
  --direct                  Force direct execution
  --sandbox                 Force sandbox execution
  --legacy                Use the explicit v0.3 compatibility pipeline
  --distro <name>           Use the specified WSL distro
  --dry-run                 Print what would happen instead of doing it
  --rebuild                 Force rebuild of the sandbox image
  --env-all                 Forward all environment variables into the container
  --no-projection           Disable workspace projection for this run
  --mirror-back             Mirror the projected workspace back after exit
  --no-mirror-back          Disable mirror-back for this run
  --writeback <policy>      Workspace writeback: realtime or review
  --allow-raw-workspace     Allow running on the raw Windows path if projection fails
  --sync / --no-sync        Enable/disable Mutagen continuous sync
  --sync-strategy <name>    Sync strategy: mutagen or projection
  --sync-keep-alive <mode>  Mutagen cleanup: terminate, pause, or running
  --sync-mode <mode>        Mutagen mode: two-way-safe (default), two-way-resolved, ...
  --no-mnt-guard            Do not inject the guard for this run
  --pi-only                 update: only the Pi core
  --plugins-only            update: only managed plugins
  --target <name>           deploy target: wsl, docker, local
  --to-host                 migrate: import legacy runtimes into this host
  --apply                   migrate --to-host: apply (default is dry-run report)
  --source <path>           migrate source directory
  --win-user <name>         Windows username for migrate source detection
  --include-auth            migrate: include credentials (never printed)
  --include-extensions      migrate: include extension source
  --shell <shell>           Shell for install-shell-env (bash, zsh, fish)
  --help, -h                Show this help message

Anything after "--" is passed to pi verbatim.

Configuration:
  <PIX_HOME>/config.json   Host user configuration (PIX_HOME defaults to
                           %USERPROFILE%\\.pix on Windows, ~/.pix elsewhere)
  .pix.json                Project configuration (can only narrow privileges)
`);
}

async function main() {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);

  if (parsed.help) {
    printHelp();
    return 0;
  }

  const onWindowsHost = isWindows() && !isInsideWsl();
  const inWsl = isInsideWsl();

  // Bridge loop protection: a forwarded management request must execute on
  // the host; it must never be forwarded onward.
  if (bridge.isBridgeRequest() && !onWindowsHost) {
    fatal('HOST_UNAVAILABLE: bridge loop detected; refusing to forward a forwarded request.');
  }

  // --- WSL shim behavior ---------------------------------------------------
  if (inWsl && !bridge.isBridgeRequest()) {
    if (HOST_COMMANDS.has(parsed.command) || parsed.command === 'status' || parsed.command === 'doctor') {
      // Management commands belong to the Windows host. Forward via the
      // binding; fail closed when unbound — never a local Linux upgrade.
      try {
        return await bridge.forwardToHost(parsed);
      } catch (err) {
        if (err.code === 'HOST_UNAVAILABLE') {
          fatal(err.message);
        }
        throw err;
      }
    }
    if (parsed.command === 'run' && !parsed.legacy) {
      const link = bridge.readHostLink();
      if (link) {
        // Managed run: orchestrated by the Windows host.
        try {
          return await bridge.forwardToHost({ ...parsed, command: 'run' });
        } catch (err) {
          if (err.code === 'HOST_UNAVAILABLE') fatal(err.message);
          throw err;
        }
      }
      fatal(
        'This WSL environment is not bound to a Windows pix host.\n' +
        '  - Run pix on the Windows host, or\n' +
        '  - Run "pix migrate --to-host" on Windows to set up the managed layout, or\n' +
        '  - Use "pix --legacy" for the explicit v0.3 compatibility pipeline.'
      );
    }
  }

  // --- command dispatch (host side, or local commands anywhere) ------------
  switch (parsed.command) {
    case 'update':
      return require('../src/cli/commands/update').execute(parsed);
    case 'deploy':
      return require('../src/cli/commands/deploy').execute(parsed);
    case 'status':
      return require('../src/cli/commands/status').execute(parsed);
    case 'doctor':
      return require('../src/cli/commands/doctor').execute(parsed);
    case 'migrate':
      return require('../src/cli/commands/migrate').execute(parsed);
    case 'install-shell-env':
      return require('../src/cli/commands/install-shell-env').execute(parsed);
    case 'init-guard':
      return require('../src/cli/commands/init-guard').execute(parsed);
    case 'run':
    default:
      return require('../src/cli/commands/run').execute(parsed);
  }
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    fatal(err.message || err);
  });
