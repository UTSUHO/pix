const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ensureRuntime, resolvePiEntrypoint } = require('../src/runtime/projection');

const PI = '@earendil-works/pi-coding-agent';
const WINDOWS_DRIVE = '/mnt/c';

function makeRelease({ piVersion = '2.0.0', optionalDeps = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pix-release-'));
  const deps = { [PI]: piVersion };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'body', dependencies: deps }));
  const lock = { lockfileVersion: 3, packages: { [`node_modules/${PI}`]: { version: piVersion } } };
  if (optionalDeps) {
    for (const [n, v] of Object.entries(optionalDeps.present || {})) {
      lock.packages[`node_modules/${n}`] = { version: v, optional: true };
    }
  }
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(lock));
  // Release-side installed pi (used for the cross-platform lock check).
  const piDir = path.join(dir, 'node_modules', '@earendil-works', 'pi-coding-agent');
  fs.mkdirSync(piDir, { recursive: true });
  fs.writeFileSync(path.join(piDir, 'package.json'), JSON.stringify({
    name: PI,
    version: piVersion,
    bin: { pi: './bin/pi.js' },
    ...(optionalDeps ? { optionalDependencies: optionalDeps.declared || {} } : {}),
  }));
  return { dir, lockDigest: require('../src/runtime/manifest').sha256hex(fs.readFileSync(path.join(dir, 'package-lock.json'))) };
}

function makeManifest(release, { piVersion = '2.0.0', resources = null } = {}) {
  return {
    schemaVersion: 1,
    bodyRevision: `rev-${piVersion}-${resources ? resources.map((r) => r.contentDigest).join(',') : 'none'}`,
    pi: { packageName: PI, exactVersion: piVersion, packageIntegrity: null, nodeRequirement: '>=18' },
    plugins: [],
    lock: { digest: release.lockDigest, packageManager: 'npm', packageManagerVersion: '10.0.0', installFlags: ['ci', '--ignore-scripts'] },
    resources,
  };
}

function makeTarget(rootDir, release) {
  return {
    rootDir,
    releaseDir: release.dir,
    platform: { os: 'linux', arch: 'x64', libc: 'glibc', nodeVersion: '22.19.0', nodeAbi: '127' },
  };
}

/** Fake npm adapter: materializes node_modules from the lock, counts calls. */
function fakeAdapters(calls) {
  return {
    npm: {
      ciInstall(dir) {
        calls.push(['ciInstall', dir]);
        const lock = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'));
        for (const [key, meta] of Object.entries(lock.packages)) {
          const rel = key.replace(/^node_modules\//, '');
          const pkgDir = path.join(dir, 'node_modules', ...rel.split('/'));
          fs.mkdirSync(pkgDir, { recursive: true });
          fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
            name: rel, version: meta.version, bin: rel === PI ? { pi: './bin/pi.js' } : undefined,
          }));
          if (rel === PI) {
            fs.mkdirSync(path.join(pkgDir, 'bin'), { recursive: true });
            fs.writeFileSync(path.join(pkgDir, 'bin', 'pi.js'), '#!/usr/bin/env node\n');
          }
        }
      },
      version: () => '10.0.0',
    },
  };
}

function setup() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pix-target-root-'));
  return { rootDir };
}

test('runtime-cold: first deploy installs, verifies, ready written last', () => {
  const { rootDir } = setup();
  const release = makeRelease();
  const calls = [];
  const desc = ensureRuntime(makeManifest(release), makeTarget(rootDir, release), { adapters: fakeAdapters(calls), nodeExecutable: '/usr/bin/node' });

  assert.equal(desc.readyHit, false);
  assert.equal(calls.filter(([op]) => op === 'ciInstall').length, 1);
  assert.equal(desc.piEntrypoint, resolvePiEntrypoint(desc.installDir, PI));
  assert.ok(fs.existsSync(path.join(rootDir, 'runtimes', desc.runtimeId, 'ready.json')));
  assert.ok(fs.existsSync(desc.piEntrypoint));
});

test('runtime-warm: second identical launch does zero install/copy/resolve', () => {
  const { rootDir } = setup();
  const release = makeRelease();
  const manifest = makeManifest(release);
  const calls = [];
  ensureRuntime(manifest, makeTarget(rootDir, release), { adapters: fakeAdapters(calls) });
  const before = calls.length;

  const desc = ensureRuntime(manifest, makeTarget(rootDir, release), { adapters: fakeAdapters(calls) });
  assert.equal(desc.readyHit, true);
  assert.equal(calls.length, before, 'warm path must not run npm ci');
});

test('runtime-version-change: new body gets a new directory; old one untouched', () => {
  const { rootDir } = setup();
  const r1 = makeRelease({ piVersion: '1.0.0' });
  const r2 = makeRelease({ piVersion: '2.0.0' });
  const d1 = ensureRuntime(makeManifest(r1, { piVersion: '1.0.0' }), makeTarget(rootDir, r1), { adapters: fakeAdapters([]) });
  const d2 = ensureRuntime(makeManifest(r2, { piVersion: '2.0.0' }), makeTarget(rootDir, r2), { adapters: fakeAdapters([]) });
  assert.notEqual(d1.runtimeId, d2.runtimeId);
  assert.ok(fs.existsSync(path.join(rootDir, 'runtimes', d1.runtimeId, 'ready.json')));
  assert.ok(fs.existsSync(path.join(rootDir, 'runtimes', d2.runtimeId, 'ready.json')));
});

