const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildForwardArgv, forwardToHost, writeHostLink, readHostLink } = require('../src/host/bridge');

function setupLink() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pix-bridge-test-'));
  writeHostLink({
    hostId: 'host123',
    windowsPixHome: 'C:\\Users\\u\\.pix',
    windowsNode: 'C:\\Program Files\\node\\node.exe',
    windowsPixEntry: 'C:\\Users\\u\\pix\\bin\\pix.js',
  }, homeDir);
  return homeDir;
}

test('route-argv: forwarded argv contains only validated flags; run args after --', () => {
  assert.deepEqual(
    buildForwardArgv({ command: 'update', piOnly: true, dryRun: true }),
    ['update', '--pi-only', '--dry-run']
  );
  assert.deepEqual(
    buildForwardArgv({ command: 'migrate', toHost: true, apply: true }),
    ['migrate', '--apply', '--to-host']
  );
  const runArgv = buildForwardArgv({
    command: 'run',
    execution: 'sandbox',
    piArgs: ['-p', 'hello; rm -rf /', '你好'],
  });
  assert.deepEqual(runArgv, ['run', '--sandbox', '--', '-p', 'hello; rm -rf /', '你好']);
});

test('route-wsl-update: bridge spawns Windows node exactly once with PIX_BRIDGE env', async () => {
  const homeDir = setupLink();
  const calls = [];
  const code = await forwardToHost({ command: 'update' }, {
    homeDir,
    env: {},
    spawnImpl(cmd, args, opts) {
      calls.push({ cmd, args, env: opts.env });
      return {
        on(event, cb) {
          if (event === 'close') setImmediate(() => cb(0));
          return this;
        },
      };
    },
  });
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'C:\\Program Files\\node\\node.exe');
  assert.deepEqual(calls[0].args, ['C:\\Users\\u\\pix\\bin\\pix.js', 'update']);
  assert.equal(calls[0].env.PIX_BRIDGE, '1');
  assert.equal(calls[0].env.PIX_BRIDGE_HOST_ID, 'host123');
});

test('route-no-host: missing binding fails closed with HOST_UNAVAILABLE', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pix-bridge-empty-'));
  await assert.rejects(
    forwardToHost({ command: 'update' }, { homeDir, env: {} }),
    (err) => err.code === 'HOST_UNAVAILABLE'
  );
});

test('bridge loop protection: PIX_BRIDGE=1 in a non-host process refuses to forward', async () => {
  const homeDir = setupLink();
  await assert.rejects(
    forwardToHost({ command: 'update' }, { homeDir, env: { PIX_BRIDGE: '1' } }),
    (err) => err.code === 'HOST_UNAVAILABLE' && /loop/.test(err.message)
  );
});

test('non-forwardable commands are rejected', () => {
  assert.throws(() => buildForwardArgv({ command: 'install-shell-env' }), /HOST_UNAVAILABLE/);
});
