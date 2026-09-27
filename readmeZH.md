# @reiutsuho/pix

[`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 的 Windows 启动器。Windows 是唯一的维护端——受管 Pi 本体、插件、Profile 和认证都维护在 Windows 上；WSL2 和 Docker 只负责把已发布的版本物化为确定版本的执行副本。

[English README](README.md)

## 工作方式（v0.4）

```text
Windows 宿主 (%USERPROFILE%\.pix)             ← 唯一维护端
  body/releases/<rev>/   不可变 Pi 发布版本（manifest + 依赖锁）
  profile/               settings、models、prompts、skills、themes
  credentials/           认证
        │  pix run / pix deploy（宿主编排）
        ▼
WSL ~/.pix/                                   ← 执行后端
  installs|runtimes/     按冻结锁在 Linux 内安装的本体
  workspaces/<id>/       工作区投影（rsync 播种 + mutagen 同步）
  sessions|runs/         会话历史与每次运行的 agent 目录
        ├── direct:  Linux Node + 受管 Pi 入口
        └── sandbox: 按同一发布清单构建的 Docker 镜像
```

- `pix update` **只在 Windows 上执行**，发布不可变版本（spec → resolve → staging → validate → release → 原子切换 current）。WSL/Docker 永远不自行决定版本。
- 热启动**零重装、零全量复制**（内容键命中 ready 即复用）。
- 本体、Profile、工作区、会话状态生命周期互相独立：升级 Pi 不会清空工作区。
- v0.3 旧管线保留为 `pix --legacy`（仅 direct 模式）。

## 环境要求

- Windows 10/11 + WSL2（发行版内需安装 Node.js）
- Docker Desktop 并启用 WSL 集成（仅 sandbox 模式需要）
- WSL 内安装 [Mutagen](https://mutagen.io/)（可选；缺失时降级为 rsync/cp 投影）

## 快速开始

```powershell
npm install -g @reiutsuho/pix
pix update            # 在 Windows 上发布 Pi 版本
pix migrate --to-host --apply --include-auth   # 一次性：导入已有 pi 数据
cd D:\your\project
pix                   # WSL 内直接运行
pix --sandbox         # Docker 沙箱运行
```

> **v0.4 破坏性变更**：`pix update` 以前是透传给 `pi update`（实际更新的是 WSL 全局 pi 或一次性容器层）。现在它只更新 Windows 主安装和受管插件。

## 命令

| 命令 | 执行位置 | 说明 |
|------|---------|------|
| `pix` | 宿主编排 | 用当前发布版本启动 pi |
| `pix update [--pi-only\|--plugins-only] [--dry-run]` | 仅 Windows | 更新受管 Pi + 插件并发布版本 |
| `pix deploy --target wsl\|docker\|local` | 宿主编排 | 把当前发布版本登台到后端 |
| `pix status` | Windows | 宿主版本 vs 后端副本、pending/未回收状态 |
| `pix doctor` | Windows | 环境诊断与恢复指引 |
| `pix migrate --to-host [--apply] [--include-auth]` | Windows | 导入旧版 Windows/WSL pi 数据（默认 dry-run） |
| `pix install-shell-env` / `init-guard` | 本地 | shell 受管块 / 守卫模板脚手架 |
| `pix --legacy ...` | WSL | 显式 v0.3 兼容管线 |

`--` 之后的参数原样透传给 pi。`PIX_DEBUG=1` 显示 runner 阶段日志和 npm 输出；`PIX_PERF=1` 输出分阶段耗时。

常用选项：`--direct` / `--sandbox`、`--distro <名称>`、`--writeback realtime|review`、`--sync-mode two-way-safe|two-way-resolved|...`、`--no-mnt-guard`、`--rebuild`、`--dry-run`。

## 配置

优先级：CLI 参数 > 项目 `.pix.json` > 宿主配置 > 默认值。

- 宿主配置（权威）：`%USERPROFILE%\.pix\config.json`（旧的 `~/.pixrc.json` 仍作为兼容回退读取）
- 项目配置：项目目录下的 `.pix.json`——只能**收窄**权限，不能设置 `security.*`、额外 Docker 参数、自定义 Dockerfile，也不能扩大环境变量白名单或容器网络。

```jsonc
// %USERPROFILE%\.pix\config.json
{
  "wsl": { "distro": "Ubuntu-22.04" },
  "execution": "direct",                    // 或 "sandbox"
  "workspace": {
    "projection": true,
    "writeback": "realtime",                // 或 "review"（只出差异报告，不自动覆盖）
    "sync": { "enabled": true, "mode": "two-way-safe", "keepAlive": "terminate" }
  },
  "container": { "network": "bridge", "workspaceAccess": "read-write" },
  "envAllowlist": ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]
}
```

`body/spec.json`（由 `pix update` 维护）声明 Pi 包源/版本策略与受管插件（npm / pin / 本地源码）。

## 数据存放位置

| 数据 | Windows 宿主 | WSL 后端 |
|------|-------------|----------|
| Pi 发布版本 | `.pix\body\releases\<rev>\` | `~/.pix/releases/`、`~/.pix/installs/`、`~/.pix/runtimes/` |
| Profile / 认证 | `.pix\profile\`、`.pix\credentials\` | `~/.pix/profiles/`、`~/.pix/credentials/` |
| 工作区副本 | 你的项目目录 | `~/.pix/workspaces/<id>/` |
| 会话历史 | `.pix\state\sessions\`（导入归档） | `~/.pix/sessions/<workspaceId>/` |
| 运行记录 | — | `~/.pix/runs/<runId>/`（plan、agent 目录、result） |
| Runner | — | `~/.pix/runners/<版本>-<摘要>/` |

GC 只清理无引用的 runtime/install 缓存；工作区、会话和未回收的运行永远不会被自动删除。

## 安全

- **`/mnt` 守卫**：每次运行组合的 Pi 扩展，阻断对 Windows 盘的写操作、读操作先询问、非交互模式直接拒绝（fail-closed）。只能在启动时用 `--no-mnt-guard` 显式关闭；配置文件无法禁用它。用 `pix init-guard` 自定义策略模板。
- **沙箱**：镜像内本体只读；只挂载投影后的工作区和本次运行的 agent 目录；不挂载宿主 HOME、docker.sock 或 Windows 管理通道。镜像身份用 label 校验（`pix.body-revision`、锁与配方摘要）——已存在的同名 tag 不被当作版本正确的证据。
- 守卫是应用层策略钩子而非硬边界；需要挂载级隔离请用 `--sandbox`。

## 开发

```powershell
npm test    # node:test 测试套件（66+ 测试，零依赖）
```

设计与交付文档：[docs/pi-body-workspace-architecture.md](docs/pi-body-workspace-architecture.md) · [docs/pi-body-workspace-agent-blueprint.md](docs/pi-body-workspace-agent-blueprint.md) · [docs/dev-docs/pi-body-workspace-delivery.md](docs/dev-docs/pi-body-workspace-delivery.md)

## License

MIT
