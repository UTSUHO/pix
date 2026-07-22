const { run } = require('../process/spawn');

async function execute(workspace, agentDir, piArgs, options = {}) {
  const { dryRun = false } = options;

  const cmd = 'pi';
  const args = [...piArgs];

  if (dryRun) {
    console.log(`cd ${workspace}`);
    console.log(`PI_CODING_AGENT_DIR=${agentDir} ${[cmd, ...args].map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`);
    return 0;
  }

  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };

  const result = await run(cmd, args, {
    cwd: workspace,
    env,
    shell: false,
  });

  return result.code ?? 0;
}

module.exports = { execute };
