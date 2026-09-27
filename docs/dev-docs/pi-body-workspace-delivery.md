# P0–P7 交付报告：Pix Windows 主控与双投影重构

日期：2026-09-27。基线：`@reiutsuho/pix` v0.3.0。
前置设计：[pi-body-workspace-architecture.md](../pi-body-workspace-architecture.md) ·
任务单：[pi-body-workspace-agent-blueprint.md](../pi-body-workspace-agent-blueprint.md) ·
P0 审计：[pi-body-workspace-refactor-audit.md](pi-body-workspace-refactor-audit.md)。

## 实现摘要

| 阶段 | 状态 | 说明 |
|---|---|---|
| P0 基线审计 + 回归测试 | ✅ 完成 | 审计文档 + 测试套件锁定现状行为 |
| P1 命令归属 + HostContext | ✅ 完成 | parse-first 路由；Windows 管理命令不再自举进 WSL；WSL shim 经 host-link 转发；循环保护 |
| P2 Windows 发布事务 | ✅ 完成 | spec → resolve → staging → validate → release → current；锁/回滚/pin/本地快照 |
| P3 Runner + 本体投影 | ✅ 完成 | 内容寻址 Runner 部署；ensureRuntime ready 复用；runtimeId/installId 分离 |
| P4 Profile/工作区/状态解耦 | ✅ 完成 | profileRevision 快照、run 级 agentDir、会话租约、认证分离、审查回收模式、防重播种 |
| P5 Docker 同一发布清单 | ✅ 完成（构建/运行未经真实 Docker 验证） | 清单化镜像、label 身份校验、挂载边界、tty/pipe 分支 |
| P6 迁移与诊断 | ✅ 完成 | migrate --to-host（dry-run 默认）、status/doctor 分开展示、GC 保护 |
| P7 集成、性能与交付 | ✅ 完成 | 本地目标端到端测试；perf 埋点；本报告 |

## 修改文件

### 新增

| 文件 | 职责 |
|---|---|
| `bin/pix-runner.js` | 目标端内部执行器（init/exec 两命令，消费 ExecutionPlan） |
| `src/host/resolve-home.js` | HostContext：PIX_HOME、hostId、发布目录布局 |
| `src/host/update-body.js` | Windows 发布事务（spec/resolve/staging/validate/release/current） |
| `src/host/adapters.js` | npm/git/local 包源适配器（execFile 可注入；Windows npm-cli.js 解析） |
| `src/host/locks.js` | mkdir 原子锁 + 持有者活性检测（不死等、不误删活锁） |
| `src/host/semver.js` | 最小 semver ranges（engines.node 门禁） |
| `src/host/bridge.js` | WSL→Windows 管理命令转发（白名单 argv 重建、PIX_BRIDGE 循环保护、HOST_UNAVAILABLE） |
| `src/host/orchestrate.js` | 宿主编排：Runner/Release/Profile/凭据登台 + 计划下发执行 |
| `src/runner/deploy.js` | 内容寻址 Runner 发布（warm 零复制） |
| `src/runner/plan.js` | ExecutionPlan 构建与校验（禁止 shell 字段） |
| `src/runtime/manifest.js` | 稳定序列化、bodyRevision/runtimeId/installId、manifest 校验 |
| `src/runtime/projection.js` | ensureRuntime：ready 命中零安装；staging 安装；锁完整性检查；NTFS 回绕拒绝 |
| `src/runtime/compose-agent.js` | run 级 agentDir 组合、Profile 快照、会话单写者租约、回收/未回收记录 |
| `src/runtime/gc.js` | 缓存 GC（引用计数、回滚保留、未回收保护） |
| `src/platform/target.js` | 目标抽象（local/wsl），argv 化 `wsl.exe --exec` 启动 |
| `src/perf.js` | PIX_PERF=1 分阶段计时与计数 |
| `src/cli/commands/update.js` / `deploy.js` / `run-legacy.js` | 新命令与显式旧管线 |
| `docker/entrypoint.js` | 从包 bin metadata 解析入口的容器入口 |
| `tests/`（16 个文件） | 63 个测试 |

