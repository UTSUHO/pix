const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { prepareWorkspace, cleanupWorkspace, writeState } = require('../src/workspace/sync');
const { diffWorkspace } = require('../src/workspace/projection');

const WIN_SOURCE = '/mnt/d/Documents/fake-project';

function configWith(overrides = {}) {
  return {
    workspace: {
      projection: true,
      projectionRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'pix-proj-root-')),
      mirrorBack: false,
      writeback: 'review',
      exclude: ['node_modules'],
      sync: { enabled: false, strategy: 'projection' },
      ...overrides,
    },
  };
}

test('workspace-no-raw-fallback: projection failure is final without explicit override', () => {
  const config = configWith();
  // Source does not exist -> rsync/cp fails -> must NOT fall back silently.
  assert.throws(
    () => prepareWorkspace(WIN_SOURCE, config, {}),
    (err) => err.code === 'WORKSPACE_PROJECTION_FAILED'
  );

  // Explicit override returns the raw path with a clear storage type.
  const desc = prepareWorkspace(WIN_SOURCE, config, { allowRawWorkspace: true });
  assert.equal(desc.storageType, 'windows-ntfs-raw');
  assert.equal(desc.executionRoot, WIN_SOURCE);
});

test('workspace-uncollected: an uncollected copy is never reseeded over', () => {
  const config = configWith();
  const { resolveProjectedPath } = require('../src/workspace/projection');
  const projected = resolveProjectedPath(WIN_SOURCE, config, process.env.HOME);
  fs.mkdirSync(projected, { recursive: true });
  fs.writeFileSync(path.join(projected, 'agent-work.txt'), 'uncollected agent output\n');
  writeState(projected, { sourceRoot: WIN_SOURCE, strategy: 'projection', collected: false });

  assert.throws(
    () => prepareWorkspace(WIN_SOURCE, config, {}),
    (err) => err.code === 'WORKSPACE_CONFLICT'
  );
  assert.equal(fs.readFileSync(path.join(projected, 'agent-work.txt'), 'utf8'), 'uncollected agent output\n');
});

test('review writeback: no auto-overwrite, diff report produced, copy kept', () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'pix-src-'));
  const projected = fs.mkdtempSync(path.join(os.tmpdir(), 'pix-proj-'));
  fs.writeFileSync(path.join(source, 'keep.txt'), 'original\n');
  fs.writeFileSync(path.join(projected, 'keep.txt'), 'modified by agent\n');
  fs.writeFileSync(path.join(projected, 'new.txt'), 'agent created\n');

  const config = configWith();
  const desc = {
    cleanupHandle: { strategy: 'projection', executionRoot: projected, sourceRoot: source },
  };
  const reportPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pix-report-')), 'diff.json');
  const result = cleanupWorkspace(desc, config, { reportPath });

  assert.equal(result.collected, false);
  assert.equal(fs.readFileSync(path.join(source, 'keep.txt'), 'utf8'), 'original\n', 'source must NOT be overwritten in review mode');
  assert.deepEqual(result.report.modified, ['keep.txt']);
  assert.deepEqual(result.report.added, ['new.txt']);
  assert.ok(fs.existsSync(reportPath));
});

test('workspace-double-change: Windows and agent both changed -> conflict visible, no silent winner', () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'pix-src2-'));
  const projected = fs.mkdtempSync(path.join(os.tmpdir(), 'pix-proj2-'));
  fs.writeFileSync(path.join(source, 'both.txt'), 'windows version\n');
  fs.writeFileSync(path.join(projected, 'both.txt'), 'agent version\n');

  const report = diffWorkspace(projected, source, []);
  assert.deepEqual(report.modified, ['both.txt']);
  // Review policy keeps both; nothing auto-merges or overwrites.
  const config = configWith();
  const result = cleanupWorkspace({ cleanupHandle: { strategy: 'projection', executionRoot: projected, sourceRoot: source } }, config, {});
  assert.equal(result.collected, false);
  assert.equal(fs.readFileSync(path.join(source, 'both.txt'), 'utf8'), 'windows version\n');
  assert.equal(fs.readFileSync(path.join(projected, 'both.txt'), 'utf8'), 'agent version\n');
});

test('workspace-stale-replica: new session over an existing collected copy ALWAYS reseeds first', () => {
  // Regression: creating a mutagen session over a stale replica without
  // reseeding let alpha-wins sync modes revert newer Windows edits.
  const config = configWith({ sync: { enabled: true, strategy: 'mutagen', mode: 'two-way-resolved' } });
  const { resolveProjectedPath } = require('../src/workspace/projection');
  const projected = resolveProjectedPath(WIN_SOURCE, config, process.env.HOME);
  fs.mkdirSync(projected, { recursive: true });
  fs.writeFileSync(path.join(projected, 'stale.txt'), 'old replica content\n');
  writeState(projected, { sourceRoot: WIN_SOURCE, strategy: 'mutagen', collected: true });

  const calls = [];
  const desc = prepareWorkspace(WIN_SOURCE, config, {
    mutagenBin: '/fake/mutagen',
    mutagenOps: {
      sessionExists: () => false,
      resumeSession: () => calls.push('resume'),
      createSession: () => calls.push('create'),
      waitForSession: () => calls.push('wait'),
    },
    projectWorkspaceImpl: () => calls.push('seed'),
  });

  assert.deepEqual(calls, ['seed', 'create', 'wait'], 'must reseed before creating a session over an existing copy');
  assert.equal(desc.syncMode, 'two-way-resolved');
});

test('workspace-live-session: an owned copy is resumed, never reseeded', () => {
  const config = configWith({ sync: { enabled: true, strategy: 'mutagen' } });
  const { resolveProjectedPath } = require('../src/workspace/projection');
  const projected = resolveProjectedPath(WIN_SOURCE, config, process.env.HOME);
  fs.mkdirSync(projected, { recursive: true });
  fs.writeFileSync(path.join(projected, 'live.txt'), 'owned by live session\n');

  const calls = [];
  prepareWorkspace(WIN_SOURCE, config, {
    mutagenBin: '/fake/mutagen',
    mutagenOps: {
      sessionExists: () => true,
      resumeSession: () => calls.push('resume'),
      createSession: () => calls.push('create'),
      waitForSession: () => calls.push('wait'),
    },
    projectWorkspaceImpl: () => calls.push('seed'),
  });

  assert.deepEqual(calls, ['resume', 'wait'], 'live session resumes without reseed');
});
