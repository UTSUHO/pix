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

function mergeConfig({ user, project }, cliOverrides = {}) {
  const base = mergeDeep(DEFAULTS, user);
  const withProject = mergeDeep(base, project);

  const allowlist = new Set([
    ...(base.envAllowlist || DEFAULTS.envAllowlist),
    ...(project.envAllowlist || []),
  ]);

  const result = mergeDeep(withProject, cliOverrides);
  result.envAllowlist = Array.from(allowlist);

  const warnings = collectWarnings(user, project);

  return { config: result, warnings };
}

module.exports = { mergeConfig, collectWarnings };
