const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { run } = require('../process/spawn');
const { runWsl, getWslHome, decodeWslOutput } = require('./wsl');

/**
 * Target abstraction: where the runner lives and executes.
 *  - 'local': this Linux machine (development, tests, Linux-native use)
 *  - 'wsl':   a WSL distro, driven from Windows via wsl.exe
 *
 * A target exposes the runner transport (file staging) and process launch.
 * All process launches are argv-based (`wsl.exe --exec`), never bash -lic
 * string splicing with user input.
 */

function createLocalTarget(options = {}) {
  const home = options.home || os.homedir();
  const nodeExecutable = options.nodeExecutable || process.execPath;
  return {
    type: 'local',
    home,
    nodeExecutable,
    existsOnTarget(p) {
      return fs.existsSync(p);
    },
    removeOnTarget(p) {
      fs.rmSync(p, { recursive: true, force: true });
    },
    writeFileOnTarget(p, content) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    },
    copyTreeToTarget(srcDir, destDir, include) {
      for (const rel of include) {
        const src = path.join(srcDir, rel);
        if (!fs.existsSync(src)) continue;
        const dest = path.join(destDir, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.cpSync(src, dest, { recursive: true });
      }
    },
    renameOnTarget(from, to) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
    },
    readFileOnTarget(p) {
      return fs.readFileSync(p, 'utf8');
    },
    async spawnRunner(runnerEntry, args, opts = {}) {
      return run(nodeExecutable, [runnerEntry, ...args], {
        stdio: opts.stdio || 'inherit',
        env: opts.env || process.env,
        shell: false,
        input: opts.input,
      });
    },
    toTargetPath(p) {
      return p;
    },
  };
}

function createWslTarget(options = {}) {
  const distro = options.distro;
  if (!distro) throw new Error('createWslTarget requires a distro');

  const home = options.home || getWslHome(distro);
  if (!home) throw new Error(`Cannot determine home directory in WSL distro "${distro}"`);

  // Resolve an absolute Linux node once; all launches use --exec argv.
  let nodeExecutable = options.nodeExecutable || null;
  if (!nodeExecutable) {
    const probe = runWsl(distro, ['bash', '-lc', 'command -v node'], {
      encoding: 'buffer',
      shell: false,
      stdio: 'pipe',
    });
    if (probe.status === 0 && probe.stdout) {
      nodeExecutable = decodeWslOutput(probe.stdout).trim();
    }
  }
  if (!nodeExecutable) {
    throw new Error(`node is not available in WSL distro "${distro}". Install Node.js in WSL first.`);
  }

  function wslCapture(args) {
    const result = runWsl(distro, args, { encoding: 'buffer', shell: false, stdio: 'pipe' });
    return {
      status: result.status,
      stdout: result.stdout ? decodeWslOutput(result.stdout) : '',
    };
  }

  /**
   * Checked variant: staging/deploy steps must never silently no-op.
   * A silently-failed deploy that still reports success violates D10.
   */
  function wslRun(args) {
    const result = wslCapture(args);
    if (result.status !== 0) {
      throw new Error(`wsl command failed (exit ${result.status}): ${args.join(' ')}`);
    }
    return result;
  }

  return {
    type: 'wsl',
    distro,
    home,
    nodeExecutable,
    existsOnTarget(p) {
      return wslCapture(['test', '-e', p]).status === 0;
    },
    removeOnTarget(p) {
      wslRun(['rm', '-rf', p]);
    },
    writeFileOnTarget(p, content) {
      // Pure argv, no bash -c: wsl.exe re-parses quoted shell strings and can
      // silently mangle them. tee receives content on stdin instead.
      wslRun(['mkdir', '-p', path.posix.dirname(p)]);
      const result = spawnSync('wsl.exe', ['-d', distro, '--exec', 'tee', p], {
        input: Buffer.from(content, 'utf8'),
        shell: false,
        stdio: ['pipe', 'ignore', 'pipe'],
      });
      if (result.status !== 0) {
        throw new Error(`failed to write ${p} on target`);
      }
    },
    copyTreeToTarget(srcDir, destDir, include) {
      // Stream a tar of the include set into the target; no Windows-mount staging.
      const tar = spawnSync('tar', ['-czf', '-', '-C', srcDir, ...include], {
        encoding: 'buffer',
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 256 * 1024 * 1024,
      });
      if (tar.status !== 0 || !tar.stdout || tar.stdout.length === 0) {
        throw new Error(`failed to pack ${srcDir} for target copy`);
      }
      wslRun(['mkdir', '-p', destDir]);
      const extract = spawnSync('wsl.exe', ['-d', distro, '--', 'tar', '-xzf', '-', '-C', destDir], {
        input: tar.stdout,
        shell: false,
        stdio: ['pipe', 'ignore', 'pipe'],
      });
      if (extract.status !== 0) {
        throw new Error(`failed to extract files into WSL:${destDir}`);
      }
    },
    renameOnTarget(from, to) {
      wslRun(['mkdir', '-p', path.posix.dirname(to)]);
      wslRun(['mv', from, to]);
    },
    readFileOnTarget(p) {
      const result = wslCapture(['cat', p]);
      if (result.status !== 0) throw new Error(`cannot read ${p} on target`);
      return result.stdout;
    },
    async spawnRunner(runnerEntry, args, opts = {}) {
      return run('wsl.exe', ['-d', distro, '--exec', nodeExecutable, runnerEntry, ...args], {
        stdio: opts.stdio || 'inherit',
        env: opts.env || process.env,
        shell: false,
        input: opts.input,
      });
    },
    toTargetPath(p) {
      return p;
    },
  };
}

function createTarget(options = {}) {
  if (options.type === 'wsl') return createWslTarget(options);
  return createLocalTarget(options);
}

module.exports = { createTarget, createLocalTarget, createWslTarget };
