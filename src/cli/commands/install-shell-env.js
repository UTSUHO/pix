const fs = require('fs');
const os = require('os');
const path = require('path');
const { log, warn } = require('../output');

const SUPPORTED_SHELLS = new Set(['bash', 'zsh', 'fish']);

function detectShell() {
  const shell = process.env.SHELL;
  if (!shell) return 'bash';
  const name = path.basename(shell);
  return SUPPORTED_SHELLS.has(name) ? name : 'bash';
}

function getRcPath(shell) {
  const home = os.homedir();
  switch (shell) {
    case 'zsh':
      return path.join(home, '.zshrc');
    case 'fish':
      return path.join(home, '.config', 'fish', 'config.fish');
    case 'bash':
    default:
      return path.join(home, '.bashrc');
  }
}

function buildBlock() {
  // Deliberately no PI_CODING_AGENT_DIR: that variable used to point bare pi
  // at the shared runtime — now it would point at an immutable release or a
  // finished run's directory, both of which are wrong. The WSL shim works
  // through ~/.pix/host-link.json and needs no environment.
  return `# >>> pix >>>
# pix managed block. The WSL shim forwards management commands to the
# Windows host via ~/.pix/host-link.json. Do not export PI_CODING_AGENT_DIR
# here: bare pi must not share the managed run/agent directories.
# <<< pix <<<
`;
}

function readRc(rcPath) {
  try {
    return fs.readFileSync(rcPath, 'utf8');
  } catch {
    return '';
  }
}

function hasExistingBlock(content) {
  return content.includes('# >>> pix >>>') && content.includes('# <<< pix <<<');
}

function updateRc(rcPath) {
  const content = readRc(rcPath);
  const block = buildBlock();

  if (hasExistingBlock(content)) {
    const oldBlock = content.match(/# >>> pix >>>[\s\S]*?# <<< pix <<</);
    const hadLegacyExport = oldBlock && /^\s*export\s+PI_CODING_AGENT_DIR=/m.test(oldBlock[0]);
    const newContent = content.replace(
      /# >>> pix >>>[\s\S]*?# <<< pix <<</,
      block.trim()
    );
    fs.writeFileSync(rcPath, newContent);
    return hadLegacyExport ? 'replaced-legacy' : 'updated';
  }

  fs.writeFileSync(rcPath, content + (content.endsWith('\n') ? '' : '\n') + block);
  return 'added';
}

function execute(parsedArgs) {
  const shell = parsedArgs.shell || detectShell();
  const rcPath = getRcPath(shell);
  const before = readRc(rcPath);

  const action = updateRc(rcPath);

  if (action === 'replaced-legacy') {
    warn('Removed the legacy PI_CODING_AGENT_DIR export from the pix block.');
    warn('Bare pi no longer shares the managed runtime; use "pix" to launch pi.');
  }
  log(`${action === 'added' ? 'Added to' : 'Updated'} ${rcPath}`);
  log('Only the pix managed block was modified; all other shell content is untouched.');
  if (readRc(rcPath).replace(buildBlock().trim(), '') !== before.replace(/# >>> pix >>>[\s\S]*?# <<< pix <<</, '').trim() && action === 'updated') {
    // defensive: unreachable in practice, kept to surface unexpected rewrites
  }
  return 0;
}

module.exports = { execute, detectShell, getRcPath, updateRc, buildBlock };
