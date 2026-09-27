# Pix 项目架构文档

> 版本：`@reiutsuho/pix` v0.3.0
> 定位：Windows 上的 Pi CLI 启动器（`pi-coding-agent` 的 WSL2/Docker 包装器）

## 1. 项目概述

**Pix 是什么**：一个发布在 npm 上的 Node.js CLI 工具（`bin: pix`），它是 AI 编码代理 [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 的启动器/包装器。

**核心解决的问题**：用户在 Windows 上工作（代码存在 NTFS 盘如 `D:\...`），但 Pi 代理运行在 WSL2 Linux 环境中。Pix 负责打通 Windows → WSL2 → Docker 这条链路，具体包括：

1. **跨平台启动**：从 Windows PowerShell/CMD 调用时，自动通过 `wsl.exe` 在 WSL 内重新调用自身。
2. **统一运行时**：Direct（WSL 直跑）和 Sandbox（Docker 沙箱）两种模式共享同一份 Pi 运行时 `~/.pix/runtime/agent`（配置、认证、会话、扩展），避免双份环境漂移。
3. **NTFS 性能优化**：Windows 盘上的项目会被"投影"（复制/同步）到 WSL ext4 文件系统，避免 Docker bind mount 跨 NTFS 边界的性能灾难。
4. **安全防护**：默认注入 `/mnt` 守卫扩展，阻止 AI 代理意外写入 Windows 盘；Sandbox 模式提供挂载级硬隔离。

**技术栈**：纯 Node.js（CommonJS，零运行时依赖），Node >= 18。外部依赖：WSL2、Docker Desktop（沙箱模式）、rsync/cp（投影）、Mutagen（可选，实时同步）。

## 2. 目录结构

```text
pix/
├── bin/pix.js                      # CLI 入口（唯一可执行文件）
├── src/
│   ├── cli/
│   │   ├── parse-args.js           # 命令行参数解析
│   │   ├── output.js               # log/warn/fatal 输出封装
│   │   └── commands/
│   │       ├── run.js              # 默认命令：启动 pi（核心编排逻辑）
│   │       ├── status.js           # 显示配置与环境状态
│   │       ├── doctor.js           # 环境诊断（WSL/Docker/镜像/同步会话等）
│   │       ├── migrate.js          # 从 Windows .pi/agent 迁移到 WSL 运行时
│   │       ├── install-shell-env.js# 写 PI_CODING_AGENT_DIR 到 shell rc
│   │       └── init-guard.js       # 导出 /mnt 守卫模板供用户自定义
│   ├── config/
│   │   ├── defaults.js             # 默认配置 + 环境变量白名单
│   │   ├── load-config.js          # 读取 ~/.pixrc.json 与 .pix.json
│   │   ├── merge-config.js         # 深合并 + 废弃键警告 + security 键过滤
│   │   ├── schema.js               # 配置校验（execution/network/sync 等枚举）
│   │   └── migrate-config.js       # 旧配置迁移辅助
│   ├── executors/
│   │   ├── direct-executor.js      # Direct 模式：WSL 内直接 spawn pi
│   │   └── sandbox-executor.js     # Sandbox 模式：组装 docker run 命令
│   ├── workspace/
│   │   ├── projection.js           # NTFS → ext4 一次性投影（rsync/cp）
│   │   ├── mutagen.js              # Mutagen 会话封装（create/resume/pause/terminate）
│   │   └── sync.js                 # prepareWorkspace/cleanupWorkspace 策略编排
│   ├── runtime/
│   │   ├── resolve-runtime.js      # 解析运行时根目录 → agentDir
│   │   ├── install-guard.js        # 安装/刷新/移除 /mnt 守卫扩展
│   │   └── migrate-runtime.js      # Windows → WSL 运行时数据迁移
│   ├── docker/
│   │   └── image.js                # 沙箱镜像检查与构建（支持自定义 Dockerfile）
│   ├── platform/
│   │   ├── wsl.js                  # WSL 检测、distro 解析、路径转换、命令探测
│   │   └── paths.js                # 路径分类（windows/wsl/UNC）、~展开
│   └── process/
│       └── spawn.js                # spawn Promise 封装（stdio inherit）
├── docker/
│   ├── Dockerfile                  # 沙箱镜像（node:24 + pi-coding-agent）
│   └── docker-compose.yml          # 参考用途
├── assets/
│   └── extensions/
│       └── pix-mnt-guard.ts        # /mnt 守卫扩展模板（Pi extension）
└── package.json                    # 无依赖；files 白名单发布 bin/docker/src/assets
```

代码总量约 1800 行 JS + 222 行 TS 守卫模板。

## 3. 核心执行流程

### 3.1 入口与自举（`bin/pix.js`）

```text
Windows 侧调用 pix
      │  isWindows() && !isInsideWsl()
      ▼
reinvokeInWsl(): 解析默认 distro → 转换 cwd/入口路径为 WSL 路径
      │  拼接: wsl.exe -d <distro> -- bash -lic "cd <wslCwd> && exec node <wslEntry> <args>"
      ▼
WSL 内的 pix（Node 进程）
      │
      ▼
parseArgs() → 分发子命令（status/doctor/migrate/install-shell-env/init-guard）
              默认 → run.execute()
```

关键点：`PIX_PACKAGE_ROOT` 环境变量在自举时注入，使沙箱镜像构建能找到包内的 Dockerfile。

### 3.2 run 命令编排（`src/cli/commands/run.js`）

这是整个工具的核心，按顺序执行：

1. **加载配置**：`loadConfig(cwd)` → `mergeConfig()` → `applyCliOverrides()` → `validateConfig()`
   - 优先级：`CLI 参数 > .pix.json（项目） > ~/.pixrc.json（用户） > 默认值`
   - 安全例外：项目配置中的 `security.*` 键被强制删除并警告——不可信的代码仓库永远不能削弱安全策略。
2. **解析运行时**：`agentDir = <wsl.runtimeRoot>/agent`（默认 `~/.pix/runtime/agent`），若位于 NTFS 则性能警告。
3. **注入 /mnt 守卫**：默认 `installGuard()`；仅 `--no-mnt-guard` 显式移除（详见 §6）。
4. **准备工作区**：若工作区在 NTFS（`/mnt/...`）且投影开启 → `prepareWorkspace()`（详见 §4）。
5. **分发执行器**：
   - `direct`：`spawn('pi', piArgs, { cwd: workspace, env: { PI_CODING_AGENT_DIR: agentDir } })`
   - `sandbox`：`ensureImage()` 后 `docker run`（详见 §5）。
6. **清理（finally）**：`cleanupWorkspace()`——投影模式做 mirror-back，Mutagen 模式按 `keepAlive` 策略 terminate/pause/保留会话。

### 3.3 两种执行模式

| 维度 | Direct（默认） | Sandbox |
|------|---------------|---------|
| 执行方式 | WSL 内直接跑 `pi` | `docker run --rm -it` 容器内跑 `pi` |
| 工作区 | 投影后的 ext4 路径（或原路径） | bind mount 到容器 `/workspace` |
| 运行时 | `PI_CODING_AGENT_DIR=agentDir` | agentDir 以**相同绝对路径** bind mount 进容器 |
| 网络 | 宿主机网络 | 可配置 `bridge/none/host` |
| 环境变量 | 继承全部 | 仅 `envAllowlist` 白名单（`--env-all` 可全传） |
| 隔离级别 | 无（依赖 /mnt 守卫） | 挂载级硬隔离 |

**统一运行时的实现**：两种模式都设置 `PI_CODING_AGENT_DIR` 为同一路径，且沙箱模式把该路径以相同绝对路径挂载进容器——配置、auth、session、extensions 完全共享，零复制。

## 4. 工作区投影与同步

这是解决"代码在 Windows 盘、执行在 Linux"性能问题的子系统，分两级策略：

### 4.1 一次性投影（`projection.js`）

```text
/mnt/d/Documents/Github/myproject       （NTFS 源，慢）
        │  rsync -a --delete（无 rsync 则 cp -a 兜底）
        ▼
~/.pix/workspaces/myproject-a1b2c3d4       （ext4 投影，快）
        │  pi 退出后，mirrorBack=true（默认）
        ▼
反向 rsync 覆盖回 Windows 源目录
```

- 投影路径 = `projectionRoot/<basename>-<sha256(路径)[:8]>`，哈希保证同名项目不冲突。
- 默认排除 `node_modules`、`.pnpm-store`。
- mirror-back 会**覆盖**源文件，执行前有 warn 提示。

### 4.2 Mutagen 连续同步（`mutagen.js` + `sync.js`，默认策略）

```text
Windows 源 (beta)  ←── two-way-resolved ──→  WSL ext4 副本 (alpha，权威端)
```

流程：
1. 先用 rsync/cp **播种** ext4 副本；
2. 创建或恢复 Mutagen 会话（`pix-<sha256[:8]>`），等待进入 `watching` 状态（30s 超时，error/conflict 状态抛错）；
3. `pi` 在副本上运行，双向实时同步——Windows 编辑器里立刻可见代理的修改；
4. 退出时按 `sync.keepAlive` 处理：`terminate`（默认）/ `pause`（下次启动更快）/ `running`。

**降级链**：Mutagen 未安装或会话创建失败 → 自动退回 rsync/cp 一次性投影，并 warn。`--no-sync` 或 `workspace.sync.enabled: false` 可强制使用旧行为。

## 5. Docker 沙箱

### 5.1 镜像（`docker/Dockerfile` + `src/docker/image.js`）

- 基础镜像 `node:24-bookworm-slim`，安装 bash/git/ripgrep，corepack 启用 pnpm 9.15.0，全局安装 `pi-coding-agent`；多处强制 IPv4（apt/npm/DNS）。
- `ensureImage()`：镜像不存在或 `--rebuild` 时 `docker build`。
- 支持自定义 Dockerfile：`container.dockerfile` 配置或 `--dockerfile` 参数（支持 `~` 与相对路径）。

### 5.2 容器启动参数（`sandbox-executor.js`）

```text
docker run --rm -it --workdir /workspace
  --network <bridge|none|host>
  --mount type=bind,src=<workspace>,dst=/workspace[,readonly]
  --mount type=bind,src=<agentDir>,dst=<agentDir>     # 同路径挂载，运行时共享
  --env KEY=VALUE ...                                  # 白名单过滤
  <extraRunOptions>
  pix-pi-sandbox pi <piArgs...>
```

## 6. 安全机制

### 6.1 /mnt 守卫（`assets/extensions/pix-mnt-guard.ts` + `install-guard.js`）

一个注入到 `<agentDir>/extensions/` 的 Pi `tool_call` 中间件扩展，保护 Windows 盘不被 AI 代理误写：

| 工具调用 | 行为 |
|---------|------|
| 不涉及 `/mnt` | 直接放行（零干扰） |
| `write`/`edit` 写 `/mnt/...` | **硬阻断** |
| 写类 bash（`rm`、重定向到 `/mnt`、`cp/mv/rsync` 目标为 `/mnt`、`sed -i`、`dd of=`、`git config/init/clone` 等） | **硬阻断** |
| 读类操作（`read`/`ls`/`grep`/`find`/读类 bash/未知工具） | 询问用户（允许一次 / 会话内信任 / 拒绝），fail-safe |
| 非交互模式（`pi -p`、JSON 模式） | 无法询问 → **阻断**（fail-closed） |

例外：会话工作目录隐式信任（从 `/mnt` 目录启动时该目录树不询问）。

**治理模型**（这是设计上值得注意的部分）：
- **默认强制注入**，每次启动都装；配置文件（用户/项目）**永远无法禁用**它；
- 唯一关闭方式：启动时显式 `--no-mnt-guard`（会移除已装文件）；
- 模板可定制，解析优先级：`security.mntGuardSource`（仅用户配置）→ `~/.pix/extensions/pix-mnt-guard.ts`（`pix init-guard` 导出）→ 包内置模板；
- 基于内容的刷新：仅当已安装文件与模板不同时重写；通过首行 `// pix-mnt-guard vN` 标记识别"自己装的文件"，无标记的同名用户文件永不被覆盖/删除。

**明确的边界声明**：README 与代码注释都指出这是应用层策略钩子而非安全边界——混淆 shell（变量拼接、glob）可绕过字符串匹配，需要硬保证时用 `--sandbox`。

### 6.2 配置层安全

- 项目 `.pix.json` 的 `security` 键被 `mergeConfig` 强制剥离并警告——防止恶意仓库篡改守卫策略。
- 沙箱环境变量默认白名单（API key、代理等 18 个），`--env-all` 才全量转发。
- 废弃配置键（`useHostPiHome` 等 8 个）识别并警告，避免旧配置产生意外行为。

## 7. 配置系统

两级 JSON 配置 + CLI 覆盖：

| 层 | 位置 | 说明 |
|----|------|------|
| 用户配置 | `~/.pixrc.json`（WSL 内） | 全局默认 |
| 项目配置 | `<cwd>/.pix.json` | 覆盖用户配置；`security` 键被忽略 |
| CLI | `--direct` `--sync-mode` 等 | 最高优先级 |

`mergeConfig` 为深合并，但 `envAllowlist` 特殊处理为**并集**（用户 + 项目的白名单累加而非覆盖）。`schema.js` 校验枚举值（execution、network、sync 策略/模式/keepAlive）与类型。

## 8. 辅助命令

| 命令 | 实现要点 |
|------|---------|
| `pix status` | 汇总执行策略、distro、运行时路径、工作区存储类型、pi/docker 可用性与版本 |
| `pix doctor` | 诊断 WSL 可用性、Docker/WSL 集成、NTFS 路径、镜像存在性、rsync、Mutagen 版本、残留 `pix-*` 会话、版本一致性 |
| `pix migrate` | 一次性将 Windows `C:\Users\<u>\.pi\agent` 的可迁移数据（settings/models/auth/sessions/skills/prompts/themes）复制到 WSL 运行时；跳过平台相关目录（npm/git/node_modules/bin/tools/trust.json）；源路径可通过 `--source`/`--win-user` 或 powershell.exe 探测 |
| `pix install-shell-env` | 向 shell rc（bash/zsh/fish）写入 `>>> pix >>>` 守卫块导出 `PI_CODING_AGENT_DIR`，使裸 `pi` 也共享同一运行时 |
| `pix init-guard` | 把内置守卫模板复制到 `~/.pix/extensions/` 供自定义 |

## 9. 平台抽象（`platform/`）

- `wsl.js`：处理 WSL 检测（`WSL_DISTRO_NAME`/`WSL_INTEROP`）、`wsl.exe --list --verbose` 输出解析（含 **UTF-16LE BOM 解码**——wsl.exe 输出的经典坑）、Windows↔WSL 路径互转（`wslpath`）、distro 内命令探测。
- `paths.js`：路径分类（`windows` / `wsl` / `linux` / `wsl-unc`）、NTFS 判定（`/mnt/` 前缀即视为 NTFS 工作区）、`~` 展开、斜杠归一化。

## 10. 架构特点总结

1. **零依赖设计**：package.json 无任何 dependencies，全部用 Node 内置模块 + 外部 CLI（wsl/docker/rsync/mutagen/pi），安装极轻。
2. **单一权威运行时**：Direct/Sandbox/裸 pi 三条路径收敛到同一个 `PI_CODING_AGENT_DIR`，消除环境分裂。
3. **优雅降级链**：Mutagen → rsync → cp → 原路径直跑，每层失败都有 warn + fallback，不会因缺少可选组件而硬失败。
4. **安全分层且防降级**：应用层（/mnt 守卫，默认强制、项目配置不可禁用）+ 挂载层（Docker 沙箱）+ 配置层（security 键用户专属、env 白名单）。
5. **关注点清晰分层**：`platform`（OS 抽象）→ `config`（配置）→ `workspace`/`runtime`/`docker`（资源准备）→ `executors`（执行）→ `cli`（编排），run.js 是唯一知道全部流程的编排者，各模块可独立测试。

## 11. 数据流总览

```text
┌─────────────┐   wsl.exe 自举   ┌──────────────────────────────────────────┐
│ Windows pix │ ───────────────► │ WSL pix (bin/pix.js)                     │
└─────────────┘                  │   │                                      │
                                 │   ├─ config 加载/合并/校验               │
                                 │   ├─ agentDir = ~/.pix/runtime/agent     │
                                 │   ├─ installGuard → agentDir/extensions  │
                                 │   ├─ prepareWorkspace                    │
                                 │   │    NTFS? ──► rsync 播种              │
                                 │   │              ──► mutagen 双向同步     │
                                 │   │              （失败降级 rsync/cp）    │
                                 │   ▼                                      │
                                 │   direct:  spawn pi (cwd=投影目录)        │
                                 │   sandbox: docker run --mount 工作区      │
                                 │            --mount agentDir(同路径)       │
                                 │   │                                      │
                                 │   └─ cleanup: mirror-back / mutagen 会话 │
                                 └──────────────────────────────────────────┘
```
