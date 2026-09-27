const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs } = require('../src/cli/parse-args');

test('commands are recognized before pi passthrough', () => {
  assert.equal(parseArgs(['update']).command, 'update');
  assert.equal(parseArgs(['deploy', '--target', 'wsl']).command, 'deploy');
  assert.equal(parseArgs(['migrate', '--to-host']).toHost, true);
  assert.equal(parseArgs([]).command, 'run');
});

test('everything after -- goes to pi verbatim, even pix flags and commands', () => {
  const p = parseArgs(['--sandbox', '--', '--direct', 'status', '--sync-mode', 'x']);
  assert.equal(p.execution, 'sandbox');
  assert.deepEqual(p.piArgs, ['--direct', 'status', '--sync-mode', 'x']);
});

test('unknown args, leading dashes, Chinese and spaces are preserved for pi', () => {
  const p = parseArgs(['--unknown-flag', '你好 世界', '-p', 'with space']);
  assert.equal(p.command, 'run');
  assert.deepEqual(p.piArgs, ['--unknown-flag', '你好 世界', '-p', 'with space']);
});

test('update/deploy options parse', () => {
  const u = parseArgs(['update', '--pi-only', '--dry-run']);
  assert.equal(u.piOnly, true);
  assert.equal(u.dryRun, true);
  const d = parseArgs(['deploy', '--target', 'docker', '--rebuild']);
  assert.equal(d.target, 'docker');
  assert.equal(d.rebuild, true);
  const m = parseArgs(['migrate', '--to-host', '--apply', '--include-auth']);
  assert.equal(m.apply, true);
  assert.equal(m.includeAuth, true);
});

test('run flags still parse alongside pi args', () => {
  const p = parseArgs(['--direct', '--writeback', 'review', '--allow-raw-workspace', 'fix', 'this']);
  assert.equal(p.execution, 'direct');
  assert.equal(p.writeback, 'review');
  assert.equal(p.allowRawWorkspace, true);
  assert.deepEqual(p.piArgs, ['fix', 'this']);
});
