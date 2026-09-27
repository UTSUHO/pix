# P0 基线审计报告：pi-body-workspace 重构

日期：2026-09-27。审计对象：`@reiutsuho/pix` v0.3.0 实际源码（非文档转述）。
审计方式：逐文件阅读 `bin/pix.js`、`src/**`、`docker/Dockerfile`、`assets/extensions/pix-mnt-guard.ts`。

## 1. P0 必答问题（基于源码的事实回答）

### 1.1 现有 `pix update` 是什么？

**结论：`pix update` 不是 Pix 命令。** `src/cli/parse-args.js` 的 `KNOWN_COMMANDS` 只有
`status / doctor / migrate / install-shell-env / init-guard`。`update` 落入 `piArgs`，
经 `run.js` 透传给 `pi`：

- **Direct 模式**：`spawn('pi', ['update'], {cwd: workspace})` → 更新的是 **WSL 内 PATH 上的全局 pi**（Linux 维护端）。
- **Sandbox 模式**：`docker run --rm ... pix-pi-sandbox pi update` → 更新发生在**一次性容器层**，`--rm` 后丢弃；镜像内的 pi 版本不变。等于"更新了空气"。
- **Windows 主安装**：任何路径下都不会被更新。Windows 上甚至不存在"受管 Windows 主安装"的概念。

用户遇到的"升级失败/升级不生效"与上述路由一致：upgrade 落在了错误的 OS / 错误的安装上。
本报告不声称已复现用户的具体失败，只确认路由事实。

### 1.2 是否所有子命令都在解析前 reinvokeInWsl()？

**是。** `bin/pix.js` 的 `main()` 顺序：`--help` 特判 → `isWindows() && !isInsideWsl()` →
`reinvokeInWsl(argv)` → 之后才 `parseArgs(argv)`。唯一特殊分支是 `--help/-h`。
因此 `pix status`、`pix doctor`、`pix migrate` 在 Windows 上调用时也会先整个自举进 WSL，
在 Linux 侧读 Linux 配置、诊断 Linux 环境。这正是 D09 要修的问题。

### 1.3 Windows Pi 的安装形态？

现有代码**完全没有** Windows 侧 Pi 的发现逻辑。唯一的 Windows 侧接触点是
`src/runtime/migrate-runtime.js`：把 `C:\Users\<u>\.pi\agent` 当**数据源**拷贝到 WSL。
Windows npm 全局 pi 是否存在、版本多少，代码无从得知，也不维护。

### 1.4 插件来源与锁？

无插件管理概念。`agentDir/extensions/` 下只有 pix 自己注入的 `pix-mnt-guard.ts`。
用户扩展靠 `pi` 自身机制（裸目录），无 spec、无锁、无摘要。`--include-extensions`
只在 migrate 时拷贝扩展源码。

### 1.5 Pi 版本与 Node 要求？

代码中无任何 Pi 版本检查、无 Node engines 检查。`package.json` 声明 pix 自身 `node >=18`。
沙箱镜像固定 `node:24-bookworm-slim` + 全局安装 **未固定版本** 的
`@earendil-works/pi-coding-agent`（`npm install -g` 无版本号）——镜像一旦构建，
版本凝固在构建时刻，且 `ensureImage` 只检查镜像名存在，不校验内容版本。
Direct 用 PATH 的 pi、Sandbox 用镜像的 pi，**二者版本可任意漂移**，status 里
两个版本号并排显示但不判定一致性。

### 1.6 Direct 与 Docker 实际使用哪个 Node/Pi？

- Direct：WSL 内 `hasCommand('pi')` 探测后 `spawn('pi', ...)` —— PATH 任意 pi，Node 为该 pi 的 shebang 解释器。
- Docker：镜像内全局 pi + node:24。
- 版本漂移：是，见 1.5。

### 1.7 工作区同步端点与 mirror-back 风险？

- 播种/回写都由 **WSL 侧**（pix 运行在 WSL 内）执行 `rsync -a --delete` / `cp -a`。
- `mirrorBackWorkspace()`（projection.js）在 `mirrorBack=true`（默认）时无条件
  `rsync -a --delete projected/ source/`。**风险确认**：若投影副本在运行前播种不完整、
  或用户在运行期间于 Windows 侧也改了文件，`--delete` 回写会删除 Windows 源中
  副本里不存在的文件、覆盖 Windows 侧的新修改。无基线、无冲突检测。
- Mutagen 模式失败降级为 projection 后，退出同样走 mirror-back，风险同上。
- `sync.js::prepareWorkspace` 每次都先 `projectWorkspace()`（`rsync --delete` 播种）
  再恢复/创建 Mutagen 会话——**即使存在已暂停的健康会话、副本含未同步修改，也会被重新播种覆盖**。这是"重新播种覆盖未回收修改"的实锤位置。

