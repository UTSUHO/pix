const fs = require('fs');
const path = require('path');
const { log, fatal } = require('../output');
const { bundledGuardPath, userTemplatePath } = require('../../runtime/install-guard');

/**
 * Copy the bundled /mnt guard template to the user template location
 * (~/.pix/extensions/pix-mnt-guard.ts) so the user can customize it.
 * From then on pix installs the user's template instead of the bundled one.
 */
function execute(_parsedArgs) {
  const src = bundledGuardPath();
  const dest = userTemplatePath();

  if (fs.existsSync(dest)) {
    fatal(`Guard template already exists: ${dest}\nEdit it directly, or delete it first to re-scaffold.`);
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);

  log(`Guard template created: ${dest}`);
  log('Edit this file to customize /mnt policy. Pix will install your template');
  log('into the shared pi runtime on every launch from now on.');
  log('Note: keep the first-line "// pix-mnt-guard vN" marker so pix can');
  log('recognize files it installed.');
  return 0;
}

module.exports = { execute };
