/**
 * Minimal semver satisfaction check for `engines.node`-style ranges.
 * Supports: exact, >=, >, <=, <, =, ^x.y.z, ~x.y.z, x.y.* / x.* / *,
 * space-separated conjunctions and `||` disjunctions. This is intentionally
 * small; it only needs to gate "is this Node allowed to run this Pi" checks,
 * not to resolve dependencies.
 */

function parseVersion(v) {
  const m = String(v).trim().replace(/^v/, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)];
}

function cmp(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function matchComparator(version, comparator) {
  const c = comparator.trim();
  if (!c || c === '*') return true;

  let m = c.match(/^(>=|<=|>|<|=)?\s*v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(?:-.*)?$/);
  if (!m) return false;
  const op = m[1] || '=';
  const major = Number(m[2]);
  const minorRaw = m[3];
  const patchRaw = m[4];
  const minorWild = minorRaw === undefined || minorRaw === 'x' || minorRaw === '*';
  const patchWild = patchRaw === undefined || patchRaw === 'x' || patchRaw === '*';
  const minor = minorWild ? 0 : Number(minorRaw);
  const patch = patchWild ? 0 : Number(patchRaw);

  // Wildcard / partial ranges: "1", "1.x" => anything within the fixed prefix.
  if (op === '=' && (minorWild || patchWild)) {
    if (version[0] !== major) return false;
    if (!minorWild && version[1] !== minor) return false;
    return true;
  }

  const target = [major, minor, patch];
  const c0 = cmp(version, target);
  switch (op) {
    case '>=': return c0 >= 0;
    case '<=': return c0 <= 0;
    case '>': return c0 > 0;
    case '<': return c0 < 0;
    case '=': return c0 === 0;
    default: return false;
  }
}

function matchCaret(version, base) {
  // ^a.b.c: >=a.b.c, <(a+1).0.0 when a>0; <0.(b+1).0 when a=0; <0.0.(c+1) when a=b=0
  if (cmp(version, base) < 0) return false;
  const [a, b, c] = base;
  const upper = a > 0 ? [a + 1, 0, 0] : b > 0 ? [0, b + 1, 0] : [0, 0, c + 1];
  return cmp(version, upper) < 0;
}

function matchTilde(version, base) {
  // ~a.b.c: >=a.b.c <a.(b+1).0
  if (cmp(version, base) < 0) return false;
  return cmp(version, [base[0], base[1] + 1, 0]) < 0;
}

function satisfies(versionStr, range) {
  if (!range || !String(range).trim() || String(range).trim() === '*') return true;
  const version = parseVersion(versionStr);
  if (!version) return false;

  return String(range).split('||').some((alternatives) =>
    alternatives.trim().split(/\s+/).filter(Boolean).every((comp) => {
      if (comp.startsWith('^')) {
        const base = parseVersion(comp.slice(1));
        return base ? matchCaret(version, base) : false;
      }
      if (comp.startsWith('~')) {
        const base = parseVersion(comp.slice(1));
        return base ? matchTilde(version, base) : false;
      }
      return matchComparator(version, comp);
    })
  );
}

module.exports = { satisfies, parseVersion };
