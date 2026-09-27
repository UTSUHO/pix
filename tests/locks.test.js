const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { acquireLock } = require('../src/host/locks');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pix-lock-test-'));
}

test('lock is mutual exclusion; second live holder gets LOCK_HELD', () => {
  const dir = tmpdir();
  const a = acquireLock(dir, 'update');
  assert.throws(() => acquireLock(dir, 'update'), /held by pid/);
  a.release();
  const b = acquireLock(dir, 'update'); // succeeds after release
  b.release();
});

test('stale lock from dead pid is reclaimed, never timeout-deleted while alive', () => {
  const dir = tmpdir();
  const lockPath = path.join(dir, 'update.lock');
  fs.mkdirSync(lockPath, { recursive: true });
  // A pid that cannot exist.
  fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: 4194303, startedAt: 'x' }));
  const lock = acquireLock(dir, 'update');
  lock.release();

  // Live pid (ourselves) must NOT be reclaimed.
  fs.mkdirSync(lockPath, { recursive: true });
  fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: 'x' }));
  assert.throws(() => acquireLock(dir, 'update'), (err) => err.code === 'LOCK_HELD');
  fs.rmSync(lockPath, { recursive: true, force: true });
});
