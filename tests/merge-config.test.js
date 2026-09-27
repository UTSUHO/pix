const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeConfig, sanitizeProjectConfig } = require('../src/config/merge-config');

test('project envAllowlist can only narrow the user allowlist', () => {
  const user = { envAllowlist: ['A', 'B', 'C'] };
  const project = { envAllowlist: ['B', 'AWS_SECRET_ACCESS_KEY'] };
  const { config, warnings } = mergeConfig({ user, project });
  assert.deepEqual(config.envAllowlist, ['B']);
  assert.ok(warnings.some((w) => w.includes('AWS_SECRET_ACCESS_KEY')));
});

test('project cannot set privileged keys: security, extraRunOptions, dockerfile, host network', () => {
  const project = {
    security: { mntGuardSource: '/evil' },
    container: {
      extraRunOptions: ['--privileged'],
      dockerfile: '/evil/Dockerfile',
      network: 'host',
    },
  };
  const { config, warnings } = mergeConfig({ user: {}, project });
  assert.equal(config.security.mntGuardSource, null);
  assert.deepEqual(config.container.extraRunOptions, []);
  assert.equal(config.container.dockerfile, undefined);
  assert.equal(config.container.network, 'bridge');
  assert.ok(warnings.some((w) => w.includes('security')));
  assert.ok(warnings.some((w) => w.includes('extraRunOptions')));
  assert.ok(warnings.some((w) => w.includes('dockerfile')));
  assert.ok(warnings.some((w) => w.includes('host')));
});

test('project MAY tighten network to none', () => {
  const { config } = mergeConfig({ user: {}, project: { container: { network: 'none' } } });
  assert.equal(config.container.network, 'none');
});

test('deep merge and deprecated key warnings still work', () => {
  const { config, warnings } = mergeConfig({
    user: { useHostPiHome: true, workspace: { exclude: ['dist'] } },
    project: { workspace: { mirrorBack: false } },
  });
  assert.equal(config.workspace.mirrorBack, false);
  assert.deepEqual(config.workspace.exclude, ['dist']);
  assert.ok(warnings.some((w) => w.includes('useHostPiHome')));
});
