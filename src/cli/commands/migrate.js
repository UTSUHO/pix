const { loadConfig } = require('../../config/load-config');
const { mergeConfig } = require('../../config/merge-config');
const { getDefaultDistro, toWslPath } = require('../../platform/wsl');
const { resolveTargetAgentDir, resolveWindowsAgentDir, migrate } = require('../../runtime/migrate-runtime');
const { log, warn } = require('../output');

function normalizeSourcePath(sourceDir, distro) {
  if (!sourceDir) return null;
  const converted = toWslPath(sourceDir, distro);
  return converted || sourceDir;
}

function execute(parsedArgs) {
  const cwd = process.cwd();
  const configs = loadConfig(cwd);
  const { config, warnings: configWarnings } = mergeConfig(configs);

  for (const message of configWarnings) {
    warn(message);
  }

  const distro = config.wsl?.distro || getDefaultDistro();
  const sourceDir = normalizeSourcePath(parsedArgs.source || resolveWindowsAgentDir(parsedArgs.winUser), distro);
  const targetDir = resolveTargetAgentDir(config, process.env.HOME);

  if (!sourceDir) {
    console.error('Could not determine Windows .pi/agent directory.');
    console.error('Use --source C:\\Users\\<user>\\.pi\\agent or --win-user <user>.');
    return 1;
  }

  log(`Migration source: ${sourceDir}`);
  log(`Migration target: ${targetDir}`);

  if (parsedArgs.dryRun) {
    log('Dry run mode: no files will be copied.');
  }

  const results = migrate(sourceDir, targetDir, {
    includeExtensions: parsedArgs.includeExtensions,
    dryRun: parsedArgs.dryRun,
  });

  console.log('');
  for (const result of results) {
    const reason = result.reason ? ` (${result.reason})` : '';
    console.log(`  [${result.action}] ${result.item}${reason}`);
  }

  if (parsedArgs.dryRun) {
    log('Dry run complete. No files were copied.');
  } else {
    log('Migration complete.');
  }

  return 0;
}

module.exports = { execute };
