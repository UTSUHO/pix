const DEFAULT_ALLOWLIST = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_ORG_ID',
  'GOOGLE_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_ENDPOINT',
  'HUGGINGFACE_API_KEY',
  'HF_TOKEN',
  'PI_AGENT_HOME',
  'PI_CODING_AGENT_DIR',
  'NODE_ENV',
  'DEBUG',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
];

const DEFAULTS = {
  wsl: {
    distro: null,
    runtimeRoot: '~/.pix/runtime',
  },
  execution: 'direct',
  workspace: {
    projection: true,
    projectionRoot: '~/.pix/workspaces',
    mirrorBack: true,
    exclude: ['node_modules', '.pnpm-store'],
    sync: {
      enabled: true,
      strategy: 'mutagen',
      keepAlive: 'terminate',
      mode: 'two-way-resolved',
      exclude: [],
    },
  },
  container: {
    image: 'pix-pi-sandbox',
    network: 'bridge',
    workspaceAccess: 'read-write',
    extraRunOptions: [],
  },
  envAllowlist: DEFAULT_ALLOWLIST,
  security: {
    mntGuard: true,
  },
};

module.exports = { DEFAULTS, DEFAULT_ALLOWLIST };
