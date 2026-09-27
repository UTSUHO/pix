#!/usr/bin/env node
/**
 * pix-runner — internal target-side executor. NOT a user CLI.
 *
 * It consumes an ExecutionPlan produced by the Windows host and nothing
 * else: no user config files, no second config merge, no version decisions.
 *
 * Commands:
 *   init --run-id <id>            read base64 plan JSON from stdin, validate,
 *                                 store at <root>/runs/<runId>/plan.json
 *   exec --plan <path>            ensureRuntime → composeAgent → workspace →
 *                                 execute → collect; writes result.json
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const { validateExecutionPlan } = require('../src/runner/plan');
const { ensureRuntime } = require('../src/runtime/projection');
const { composeRunAgent, collectRunState, markRunUncollected } = require('../src/runtime/compose-agent');
const { prepareWorkspace, cleanupWorkspace } = require('../src/workspace/sync');
const { validateManifest } = require('../src/runtime/manifest');
const { createAdapters } = require('../src/host/adapters');
const directExecutor = require('../src/executors/direct-executor');
const sandboxExecutor = require('../src/executors/sandbox-executor');
const perf = require('../src/perf');

function eprintln(...args) {
  console.error('[pix-runner]', ...args);
}

function fail(message, code = 1) {
  eprintln(message);
  process.exit(code);
}

function runnerRoot(env = process.env) {
  return env.PIX_TARGET_ROOT || path.join(os.homedir(), '.pix');
}

function parseRunnerArgs(argv) {
  const out = { command: argv[0] || null, runId: null, plan: null };
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === '--run-id') out.runId = argv[++i];
    else if (argv[i] === '--plan') out.plan = argv[++i];
  }
  return out;
}

function readPlanFile(planPath) {
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  const validation = validateExecutionPlan(plan);
  if (!validation.valid) {
    fail(`invalid plan: ${validation.errors.join('; ')}`);
  }
  return plan;
}

function loadReleaseManifest(rootDir, bodyRevision) {
  const releaseDir = path.join(rootDir, 'releases', bodyRevision);
  const manifestPath = path.join(releaseDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    const err = new Error(`RUNTIME_DEPLOY_FAILED: release ${bodyRevision.slice(0, 12)} not staged on target (${releaseDir}). Run "pix deploy" first.`);
    err.code = 'RUNTIME_DEPLOY_FAILED';
    throw err;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const validation = validateManifest(manifest);
  if (!validation.valid || manifest.bodyRevision !== bodyRevision) {
    const err = new Error(`RUNTIME_VERSION_MISMATCH: staged release does not match plan bodyRevision`);
    err.code = 'RUNTIME_VERSION_MISMATCH';
    throw err;
  }
  return { manifest, releaseDir };
}

function probePlatform() {
  return {
    os: process.platform,
    arch: process.arch,
    libc: process.report && process.report.getReport().header.glibcVersionRuntime ? 'glibc' : null,
    nodeVersion: process.versions.node,
    nodeAbi: process.versions.modules,
    packageManagerVersion: null,
    environmentFingerprint: null,
  };
}

async function cmdInit(args) {
  if (!args.runId) fail('init requires --run-id');
  const chunks = [];
  // Never block forever on a plan that never arrives.
  const stdinTimeout = setTimeout(() => {
    eprintln('init timed out waiting for the plan on stdin');
    process.exit(75);
  }, 15000);
  try {
    for await (const chunk of process.stdin) chunks.push(chunk);
  } finally {
    clearTimeout(stdinTimeout);
  }
  const plan = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const validation = validateExecutionPlan(plan);
  if (!validation.valid) fail(`invalid plan: ${validation.errors.join('; ')}`);
  if (plan.runId !== args.runId) fail('plan runId does not match --run-id');

  const rootDir = runnerRoot();
  const runDir = path.join(rootDir, 'runs', plan.runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
  eprintln(`plan stored: ${path.join(runDir, 'plan.json')}`);
  return 0;
}

/** Adapters with visible npm output when PIX_DEBUG=1 (cold installs are
 *  otherwise silent for minutes and look like a hang). */
function makeRunnerAdapters() {
  if (process.env.PIX_DEBUG !== '1') return undefined;
  const { execFileSync } = require('child_process');
  return createAdapters({
    execFile(cmd, args, options = {}) {
      eprintln(`+ ${cmd} ${args.join(' ')}`);
      try {
        const stdout = execFileSync(cmd, args, {
          encoding: 'utf8', shell: false, stdio: ['ignore', 'inherit', 'inherit'], ...options,
        });
        return { status: 0, stdout: stdout || '' };
      } catch (err) {
        return { status: err.status ?? 1, stdout: (err.stdout || '').toString() };
      }
    },
  });
}

