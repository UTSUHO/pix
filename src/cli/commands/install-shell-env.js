const fs = require('fs');
const os = require('os');
const path = require('path');
const { log } = require('../output');
const { loadConfig } = require('../../config/load-config');
const { mergeConfig } = require('../../config/merge-config');
const { resolveAgentDir } = require('../../runtime/resolve-runtime');

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

function buildEnvLine(agentDir) {
  return `export PI_CODING_AGENT_DIR="${agentDir}"`;
}

function buildBlock(agentDir) {
  return `# >>> pix >>>
${buildEnvLine(agentDir)}
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

function updateRc(rcPath, agentDir) {
  const content = readRc(rcPath);
  const block = buildBlock(agentDir);

  if (hasExistingBlock(content)) {
    const newContent = content.replace(
      /# >>> pix >>>[\s\S]*?# <<< pix <<</,
      block.trim()
    );
    fs.writeFileSync(rcPath, newContent);
    return 'updated';
  }

  fs.writeFileSync(rcPath, content + (content.endsWith('\n') ? '' : '\n') + block);
  return 'added';
}

function execute(parsedArgs) {
  const cwd = process.cwd();
  const configs = loadConfig(cwd);
  const { config } = mergeConfig(configs);

  const agentDir = resolveAgentDir(config, process.env.HOME);
  const shell = parsedArgs.shell || detectShell();
  const rcPath = getRcPath(shell);

  const action = updateRc(rcPath, agentDir);
  log(`PI_CODING_AGENT_DIR=${agentDir}`);
  log(`${action === 'added' ? 'Added to' : 'Updated'} ${rcPath}`);
  log('Run "source ' + rcPath + '" or open a new shell to apply the change.');

  return 0;
}

module.exports = { execute, detectShell, getRcPath, updateRc };