### 重构

| 文件 | 变化 |
|---|---|
| `bin/pix.js` | parse-first 路由；WSL shim 管理命令转发；不再无条件自举 |
| `src/cli/parse-args.js` | update/deploy/--to-host/--apply/--writeback/--allow-raw-workspace/--legacy；`--` 后全部透传 |
| `src/cli/commands/run.js` | 改为宿主编排（current → stage → plan → runner）；`--legacy` 走旧管线 |
| `src/cli/commands/status.js` / `doctor.js` | host current / 目标 ready / pending / uncollected 分开展示 |
| `src/cli/commands/migrate.js` | 新增 --to-host（inspect→backup→import→validate→activate，冲突保双边）；旧行为保留为 legacy |
| `src/cli/commands/install-shell-env.js` | 不再导出 PI_CODING_AGENT_DIR；只改 pix 受管块 |
| `src/config/merge-config.js` | **安全修复**：envAllowlist 由"项目并集"改为"项目只能收窄"；项目禁设 security/extraRunOptions/dockerfile/host 网络 |
| `src/config/defaults.js` / `schema.js` | sync.mode 默认改 two-way-safe（two-way-resolved 保留+警告）；新增 writeback 校验 |
| `src/executors/direct-executor.js` | 绝对 Node + 受管 Pi 入口（来自包 bin metadata），不再 PATH 解析 |
| `src/executors/sandbox-executor.js` | 挂载三分（镜像内 body ro / workspace / run agent）；tty/pipe 分支；镜像身份校验；Docker 失败不退 direct |
| `src/docker/image.js` + `docker/Dockerfile` | 清单化构建（lock + vendor + labels），镜像标签含 bodyRevision，inspect 校验 label |
| `src/process/spawn.js` | argv-only、信号转发、stdin 输入支持、infra 错误与退出码区分 |
| `src/workspace/sync.js` / `projection.js` | 结构化 WorkspaceDescriptor；健康会话恢复不重播种；未回收副本拒绝覆盖；review 写回产出差异报告；投影失败不再静默回退原路径 |
| `src/platform/wsl.js` | 导出 decodeWslOutput（UTF-16LE 处理保留） |

## CLI 行为

- **新增**：`pix update [--pi-only|--plugins-only|--dry-run]`、`pix deploy --target wsl|docker|local`、`pix migrate --to-host [--apply] [--include-auth]`。
- **语义变化（显式）**：`pix update` 不再是 pi 参数透传（旧行为实际更新 WSL 全局 pi 或一次性容器层）。现在只更新 Windows 主安装与受管插件。
- **兼容**：无参 `pix`、`--direct/--sandbox`、`--sync-*`、`--no-mnt-guard`、`migrate`（无 --to-host）、`init-guard` 保持旧语义；`pix --legacy` 走 v0.3 管线（仅 direct）。
- **WSL shim**：绑定存在时管理命令与 run 转发到 Windows（argv 白名单重建，无 shell 拼接）；未绑定时管理命令 `HOST_UNAVAILABLE` 失败关闭；run 提示 `--legacy`。

## 测试

命令：`npm test`（Node 内置 test runner，零依赖）。

- **平台**：Windows 11 宿主（Node 24）实测 **63 pass / 0 fail**；其中 `runtime-symlink-ntfs` 在 win32 跳过（WSL-only 场景）。
- **mock 层**：npm/git/WSL/Docker 全部由注入适配器模拟；update 事务、锁、路由、计划校验、配置权限为纯单元测试。
- **真实进程层**：`tests/e2e-local.test.js` 用 vendored tarball + 真实 `npm pack / install --package-lock-only / ci`（全部离线 `file:` 源）+ 真实 pix-runner 子进程 + 真实假 pi 子进程跑通 update→deploy→run→collect→warm 全链路。