test('runtime-resource-only: resource change -> new runtime reuses install (no reinstall)', () => {
  const { rootDir } = setup();
  const release = makeRelease();
  fs.mkdirSync(path.join(release.dir, 'resources', 'ext1'), { recursive: true });
  fs.writeFileSync(path.join(release.dir, 'resources', 'ext1', 'e.ts'), '// v1\n');
  const calls = [];
  const m1 = makeManifest(release, { resources: [{ id: 'ext1', relativePath: 'resources/ext1', contentDigest: 'd1' }] });
  const d1 = ensureRuntime(m1, makeTarget(rootDir, release), { adapters: fakeAdapters(calls) });

  fs.writeFileSync(path.join(release.dir, 'resources', 'ext1', 'e.ts'), '// v2\n');
  const m2 = makeManifest(release, { resources: [{ id: 'ext1', relativePath: 'resources/ext1', contentDigest: 'd2' }] });
  const d2 = ensureRuntime(m2, makeTarget(rootDir, release), { adapters: fakeAdapters(calls) });

  assert.notEqual(d1.runtimeId, d2.runtimeId, 'resource change must produce a new runtime');
  assert.equal(d1.installId, d2.installId, 'non-dependency resource change must reuse the install');
  assert.equal(calls.filter(([op]) => op === 'ciInstall').length, 1, 'no reinstall for resource-only change');
});

test('runtime-lock-incomplete: missing optional platform deps fails; lock never rewritten', () => {
  const { rootDir } = setup();
  const release = makeRelease({
    optionalDeps: { declared: { 'native-linux-x64': '1.0.0' }, present: {} },
  });
  const lockBefore = fs.readFileSync(path.join(release.dir, 'package-lock.json'), 'utf8');
  assert.throws(
    () => ensureRuntime(makeManifest(release), makeTarget(rootDir, release), { adapters: fakeAdapters([]) }),
    (err) => err.code === 'RUNTIME_DEPLOY_FAILED' && /missing platform\/optional/.test(err.message)
  );
  assert.equal(fs.readFileSync(path.join(release.dir, 'package-lock.json'), 'utf8'), lockBefore);
});

test('runtime-path-shadowing: entrypoint comes from package metadata, never PATH', () => {
  const { rootDir } = setup();
  const release = makeRelease();
  const shadowDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pix-shadow-'));
  fs.writeFileSync(path.join(shadowDir, 'pi'), '#!/bin/sh\necho SHADOW\n');
  fs.chmodSync(path.join(shadowDir, 'pi'), 0o755);
  process.env.PATH = `${shadowDir}:${process.env.PATH}`;

  const desc = ensureRuntime(makeManifest(release), makeTarget(rootDir, release), { adapters: fakeAdapters([]) });
  assert.ok(desc.piEntrypoint.startsWith(desc.installDir));
  assert.ok(!desc.piEntrypoint.startsWith(shadowDir));
});

test('runtime-interrupted: staging without ready is not picked up', () => {
  const { rootDir } = setup();
  const release = makeRelease();
  const manifest = makeManifest(release);
  const target = makeTarget(rootDir, release);
  const calls = [];
  const adapters = fakeAdapters(calls);
  const orig = adapters.npm.ciInstall;
  adapters.npm.ciInstall = (dir) => {
    orig(dir);
    throw new Error('simulated crash after install');
  };
  assert.throws(() => ensureRuntime(manifest, target, { adapters }), /crash/);

  // Retry with a working adapter: must deploy cleanly despite leftover staging.
  const desc = ensureRuntime(manifest, target, { adapters: fakeAdapters(calls) });
  assert.equal(desc.readyHit, false);
  assert.ok(fs.existsSync(path.join(rootDir, 'runtimes', desc.runtimeId, 'ready.json')));
});

// WSL-target only: on Windows there is no /mnt boundary to defend.
const symlinkTestOpts = process.platform === 'win32' ? { skip: 'WSL-only: no /mnt boundary on Windows' } : {};
test('runtime-symlink-ntfs: install resolving onto a Windows drive is rejected', symlinkTestOpts, () => {
  const { rootDir } = setup();
  const release = makeRelease();
  const manifest = makeManifest(release);
  const target = makeTarget(rootDir, release);
  const calls = [];
  const desc = ensureRuntime(manifest, target, { adapters: fakeAdapters(calls) });
  // Corrupt: replace install dir with a symlink onto a Windows drive.
  fs.rmSync(desc.installDir, { recursive: true, force: true });
  fs.symlinkSync(WINDOWS_DRIVE, desc.installDir, 'dir');
  assert.throws(
    () => ensureRuntime(manifest, target, { adapters: fakeAdapters(calls) }),
    (err) => err.code === 'RUNTIME_DEPLOY_FAILED' && /Windows filesystem/.test(err.message)
  );
});
