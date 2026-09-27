const test = require('node:test');
const assert = require('node:assert/strict');
const {
  canonicalSerialize,
  computeBodyRevision,
  computeRuntimeId,
  computeInstallId,
  validateManifest,
} = require('../src/runtime/manifest');

test('canonicalSerialize is key-order independent', () => {
  const a = canonicalSerialize({ b: 1, a: { d: [1, 2], c: 'x' } });
  const b = canonicalSerialize({ a: { c: 'x', d: [1, 2] }, b: 1 });
  assert.equal(a, b);
});

test('bodyRevision is stable and ignores irrelevant context', () => {
  const core = {
    pi: { packageName: 'p', exactVersion: '1.0.0', packageIntegrity: null, nodeRequirement: '>=18' },
    plugins: [],
    lock: { digest: 'abc' },
    resources: null,
    recipe: { installer: 'npm-ci' },
  };
  assert.equal(computeBodyRevision(core), computeBodyRevision(core));
  const changed = computeBodyRevision({ ...core, pi: { ...core.pi, exactVersion: '1.0.1' } });
  assert.notEqual(computeBodyRevision(core), changed);
});

test('runtimeId excludes workspace/run identity; installId excludes resources', () => {
  const base = {
    bodyRevision: 'r1',
    os: 'linux',
    arch: 'x64',
    libc: 'glibc',
    nodeVersion: '22.0.0',
    nodeAbi: '127',
    packageManagerVersion: '10.0.0',
    dependencyLockDigest: 'lock1',
  };
  const r1 = computeRuntimeId(base);
  assert.equal(r1, computeRuntimeId({ ...base, workspaceId: 'ws-a' }));
  assert.notEqual(r1, computeRuntimeId({ ...base, nodeAbi: '131' }));
  assert.notEqual(r1, computeRuntimeId({ ...base, environmentFingerprint: 'image@sha256:x' }));

  const i1 = computeInstallId(base);
  assert.equal(i1, computeInstallId({ ...base, bodyRevision: 'other', resourcesDigest: 'zzz' }));
  assert.notEqual(i1, computeInstallId({ ...base, dependencyLockDigest: 'lock2' }));
  assert.notEqual(i1, computeInstallId({ ...base, nativeSourceDigests: ['x'] }));
});

test('validateManifest rejects credential-bearing locators and bad schema', () => {
  const good = {
    schemaVersion: 1,
    bodyRevision: 'r',
    pi: { packageName: 'p', exactVersion: '1.0.0' },
    plugins: [],
    lock: { digest: 'd' },
  };
  assert.equal(validateManifest(good).valid, true);

  const bad = validateManifest({ ...good, schemaVersion: 99 });
  assert.equal(bad.valid, false);

  const cred = validateManifest({
    ...good,
    plugins: [{ id: 'x', sourceLocator: 'https://host/repo?token=abc' }],
  });
  assert.equal(cred.valid, false);
});
