const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { prepareBuildContext } = require('../src/docker/image');

test('docker context: resources/ and vendor/ always exist even when the release has none', () => {
  const release = fs.mkdtempSync(path.join(os.tmpdir(), 'pix-rel-'));
  fs.writeFileSync(path.join(release, 'package.json'), '{}');
  fs.writeFileSync(path.join(release, 'package-lock.json'), '{}');
  const ctx = fs.mkdtempSync(path.join(os.tmpdir(), 'pix-ctx-'));

  prepareBuildContext(release, ctx);

  for (const item of ['Dockerfile', 'entrypoint.js', 'package.json', 'package-lock.json']) {
    assert.ok(fs.existsSync(path.join(ctx, item)), `missing ${item}`);
  }
  assert.ok(fs.statSync(path.join(ctx, 'resources')).isDirectory(), 'resources/ must exist (Dockerfile COPYs it unconditionally)');
  assert.ok(fs.statSync(path.join(ctx, 'vendor')).isDirectory(), 'vendor/ must exist');
});

test('docker context: vendored tarballs and sealed resources are copied when present', () => {
  const release = fs.mkdtempSync(path.join(os.tmpdir(), 'pix-rel2-'));
  fs.writeFileSync(path.join(release, 'package.json'), '{}');
  fs.writeFileSync(path.join(release, 'package-lock.json'), '{}');
  fs.mkdirSync(path.join(release, 'vendor'), { recursive: true });
  fs.writeFileSync(path.join(release, 'vendor', 'pi.tgz'), 'fake');
  fs.mkdirSync(path.join(release, 'resources', 'ext1'), { recursive: true });
  fs.writeFileSync(path.join(release, 'resources', 'ext1', 'e.ts'), '// ext');
  const ctx = fs.mkdtempSync(path.join(os.tmpdir(), 'pix-ctx2-'));

  prepareBuildContext(release, ctx);

  assert.ok(fs.existsSync(path.join(ctx, 'vendor', 'pi.tgz')));
  assert.ok(fs.existsSync(path.join(ctx, 'resources', 'ext1', 'e.ts')));
});
