const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

/**
 * Host bridge: forwards Pix management commands from a managed WSL shim to
 * the Windows maintenance host. The link file is routing metadata written by
 * the host during setup/migration; it is not read from project config and it
 * is not an authentication mechanism.
 *
 * Loop protection: forwarded invocations carry PIX_BRIDGE=1. A process that
 * sees PIX_BRIDGE=1 while *not* on the host platform refuses to forward
 * again, so Windows -> WSL -> Windows ping-pong cannot occur.
 */

const BRIDGE_ENV = 'PIX_BRIDGE';
const BRIDGE_HOST_ID_ENV = 'PIX_BRIDGE_HOST_ID';
const HOST_LINK_VERSION = 1;

/** Commands the bridge accepts, with the flags each may carry. */
const FORWARDABLE = {
  update: ['--pi-only', '--plugins-only', '--dry-run'],
  deploy: ['--target', '--dry-run', '--rebuild'],
  status: ['--distro'],
  doctor: ['--distro'],
  migrate: ['--to-host', '--apply', '--dry-run', '--source', '--win-user', '--include-auth'],
  // run carries opaque pi args; they are forwarded as discrete argv elements
  // after "--" (never re-parsed as pix flags, never joined into a shell).
  run: ['--direct', '--sandbox', '--distro'],
};

function hostLinkPath(homeDir = os.homedir()) {
  return path.join(homeDir, '.pix', 'host-link.json');
}

function readHostLink(homeDir = os.homedir()) {
  try {
    const link = JSON.parse(fs.readFileSync(hostLinkPath(homeDir), 'utf8'));
    if (!link || link.schemaVersion !== HOST_LINK_VERSION || !link.hostId) return null;
    if (!link.windowsPixEntry || !link.windowsNode) return null;
    return link;
  } catch {
    return null;
  }
}

function writeHostLink(link, homeDir = os.homedir()) {
  const dest = hostLinkPath(homeDir);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(
    dest,
    JSON.stringify({ schemaVersion: HOST_LINK_VERSION, ...link }, null, 2) + '\n',
    'utf8'
  );
  return dest;
}

function isBridgeRequest(env = process.env) {
  return env[BRIDGE_ENV] === '1';
}

function hostUnavailable(reason) {
  const err = new Error(`HOST_UNAVAILABLE: ${reason}`);
  err.code = 'HOST_UNAVAILABLE';
  return err;
}

/**
 * Rebuild a validated argv from the parsed command. Only whitelisted commands
 * and flags survive; arbitrary shell fragments are impossible by construction.
 */
function buildForwardArgv(parsed) {
  const allowed = FORWARDABLE[parsed.command];
  if (!allowed) {
    throw hostUnavailable(`command "${parsed.command}" cannot be forwarded to the host`);
  }
  const argv = [parsed.command];
  const flagValues = {
    '--pi-only': parsed.piOnly,
    '--plugins-only': parsed.pluginsOnly,
    '--dry-run': parsed.dryRun,
    '--rebuild': parsed.rebuild,
    '--apply': parsed.apply,
    '--to-host': parsed.toHost,
    '--include-auth': parsed.includeAuth,
  };
  for (const [flag, on] of Object.entries(flagValues)) {
    if (on && allowed.includes(flag)) argv.push(flag);
  }
  const valued = {
    '--target': parsed.target,
    '--distro': parsed.distro,
    '--source': parsed.source,
    '--win-user': parsed.winUser,
  };
  for (const [flag, value] of Object.entries(valued)) {
    if (value && allowed.includes(flag)) argv.push(flag, String(value));
  }
  if (parsed.command === 'run') {
    if (parsed.execution === 'direct' && allowed.includes('--direct')) argv.push('--direct');
    if (parsed.execution === 'sandbox' && allowed.includes('--sandbox')) argv.push('--sandbox');
    argv.push('--', ...parsed.piArgs.map(String));
  }
  return argv;
}

/**
 * Forward a management command to the Windows host. Runs the recorded Windows
 * Node with the recorded Pix entry via WSL interop — never a shell string.
 *
 * @param {object} parsed  parseArgs() result
 * @param {object} deps    { homeDir, env, spawnImpl } for tests
 * @returns {Promise<number>} host-side exit code
 */
async function forwardToHost(parsed, deps = {}) {
  const env = deps.env || process.env;
  if (isBridgeRequest(env)) {
    throw hostUnavailable('bridge loop detected (PIX_BRIDGE already set in a non-host process)');
  }
  const link = readHostLink(deps.homeDir || os.homedir());
  if (!link) {
    throw hostUnavailable('no host binding (~/.pix/host-link.json missing or invalid). Run "pix migrate --to-host" on Windows first.');
  }

  const argv = buildForwardArgv(parsed);
  const spawnImpl = deps.spawnImpl || spawn;

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(link.windowsNode, [link.windowsPixEntry, ...argv], {
        stdio: 'inherit',
        shell: false,
        env: { ...env, [BRIDGE_ENV]: '1', [BRIDGE_HOST_ID_ENV]: link.hostId },
      });
    } catch (err) {
      reject(hostUnavailable(`failed to launch Windows host: ${err.message}`));
      return;
    }
    child.on('error', (err) => reject(hostUnavailable(`Windows host unreachable: ${err.message}`)));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

module.exports = {
  BRIDGE_ENV,
  BRIDGE_HOST_ID_ENV,
  HOST_LINK_VERSION,
  FORWARDABLE,
  hostLinkPath,
  readHostLink,
  writeHostLink,
  isBridgeRequest,
  buildForwardArgv,
  forwardToHost,
};
