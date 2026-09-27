const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { collectBodyGarbage } = require('../src/runtime/gc');

function setupRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pix-gc-root-'));
  const mk = (p, content = '{}') => {
    const full = path.join(root, p);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  // current runtime + install
  mk('runtimes/rt-current/ready.json', JSON.stringify({ bodyRevision: 'revA', installId: 'inst-1' }));
  mk('installs/inst-1/ready.json', '{}');
  // rollback runtime + its install
  mk('runtimes/rt-prev/ready.json', JSON.stringify({ bodyRevision: 'revB', installId: 'inst-2' }));
  mk('installs/inst-2/ready.json', '{}');
  // obsolete runtime + orphan install
  mk('runtimes/rt-old/ready.json', JSON.stringify({ bodyRevision: 'revC', installId: 'inst-3' }));
  mk('installs/inst-3/ready.json', '{}');
  mk('installs/inst-orphan/ready.json', '{}');
  // interrupted staging
  fs.mkdirSync(path.join(root, 'runtimes', '.staging-xyz'), { recursive: true });
  // runs: one uncollected, many collected
  mk('runs/run-crash/UNCOLLECTED', '{}');
  for (let i = 0; i < 25; i += 1) {
    mk(`runs/run-${String(i).padStart(2, '0')}/result.json`, '{}');
  }
  // workspace + sessions (must always survive)
  mk('workspaces/ws-1/code.txt', 'x');
  mk('sessions/ws-1/s.json', '{}');
  return root;
}

test('gc-protection: active/rollback kept, uncollected runs + workspaces + sessions survive', () => {
  const root = setupRoot();
  const removed = collectBodyGarbage(root, {
    currentBodyRevision: 'revA',
    previousBodyRevision: 'revB',
    keepRuns: 20,
  });

  assert.ok(fs.existsSync(path.join(root, 'runtimes', 'rt-current')));
  assert.ok(fs.existsSync(path.join(root, 'runtimes', 'rt-prev')), 'rollback runtime kept');
  assert.ok(!fs.existsSync(path.join(root, 'runtimes', 'rt-old')), 'obsolete runtime removed');
  assert.ok(fs.existsSync(path.join(root, 'installs', 'inst-1')));
  assert.ok(fs.existsSync(path.join(root, 'installs', 'inst-2')));
  assert.ok(!fs.existsSync(path.join(root, 'installs', 'inst-orphan')), 'orphan install removed');
  assert.ok(!fs.existsSync(path.join(root, 'runtimes', '.staging-xyz')), 'staging cleaned');

  assert.ok(fs.existsSync(path.join(root, 'runs', 'run-crash', 'UNCOLLECTED')), 'uncollected run protected');
  assert.ok(fs.existsSync(path.join(root, 'workspaces', 'ws-1', 'code.txt')), 'workspace protected');
  assert.ok(fs.existsSync(path.join(root, 'sessions', 'ws-1', 's.json')), 'session protected');

  const remainingRuns = fs.readdirSync(path.join(root, 'runs'));
  assert.equal(remainingRuns.length, 21, '20 collected kept + 1 uncollected');
  assert.ok(removed.runtimes.length >= 1);
});
