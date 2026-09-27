const { run } = require('../process/spawn');

/**
 * Direct executor: runs the MANAGED Pi from the runtime descriptor with an
 * explicit Node executable. Never resolves "pi" from PATH — a shadow pi
 * earlier in PATH cannot hijack execution.
 *
 * @param {object} runtime  RuntimeDescriptor { nodeExecutable, piEntrypoint }
 * @param {object} runCtx   { agentDir, workspaceRoot, piArgs, env, transport }
 */
async function execute(runtime, runCtx, options = {}) {
  const { dryRun = false } = options;
  const cmd = runtime.nodeExecutable || 'node';
  const args = [runtime.piEntrypoint, ...runCtx.piArgs];

  const env = {
    ...runCtx.env,
    PI_CODING_AGENT_DIR: runCtx.agentDir,
  };

  if (dryRun) {
    console.error(`[pix] cd ${runCtx.workspaceRoot}`);
    console.error(`[pix] PI_CODING_AGENT_DIR=${runCtx.agentDir} ${cmd} ${args.join(' ')}`);
    return { code: 0, signal: null };
  }

  // tty vs pipe: inherit keeps the interactive terminal; pipe mode keeps the
  // three streams separate and never allocates a pty. Pix's own logs go to
  // stderr only, so stdout stays a clean protocol channel for pi.
  return run(cmd, args, {
    cwd: runCtx.workspaceRoot,
    env,
    shell: false,
    stdio: 'inherit',
  });
}

module.exports = { execute };
