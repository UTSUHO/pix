const { DEFAULTS } = require('./defaults');

const DEPRECATED_KEYS = [
  'useHostPiHome',
  'piHomeHostPath',
  'useHostAgentHome',
  'agentHomeHostPath',
  'contextName',
  'extraComposeOptions',
  'imageName',
  'pi',
];

/**
 * Privileged keys a project checkout may never set. Project config can only
 * request or tighten — never widen — the sandbox boundary.
 */
const PROJECT_FORBIDDEN_PATHS = [
  ['security'],
  ['container', 'extraRunOptions'],
  ['container', 'dockerfile'],
];

function getPath(obj, pathArr) {
  let cur = obj;
  for (const key of pathArr) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}

function collectWarnings(userConfig, projectConfig) {
  const warnings = [];
  const configs = [userConfig, projectConfig];
  for (const cfg of configs) {
    for (const key of DEPRECATED_KEYS) {
      if (cfg && Object.prototype.hasOwnProperty.call(cfg, key)) {
        warnings.push(`Config key "${key}" is deprecated and ignored. Update your .pixrc.json / .pix.json.`);
      }
    }
  }
  if (projectConfig) {
    if (Object.prototype.hasOwnProperty.call(projectConfig, 'security')) {
      warnings.push('Project .pix.json cannot set "security" keys (policy settings are user-level only). Ignored.');
    }
    for (const p of PROJECT_FORBIDDEN_PATHS) {
      if (getPath(projectConfig, p) !== undefined) {
        warnings.push(`Project .pix.json cannot set "${p.join('.')}" (privileged, user-level only). Ignored.`);
      }
    }
    const projectNetwork = getPath(projectConfig, ['container', 'network']);
    if (projectNetwork && projectNetwork !== 'none') {
      warnings.push(`Project .pix.json cannot widen container.network to "${projectNetwork}" (only "none" is allowed project-side). Ignored.`);
    }
    // envAllowlist: project may narrow, never widen.
    const userList = (userConfig && userConfig.envAllowlist) || DEFAULTS.envAllowlist;
    const projectList = projectConfig.envAllowlist;
    if (Array.isArray(projectList)) {
      const widening = projectList.filter((k) => !userList.includes(k));
      if (widening.length) {
        warnings.push(`Project .pix.json tried to add env vars beyond the user allowlist: ${widening.join(', ')}. Ignored.`);
      }
    }
  }
  return warnings;
}

function mergeDeep(target, source) {
  const result = { ...target };
  if (!source) return result;
  for (const key of Object.keys(source)) {
    const sourceVal = source[key];
    const targetVal = result[key];
    if (
      sourceVal &&
      typeof sourceVal === 'object' &&
      !Array.isArray(sourceVal) &&
      targetVal &&
      typeof targetVal === 'object' &&
      !Array.isArray(targetVal)
    ) {
      result[key] = mergeDeep(targetVal, sourceVal);
    } else {
      result[key] = sourceVal;
    }
  }
  return result;
}

/** Remove privileged keys from a project config before merging. */
function sanitizeProjectConfig(project) {
  if (!project) return project;
  const safe = JSON.parse(JSON.stringify(project));
  delete safe.security;
  if (safe.container) {
    delete safe.container.extraRunOptions;
    delete safe.container.dockerfile;
    if (safe.container.network && safe.container.network !== 'none') {
      delete safe.container.network;
    }
  }
  return safe;
}

function mergeConfig({ user, project }, cliOverrides = {}) {
  const safeProject = sanitizeProjectConfig(project);

  const base = mergeDeep(DEFAULTS, user);
  const withProject = mergeDeep(base, safeProject);

  // envAllowlist: project can only NARROW the user allowlist (intersection),
  // never widen it. An untrusted checkout must not exfiltrate new variables
  // into the container.
  const userAllowlist = (user && user.envAllowlist) || DEFAULTS.envAllowlist;
  let effectiveAllowlist = [...userAllowlist];
  if (safeProject && Array.isArray(safeProject.envAllowlist)) {
    effectiveAllowlist = userAllowlist.filter((k) => safeProject.envAllowlist.includes(k));
  }

  const result = mergeDeep(withProject, cliOverrides);
  result.envAllowlist = effectiveAllowlist;

  const warnings = collectWarnings(user, project);

  return { config: result, warnings };
}

module.exports = { mergeConfig, collectWarnings, sanitizeProjectConfig };
