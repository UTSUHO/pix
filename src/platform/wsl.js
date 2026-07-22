const { spawnSync } = require('child_process');
const { normalizeSlashes } = require('./paths');

function isWindows() {
  return process.platform === 'win32';
}

function isInsideWsl() {
  return process.platform === 'linux' && (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

function wslBin() {
  return isWindows() ? 'wsl.exe' : 'wsl';
}

function decodeWslOutput(buffer) {
  if (!buffer) return '';
  if (!Buffer.isBuffer(buffer)) return String(buffer);

  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.toString('utf16le').replace(/^﻿/, '');
  }

  let nullCount = 0;
  for (let i = 0; i < buffer.length; i += 2) {
    if (i + 1 < buffer.length && buffer[i + 1] === 0x00) {
      nullCount += 1;
    }
  }

  if (nullCount > buffer.length / 4) {
    return buffer.toString('utf16le');
  }

  return buffer.toString('utf8');
}

function runWsl(distro, args, options = {}) {
  const cmdArgs = distro ? ['-d', distro, '--', ...args] : ['--', ...args];
  return spawnSync(wslBin(), cmdArgs, {
    encoding: 'utf8',
    shell: false,
    stdio: 'pipe',
    ...options,
  });
}

function getDefaultDistro() {
  if (isInsideWsl()) {
    return process.env.WSL_DISTRO_NAME || null;
  }

  const result = spawnSync('wsl.exe', ['--list', '--verbose'], {
    encoding: 'buffer',
    shell: false,
    stdio: 'pipe',
  });

  if (result.status !== 0 || !result.stdout) {
    return null;
  }

  const stdout = decodeWslOutput(result.stdout);
  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('NAME')) continue;
    const match = trimmed.match(/^\*?\s*(\S+)/);
    if (match) {
      return match[1];
    }
  }

  return null;
}

function listDistros() {
  if (isInsideWsl()) {
    const name = process.env.WSL_DISTRO_NAME;
    return name ? [name] : [];
  }

  const result = spawnSync('wsl.exe', ['--list', '--quiet'], {
    encoding: 'buffer',
    shell: false,
    stdio: 'pipe',
  });

  if (result.status !== 0 || !result.stdout) {
    return [];
  }

  const stdout = decodeWslOutput(result.stdout);
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function isWslAvailable() {
  const result = spawnSync('wsl.exe', ['--list'], {
    encoding: 'buffer',
    shell: false,
    stdio: 'pipe',
  });
  return result.status === 0;
}

function toWslPath(inputPath, distro) {
  if (!inputPath) return inputPath;

  const normalizedInput = normalizeSlashes(inputPath);

  if (isInsideWsl()) {
    if (normalizedInput.startsWith('/mnt/') || normalizedInput.startsWith('/')) {
      return normalizedInput;
    }
    const result = spawnSync('wslpath', ['-a', normalizedInput], {
      encoding: 'utf8',
      shell: false,
      stdio: 'pipe',
    });
    if (result.status === 0 && result.stdout) {
      return result.stdout.trim();
    }
    return inputPath;
  }

  const result = runWsl(distro, ['wslpath', '-a', normalizedInput], {
    encoding: 'buffer',
    shell: false,
    stdio: 'pipe',
  });

  if (result.status !== 0 || !result.stdout) {
    return null;
  }

  return decodeWslOutput(result.stdout).trim();
}

function getWslHome(distro) {
  if (isInsideWsl()) {
    return process.env.HOME || '/root';
  }

  const result = runWsl(distro, ['bash', '-lc', 'echo "$HOME"'], {
    encoding: 'buffer',
    shell: false,
    stdio: 'pipe',
  });

  if (result.status !== 0 || !result.stdout) {
    return null;
  }

  return decodeWslOutput(result.stdout).trim();
}

function hasCommand(cmd, distro) {
  if (isInsideWsl()) {
    const result = spawnSync('sh', ['-c', `command -v ${cmd}`], {
      encoding: 'utf8',
      shell: false,
      stdio: 'pipe',
    });
    return result.status === 0 && result.stdout && result.stdout.trim().length > 0;
  }

  const checkCmd = `command -v ${cmd}`;
  const result = runWsl(distro, ['bash', '-lic', checkCmd], {
    encoding: 'buffer',
    shell: false,
    stdio: 'pipe',
  });
  return result.status === 0 && result.stdout && decodeWslOutput(result.stdout).trim().length > 0;
}

module.exports = {
  isWindows,
  isInsideWsl,
  wslBin,
  runWsl,
  getDefaultDistro,
  listDistros,
  isWslAvailable,
  toWslPath,
  getWslHome,
  hasCommand,
};
