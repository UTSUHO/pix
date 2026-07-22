# @reiutsuho/pix

A Windows CLI launcher for [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) that runs Pi inside WSL2 and an optional Docker sandbox.

Pix is installed on Windows, but Pi itself runs in WSL. Both **Direct** (WSL) and **Sandbox** (Docker) modes share the same canonical Pi runtime at `~/.pix/runtime/agent` inside the WSL Linux filesystem. Windows `.pi` is no longer part of the active runtime; it is only used as a one-time migration source.

## Requirements

- Windows 10/11 with WSL2
- A WSL distro with Node.js and `pi` installed (for Direct mode)
- Docker Desktop with WSL integration enabled (for Sandbox mode)

## Installation

Install Pix inside your WSL distro so that `node` and `pi` are available:

```bash
npm install -g @reiutsuho/pix
```

You can also run it from Windows PowerShell/CMD; Pix will re-invoke itself inside WSL automatically.

## Usage

```bash
cd /path/to/project
pix
```

By default `pix` uses the execution policy from your configuration (`direct` if unset).

### Commands

| Command | Description |
|---------|-------------|
| `pix` | Launch `pi` using the configured execution policy. |
| `pix --direct` | Force Direct execution in WSL. |
| `pix --sandbox` | Force Sandbox execution in Docker. |
| `pix status` | Show execution policy, WSL distro, runtime path, workspace storage type, pi/Docker availability, and pi versions. |
| `pix doctor` | Diagnose environment issues (WSL, Docker, NTFS paths, image, runtime mounts, version consistency, etc.). |
| `pix migrate` | One-time migration from Windows `.pi/agent` to the WSL canonical runtime. |
| `pix install-shell-env` | Add `PI_CODING_AGENT_DIR` to your shell rc file so plain `pi` uses the same runtime. |

### Options

| Option | Description |
|--------|-------------|
| `--direct` | Force Direct execution. |
| `--sandbox` | Force Sandbox execution. |
| `--distro <name>` | Use a specific WSL distro. |
| `--dry-run` | Print the command that would run instead of executing it. |
| `--rebuild` | Force rebuild the sandbox Docker image. |
| `--env-all` | Forward all environment variables into the container. |
| `--source <path>` | Source `.pi/agent` directory for `migrate`. |
| `--win-user <name>` | Windows username for auto-detecting the migrate source. |
| `--include-extensions` | Migrate extension source during `migrate`. |
| `--no-projection` | Disable workspace projection for this run. |
| `--mirror-back` | Mirror projected workspace back to Windows source after exit (default). |
| `--no-mirror-back` | Disable mirror-back for this run. |
| `--shell <shell>` | Shell for `install-shell-env` (`bash`, `zsh`, `fish`). |
| `--help, -h` | Show help. |

Any other arguments are passed through to `pi`:

```bash
pix --help
pix --some-pi-flag
```

## Configuration

Pix reads optional JSON config files. Project config overrides user config.

- User config: `~/.pixrc.json` (inside WSL, e.g. `/home/<user>/.pixrc.json`)
- Project config: `.pix.json` in the current working directory

Example `~/.pixrc.json`:

```json
{
  "wsl": {
    "distro": "Ubuntu",
    "runtimeRoot": "~/.pix/runtime"
  },
  "execution": "direct",
  "workspace": {
    "projection": true,
    "projectionRoot": "~/.pix/workspaces",
    "mirrorBack": false,
    "exclude": ["node_modules", ".pnpm-store"]
  },
  "container": {
    "image": "pix-pi-sandbox",
    "network": "bridge",
    "workspaceAccess": "read-write",
    "extraRunOptions": []
  },
  "envAllowlist": [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "DEBUG"
  ]
}
```

Example `.pix.json` for a project that needs network isolation:

```json
{
  "execution": "sandbox",
  "container": {
    "network": "none",
    "workspaceAccess": "read-write"
  }
}
```

### Config fields

