const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  hashProfile,
  ensureProfileSnapshot,
  renderJsonPaths,
  composeRunAgent,
  listUncollectedRuns,
  markRunUncollected,
} = require('../src/runtime/compose-agent');

function setup() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pix-compose-root-'));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pix-profile-'));
  fs.writeFileSync(path.join(profileDir, 'settings.json'), JSON.stringify({ theme: 'dark', ext: 'extensions/e1' }));
  fs.mkdirSync(path.join(profileDir, 'extensions'), { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'extensions', 'e1'), '// ext');
  const credentialsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pix-creds-'));
  fs.writeFileSync(path.join(credentialsDir, 'auth.json'), JSON.stringify({ token: 'secret' }));
  const resourcesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pix-resources-'));
  fs.mkdirSync(path.join(resourcesRoot, 'res-ext'), { recursive: true });
  fs.writeFileSync(path.join(resourcesRoot, 'res-ext', 'r.ts'), '// resource');
  return { rootDir, profileDir, credentialsDir, resourcesRoot };
}

function compose(env, runId, workspaceId = 'ws-1') {
  return composeRunAgent({
    rootDir: env.rootDir,
    runId,
    workspaceId,
    profileRevision: hashProfile(env.profileDir),
    profileSourceDir: env.profileDir,
    runtime: { resourcesRoot: env.resourcesRoot },
    credentialsDir: env.credentialsDir,
    mntGuard: true,
    guardConfig: null,
  });
}

test('profile-only-change: settings edit changes profileRevision, snapshot reused while unchanged', () => {
  const env = setup();
  const rev1 = hashProfile(env.profileDir);
  const snap1 = ensureProfileSnapshot(env.rootDir, env.profileDir, rev1);
  const again = ensureProfileSnapshot(env.rootDir, env.profileDir, rev1);
  assert.equal(snap1, again);

  fs.writeFileSync(path.join(env.profileDir, 'settings.json'), JSON.stringify({ theme: 'light' }));
  const rev2 = hashProfile(env.profileDir);
  assert.notEqual(rev1, rev2, 'settings change must change profileRevision only');
});

test('renderJsonPaths rewrites profile-relative refs, leaves prompts/URLs alone', () => {
  const env = setup();
  const rendered = renderJsonPaths(
    { ext: 'extensions/e1', url: 'https://example.com/x', prompt: 'please edit extensions/e1 carefully' },
    env.profileDir
  );
  assert.equal(rendered.ext, path.join(env.profileDir, 'extensions', 'e1'));
  assert.equal(rendered.url, 'https://example.com/x');
  assert.equal(rendered.prompt, 'please edit extensions/e1 carefully');
});

test('session-lock: same workspace session cannot have two concurrent owners', () => {
  const env = setup();
  const first = compose(env, 'run-1', 'ws-shared');
  assert.throws(() => compose(env, 'run-2', 'ws-shared'), (err) => err.code === 'SESSION_LOCKED');
  first.leaseRelease();
  const third = compose(env, 'run-3', 'ws-shared');
  third.leaseRelease();
});

test('session-mapping: different workspaces get different session directories', () => {
  const env = setup();
  const a = compose(env, 'run-a', 'ws-a');
  const b = compose(env, 'run-b', 'ws-b');
  assert.notEqual(a.sessionDir, b.sessionDir);
  a.leaseRelease();
  b.leaseRelease();
});

test('auth-not-in-body: credentials copied per run, profile digest unaffected', () => {
  const env = setup();
  const before = hashProfile(env.profileDir);
  const agent = compose(env, 'run-auth');
  assert.ok(fs.existsSync(path.join(agent.agentDir, 'auth.json')));
  fs.writeFileSync(path.join(env.credentialsDir, 'auth.json'), JSON.stringify({ token: 'rotated' }));
  assert.equal(hashProfile(env.profileDir), before, 'credential rotation must not change profileRevision');
  agent.leaseRelease();
});

test('profile-writeback: run-time changes never touch the host profile source', () => {
  const env = setup();
  const agent = compose(env, 'run-w');
  const runSettings = path.join(agent.agentDir, 'settings.json');
  fs.writeFileSync(runSettings, JSON.stringify({ theme: 'changed-by-agent' }));
  const source = JSON.parse(fs.readFileSync(path.join(env.profileDir, 'settings.json'), 'utf8'));
  assert.equal(source.theme, 'dark', 'host profile must not be overwritten by run changes');
  agent.leaseRelease();
});

test('guard composes into the run agent dir, not into sealed resources', () => {
  const env = setup();
  const agent = compose(env, 'run-g');
  assert.ok(fs.existsSync(path.join(agent.agentDir, 'extensions', 'pix-mnt-guard.ts')));
  assert.ok(!fs.existsSync(path.join(env.resourcesRoot, 'pix-mnt-guard.ts')), 'sealed resources must stay untouched');
  // runtime resource extension also composed
  assert.ok(fs.existsSync(path.join(agent.agentDir, 'extensions', 'res-ext', 'r.ts')));
  agent.leaseRelease();
});

test('uncollected runs are tracked for doctor/GC protection', () => {
  const env = setup();
  markRunUncollected(env.rootDir, 'run-x', 'simulated crash');
  const runs = listUncollectedRuns(env.rootDir);
  assert.deepEqual(runs.map((r) => r.runId), ['run-x']);
});
