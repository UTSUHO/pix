const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDockerArgs, collectEnvVars } = require('../src/executors/sandbox-executor');

const runtime = { nodeExecutable: 'node', piEntrypoint: '/opt/pix/body/x.js' };
const runCtx = {
  agentDir: '/home/u/.pix/runs/r1/agent',
  workspaceRoot: '/home/u/.pix/workspaces/ws-1',
  piArgs: ['-p', 'hi'],
  env: {},
  transport: 'tty',
};

test('docker-mount-boundary: only workspace + run agent mounts, nothing else', () => {
  const args = buildDockerArgs(runtime, runCtx, { container: {}, envAllowlist: [] }, { imageName: 'img:tag' });
  const mounts = args.filter((a, i) => args[i - 1] === '--mount');
  assert.equal(mounts.length, 2);
  assert.ok(mounts.some((m) => m === 'type=bind,src=/home/u/.pix/workspaces/ws-1,dst=/workspace'));
  assert.ok(mounts.some((m) => m === 'type=bind,src=/home/u/.pix/runs/r1/agent,dst=/run/pix-agent'));
  const joined = args.join(' ');
  for (const banned of ['docker.sock', '/.pix/body,', 'type=bind,src=/home/u,', '--privileged', 'host-link']) {
    assert.ok(!joined.includes(banned), `must not contain ${banned}`);
  }
});

test('docker tty/pipe branch: tty gets -it, pipe gets -i without -t', () => {
  const ttyArgs = buildDockerArgs(runtime, runCtx, { container: {}, envAllowlist: [] }, { imageName: 'i' });
  assert.ok(ttyArgs.includes('-it'));

  const pipeArgs = buildDockerArgs(runtime, { ...runCtx, transport: 'pipe' }, { container: {}, envAllowlist: [] }, { imageName: 'i' });
  assert.ok(pipeArgs.includes('-i'));
  assert.ok(!pipeArgs.includes('-it'));
  assert.ok(!pipeArgs.includes('-t'));
});

test('docker read-only workspace and non-privileged user', () => {
  const args = buildDockerArgs(
    runtime,
    { ...runCtx, runAsUser: '1000:1000' },
    { container: { workspaceAccess: 'read-only' }, envAllowlist: [] },
    { imageName: 'i' }
  );
  assert.ok(args.some((a) => a === 'type=bind,src=/home/u/.pix/workspaces/ws-1,dst=/workspace,readonly'));
  const userIdx = args.indexOf('--user');
  assert.equal(args[userIdx + 1], '1000:1000');
});

test('env allowlist filters; PI_CODING_AGENT_DIR points at the run dir', () => {
  process.env.ALLOWED_KEY = 'yes';
  process.env.SECRET_KEY = 'no';
  const env = collectEnvVars({ envAllowlist: ['ALLOWED_KEY'] }, false);
  assert.equal(env.ALLOWED_KEY, 'yes');
  assert.equal(env.SECRET_KEY, undefined);

  const args = buildDockerArgs(runtime, runCtx, { container: {}, envAllowlist: ['ALLOWED_KEY'] }, { imageName: 'i' });
  assert.ok(args.includes('PI_CODING_AGENT_DIR=/run/pix-agent'));
});
