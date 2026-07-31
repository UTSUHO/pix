# @reiutsuho/pix

A Windows CLI launcher for [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) that runs Pi inside WSL2 and an optional Docker sandbox.

Pix is installed on Windows, but Pi itself runs in WSL. Both **Direct** (WSL) and **Sandbox** (Docker) modes share the same canonical Pi runtime at `~/.pix/runtime/agent` inside the WSL Linux filesystem. Windows `.pi` is no longer part of the active runtime; it is only used as a one-time migration source.

## Requirements

- Windows 10/11 with WSL2
- A WSL distro with Node.js and `pi` installed (for Direct mode)
- Docker Desktop with WSL integration enabled (for Sandbox mode)
- [Mutagen](https://mutagen.io/) (optional, recommended for real-time workspace sync)

## Mutagen installation

When your project lives on a Windows drive, Pix can keep the WSL-ext4 projection in continuous two-way sync with the Windows source directory using [Mutagen](https://mutagen.io/). Install Mutagen inside your WSL distro:

```bash
curl -fsSL "https://github.com/mutagen-io/mutagen/releases/latest/download/mutagen_linux_amd64.tar.gz" | tar xzf - -C /usr/local/bin
```

Then verify it is available in your WSL PATH:

```bash
mutagen version
```

If Mutagen is not installed, Pix automatically falls back to the original `rsync`/`cp` projection behavior.

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
| `pix init-guard` | Copy the default `/mnt` guard template to `~/.pix/extensions/` for customization. |

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
| `--sync` | Enable Mutagen continuous sync (default). |
| `--no-sync` | Disable Mutagen continuous sync; use `rsync`/`cp` projection. |
| `--sync-strategy <name>` | Sync strategy: `mutagen` or `projection`. |
| `--sync-keep-alive <mode>` | Mutagen session cleanup: `terminate`, `pause`, or `running`. |
| `--sync-mode <mode>` | Mutagen sync mode: `two-way-safe`, `two-way-resolved`, `one-way-safe`, or `one-way-replica`. |
| `--no-mnt-guard` | Do not inject the `/mnt` guard for this run (removes the installed extension). The guard is injected by default; this launch-time flag is the only way to opt out. |
| `--dockerfile <path>` | Use a custom Dockerfile for the sandbox image. |
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
    "exclude": ["node_modules", ".pnpm-store"],
    "sync": {
      "enabled": true,
      "strategy": "mutagen",
      "mode": "two-way-resolved",
      "keepAlive": "terminate",
      "exclude": []
    }
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
| `container.dockerfile` | Custom Dockerfile path for the sandbox image (`~` and relative paths supported). Default: the Dockerfile bundled with pix. Use `--rebuild` after changing it. |
| `workspace.projection` | Auto-project Windows NTFS workspaces into WSL filesystem. Default: `true`. |
| `workspace.projectionRoot` | Parent directory for projected workspaces. Default: `~/.pix/workspaces`. |
| `workspace.mirrorBack` | Mirror projected workspace back to Windows source after exit. Default: `true`. |
| `workspace.exclude` | Paths excluded during projection. Default: `["node_modules", ".pnpm-store"]`. |
| `workspace.sync.enabled` | Enable Mutagen continuous sync. Default: `true`. |
| `workspace.sync.strategy` | Sync strategy: `mutagen` or `projection`. Default: `mutagen`. |
| `workspace.sync.mode` | Mutagen sync mode: `two-way-safe`, `two-way-resolved`, `one-way-safe`, `one-way-replica`. Default: `two-way-resolved`. |
| `workspace.sync.keepAlive` | Mutagen session cleanup after exit: `terminate`, `pause`, or `running`. Default: `terminate`. |
| `workspace.sync.exclude` | Additional ignore patterns passed to Mutagen. Default: `[]`. |
| `envAllowlist` | Environment variables forwarded into the container. |
| `security.mntGuardSource` | **User config only.** Custom `/mnt` guard template path. Default: `~/.pix/extensions/pix-mnt-guard.ts` if it exists, otherwise the template bundled with pix. See [`/mnt` guard](#mnt-guard-windows-drive-protection). |

### Precedence

```text
CLI flags > .pix.json > ~/.pixrc.json > defaults
```

Exception: `security.*` keys are **user-level only**. A project `.pix.json` that contains `security` is ignored with a warning, so an untrusted checkout can never weaken or redirect the `/mnt` guard policy.

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

## Continuous workspace sync with Mutagen

When `workspace.sync.enabled` is `true` (default) and the workspace is on Windows NTFS, Pix first seeds a WSL-ext4 replica with `rsync`/`cp`, then asks Mutagen to keep the replica and the Windows source in continuous two-way sync. This gives `pi` fast ext4 I/O while your Windows editor sees changes in real time.

```text
/mnt/d/Documents/Github/myproject  ←→  ~/.pix/workspaces/myproject-a1b2c3d4
         (Windows source)                (WSL ext4 replica, authoritative)
```

Default behavior:

- `workspace.sync.strategy: "mutagen"`: try Mutagen first; fall back to one-shot `rsync`/`cp` projection if Mutagen is missing or fails.
- `workspace.sync.mode: "two-way-resolved"`: changes propagate both ways; if a file is modified on both sides, the WSL replica wins.
- `workspace.sync.keepAlive: "terminate"`: the Mutagen session is terminated when `pi` exits.

Use `--sync-keep-alive pause` to pause the session on exit (faster next startup), or `--sync-keep-alive running` to leave it running indefinitely. Stale `pix-*` sessions are reported by `pix doctor`.

If you prefer the old one-shot projection without continuous sync, set `workspace.sync.enabled: false` or run with `--no-sync`.

## `/mnt` guard (Windows drive protection)

On WSL, Pix installs a small Pi extension (`pix-mnt-guard.ts`) into the shared runtime at `<agentDir>/extensions/` on every launch. Because both Direct and Sandbox modes set `PI_CODING_AGENT_DIR` to the same path, the guard is auto-discovered by `pi` in both modes (and by plain `pi` after `pix install-shell-env`).

The extension is a `tool_call` middleware:

- Tool calls that do **not** touch `/mnt` pass through untouched.
- **Reads** of `/mnt/...` (`read`, `grep`, `find`, `ls`, read-like `bash` commands) ask the user: allow once, trust the path for the session, or deny.
- **Writes** to `/mnt/...` (`write`, `edit`, and write-like `bash` commands such as `rm`, redirection, `cp`/`mv`/`rsync` with a `/mnt` destination, `sed -i`, etc.) are blocked outright.
- `cd /mnt/...` inside a bash command counts as touching `/mnt`.
- In non-interactive modes (`pi -p`, JSON mode) there is no way to ask, so `/mnt` access is blocked (fail-closed).
- The session working directory is implicitly trusted: if you launch `pi` from a `/mnt` directory, that tree does not prompt.

This is an application-level policy hook, not a hard security boundary: obfuscated shell (variable splicing, globs) can evade string matching. Use `pix --sandbox` for mount-level isolation when you need a hard guarantee.

### Opting out (launch-time only)

The guard is injected by default on every launch. The **only** way to disable it is the explicit launch flag:

```bash
pix --no-mnt-guard
```

This removes the extension file pix installed (so `pi` will not auto-discover it) and launches without the guard. The next normal launch re-installs it. Config files — user or project — can never disable the guard; there is no silent opt-out.

### Customizing the guard template

The installed extension is rendered from a template, resolved in this order:

1. `security.mntGuardSource` in `~/.pixrc.json` (user config only)
2. `~/.pix/extensions/pix-mnt-guard.ts` (your edited copy)
3. the template bundled with pix (default)

To customize the policy, scaffold the editable copy once and edit it:

```bash
pix init-guard   # copies the default template to ~/.pix/extensions/pix-mnt-guard.ts
```

Pix installs your template into the shared runtime on every subsequent launch (content-based refresh: the installed file is rewritten only when it differs from the resolved template). Keep the first-line `// pix-mnt-guard vN` marker in your template so pix can recognize files it installed; user-maintained files with the same name but no marker are never overwritten or removed.

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
