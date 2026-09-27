# @reiutsuho/pix

A Windows CLI launcher for [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent). Windows is the single maintenance owner — the managed Pi install, plugins, profile and credentials live on Windows; WSL2 and Docker only materialize the published release as versioned execution copies.

[中文文档](readmeZH.md)

## How it works (v0.4)

```text
Windows host (%USERPROFILE%\.pix)              <- the only place you maintain
  body/releases/<rev>/   immutable Pi releases (manifest + lockfile)
  profile/               settings, models, prompts, skills, themes
  credentials/           auth
        │  pix run / pix deploy (host orchestrates)
        ▼
WSL ~/.pix/                                    <- execution backend
  installs|runtimes/     body installed per platform from the frozen lock
  workspaces/<id>/       projected workspace (rsync seed + mutagen sync)
  sessions|runs/         session history & per-run agent dir
        ├── direct:  Linux Node + managed Pi entrypoint
        └── sandbox: Docker image built from the same release manifest
```

- `pix update` runs **on Windows only** and publishes an immutable release (spec → resolve → staging → validate → release → atomic `current` switch). WSL/Docker never pick versions themselves.
- Warm runs do **zero** reinstall / full body copy (ready-hit by content keys).
- Body, profile, workspace and session state have independent lifecycles: updating Pi never wipes a workspace.
- The v0.3 pipeline remains available as `pix --legacy` (direct mode only).

## Requirements

- Windows 10/11 with WSL2 (Node.js installed in the distro)
- Docker Desktop with WSL integration (sandbox mode only)
- [Mutagen](https://mutagen.io/) in WSL (optional; falls back to rsync/cp projection)

## Quick start

```powershell
npm install -g @reiutsuho/pix
pix update            # publish the Pi release on Windows
pix migrate --to-host --apply --include-auth   # one-time, if you have existing pi data
cd D:\your\project
pix                   # direct in WSL
pix --sandbox         # in the Docker sandbox
```

> **Breaking change in v0.4**: `pix update` used to pass through to `pi update` (updating the WSL global pi, or a throwaway container layer). It now updates the Windows master install and managed plugins only.

## Commands

| Command | Runs on | Description |
|---------|---------|-------------|
| `pix` | host orchestrates | Launch pi from the current published release |
| `pix update [--pi-only\|--plugins-only] [--dry-run]` | Windows | Update managed Pi + plugins, publish a release |
| `pix deploy --target wsl\|docker\|local` | host orchestrates | Stage the current release onto a backend |
| `pix status` | Windows | Host release vs backend copies, pending/uncollected state |
| `pix doctor` | Windows | Diagnostics with recovery guidance |
| `pix migrate --to-host [--apply] [--include-auth]` | Windows | Import legacy Windows/WSL pi data (dry-run by default) |
| `pix install-shell-env` / `init-guard` | local | Shell block / guard template scaffolding |
| `pix --legacy ...` | WSL | Explicit v0.3 compatibility pipeline |

Everything after `--` is passed to pi verbatim. Set `PIX_DEBUG=1` for runner stage logs and npm output; `PIX_PERF=1` for phase timings.

Common options: `--direct` / `--sandbox`, `--distro <name>`, `--writeback realtime|review`, `--sync-mode two-way-safe|two-way-resolved|...`, `--no-mnt-guard`, `--rebuild`, `--dry-run`.

## Configuration

Priority: CLI flags > project `.pix.json` > host config > defaults.

- Host config (authoritative): `%USERPROFILE%\.pix\config.json` (legacy `~/.pixrc.json` still read as fallback)
- Project config: `.pix.json` in the project directory — can only **narrow** privileges. It can never set `security.*`, extra Docker args, custom Dockerfile, or widen the env allowlist / container network.

```jsonc
// %USERPROFILE%\.pix\config.json
{
  "wsl": { "distro": "Ubuntu-22.04" },
  "execution": "direct",                    // or "sandbox"
  "workspace": {
    "projection": true,
    "writeback": "realtime",                // or "review" (diff report, no auto-overwrite)
    "sync": { "enabled": true, "mode": "two-way-safe", "keepAlive": "terminate" }
  },
  "container": { "network": "bridge", "workspaceAccess": "read-write" },
  "envAllowlist": ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]
}
```

`body/spec.json` (managed by `pix update`) pins the Pi package source/version policy and managed plugins (npm / pinned / local sources).

## Where things live

| Data | Windows host | WSL backend |
|------|-------------|-------------|
| Pi releases | `.pix\body\releases\<rev>\` | `~/.pix/releases/`, `~/.pix/installs/`, `~/.pix/runtimes/` |
| Profile / auth | `.pix\profile\`, `.pix\credentials\` | `~/.pix/profiles/`, `~/.pix/credentials/` |
| Workspace copies | your project dir | `~/.pix/workspaces/<id>/` |
| Session history | `.pix\state\sessions\` (imported archive) | `~/.pix/sessions/<workspaceId>/` |
| Run records | — | `~/.pix/runs/<runId>/` (plan, agent dir, result) |
| Runner | — | `~/.pix/runners/<version>-<digest>/` |

GC removes unreferenced runtimes/installs only; workspaces, sessions and uncollected runs are never auto-deleted.

## Security

- **`/mnt` guard**: a Pi extension composed into every run blocks writes to Windows drives, asks before reads, and fails closed in non-interactive mode. Disable per launch with `--no-mnt-guard` only; config files cannot disable it. Customize via `pix init-guard`.
- **Sandbox**: the body is read-only inside the image; only the projected workspace and the per-run agent dir are mounted; no host HOME, docker.sock, or Windows management channel. Image identity is verified by labels (`pix.body-revision`, lock & recipe digests) — a pre-existing tag is never accepted as proof of version.
- The guard is an application-level policy hook, not a hard boundary; use `--sandbox` for mount-level isolation.

## Development

```powershell
npm test    # node:test suite (66+ tests, zero dependencies)
```

Design & delivery docs: [docs/pi-body-workspace-architecture.md](docs/pi-body-workspace-architecture.md) · [docs/pi-body-workspace-agent-blueprint.md](docs/pi-body-workspace-agent-blueprint.md) · [docs/dev-docs/pi-body-workspace-delivery.md](docs/dev-docs/pi-body-workspace-delivery.md)

## License

MIT
