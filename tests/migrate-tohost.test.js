const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function makeLegacyAgent() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pix-legacy-agent-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ theme: 'legacy-dark' }));
  fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify({ default: 'm1' }));
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ token: 'x' }));
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sessions', 's1.json'), '{"s":1}');
  return dir;
}

test('migration-dry-run: zero writes to the host layout', () => {
  process.env.PIX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pix-mig-home-'));
  const agent = makeLegacyAgent();
  const migrateCmd = require('../src/cli/commands/migrate');

  const code = migrateCmd.execute({ toHost: true, apply: false, source: agent });
  assert.equal(code, 0);
  assert.equal(fs.existsSync(path.join(process.env.PIX_HOME, 'profile', 'settings.json')), false);
  assert.equal(fs.existsSync(path.join(process.env.PIX_HOME, 'credentials', 'auth.json')), false);
});

test('migration-conflict: differing values keep both sides, no silent winner', () => {
  process.env.PIX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pix-mig-home2-'));
  const ctx = require('../src/host/resolve-home').resolveHostContext({ ensure: true });
  fs.writeFileSync(path.join(ctx.profileDir, 'settings.json'), JSON.stringify({ theme: 'host-light' }));

  const agent = makeLegacyAgent();
  const migrateCmd = require('../src/cli/commands/migrate');
  const code = migrateCmd.execute({ toHost: true, apply: true, source: agent, includeAuth: false });

  assert.equal(code, 1, 'conflicts reported as non-zero on apply');
  const hostSettings = JSON.parse(fs.readFileSync(path.join(ctx.profileDir, 'settings.json'), 'utf8'));
  assert.equal(hostSettings.theme, 'host-light', 'host value preserved');
  const legacySettings = JSON.parse(fs.readFileSync(path.join(agent, 'settings.json'), 'utf8'));
  assert.equal(legacySettings.theme, 'legacy-dark', 'incoming value preserved');

  // Non-conflicting data imported; auth skipped without --include-auth.
  assert.ok(fs.existsSync(path.join(ctx.profileDir, 'models.json')));
  assert.equal(fs.existsSync(path.join(ctx.credentialsDir, 'auth.json')), false);
});

test('migration-repeat: re-running does not duplicate sessions or overwrite', () => {
  process.env.PIX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pix-mig-home3-'));
  const agent = makeLegacyAgent();
  const migrateCmd = require('../src/cli/commands/migrate');

  migrateCmd.execute({ toHost: true, apply: true, source: agent, includeAuth: true });
  const ctx = require('../src/host/resolve-home').resolveHostContext({});
  const importedDir = path.join(ctx.sessionsStateDir, 'imported');
  const first = fs.existsSync(importedDir) ? fs.readdirSync(importedDir) : [];

  migrateCmd.execute({ toHost: true, apply: true, source: agent, includeAuth: true });
  const second = fs.existsSync(importedDir) ? fs.readdirSync(importedDir) : [];
  assert.deepEqual(first, second, 'no duplicate sessions on repeat');
});
