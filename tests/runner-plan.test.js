const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ensureRunner, createLocalTransport, runnerDigest } = require('../src/runner/deploy');
const { buildExecutionPlan, validateExecutionPlan } = require('../src/runner/plan');

function fakePackage() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pix-pkg-'));
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bin', 'pix-runner.js'), '// runner\n');
  fs.writeFileSync(path.join(root, 'src', 'mod.js'), '// mod\n');
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"pix"}\n');
  return root;
}

test('runner deploy is content-addressed: warm deploy copies nothing', () => {
  const pkg = fakePackage();
  const targetHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pix-target-'));
  const transport = createLocalTransport();

  const first = ensureRunner({ packageRoot: pkg, pixVersion: '0.4.0', targetHome }, transport);
  assert.equal(first.deployed, true);
  assert.ok(fs.existsSync(path.join(targetHome, '.pix', 'runners', first.name, 'bin', 'pix-runner.js')));

  const second = ensureRunner({ packageRoot: pkg, pixVersion: '0.4.0', targetHome }, transport);
  assert.equal(second.deployed, false);
  assert.equal(second.name, first.name);

  // Content change -> new runner directory.
  fs.writeFileSync(path.join(pkg, 'src', 'mod.js'), '// mod v2\n');
  const third = ensureRunner({ packageRoot: pkg, pixVersion: '0.4.0', targetHome }, transport);
  assert.equal(third.deployed, true);
  assert.notEqual(third.name, first.name);
});

test('execution plan validation', () => {
  const plan = buildExecutionPlan({
    hostId: 'h1',
    runId: 'r1',
    backend: 'direct',
    transport: 'pipe',
    bodyRevision: 'rev',
    profileRevision: 'prof',
    workspace: { id: 'ws-1', sourceRoot: '/src', executionRoot: '/home/u/.pix/workspaces/ws-1' },
    session: { directory: '/home/u/.pix/sessions/ws-1' },
    piArgs: ['-p', 'hi'],
    approvedPolicy: { workspace: {} },
  });
  assert.equal(validateExecutionPlan(plan).valid, true);

  assert.throws(() => buildExecutionPlan({
    hostId: 'h1', runId: 'r1', backend: 'direct', bodyRevision: 'rev', profileRevision: 'p',
    workspace: { id: 'w', sourceRoot: '/s', executionRoot: 'relative/bad' },
    session: { directory: '/x' },
  }), /executionRoot/);
});
