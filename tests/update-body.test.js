const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveHostContext } = require('../src/host/resolve-home');
const { updateHostBody, readSpec } = require('../src/host/update-body');
const { createLocalAdapter } = require('../src/host/adapters');

/**
 * Fake npm registry + installer. Records every call so tests can assert that
 * no backend (WSL/Docker) was touched and that installs happen only in the
 * managed staging directory with a controlled environment.
 */
function makeFakeNpm(registry, calls) {
  return {
    kind: 'npm',
    resolve(packageName, range = 'latest') {
      calls.push(['resolve', packageName, range]);
      const versions = registry[packageName];
      if (!versions) throw new Error(`404 ${packageName}`);
      const exactVersion = range === 'latest' ? versions.latest : range;
      if (!versions.versions[exactVersion]) throw new Error(`No version ${packageName}@${range}`);
      return { exactVersion, packageIntegrity: `sha256-${packageName}-${exactVersion}` };
    },
    engines(packageName, version) {
      return (registry[packageName] && registry[packageName].versions[version].engines) || {};
    },
    generateLock(dir, env) {
      calls.push(['generateLock', dir, env]);
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      const lock = { name: pkg.name, lockfileVersion: 3, packages: {} };
      for (const [name, version] of Object.entries(pkg.dependencies)) {
        lock.packages[`node_modules/${name}`] = { version };
      }
      fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(lock, null, 2));
    },
    ciInstall(dir, env) {
      calls.push(['ciInstall', dir, env]);
      const lock = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'));
      for (const [key, meta] of Object.entries(lock.packages)) {
        const rel = key.replace(/^node_modules\//, '');
        const pkgDir = path.join(dir, 'node_modules', ...rel.split('/'));
        fs.mkdirSync(pkgDir, { recursive: true });
        const name = rel.split('/').pop();
        const regMeta = (registry[rel] && registry[rel].versions[meta.version]) || {};
        fs.writeFileSync(
          path.join(pkgDir, 'package.json'),
          JSON.stringify({ name: rel, version: meta.version, engines: regMeta.engines || {} })
        );
        fs.writeFileSync(path.join(pkgDir, 'index.js'), `// ${name}`);
      }
    },
    version() {
      return '10.9.0';
    },
  };
}

function makeAdapters(registry, calls) {
  return {
    npm: makeFakeNpm(registry, calls),
    git: { kind: 'git', resolveCommit: () => ({ resolvedCommit: 'deadbeef' }) },
    local: createLocalAdapter(),
  };
}

function setupHost() {
  const pixHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pix-host-test-'));
  const ctx = resolveHostContext({ env: { PIX_HOME: pixHome }, ensure: true });
  return { ctx, pixHome };
}

const PI = '@earendil-works/pi-coding-agent';

function baseRegistry() {
  return {
    [PI]: {
      latest: '2.0.0',
      versions: {
        '1.0.0': { engines: { node: '>=18' } },
        '2.0.0': { engines: { node: '>=22.19' } },
      },
    },
    'plugin-a': { latest: '1.1.0', versions: { '1.0.0': {}, '1.1.0': {} } },
    'plugin-b': { latest: '3.0.0', versions: { '3.0.0': {} } },
  };
}