### 蓝图命名测试对照

route-windows-update / route-wsl-update / route-no-host / route-argv ✅（routing.test.js）；
update-real-host-artifact / update-without-backends / update-partial-failure / update-concurrent / update-crash-points / update-pins-local / update-node-mismatch / update-project-isolation ✅（update-body.test.js）；
runtime-cold / runtime-warm / runtime-version-change / runtime-resource-only / runtime-lock-incomplete / runtime-path-shadowing / runtime-interrupted / runtime-symlink-ntfs ✅（runtime-projection.test.js，后者 WSL-only）；
profile-only-change / session-mapping / session-lock / auth-not-in-body / profile-writeback ✅（compose-agent.test.js）；
workspace-double-change / workspace-uncollected / workspace-no-raw-fallback ✅（workspace-sync.test.js）；
docker-mount-boundary / docker-rpc-clean(tty/pipe 分支) ✅（sandbox-args.test.js，argv 级）；
migration-dry-run / migration-conflict / migration-repeat ✅（migrate-tohost.test.js）；
shell-block ✅；gc-protection ✅；status-pending 逻辑含于 status.js（未单独自动化）。

## 迁移

- `pix migrate --to-host` 默认 dry-run：inspect → 报告，零写入；`--apply` 时 backups/ 留档后导入。
- 冲突（Windows/WSL 同名不同值）双边保留并逐项列出，不按 mtime 猜赢家。
- 认证仅在 `--include-auth` 时导入，永不打印内容；会话按内容哈希去重。
- 旧 `pix migrate`（Windows→WSL）原样保留并提示新入口；旧 WSL 运行时不自动删除。
- shell rc：仅改 `# >>> pix >>>` 受管块，移除旧的 PI_CODING_AGENT_DIR 导出，其余字节不动。

## 性能

- 埋点：`PIX_PERF=1` 时分阶段计时（ensureRuntime / prepareWorkspace / composeAgent / execute / collectWorkspace）写入 stderr 与 `runs/<runId>/perf.json`。
- 硬性门槛（由测试断言，非目测）：warm body reinstall=0、warm body fullCopy=0（ready.json 命中即返回）、Profile-only reinstall=0（installId 不含资源）、body-update workspace-wipe=0（workspaceId 与 body 解耦）。
- e2e 实测（Windows 11，本地目标）：冷启动含真实 npm ci ≈1.5s（开发机，样本 1，不作性能承诺）。
- 未做：WSL 直读 Windows 目录 vs 投影的对照基准（需要真实 WSL 环境，列为未验证项）。

## 限制（未验证/未实现）

1. **未经真实 WSL/Docker 端到端验证**：wsl.exe 目标传输（tar 流式登台）、Docker 镜像构建与容器运行均为 mock/argv 级验证。Dockerfile 的 `npm ci` 构建路径未在真实 Docker Desktop 构建过。
2. **Git 源插件**：解析到 commit 已实现，打包进冻结安装未实现——遇到 git 插件会明确 `UPDATE_FAILED`（不静默丢插件）。
3. **Pi 上游接口**：`pi update` 范围、`--session` 等参数以所装版本的 `--help` 为准；沙箱入口从包 bin metadata 解析，不硬编码，但未对真实 pi 包的 dist 布局做过验证。
4. **认证并发**：MVP 只对同 workspace 会话做单写者租约；OAuth refresh 的跨任务冲突保留在 run 状态中，需人工批准回收，未实现自动合并。
5. **legacy sandbox 未保留**：旧的固定标签镜像管线无法保证版本一致，`--legacy` 只支持 direct。
6. **性能对照基准**未在真实 WSL 上测量（上述硬门槛已由测试锁定）。
7. **普通 Windows 原生执行**（第三 executor）按方案属后续工作，本次未实现。
