const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { updateRc, buildBlock } = require('../src/cli/commands/install-shell-env');

test('shell-block: only the pix managed block changes; legacy export removed', () => {
  const rc = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pix-rc-')), '.bashrc');
  const original = [
    '# user header',
    'export EDITOR=vim',
    '',
    '# >>> pix >>>',
    'export PI_CODING_AGENT_DIR="/home/u/.pix/runtime/agent"',
    '# <<< pix <<<',
    '',
    'alias ll="ls -la"',
    '',
  ].join('\n');
  fs.writeFileSync(rc, original);

  const action = updateRc(rc);
  assert.equal(action, 'replaced-legacy');

  const after = fs.readFileSync(rc, 'utf8');
  assert.ok(after.includes('# user header'));
  assert.ok(after.includes('export EDITOR=vim'));
  assert.ok(after.includes('alias ll="ls -la"'));
  assert.ok(!after.includes('PI_CODING_AGENT_DIR="/home'), 'legacy export removed');
  assert.ok(after.includes('# >>> pix >>>'));

  // Idempotent: second run is a no-op update.
  const before2 = fs.readFileSync(rc, 'utf8');
  const action2 = updateRc(rc);
  assert.equal(action2, 'updated');
  assert.equal(fs.readFileSync(rc, 'utf8'), before2);
});

test('shell-block: block never points at a release or run directory', () => {
  const block = buildBlock();
  assert.ok(!block.includes('PI_CODING_AGENT_DIR='));
  assert.ok(!block.includes('/releases/'));
  assert.ok(!block.includes('/runs/'));
});
