# @reiutsuho/pix

A local CLI wrapper that launches [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) inside an automatically created Docker context/runtime.

## Features

- **Docker context auto-creation**: Creates a dedicated Docker context (`pi-local` by default) on first run.
- **Sandboxed runtime**: Runs `pi` inside a container with the official Node.js + tooling image.
- **Host workspace mount**: Mounts the current directory into `/workspace` so file edits apply directly to your project.
- **Host `~/.pi` mount**: Mounts your host `~/.pi` directory into the container's `/root/.pi` by default, so `pi` can read your existing auth/session files without extra environment variables.
- **Environment allowlist**: Forwards only the environment variables you configure, with an opt-in `--env-all` override.

## Requirements

- [Docker](https://docs.docker.com/get-docker/) installed and running
- Node.js >= 18 (for the wrapper CLI)

## Installation

```bash
npm install -g @reiutsuho/pix
```

Or use with `npx`:

```bash
npx @reiutsuho/pix --help
```

## Usage

```bash
# Run pi in Docker from any project directory
# pi will read auth/session files from your host ~/.pi directory
cd /path/to/project
pix
```

If you prefer to pass the API key via environment variable instead, set it in your shell:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
pix
```

### CLI options

| Option | Description |
|--------|-------------|
| `--rebuild` | Force rebuild the Docker image before running. |
| `--env-all` | Forward **all** environment variables into the container. |
| `--dry-run` | Print the Docker command and generated compose file instead of executing it. |

Any other arguments are passed through to `pi`:

```bash
pix --help
pix --some-pi-flag
```

## Configuration

`pix` reads optional JSON config files. Project config overrides user config.

- User config: `~/.pixrc.json`
- Project config: `.pix.json` in the current working directory

Example `.pix.json`:

```json
{
  "contextName": "pi-local",
  "imageName": "pix-pi-sandbox",
  "apiKeyEnv": "ANTHROPIC_API_KEY",
  "requireApiKey": false,
  "useHostPiHome": true,
  "piHomeHostPath": "~/.pi",
  "envAllowlist": [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "DEBUG"
  ],
  "extraEnv": {
    "NODE_ENV": "development"
  },
  "extraRunOptions": ["--service-ports"]
}
```

To use a Docker named volume for `/root/.pi` instead of mounting the host directory, set:

```json
{
  "useHostPiHome": false
}
```

The default host path is `~/.pi` (resolved to the current user's home directory). You can override it with `piHomeHostPath`.

### Config fields

| Field | Description |
|-------|-------------|
| `contextName` | Name of the Docker context to create/use. Default: `pi-local`. |
| `imageName` | Tag for the built sandbox image. Default: `pix-pi-sandbox`. |
| `apiKeyEnv` | Environment variable treated as the required API key. Default: `ANTHROPIC_API_KEY`. |
| `requireApiKey` | Whether to error if the API key env var is missing. Default: `false` when `useHostPiHome` is `true`, otherwise `true`. |
| `envAllowlist` | List of environment variables forwarded into the container. |
| `extraEnv` | Static extra environment variables injected into the container. |
| `dockerfilePath` | Override the Dockerfile used to build the image. |
| `useHostPiHome` | Mount host `~/.pi` into the container at `/root/.pi`. Default: `true`. |
| `piHomeHostPath` | Host path to mount as `/root/.pi` when `useHostPiHome` is `true`. Default: `~/.pi`. |
| `useHostAgentHome` | Legacy alias for `useHostPiHome`. |
| `agentHomeHostPath` | Legacy alias for `piHomeHostPath`. |
| `extraComposeOptions` | Extra options passed to `docker compose`. |
| `extraRunOptions` | Extra options passed to `docker compose run`. |

## How it works

1. Checks that Docker is available.
2. Loads config from `~/.pixrc.json` and `./.pix.json`.
3. Creates the Docker context if it does not exist.
4. Ensures the host `~/.pi` directory exists (when using host mount).
5. Generates a temporary `docker-compose.yml` with:
   - Current directory mounted to `/workspace`
   - Host `~/.pi` mounted to `/root/.pi`
6. Runs `docker --context <context> compose run --rm pi <args>`.

## License

MIT
