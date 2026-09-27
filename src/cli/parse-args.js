/**
 * Pix argument parser. Runs BEFORE any WSL bootstrap so command ownership
 * (Windows host vs backend) can be decided from the parsed result.
 *
 * Everything after a literal `--` is passed to pi verbatim.
 */

const KNOWN_COMMANDS = new Set([
  'run',
  'status',
  'doctor',
  'migrate',
  'install-shell-env',
  'init-guard',
  'update',
  'deploy',
]);

/** Commands that manage the Windows host installation and must never be
 * silently executed inside a backend. */
const HOST_COMMANDS = new Set(['update', 'deploy', 'migrate']);

function parseArgs(argv) {
  const result = {
    command: 'run',
    execution: null,
    dryRun: false,
    rebuild: false,
    envAll: false,
    distro: null,
    help: false,
    source: null,
    winUser: null,
    includeExtensions: false,
    shell: null,
    noProjection: false,
    noMirrorBack: false,
    mirrorBack: false,
    writeback: null,
    allowRawWorkspace: false,
    legacy: false,
    sync: null,
    syncStrategy: null,
    syncKeepAlive: null,
    syncMode: null,
    mntGuard: null,
    dockerfile: null,
    // update / deploy / migrate --to-host
    piOnly: false,
    pluginsOnly: false,
    target: null,
    toHost: false,
    apply: false,
    includeAuth: false,
    piArgs: [],
  };

  let passthrough = false;
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    if (passthrough) {
      result.piArgs.push(arg);
      i += 1;
      continue;
    }

    if (arg === '--') {
      passthrough = true;
    } else if (arg === '--direct') {
      result.execution = 'direct';
    } else if (arg === '--sandbox') {
      result.execution = 'sandbox';
    } else if (arg === '--dry-run') {
      result.dryRun = true;
    } else if (arg === '--rebuild') {
      result.rebuild = true;
    } else if (arg === '--env-all') {
      result.envAll = true;
    } else if (arg === '--include-extensions') {
      result.includeExtensions = true;
    } else if (arg === '--no-projection') {
      result.noProjection = true;
    } else if (arg === '--no-mirror-back') {
      result.noMirrorBack = true;
    } else if (arg === '--mirror-back') {
      result.mirrorBack = true;
    } else if (arg === '--writeback') {
      i += 1;
      result.writeback = argv[i];
    } else if (arg === '--allow-raw-workspace') {
      result.allowRawWorkspace = true;
    } else if (arg === '--legacy') {
      result.legacy = true;
    } else if (arg === '--sync') {
      result.sync = true;
    } else if (arg === '--no-sync') {
      result.sync = false;
    } else if (arg === '--sync-strategy') {
      i += 1;
      result.syncStrategy = argv[i];
    } else if (arg === '--sync-keep-alive') {
      i += 1;
      result.syncKeepAlive = argv[i];
    } else if (arg === '--sync-mode') {
      i += 1;
      result.syncMode = argv[i];
    } else if (arg === '--mnt-guard') {
      result.mntGuard = true;
    } else if (arg === '--no-mnt-guard') {
      result.mntGuard = false;
    } else if (arg === '--dockerfile') {
      i += 1;
      result.dockerfile = argv[i];
    } else if (arg === '--distro') {
      i += 1;
      result.distro = argv[i];
    } else if (arg === '--source') {
      i += 1;
      result.source = argv[i];
    } else if (arg === '--win-user') {
      i += 1;
      result.winUser = argv[i];
    } else if (arg === '--shell') {
      i += 1;
      result.shell = argv[i];
    } else if (arg === '--pi-only') {
      result.piOnly = true;
    } else if (arg === '--plugins-only') {
      result.pluginsOnly = true;
    } else if (arg === '--target') {
      i += 1;
      result.target = argv[i];
    } else if (arg === '--to-host') {
      result.toHost = true;
    } else if (arg === '--apply') {
      result.apply = true;
    } else if (arg === '--include-auth') {
      result.includeAuth = true;
    } else if (arg === '--help' || arg === '-h') {
      result.help = true;
    } else if (result.command === 'run' && !result.piArgs.length && KNOWN_COMMANDS.has(arg)) {
      result.command = arg;
    } else {
      result.piArgs.push(arg);
    }

    i += 1;
  }

  return result;
}

module.exports = { parseArgs, KNOWN_COMMANDS, HOST_COMMANDS };
