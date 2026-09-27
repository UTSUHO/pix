const { spawn } = require('child_process');

/**
 * Process wrapper.
 *  - argv only, never shell string splicing (shell defaults to false);
 *  - forwards Ctrl+C / termination signals to the child;
 *  - resolves with { code, signal } and never rejects on non-zero exit;
 *  - rejects only when the process could not be started (infra error), so
 *    callers can distinguish Pi failures from launcher failures.
 */
function run(cmd, args, options = {}) {
  const { onSpawn, input, ...spawnOptions } = options;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, {
        stdio: input !== undefined ? ['pipe', 'inherit', 'inherit'] : 'inherit',
        shell: false,
        ...spawnOptions,
      });
    } catch (err) {
      err.infraError = true;
      reject(err);
      return;
    }

    if (input !== undefined && child.stdin) {
      child.stdin.write(input);
      child.stdin.end();
    }

    const forward = (sig) => {
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill(sig);
      } catch { /* already gone */ }
    };
    const sigint = () => forward('SIGINT');
    const sigterm = () => forward('SIGTERM');
    process.on('SIGINT', sigint);
    process.on('SIGTERM', sigterm);

    if (onSpawn) onSpawn(child);

    child.on('error', (err) => {
      cleanup();
      err.infraError = true;
      reject(err);
    });
    child.on('close', (code, signal) => {
      cleanup();
      resolve({ code, signal });
    });

    function cleanup() {
      process.removeListener('SIGINT', sigint);
      process.removeListener('SIGTERM', sigterm);
    }
  });
}

module.exports = { run };