async function cmdExec(args) {
  const rootDir = runnerRoot();
  const plan = readPlanFile(args.plan);
  const runId = plan.runId;
  const policy = plan.approvedPolicy || {};

  let leaseRelease = null;
  let workspaceDesc = null;
  let agent = null;

  try {
    // 1. Body execution copy (ready-hit does zero install / zero copy).
    eprintln(`loading release ${plan.bodyRevision.slice(0, 12)}...`);
    const { manifest, releaseDir } = loadReleaseManifest(rootDir, plan.bodyRevision);
    eprintln('ensuring runtime (a cold deploy runs a frozen npm ci once; PIX_DEBUG=1 shows npm output)...');
    const runtime = await perf.timed('ensureRuntime', () =>
      ensureRuntime(manifest, {
        rootDir,
        platform: probePlatform(),
        releaseDir,
      }, { nodeExecutable: process.execPath, adapters: makeRunnerAdapters() })
    );
    eprintln(`runtime ${runtime.runtimeId.slice(0, 12)} ${runtime.readyHit ? 'ready (cached)' : 'deployed'}`);

    // 2. Workspace execution copy (resume-over-reseed protections inside).
    eprintln('preparing workspace...');
    workspaceDesc = await perf.timed('prepareWorkspace', () =>
      prepareWorkspace(plan.workspace.sourceRoot, policy.workspace || {}, {})
    );
    eprintln(`workspace: ${workspaceDesc.executionRoot} (${workspaceDesc.storageType}, ${workspaceDesc.syncMode})`);

    // 3. Per-run agent dir.
    agent = await perf.timed('composeAgent', () =>
      composeRunAgent({
        rootDir,
        runId,
        workspaceId: workspaceDesc.workspaceId || plan.workspace.id,
        profileRevision: plan.profileRevision,
        profileSourceDir: path.join(rootDir, 'profiles', plan.profileRevision),
        runtime,
        credentialsDir: path.join(rootDir, 'credentials'),
        mntGuard: policy.mntGuard !== false,
        guardConfig: policy.guardConfig || null,
      })
    );
    leaseRelease = agent.leaseRelease;
    eprintln(`run agent: ${agent.agentDir}`);

    // 4. Execute.
    eprintln(`starting pi (${plan.backend})...`);
    const runCtx = {
      agentDir: agent.agentDir,
      workspaceRoot: workspaceDesc.executionRoot,
      piArgs: plan.piArgs,
      env: policy.env || {},
      transport: plan.transport,
      runAsUser: policy.runAsUser || null,
    };

    let result;
    if (plan.backend === 'direct') {
      result = await perf.timed('execute', () => directExecutor.execute(runtime, runCtx, {}));
    } else {
      result = await perf.timed('execute', () =>
        sandboxExecutor.execute(runtime, runCtx, policy.containerConfig || {}, {
          manifest,
          releaseDir,
          rebuild: policy.rebuild === true,
        })
      );
    }

    // 5. Collect.
    await perf.timed('collectWorkspace', () =>
      cleanupWorkspace(workspaceDesc, policy.workspace || {}, {
        reportPath: path.join(rootDir, 'runs', runId, 'workspace-diff.json'),
      })
    );
    collectRunState(rootDir, runId, { code: result.code, signal: result.signal, imageId: result.imageId });
    if (perf.enabled()) {
      perf.reportToStderr();
      fs.writeFileSync(path.join(rootDir, 'runs', runId, 'perf.json'), JSON.stringify(perf.report(), null, 2));
    }
    return result.code ?? 0;
  } catch (err) {
    markRunUncollected(rootDir, runId, err.message || String(err));
    eprintln(err.message || String(err));
    try {
      if (workspaceDesc) {
        cleanupWorkspace(workspaceDesc, policy.workspace || {}, {});
      }
    } catch { /* preserve original error */ }
    if (err.code === 'SESSION_LOCKED') return 73;
    if (err.code === 'RUNTIME_VERSION_MISMATCH') return 74;
    if (err.code === 'RUNTIME_DEPLOY_FAILED') return 75;
    if (err.code === 'WORKSPACE_CONFLICT' || err.code === 'WORKSPACE_PROJECTION_FAILED') return 76;
    return 1;
  } finally {
    if (leaseRelease) {
      try { leaseRelease(); } catch { /* ignore */ }
    }
  }
}

async function main() {
  const args = parseRunnerArgs(process.argv.slice(2));
  if (args.command === 'init') return cmdInit(args);
  if (args.command === 'exec') {
    if (!args.plan) fail('exec requires --plan <path>');
    return cmdExec(args);
  }
  fail('usage: pix-runner <init|exec> [--run-id <id>] [--plan <path>]', 2);
  return 2;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    eprintln(err.message || String(err));
    process.exit(1);
  });
