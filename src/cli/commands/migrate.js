const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveHostContext } = require('../../host/resolve-home');
const { getDefaultDistro, toWslPath } = require('../../platform/wsl');
const { resolveTargetAgentDir, resolveWindowsAgentDir, migrate } = require('../../runtime/migrate-runtime');
const { loadConfig } = require('../../config/load-config');
const { mergeConfig } = require('../../config/merge-config');
const { log, warn } = require('../output');

/**
 * pix migrate
 *   legacy (no --to-host): Windows .pi/agent -> WSL shared runtime (v0.3
 *     behavior, unchanged).
 *   --to-host [--apply]:   import legacy Windows/WSL data into the Windows
 *     managed layout. Dry-run by default: inspect -> report, zero writes.
 *     Apply: backup -> import non-conflicting data -> validate -> activate.
 */

const IMPORTABLE_PROFILE_ITEMS = ['settings.json', 'models.json', 'prompts', 'skills', 'themes'];

function execute(parsedArgs) {
  if (parsedArgs.toHost) {
    return executeToHost(parsedArgs);
  }
  return executeLegacy(parsedArgs);
}

// ---------------------------------------------------------------------------
// --to-host: import into the Windows managed layout
// ---------------------------------------------------------------------------

function executeToHost(parsedArgs) {
  const ctx = resolveHostContext({ ensure: parsedArgs.apply === true });
  const apply = parsedArgs.apply === true;

  log(`Mode: ${apply ? 'APPLY (backup -> import -> validate -> activate)' : 'DRY-RUN (inspect -> report, no writes)'}`);
  log(`Host: ${ctx.pixHome}`);

  const sources = collectSources(parsedArgs);
  const report = { imported: [], conflicts: [], skipped: [], backups: [] };

  for (const source of sources) {
    if (!source.exists) {
      report.skipped.push({ source: source.label, reason: 'not found' });
      continue;
    }
    for (const item of IMPORTABLE_PROFILE_ITEMS) {
      const srcPath = path.join(source.agentDir, item);
      if (!fs.existsSync(srcPath)) continue;
      const destPath = path.join(ctx.profileDir, item);
      const classification = classifyImport(srcPath, destPath);
      if (classification === 'import') {
        report.imported.push({ source: source.label, item });
        if (apply) copyItem(srcPath, destPath);
      } else if (classification === 'conflict') {
        // Keep both sides; never guess a winner by mtime.
        report.conflicts.push({ source: source.label, item, hostValue: describeItem(destPath), incomingValue: describeItem(srcPath) });
      } else {
        report.skipped.push({ source: source.label, item, reason: 'identical to host value' });
      }
    }

    // Credentials: only on explicit request, never printed.
    const authSrc = path.join(source.agentDir, 'auth.json');
    if (fs.existsSync(authSrc)) {
      if (parsedArgs.includeAuth) {
        const authDest = path.join(ctx.credentialsDir, 'auth.json');
        if (!fs.existsSync(authDest)) {
          report.imported.push({ source: source.label, item: 'auth.json (credentials)' });
          if (apply) {
            fs.mkdirSync(ctx.credentialsDir, { recursive: true });
            fs.copyFileSync(authSrc, authDest);
          }
        } else {
          report.conflicts.push({ source: source.label, item: 'auth.json', reason: 'host credentials already exist; kept host value' });
        }
      } else {
        report.skipped.push({ source: source.label, item: 'auth.json', reason: 'credentials not imported without --include-auth' });
      }
    }

    // Sessions: deduplicated by content hash, cwd metadata preserved.
    const sessionsSrc = path.join(source.agentDir, 'sessions');
    if (fs.existsSync(sessionsSrc)) {
      const imported = importSessions(sessionsSrc, ctx.sessionsStateDir, apply);
      report.imported.push(...imported.map((s) => ({ source: source.label, item: `session ${s}` })));
    }
  }

  // Config files: importable keys from legacy user configs.
  for (const cfgPath of legacyConfigPaths()) {
    if (!fs.existsSync(cfgPath)) continue;
    report.skipped.push({
      source: cfgPath,
      reason: 'legacy user config detected; review manually and move desired keys into <PIX_HOME>/config.json (not auto-merged)',
    });
  }

  if (apply) {
    const backupDir = path.join(ctx.backupsDir, `to-host-${Date.now().toString(36)}`);
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, 'import-report.json'), JSON.stringify(report, null, 2) + '\n');
    report.backups.push(backupDir);
  }

  printReport(report, apply);
  return report.conflicts.length > 0 && apply ? 1 : 0;
}

function collectSources(parsedArgs) {
  const sources = [];
  const addSource = (label, agentDir) => {
    if (!agentDir) return;
    sources.push({ label, agentDir, exists: safeIsDir(agentDir) });
  };

  if (parsedArgs.source) {
    addSource(`--source ${parsedArgs.source}`, parsedArgs.source);
  } else {
    const winAgent = resolveWindowsAgentDir(parsedArgs.winUser);
    addSource(`Windows .pi/agent (${winAgent || 'unknown'})`, winAgent);
  }

  // Legacy WSL shared runtime. On Windows hosts it is reachable through the
  // \\wsl$ UNC share; on Linux/WSL it is a plain local path.
  if (process.platform === 'win32') {
    for (const p of detectWslLegacyViaUnc(parsedArgs.distro || getDefaultDistro())) {
      addSource(`WSL legacy runtime (${p})`, p);
    }
  } else {
    const wslLegacy = path.join(process.env.HOME || '/', '.pix', 'runtime', 'agent');
    addSource('WSL legacy runtime (~/.pix/runtime/agent)', wslLegacy);
  }
  return sources;
}

function safeIsDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Probe the legacy WSL runtime through the \\wsl$ UNC share (Windows hosts). */
function detectWslLegacyViaUnc(distro) {
  if (!distro) return [];
  const found = [];
  for (const prefix of ['\\\\wsl$\\', '\\\\wsl.localhost\\']) {
    const base = `${prefix}${distro}`;
    const candidates = [`${base}\\root\\.pix\\runtime\\agent`];
    try {
      for (const user of fs.readdirSync(`${base}\\home`)) {
        candidates.push(`${base}\\home\\${user}\\.pix\\runtime\\agent`);
      }
    } catch { /* home not enumerable */ }
    for (const candidate of candidates) {
      if (safeIsDir(candidate)) found.push(candidate);
    }
    if (found.length) break;
  }
  return found;
}

function classifyImport(srcPath, destPath) {
  if (!fs.existsSync(destPath)) return 'import';
  const srcDigest = digestItem(srcPath);
  const destDigest = digestItem(destPath);
  return srcDigest === destDigest ? 'identical' : 'conflict';
}

function digestItem(itemPath) {
  const hash = crypto.createHash('sha256');
  const stat = fs.statSync(itemPath);
  if (stat.isDirectory()) {
    for (const file of walkFiles(itemPath)) {
      hash.update(path.relative(itemPath, file));
      hash.update(fs.readFileSync(file));
    }
  } else {
    hash.update(fs.readFileSync(itemPath));
  }
  return hash.digest('hex');
}

function walkFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out.sort();
}

function describeItem(itemPath) {
  const stat = fs.statSync(itemPath);
  return stat.isDirectory() ? `directory (${walkFiles(itemPath).length} files)` : `file (${stat.size} bytes)`;
}

function copyItem(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

function importSessions(sessionsSrc, sessionsStateDir, apply) {
  const imported = [];
  const seen = new Set();
  if (apply && fs.existsSync(sessionsStateDir)) {
    for (const existing of walkFiles(sessionsStateDir)) {
      seen.add(crypto.createHash('sha256').update(fs.readFileSync(existing)).digest('hex'));
    }
  }
  for (const file of walkFiles(sessionsSrc)) {
    const digest = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (seen.has(digest)) continue;
    seen.add(digest);
    imported.push(path.basename(file));
    if (apply) {
      const dest = path.join(sessionsStateDir, 'imported', path.basename(file));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(file, dest);
    }
  }
  return imported;
}

function legacyConfigPaths() {
  const home = process.env.HOME || process.env.USERPROFILE || '/';
  return [path.join(home, '.pixrc.json')];
}

function printReport(report, apply) {
  log(`--- ${apply ? 'Import' : 'Dry-run'} report ---`);
  for (const i of report.imported) log(`  ${apply ? 'imported' : 'would import'}: [${i.source}] ${i.item}`);
  for (const c of report.conflicts) {
    warn(`  conflict: [${c.source}] ${c.item}`);
    if (c.hostValue) warn(`    host:     ${c.hostValue}`);
    if (c.incomingValue) warn(`    incoming: ${c.incomingValue}`);
    warn('    both values preserved; resolve explicitly and re-run.');
  }
  for (const s of report.skipped) log(`  skipped: [${s.source}] ${s.item || ''} ${s.reason}`);
  for (const b of report.backups) log(`  backup: ${b}`);
  if (!apply) log('Dry-run only. Re-run with --apply to import non-conflicting data.');
}

// ---------------------------------------------------------------------------
// legacy: Windows .pi/agent -> WSL shared runtime (v0.3 behavior, unchanged)
// ---------------------------------------------------------------------------

function executeLegacy(parsedArgs) {
  const cwd = process.cwd();
  const configs = loadConfig(cwd);
  const { config, warnings: configWarnings } = mergeConfig(configs);
  for (const message of configWarnings) warn(message);

  warn('Legacy migrate (Windows -> WSL shared runtime). For the managed layout use "pix migrate --to-host".');

  const distro = config.wsl?.distro || getDefaultDistro();
  const sourceDir = normalizeSourcePath(parsedArgs.source || resolveWindowsAgentDir(parsedArgs.winUser), distro);
  const targetDir = resolveTargetAgentDir(config, process.env.HOME);

  if (!sourceDir) {
    console.error('Could not determine Windows .pi/agent directory.');
    console.error('Use --source C:\\Users\\<user>\\.pi\\agent or --win-user <user>.');
    return 1;
  }

  const result = migrate({
    sourceDir,
    targetDir,
    includeExtensions: parsedArgs.includeExtensions,
    dryRun: parsedArgs.dryRun,
  });

  for (const item of result.copied) log(`copied: ${item}`);
  for (const item of result.skipped) log(`skipped: ${item}`);
  for (const message of result.warnings) warn(message);

  if (result.errors.length > 0) {
    for (const message of result.errors) warn(`error: ${message}`);
    return 1;
  }

  log(`Migration complete: ${sourceDir} -> ${targetDir}`);
  return 0;
}

function normalizeSourcePath(sourceDir, distro) {
  if (!sourceDir) return null;
  const converted = toWslPath(sourceDir, distro);
  return converted || sourceDir;
}

module.exports = { execute, detectWslLegacyViaUnc };