### 1.8 日志是否污染 stdout？`-it` 是否固定？

- `src/cli/output.js`：`log/warn/fatal` 全部写 `console.error`（stderr）。✔ stdout 干净。
- `sandbox-executor.js`：`docker run --rm -it` **固定** `-it`，无 tty/pipe 分支。
  在 pipe/RPC 场景（`pi -p`、JSON 模式）会分配伪终端，可能污染协议流。需修。
- `direct-executor.js` / `spawn.js`：`stdio: 'inherit'`，无 tty/pipe 区分（继承终端时无问题，
  管道场景也安全，因为不加 `-t`）。

## 2. 文档与源码的差异

| 架构文档（v0.3.0 整理版）描述 | 源码事实 |
|---|---|
| `pix migrate` 从 Windows 迁向 WSL | 一致（`migrate-runtime.js`），但无反向、无冲突报告、无备份 |
| envAllowlist 用户+项目**并集** | 一致（`merge-config.js` 用 Set 并集）——**这是权限扩大漏洞**：不可信项目 `.pix.json` 可往白名单里加 `AWS_SECRET_ACCESS_KEY` 等任意变量并泄进容器。§12 要求修正为项目只能收窄 |
| run.js 失败时"回退原 Windows 路径" | 一致（`prepareWorkspace` catch 后 `effectiveWorkspace = sourceWorkspace`）——静默降级到 NTFS 原路径，D10 禁止 |
| 守卫注入共享 agentDir | 一致（`install-guard.js` 写 `<agentDir>/extensions/`）——每次启动改写共享运行时目录，与"不可变本体"冲突，P4 改为注入 run 级资源集 |

## 3. 命令兼容表（现状 → 目标）

| 现状 | 目标 | 兼容策略 |
|---|---|---|
| `pix`（无参）/ `pix --direct/--sandbox` | 保留，走新 Host 编排 run | 默认行为不变，内部路径替换 |
| `pix status` / `doctor` | Windows 汇总 + 后端 pending 展示 | 输出项增加，不删减现有行 |
| `pix migrate` | 保留 legacy 分支 + 新增 `--to-host` | 无 `--to-host` 时行为同旧 |
| `pix install-shell-env` | 不再指向共享 agentDir；仅改受管块 | 块标记不变（`# >>> pix >>>`） |
| `pix init-guard` | 保留 | 不变 |
| `pix update`（现为透传） | **新的 Windows 管理命令** | 语义变化：旧行为是"透传给 pi update"。需在帮助与交付报告中显式标注此变化 |
| `pix deploy` | 新增 | 不与现有命令冲突 |

## 4. P1/P2 应替换的实际位置

1. `bin/pix.js::main()` —— reinvoke 提前到 parse 之后，仅 run 类命令进后端。
2. `src/cli/parse-args.js` —— 新增 `update`/`deploy` 命令与 `--to-host/--apply/--pi-only/--plugins-only` 等选项。
3. `src/cli/commands/run.js` —— 整体改为 Host 编排（current → ensureRunner → ensureRuntime → workspace → composeAgent → plan → execute → collect）。
4. `src/executors/direct-executor.js` —— 弃用 PATH pi，改 RuntimeDescriptor 的绝对 Node + Pi 入口。
5. `src/executors/sandbox-executor.js` —— 挂载三分（body ro / workspace / run-agent），tty/pipe 分支。
6. `src/docker/image.js` + `docker/Dockerfile` —— 清单化构建与身份校验。
7. `src/config/merge-config.js` —— envAllowlist 并集 → 项目只能收窄；特权键（network host、extraRunOptions 等）项目不可设。
8. `src/workspace/sync.js` —— 会话存在且健康时不重新播种；结构化返回。
9. `src/workspace/projection.js` —— mirror-back 不再是默认无脑 `--delete` 覆盖；review 模式产出差异报告。
10. `src/runtime/install-guard.js` —— 安装目标从共享 agentDir 改为 run 级 agentDir。

## 5. 最小回归测试基线

随本阶段交付（`tests/`），锁定以下现状行为，供后续阶段对照：

- `parse-args`：已知命令识别、`--` 后全部进 piArgs、未知参数透传、空格/中文/前导 `-` 保留。
- `merge-config`：深合并、`security` 项目键剥离、废弃键警告、envAllowlist 现状（并集）行为固化（P1 修正后更新该测试）。
- `paths`：`isNtfsWorkspace`、`classifyPath`、UNC 识别。
- `projection`：投影 ID 稳定性（同路径同 ID、同名不同路径不同 ID）。
- `routing`（P0 现状固化）：证明当前所有命令都在 parse 前自举（用 fake isWindows/isInsideWsl 注入），P1 后此测试反转为新路由断言。

无真实用户数据变更。
