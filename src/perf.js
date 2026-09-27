/**
 * Lightweight phase timing + operation counters (PIX_PERF=1 to enable).
 * Reports to stderr (never stdout, so pi protocol streams stay clean) and
 * can be persisted into the run directory for the delivery report.
 */
const enabled = () => process.env.PIX_PERF === '1';

const phases = new Map();
const counters = new Map();

function phaseStart(name) {
  if (!enabled()) return () => {};
  const start = process.hrtime.bigint();
  return () => phaseEnd(name, start);
}

function phaseEnd(name, start) {
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  phases.set(name, (phases.get(name) || 0) + ms);
}

/** Time an async or sync function under a phase name. */
async function timed(name, fn) {
  if (!enabled()) return fn();
  const done = phaseStart(name);
  try {
    return await fn();
  } finally {
    done();
  }
}

function count(name, n = 1) {
  if (!enabled()) return;
  counters.set(name, (counters.get(name) || 0) + n);
}

function report() {
  const lines = [];
  for (const [name, ms] of phases) lines.push(`${name}: ${ms.toFixed(1)}ms`);
  for (const [name, n] of counters) lines.push(`${name}: ${n}`);
  return { phases: Object.fromEntries(phases), counters: Object.fromEntries(counters), lines };
}

function reportToStderr() {
  if (!enabled()) return;
  const { lines } = report();
  for (const line of lines) console.error(`[pix perf] ${line}`);
}

function reset() {
  phases.clear();
  counters.clear();
}

module.exports = { enabled, phaseStart, phaseEnd, timed, count, report, reportToStderr, reset };
