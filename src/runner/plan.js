const { RUNNER_PROTOCOL_VERSION } = require('../runtime/manifest');

/**
 * ExecutionPlan — the ONLY input a runner consumes. It is produced by the
 * host after config merge + policy checks; the runner never loads another
 * user-level config and never merges a second config hierarchy.
 *
 * @typedef {Object} ExecutionPlan
 * @property {number} schemaVersion
 * @property {string} hostId
 * @property {string} runId
 * @property {'direct'|'sandbox'} backend
 * @property {'tty'|'pipe'} transport
 * @property {string} bodyRevision
 * @property {string} runtimeId
 * @property {string} profileRevision
 * @property {{id:string, sourceRoot:string, executionRoot:string}} workspace
 * @property {{directory:string, file:(string|null)}} session
 * @property {string[]} piArgs
 * @property {Object} approvedPolicy
 */

const PLAN_SCHEMA_VERSION = 1;

function buildExecutionPlan(input) {
  const plan = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    runnerProtocolVersion: RUNNER_PROTOCOL_VERSION,
    hostId: input.hostId,
    runId: input.runId,
    backend: input.backend,
    transport: input.transport === 'pipe' ? 'pipe' : 'tty',
    bodyRevision: input.bodyRevision,
    runtimeId: input.runtimeId || null,
    profileRevision: input.profileRevision,
    workspace: {
      id: input.workspace.id,
      sourceRoot: input.workspace.sourceRoot,
      executionRoot: input.workspace.executionRoot,
    },
    session: {
      directory: input.session.directory,
      file: input.session.file || null,
    },
    piArgs: Array.isArray(input.piArgs) ? [...input.piArgs] : [],
    approvedPolicy: input.approvedPolicy || {},
  };
  const validation = validateExecutionPlan(plan);
  if (!validation.valid) {
    throw new Error(`Invalid execution plan: ${validation.errors.join('; ')}`);
  }
  return plan;
}

function isAbsolutePosix(p) {
  return typeof p === 'string' && p.startsWith('/');
}

/** executionRoot must be absolute on the target fs. Linux targets require
 *  /...; the local dev target on Windows accepts drive-letter paths. */
function isAbsoluteTargetPath(p) {
  if (typeof p !== 'string') return false;
  return p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p);
}

function validateExecutionPlan(plan) {
  const errors = [];
  if (!plan || typeof plan !== 'object') return { valid: false, errors: ['plan must be an object'] };
  if (plan.schemaVersion !== PLAN_SCHEMA_VERSION) errors.push('unsupported schemaVersion');
  if (typeof plan.hostId !== 'string' || !plan.hostId) errors.push('hostId required');
  if (typeof plan.runId !== 'string' || !plan.runId) errors.push('runId required');
  if (!['direct', 'sandbox'].includes(plan.backend)) errors.push('backend must be direct|sandbox');
  if (!['tty', 'pipe'].includes(plan.transport)) errors.push('transport must be tty|pipe');
  if (typeof plan.bodyRevision !== 'string' || !plan.bodyRevision) errors.push('bodyRevision required');
  if (typeof plan.profileRevision !== 'string' || !plan.profileRevision) errors.push('profileRevision required');
  if (!plan.workspace || typeof plan.workspace.id !== 'string') {
    errors.push('workspace.id required');
  } else {
    // sourceRoot may be a Windows path on the host side; executionRoot is
    // always a Linux-local absolute path on the target.
    if (!isAbsoluteTargetPath(plan.workspace.executionRoot)) errors.push('workspace.executionRoot must be an absolute path on the target');
  }
  if (!plan.session || typeof plan.session.directory !== 'string') errors.push('session.directory required');
  if (!Array.isArray(plan.piArgs)) errors.push('piArgs must be an array');
  if (plan.approvedPolicy && typeof plan.approvedPolicy !== 'object') errors.push('approvedPolicy must be an object');
  // A plan must never carry executable host shell or plaintext credentials.
  const serialized = JSON.stringify(plan);
  if (/"(shell|cmd|commandLine)"\s*:/.test(serialized)) errors.push('plan must not contain shell command fields');
  return { valid: errors.length === 0, errors };
}

module.exports = { PLAN_SCHEMA_VERSION, buildExecutionPlan, validateExecutionPlan };