test('update-real-host-artifact: release contains real install and manifest matches current', async () => {
  const { ctx } = setupHost();
  const calls = [];
  const result = await updateHostBody(ctx, { nodeVersion: '22.19.0' }, {
    adapters: makeAdapters(baseRegistry(), calls),
    platform: 'linux',
    pixVersion: '0.4.0-test',
  });

  assert.equal(result.release.activated, true);
  assert.equal(result.pi.status, 'changed');
  assert.equal(result.pi.to, '2.0.0');

  const current = JSON.parse(fs.readFileSync(ctx.currentPath, 'utf8'));
  assert.equal(current.bodyRevision, result.release.bodyRevision);

  const releaseDir = path.join(ctx.releasesDir, current.bodyRevision);
  const manifest = JSON.parse(fs.readFileSync(path.join(releaseDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.pi.exactVersion, '2.0.0');
  assert.equal(manifest.bodyRevision, current.bodyRevision);

  // Real artifact: installed package on disk matches manifest.
  const installed = JSON.parse(
    fs.readFileSync(path.join(releaseDir, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json'), 'utf8')
  );
  assert.equal(installed.version, manifest.pi.exactVersion);
  assert.ok(manifest.lock.digest.length === 64);
});

test('update-without-backends: no WSL/Docker adapter exists or is called', async () => {
  const { ctx } = setupHost();
  const calls = [];
  await updateHostBody(ctx, { nodeVersion: '22.19.0' }, {
    adapters: makeAdapters(baseRegistry(), calls),
    platform: 'linux',
  });
  const backends = calls.filter(([op]) => /wsl|docker/i.test(String(op)));
  assert.equal(backends.length, 0);
});

test('update-partial-failure: failing plugin leaves current untouched', async () => {
  const { ctx } = setupHost();
  const calls = [];
  // First successful update to establish current.
  await updateHostBody(ctx, { nodeVersion: '22.19.0' }, { adapters: makeAdapters(baseRegistry(), calls) });
  const before = fs.readFileSync(ctx.currentPath, 'utf8');

  // Add a plugin spec that cannot resolve.
  const { spec } = readSpec(ctx);
  spec.plugins = [{ id: 'ghost', sourceKind: 'npm', packageName: 'does-not-exist', range: 'latest' }];
  fs.writeFileSync(ctx.specPath, JSON.stringify(spec, null, 2));

  await assert.rejects(
    updateHostBody(ctx, { nodeVersion: '22.19.0' }, { adapters: makeAdapters(baseRegistry(), calls) }),
    (err) => err.code === 'UPDATE_FAILED'
  );
  assert.equal(fs.readFileSync(ctx.currentPath, 'utf8'), before);

  // Resolution failed before staging: current untouched, no new release.
  assert.equal(fs.readdirSync(ctx.releasesDir).length, 1);
});

test('update-concurrent: a live lock blocks the second updater', async () => {
  const { ctx } = setupHost();
  const { acquireLock } = require('../src/host/locks');
  const held = acquireLock(ctx.locksDir, 'body-update');
  await assert.rejects(
    updateHostBody(ctx, {}, { adapters: makeAdapters(baseRegistry(), []) }),
    (err) => err.code === 'LOCK_HELD'
  );
  held.release();
});

test('update-crash-points: version-mismatch validation failure keeps old current', async () => {
  const { ctx } = setupHost();
  const calls = [];
  await updateHostBody(ctx, { nodeVersion: '22.19.0' }, { adapters: makeAdapters(baseRegistry(), calls) });
  const before = fs.readFileSync(ctx.currentPath, 'utf8');

  // Registry now claims 2.0.0 but the installer will lay down a different version.
  const registry = baseRegistry();
  const adapters = makeAdapters(registry, calls);
  const origCi = adapters.npm.ciInstall;
  adapters.npm.ciInstall = (dir, env) => {
    origCi(dir, env);
    // Simulate a corrupted install: write wrong version after ci.
    const pkgPath = path.join(dir, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json');
    fs.writeFileSync(pkgPath, JSON.stringify({ name: PI, version: '9.9.9' }));
  };

  await assert.rejects(
    updateHostBody(ctx, { nodeVersion: '22.19.0' }, { adapters }),
    /version mismatch/i
  );
  assert.equal(fs.readFileSync(ctx.currentPath, 'utf8'), before);

  // Failed candidate kept for diagnosis, marked FAILED, never activated.
  const staging = fs.readdirSync(ctx.stagingDir).map((d) => path.join(ctx.stagingDir, d));
  assert.ok(staging.some((d) => fs.existsSync(path.join(d, 'FAILED'))));
});

test('update-pins-local: pinned pi is skipped; local plugin sealed, never mutated', async () => {
  const { ctx } = setupHost();
  const calls = [];
  await updateHostBody(ctx, { nodeVersion: '22.19.0' }, { adapters: makeAdapters(baseRegistry(), calls) });

  const localSrc = fs.mkdtempSync(path.join(os.tmpdir(), 'pix-local-plugin-'));
  fs.writeFileSync(path.join(localSrc, 'ext.ts'), 'export const x = 1;\n');
  const beforeContent = fs.readFileSync(path.join(localSrc, 'ext.ts'), 'utf8');

  const { spec } = readSpec(ctx);
  spec.pi.updatePolicy = 'pin';
  spec.plugins = [{ id: 'mine', sourceKind: 'local', sourceLocator: localSrc }];
  fs.writeFileSync(ctx.specPath, JSON.stringify(spec, null, 2));

  const result = await updateHostBody(ctx, { nodeVersion: '22.19.0' }, { adapters: makeAdapters(baseRegistry(), calls) });
  assert.equal(result.pi.status, 'skipped');
  assert.equal(result.plugins.find((p) => p.id === 'mine').status, 'changed');

  // Local source untouched.
  assert.equal(fs.readFileSync(path.join(localSrc, 'ext.ts'), 'utf8'), beforeContent);

  // Snapshot sealed into release resources.
  const releaseDir = path.join(ctx.releasesDir, result.release.bodyRevision);
  assert.ok(fs.existsSync(path.join(releaseDir, 'resources', 'mine', 'ext.ts')));
});

test('update-node-mismatch: unsatisfiable engines fails, system Node untouched', async () => {
  const { ctx } = setupHost();
  const calls = [];
  await assert.rejects(
    updateHostBody(ctx, { nodeVersion: '18.0.0' }, { adapters: makeAdapters(baseRegistry(), calls) }),
    (err) => err.code === 'UPDATE_FAILED' && /requires Node/.test(err.message)
  );
  assert.equal(fs.existsSync(ctx.currentPath), false);
});

test('update-project-isolation: npm runs in staging with managed userconfig, never project cwd', async () => {
  const { ctx } = setupHost();
  const calls = [];
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pix-evil-project-'));
  fs.writeFileSync(path.join(projectDir, '.npmrc'), 'registry=http://evil.example/\n');
  process.chdir(projectDir);

  await updateHostBody(ctx, { nodeVersion: '22.19.0' }, {
    adapters: makeAdapters(baseRegistry(), calls),
    env: { ...process.env, npm_config_registry: 'http://evil.example/' },
  });

  for (const [op, dir, env] of calls) {
    if (op === 'generateLock' || op === 'ciInstall') {
      assert.ok(dir.startsWith(ctx.stagingDir), `npm ran outside staging: ${dir}`);
      assert.notEqual(dir, projectDir);
      assert.equal(env.npm_config_registry, undefined, 'project/inherited npm_config_* leaked');
      assert.ok(env.npm_config_userconfig.includes('managed-npmrc'));
      assert.equal(env.npm_config_ignore_scripts, 'true');
    }
  }
});

test('update unchanged input does not create a new release directory', async () => {
  const { ctx } = setupHost();
  const calls = [];
  const adapters = makeAdapters(baseRegistry(), calls);
  const first = await updateHostBody(ctx, { nodeVersion: '22.19.0' }, { adapters });
  const second = await updateHostBody(ctx, { nodeVersion: '22.19.0' }, { adapters });
  assert.equal(first.release.bodyRevision, second.release.bodyRevision);
  assert.equal(fs.readdirSync(ctx.releasesDir).length, 1);
});