| Field | Description |
|-------|-------------|
| `wsl.distro` | WSL distro to use. Default: default WSL distro. |
| `wsl.runtimeRoot` | Parent directory of the canonical Pi runtime. Default: `~/.pix/runtime`. The agent dir is always `runtimeRoot/agent`. |
| `execution` | Execution policy: `direct` or `sandbox`. Default: `direct`. |
| `container.image` | Docker image tag for Sandbox. Default: `pix-pi-sandbox`. |
| `container.network` | Docker network mode, e.g. `bridge`, `none`, `host`. Default: `bridge`. |
| `container.workspaceAccess` | `read-write` or `read-only`. Default: `read-write`. |
| `container.extraRunOptions` | Extra options passed to `docker run`. |
| `workspace.projection` | Auto-project Windows NTFS workspaces into WSL filesystem. Default: `true`. |
| `workspace.projectionRoot` | Parent directory for projected workspaces. Default: `~/.pix/workspaces`. |
| `workspace.mirrorBack` | Mirror projected workspace back to Windows source after exit. Default: `true`. |
| `workspace.exclude` | Paths excluded during projection. Default: `["node_modules", ".pnpm-store"]`. |
| `envAllowlist` | Environment variables forwarded into the container. |

### Precedence

```text
CLI flags > .pix.json > ~/.pixrc.json > defaults
```

## How it works

1. When invoked from Windows, Pix re-invokes itself inside WSL using `wsl.exe`.
2. Inside WSL, Pix loads config, resolves the WSL distro, workspace path, and canonical Pi runtime.
3. **Direct** mode runs `pi` in WSL directly, with `PI_CODING_AGENT_DIR` pointing at `~/.pix/runtime/agent`.
4. **Workspace projection:** If the project is on Windows NTFS (`/mnt/...`), Pix copies it to the WSL ext4 filesystem under `~/.pix/workspaces/<basename>-<hash>` before running `pi`. This avoids slow NTFS bind mounts in Sandbox mode.
5. **Sandbox** mode runs `docker run` from WSL, mounting:
   - the projected workspace to `/workspace`
   - the canonical Pi runtime into the container at the same absolute path
6. Sandbox sets `PI_CODING_AGENT_DIR` to the same path used by Direct mode, so both modes see the same configuration, auth, sessions, and extensions without copying files.

## Workspace projection

If your project lives on a Windows drive (e.g. `D:\Documents\Github\myproject`), the WSL path is `/mnt/d/Documents/Github/myproject`. Bind-mounting that into Docker is slow because every file operation crosses the Windows NTFS boundary.

Pix can automatically project the workspace into the WSL ext4 filesystem before running `pi`:

```text
/mnt/d/Documents/Github/myproject
    ↓ copy
~/.pix/workspaces/myproject-a1b2c3d4
```

Enable/configure in `~/.pixrc.json`:

```json
{
  "workspace": {
    "projection": true,
    "projectionRoot": "~/.pix/workspaces",
    "mirrorBack": true,
    "exclude": ["node_modules", ".pnpm-store"]
  }
}
```

- `projection: true` (default) copies the workspace before launch when it is on NTFS.
- `mirrorBack: true` (default) copies the projected workspace back to the Windows source after `pi` exits, overwriting source files.
- `--no-projection` disables projection for a single run.
- `--no-mirror-back` disables mirror-back for a single run.

Pix uses `rsync -a --delete` when available; otherwise it falls back to `cp -a`.

## Running `pi` directly inside WSL

Pix sets `PI_CODING_AGENT_DIR` when it launches `pi`, so Direct and Sandbox modes share the same runtime. If you also want to run `pi` directly in WSL (without typing `pix`), make sure the same environment variable is set:

```bash
pix install-shell-env
source ~/.bashrc
```

This writes a guarded block into your shell rc file:

```bash
# >>> pix >>>
export PI_CODING_AGENT_DIR="/home/<user>/.pix/runtime/agent"
# <<< pix <<<
```

After that, plain `pi` in WSL uses the exact same runtime as `pix --direct` and `pix --sandbox`. Re-run `pix install-shell-env` to update the path if you change `wsl.runtimeRoot`.

## Migration from Windows `.pi`

If you previously used a Windows-native Pi installation with `C:\Users\<user>\.pi\agent`, run:

```powershell
pix migrate
```

This performs a one-time copy of portable data (settings, models, auth, sessions, skills, prompts, themes) into `/home/<wsl-user>/.pix/runtime/agent`. Platform-specific directories (`npm`, `git`, `node_modules`, `bin`, `tools`) and `trust.json` are skipped and should be rebuilt inside WSL.

To also copy custom extension source, add `--include-extensions`.

## Notes

- Pix does not manage the contents of your Pi runtime, run `git pull`, or execute `pnpm install` automatically.
- If your workspace or runtime is on Windows NTFS (`/mnt/c/...`), Pix will warn you because performance will be slower.
- The old config keys `useHostPiHome`, `piHomeHostPath`, `useHostAgentHome`, `agentHomeHostPath`, `contextName`, `extraComposeOptions`, `imageName`, and `pi` are deprecated and ignored.

## License

MIT
