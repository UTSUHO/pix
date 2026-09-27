const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * End-to-end integration on a LOCAL target: hand-built host release (with a
 * vendored tarball dependency and a real generated lockfile) -> run command
 * -> real pix-runner child process -> real npm ci -> fake managed pi child
 * process. No network, no WSL, no Docker.
 *
 * Covered: release staging, runner deploy, plan init over stdin, frozen
 * install, composeRunAgent, direct execution, collect, warm reuse.
 */

const PI = '@earendil-works/pi-coding-agent';

function buildFakePiPackage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pix-e2e-pkg-'));
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: PI,
    version: '2.1.0',
    bin: { pi: './bin/pi.js' },
    engines: { node: '>=18' },
  }, null, 2));
  // A REAL executable fake pi: records its environment into cwd, exits 0.
  fs.writeFileSync(path.join(dir, 'bin', 'pi.js'), [
    'const fs = require("fs");',
    'const path = require("path");',
    'const out = {',
    '  cwd: process.cwd(),',
    '  agentDir: process.env.PI_CODING_AGENT_DIR,',
    '  args: process.argv.slice(2),',
    '};',
    'fs.writeFileSync(path.join(process.cwd(), "pi-run-record.json"), JSON.stringify(out));',
    'process.exit(0);',
  ].join('\n'));
  return dir;
}

function buildRelease(ctx, fakePiDir) {
  const { computeBodyRevision, sha256hex } = require('../src/runtime/manifest');
  const { resolveNpmCommand } = require('../src/host/adapters');
  const npmCmd = resolveNpmCommand();

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'pix-e2e-release-'));
  // npm ci cannot consume linked file: deps; pack the fake pi into a vendored
  // tarball inside the release so the frozen install works fully offline.
  const vendorDir = path.join(staging, 'vendor');
  fs.mkdirSync(vendorDir, { recursive: true });
  execFileSync(npmCmd.command, [...npmCmd.prefixArgs, 'pack', fakePiDir, '--pack-destination', vendorDir], {
    cwd: staging, stdio: 'pipe',
  });
  const tarball = fs.readdirSync(vendorDir).find((f) => f.endsWith('.tgz'));
  fs.writeFileSync(path.join(staging, 'package.json'), JSON.stringify({
    name: 'pix-managed-body', private: true, version: '0.0.0',
    dependencies: { [PI]: `file:./vendor/${tarball}` },
  }, null, 2));
  // Real lockfile, generated offline from the vendored tarball.
  execFileSync(npmCmd.command, [...npmCmd.prefixArgs, 'install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: staging, stdio: 'pipe',
  });

  const lockDigest = sha256hex(fs.readFileSync(path.join(staging, 'package-lock.json')));
  const manifestCore = {
    pi: { packageName: PI, exactVersion: '2.1.0', packageIntegrity: null, nodeRequirement: '>=18' },
    plugins: [],
    lock: { relativePath: 'package-lock.json', digest: lockDigest, packageManager: 'npm', packageManagerVersion: '10.0.0', installFlags: ['ci', '--ignore-scripts'] },
    resources: null,
    recipe: { installer: 'npm-ci', ignoreScripts: true },
  };
  const bodyRevision = computeBodyRevision(manifestCore);
  const manifest = { schemaVersion: 1, bodyRevision, ...manifestCore, createdBy: { pixVersion: 'test' } };

  const releaseDir = path.join(ctx.releasesDir, bodyRevision);
  fs.mkdirSync(releaseDir, { recursive: true });
  fs.copyFileSync(path.join(staging, 'package.json'), path.join(releaseDir, 'package.json'));
  fs.copyFileSync(path.join(staging, 'package-lock.json'), path.join(releaseDir, 'package-lock.json'));
  fs.cpSync(vendorDir, path.join(releaseDir, 'vendor'), { recursive: true });
  fs.writeFileSync(path.join(releaseDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(ctx.currentPath, JSON.stringify({ bodyRevision, activatedAt: new Date().toISOString() }, null, 2) + '\n');
  return { bodyRevision, manifest };
}

test('e2e: run on local target executes the managed pi inside the composed run env', { timeout: 180000 }, async () => {
  const pixHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pix-e2e-home-'));
  const targetHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pix-e2e-target-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pix-e2e-ws-'));

  process.env.PIX_HOME = pixHome;

  const { resolveHostContext } = require('../src/host/resolve-home');
  const ctx = resolveHostContext({ ensure: true });
  fs.writeFileSync(path.join(ctx.profileDir, 'settings.json'), JSON.stringify({ theme: 'dark' }));

  buildRelease(ctx, buildFakePiPackage());

  const { createLocalTarget } = require('../src/platform/target');
  const target = createLocalTarget({ home: targetHome });
  const runCmd = require('../src/cli/commands/run');

  const code = await runCmd.execute({
    command: 'run', execution: 'direct', piArgs: ['--version-check'], mntGuard: true,
  }, { target, sourceRoot: workspace });
  assert.equal(code, 0);

  // The fake pi ran with the composed agent dir, cwd = workspace.
  const record = JSON.parse(fs.readFileSync(path.join(workspace, 'pi-run-record.json'), 'utf8'));
  assert.equal(record.cwd, workspace);
  assert.ok(record.agentDir.startsWith(path.join(targetHome, '.pix', 'runs')), `agentDir was ${record.agentDir}`);
  assert.deepEqual(record.args, ['--version-check']);

  // Run artifacts on the target: plan, result, guard, settings, runtime ready.
  const runIds = fs.readdirSync(path.join(targetHome, '.pix', 'runs')).filter((d) => !d.startsWith('.'));
  assert.equal(runIds.length, 1);
  const runDir = path.join(targetHome, '.pix', 'runs', runIds[0]);
  assert.ok(fs.existsSync(path.join(runDir, 'plan.json')));
  const result = JSON.parse(fs.readFileSync(path.join(runDir, 'result.json'), 'utf8'));
  assert.equal(result.exitCode, 0);
  assert.ok(fs.existsSync(path.join(runDir, 'agent', 'extensions', 'pix-mnt-guard.ts')));
  assert.ok(fs.existsSync(path.join(runDir, 'agent', 'settings.json')));

  const runtimes = fs.readdirSync(path.join(targetHome, '.pix', 'runtimes')).filter((d) => !d.startsWith('.'));
  assert.equal(runtimes.length, 1);
  assert.ok(fs.existsSync(path.join(targetHome, '.pix', 'runtimes', runtimes[0], 'ready.json')));

  // Host profile untouched by the run.
  const hostSettings = JSON.parse(fs.readFileSync(path.join(ctx.profileDir, 'settings.json'), 'utf8'));
  assert.equal(hostSettings.theme, 'dark');

  // Warm second run: same runtime reused, no reinstall.
  const code2 = await runCmd.execute({
    command: 'run', execution: 'direct', piArgs: [], mntGuard: true,
  }, { target, sourceRoot: workspace });
  assert.equal(code2, 0);
  assert.equal(fs.readdirSync(path.join(targetHome, '.pix', 'runtimes')).filter((d) => !d.startsWith('.')).length, 1);
});
