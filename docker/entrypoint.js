#!/usr/bin/env node
/**
 * Sandbox entrypoint: resolve the managed Pi CLI from the installed
 * package's own `bin` metadata (never a hardcoded upstream path), then
 * exec it with all arguments forwarded. Signals and exit codes propagate.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const pkgName = process.env.PI_PACKAGE_NAME || '@earendil-works/pi-coding-agent';
const bodyDir = process.env.PI_BODY_DIR || '/opt/pix/body';

function fail(message) {
  console.error(`[pix-sandbox] ${message}`);
  process.exit(1);
}

const pkgDir = path.join(bodyDir, 'node_modules', ...pkgName.split('/'));
let pkg;
try {
  pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
} catch {
  fail(`managed package not installed in image: ${pkgName}`);
}

let binRel = null;
if (typeof pkg.bin === 'string') binRel = pkg.bin;
else if (pkg.bin && typeof pkg.bin === 'object') binRel = pkg.bin.pi || Object.values(pkg.bin)[0];
if (!binRel) fail(`package ${pkgName} exposes no CLI entrypoint`);

const entry = path.join(pkgDir, binRel);
if (!fs.existsSync(entry)) fail(`CLI entrypoint missing: ${entry}`);

const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: false,
});
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    try { child.kill(sig); } catch { /* gone */ }
  });
}
child.on('error', (err) => fail(`failed to start pi: ${err.message}`));
child.on('close', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
