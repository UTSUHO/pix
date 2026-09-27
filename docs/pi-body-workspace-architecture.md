# Pix 架构修改方案：Windows 本体维护 + 双投影执行

状态：提议，供编码智能体实施；不是已完成的代码修改。
基线：用户提供的 `@reiutsuho/pix` v0.3.0 架构文档。
日期：2026-09-27。
配套任务：[Agent Blueprint](../agent-blueprint/pi-body-workspace-agent-blueprint.md)。

## 0. 任务边界与证据范围

本次只解决一个核心问题：**Pi 本体及其插件在 Windows 统一维护；WSL / Docker 运行的是由 Windows 管理的执行副本，不再成为另一套维护环境。**

同时保留现有 NTFS → WSL Linux 文件系统的工作区投影，避免为了统一维护而重新引入高频跨文件系统读写。

依据分为三类：

- **现状**：来自附带的原始架构文档 [S0]，不是源码审计结果。
- **已确定需求**：来自本次讨论，包括 Windows 本体维护、`pix update` 更新 Windows 的 Pi 与插件、本体和工作区分别投影、运行时就近读写。
- **新增设计**：本文件规定的目录、协议、事务、任务及验收条件，均为待实现方案。

原文的子命令列表没有列出 `update`，不能据此认定当前代码没有该命令，也不能确定用户遇到的升级失败发生在哪一步。实施时必须先检查入口、参数解析、命令透传及当前更新逻辑。

本次不要求重写 Pi、不开发 VS Code 插件、不做常驻管理服务、不建设通用远程调度平台、不自动接管系统里所有裸 `pi` 安装。保持 Pix 现有 CommonJS 与优先零新增运行时依赖的组织方式。

## 1. 固定架构决策

| 编号 | 决策 |
|---|---|
| D01 | Windows 是唯一维护端，且保存实际可验证的 Pi 主安装，不是仅保存一份配置、把真实版本管理留给 Linux。 |
| D02 | 分开管理本体投影和工作区投影；二者不能共用一个无差别目录同步任务。 |
| D03 | `pix update` 默认更新 Windows 受管 Pi 核心及受管插件，尊重显式固定版本策略；不默认更新 Pix 自身。 |
| D04 | `deploy / ensureRuntime` 只落实已确定的版本，不在 Linux 自行追踪 latest、移动分支或独立升级插件。 |
| D05 | WSL / Docker 的程序、依赖、运行配置、工作区和活跃状态均就近存储；正常任务读写不经过 Windows 管理端逐文件转发。 |
| D06 | 完成本体发布后生成不可原地更新的版本目录；更新期间旧任务继续持有旧版本，新任务选取新版本。 |
| D07 | 会话、日志、认证变化、工作区修改不是可随意删除的安装缓存。 |
| D08 | 本体和插件的发布方向是 Windows → 执行端；禁止把执行副本中的程序修改自动写回主安装。 |
| D09 | 先解析命令，再决定是否进入 WSL；管理命令不能因为全局自举而自动落到 Linux。 |
| D10 | 目标版本准备失败时明确失败，不静默使用旧版本、Windows 挂载目录或较弱隔离环境。 |

### 1.1 术语

**Pi 本体（body）**：Pi 程序包、受管插件的确定版本/源快照、依赖锁、必要程序资源。程序安装与用户偏好应分开保存。

**Profile**：Windows 维护的 settings/models、提示词、技能、主题等可编辑用户资源。它们参与运行环境组合，但修改一项设置不应触发重新安装整个 Pi。

**执行副本（runtime）**：根据 body 版本和目标平台生成的安装产物。Windows 安装产物、WSL 安装产物、容器镜像可以不同；版本决策必须相同。

**工作区（workspace）**：代理实际处理的项目代码及其运行副本。项目源文件与代理工作区按单独的同步政策交换变更。

**运行状态（run state）**：会话、认证刷新、日志、临时配置和未回收输出。其生命周期独立于 body 缓存。

## 2. 当前架构的修改点

以下“当前”仅表示 [S0] 的记载。

| 当前行为 | 修改后行为 | 主要影响模块 |
|---|---|---|
| `bin/pix.js` 先 `reinvokeInWsl()`，之后才解析命令 | 先识别命令；Windows 管理命令在宿主执行，run 才转入后端 | `bin/pix.js`、`cli/parse-args.js` |
| 用户配置在 WSL `~/.pixrc.json` 读取 | Windows 用户配置为权威来源；WSL Runner 消费已解析计划 | `config/load-config.js`、`cli/commands/run.js` |
| Direct 使用 PATH 中的 `pi` | 显式使用受管目标 Node 与当前执行副本中的 Pi 入口 | `executors/direct-executor.js` |
| 镜像自行全局安装 Pi | 镜像按 Windows 发布清单构建，固定版本和依赖输入 | `docker/Dockerfile`、`docker/image.js` |
| Direct 和 Sandbox 共享整个 `agentDir` | 共享版本声明；本体只读复用，运行态按任务分开 | `runtime/`、两个 executor |
| 工作区已有 ext4 投影与 Mutagen | 保留，并与本体发布解耦；不因更新本体清空工作区 | `workspace/` |
| `migrate` 主要从 Windows 迁向 WSL | 新增显式向 Windows 维护端归并；旧数据备份保留 | `migrate-runtime.js`、`commands/migrate.js` |
| `install-shell-env` 把裸 Pi 指向共享运行时 | 迁移后不再指向不可变 body 或临时 run 目录 | `commands/install-shell-env.js` |

用户之前遇到的 `pix update` 问题，优先修正**命令归属**，而不是通过共享 Windows 安装目录“修复”。

## 3. 目标结构

```text
Windows
  pix CLI / Host Manager
    ├── 配置合并、权限决策
    ├── Pi 主安装、插件源和版本锁
    ├── update / install / remove
    ├── 发布版本、项目与会话索引
    └── 生成执行计划
             │
             ├── 本体发布：仅首次 / 版本改变 / 显式修复时
             ├── Profile 发布：仅资源变化时
             └── 工作区准备或增量同步
                         │
                         ▼
WSL 的 Linux 文件系统
  受管 Runner
    ├── body 执行副本：程序和 Linux 依赖
    ├── Profile 快照
    ├── workspace 执行副本
    └── run state / sessions
             │
             ├── direct：Linux Node + 受管 Pi
             └── sandbox：匹配清单的 Docker 镜像 + Linux 工作区
```

Windows 只参与管理、发布、同步与结果归档。Pi 的常规 `read/edit/write/bash` 不通过 Host Manager 实现文件系统代理。

这里的“本地投影”必须是实际落在目标文件系统中的文件，不能是指向 `/mnt/c`、`/mnt/d` 的符号链接，也不能在容器里改名为 `/workspace` 就声称已经本地化。[S1][S2]

## 4. 存储布局与所有权

以下路径为建议布局；实现可在不改变职责的前提下合并目录。默认 `PIX_HOME=%USERPROFILE%\.pix`。

### 4.1 Windows

```text
%USERPROFILE%\.pix\
  config.json                    # Windows 用户级 Pix 配置
  host.json                      # hostId、模式和 schemaVersion
  profile\
    settings.json
    models.json
    prompts\
    skills\
    themes\
    extensions\                  # Windows 维护的本地扩展源码
  body\
    spec.json                    # 用户意图：包源、更新策略、pin 等
    current.json                 # 唯一活动版本指针
    releases\<bodyRevision>\
      manifest.json              # 确定版本、完整依赖锁引用、资源摘要
      package.json
      package-lock.json
      windows\                   # 实际 Windows 主安装产物
      resources\                 # 发布时封存的本地扩展等程序资源
    staging\<transactionId>\     # 尚未发布的候选版本
  credentials\                   # 不属于 body，不参与内容摘要
  state\
    projects\                    # 项目身份与后端路径映射
    sessions\                    # 已回收会话和索引
    runs\                        # 运行记录、结果回收记录
  locks\
  backups\
```

建议将主安装收归 Pix 的 Windows 受管目录，以支持完整候选版本验证与切换；不要在未明确要求时改写用户另一套 npm 全局 Pi。

迁移时读取既有 Windows Pi 安装和 `~/.pi/agent`，导入受管布局。若提供裸 `pi` 的受管 shim，应作为显式选项，不能自动修改 PATH、覆盖已有 shim 或重写无关 npm 全局目录。

### 4.2 WSL

```text
~/.pix/
  host-link.json                 # 受管 Windows owner 的绑定信息
  runners/<pixVersion>-<digest>/ # 同一 Pix 包发布的 Runner；不单独 npm -g 更新
  installs/<installId>/           # 可跨资源版本复用的本地依赖安装
  runtimes/<runtimeId>/
    manifest.json
    ready.json
    install/                     # 指向受管 Linux 安装或包含其本地物化产物
    resources/                   # 本地封存资源
  profiles/<profileRevision>/    # 配置、提示词、技能等本地快照
  workspaces/<workspaceId>/      # 持久化执行副本
  sessions/<workspaceId>/        # 活跃/待回收会话
  runs/<runId>/
    plan.json
    agent/                       # 本次运行的 PI_CODING_AGENT_DIR
    output/
    result.json
  locks/
```

`runtimeId` 不包含工作区 ID；一个相同本体运行多个项目时可以复用安装。

`workspaceId` 不包含本体版本；更新 Pi 时不得删除、重建或重新编号项目工作区。

**所有权规则**：Windows 主安装和 Profile 可由用户/Host Manager 维护；执行副本的程序区由部署流程管理；Pi 只能按运行权限写本次状态和工作区。WSL 同用户运行的只读标记不是对恶意进程的强安全边界。

## 5. 命令路由与对外语义

下表含新命令/选项提案。实施前审计现有命令，不得悄悄覆盖已有含义。

| 命令 | 权威执行位置 | 语义 |
|---|---|---|
| `pix update` | Windows | 更新受管 Pi 核心和插件，生成 Windows 新发布版本；默认不启动 WSL 或 Docker |
| `pix update --pi-only` | Windows | 仅调整 Pi 核心，仍生成一致的新发布版本 |
| `pix update --plugins-only` | Windows | 仅更新受管插件；尊重 pin 和本地源码 |
| `pix deploy --target wsl` | Windows 编排、WSL 准备 | 部署当前已发布版本，不选新版本 |
| `pix deploy --target docker` | Windows 编排、Docker 构建 | 构建/准备对应容器产物，不升级包 |
| `pix run` / 原默认启动 | Windows 编排 | 读取当前发布版本 → 确保副本 → 准备工作区 → 启动 |
| `pix status` | Windows 汇总 | 分开显示主版本、后端副本版本、pending/stale 状态 |
| `pix doctor` | Windows 编排 | 检查目标工具、路径、版本差异和未回收状态 |
| `pix migrate --to-host --dry-run` | Windows | 只生成导入/冲突报告 |
| `pix migrate --to-host --apply` | Windows | 应用已经明确的导入策略，先备份再写入 |

可提供 `pix update --deploy=wsl` 作为组合命令，但必须把 update 和 deploy 的阶段结果分别报告。默认 `pix update` 在 WSL 未安装、未启动或损坏时仍能完成 Windows 更新。

`@reiutsuho/pix` 自身升级是单独职责。本次不默认把它混入 `pix update`；若现有实现已经包含自更新，保留兼容入口并显式标注目标，不允许只有 Pix 更新而 Pi/插件未更新却报告整体成功。

### 5.1 Pi 上游命令不能不经核实地透传

查询日的 Pi 官方 CLI 文档区分：`pi update` 更新 Pi，`pi update --extensions` 更新包，`pi update --all` 更新两者。[S6]

这不是用户已安装版本的保证。P0 必须针对实际 Pi 版本检查 `--help` 和包布局。Pix 的 update 必须落实其自身的“Windows 主安装 + 插件”契约，不能仅 `spawn('pi', ['update'])` 就认为全部完成。

对于受管目录，不得直接调用会写入非受管全局安装位置的 Pi 自更新逻辑。默认使用 npm/Git 等**受控适配器**在候选目录准备版本；只有验证上游命令的目标目录、包范围与原子性符合要求后才可复用它。

### 5.2 从 WSL 发起 `pix update`

受管 WSL shim 通过绑定的 `hostId`、Windows Node 和 Pix 入口，将管理请求交回 Windows。转发路径是受管配置，不从项目 `.pix.json` 读取。

- 仅允许明确的 Pix 管理命令及经过校验的参数；不接受任意宿主 shell 字符串。
- Windows 侧仍重新解析和校验命令，不能把 Runner 提供的计划当成宿主写入授权。
- 设循环检测标志，并检查宿主模式，避免 Windows → WSL → Windows 无限自举。
- 绑定缺失、interop 不可用或宿主不可达时返回 `HOST_UNAVAILABLE`；不得回退到 WSL 全局升级。
- `host-link.json` 是路由元数据，不是密码或强认证机制；WSL 同用户权限边界不能靠这个文件保证。

Sandbox 中不提供宿主更新代理，不挂载 Windows 管理入口；容器不能借 `pix update` 回到 Windows 改主安装。

## 6. Windows 更新与版本发布

### 6.1 分开保存意图和解析结果

`body/spec.json` 保存用户维护的包源和策略，例如 npm 范围、固定版本、Git 来源、本地扩展路径。`manifest.json` 保存**实际确定的结果**。

manifest 至少包括：

```text
schemaVersion
bodyRevision
pi: packageName, exactVersion, packageIntegrity, nodeRequirement
plugins[]:
  id, sourceKind, sourceLocator,
  resolvedVersion | resolvedCommit | sourceDigest,
  updatePolicy, resourceEntrypoints
lock: relativePath, digest, packageManager, packageManagerVersion, installFlags
resources: relativePath, contentDigest
createdBy: pixVersion
```

`sourceLocator` 不得包含认证 token。manifest 不包含 auth、API key、会话、日志、工作区和临时路径。

`bodyRevision` 对 Pi/插件解析结果、完整锁摘要、程序资源摘要及必要发布配方进行稳定序列化后计算；排除 `bodyRevision` 自身、生成时间、绝对安装路径与审计备注，避免循环摘要和每次发布无意义失效。

npm 包解析为精确版本及完整依赖锁；Git 标签/分支解析为提交 ID；本地扩展封存源文件并计算内容摘要。仅锁顶层 Pi 和插件版本，不足以声称传递依赖已经可重建。

### 6.2 更新事务

```text
取得 Windows body 更新锁
  → 读取当前版本及 spec
  → 解析 Pi 与插件目标版本
  → 准备 staging 目录及依赖锁
  → 在 Windows 候选目录安装、验证实际版本与资源清单
  → 计算 bodyRevision、写完整 manifest
  → 发布不可变 releases/<bodyRevision>
  → 最后切换 current.json
  → 释放锁、报告各组件结果
```

任何组件失败，默认不激活部分完成的候选版本。原 current 保持不变。候选目录可保留诊断信息，但不是活动安装。

更新流程在受管 staging 目录运行，不读取当前项目的 `.npmrc`、`.pi` 或执行项目脚本；registry、包源、环境变量及脚本策略来自用户级批准，不能由当前仓库劫持。

使用同一卷内的临时文件/版本目录和受控指针替换；处理 Windows 文件被占用、权限失败、进程崩溃等情况。禁止“先删除旧 current 再创建新 current”。活动指针是唯一提交点，spec 或审计记录的中间变化不得让 run 看到半成品。

锁实现可使用 Node 内置文件系统原语；不得仅根据固定超时删除仍被活跃进程持有的锁。并发更新需串行；并发 run 可以继续读取已发布版本。

### 6.3 插件更新规则

受管插件按来源更新：npm 按策略解析；Git 按原跟踪策略解析新提交；明确 pin 的包保持 pin 并报告 skipped；本地源码只封存新快照，不擅自 `git pull` 或覆盖用户修改。

插件无法在目标平台工作时，默认部署失败并点名插件。不能偷偷少加载一个插件还报告环境一致。未来可增加用户授权的禁用策略，但实际集合必须进入目标产物记录。

Windows 中修改本地扩展后，下次运行可以发布新的**资源快照**，无需重新下载未变化的 Pi 和 npm 依赖。设置/提示词变化只改变 `profileRevision`，不改变依赖安装键。

### 6.4 发布结果不等于所有后端已经更新

默认 update 只提交 Windows 发布版本。`status` 通过比较目标 revision 计算副本是否过期，不要求 update 必须连接 WSL 去改一个 stale 文件。

```text
Windows main:  R2 ready
WSL runtime:   R1 ready; R2 pending
Docker image:  R1 ready; R2 pending
```

不得在上述状态显示“所有环境已更新”。

## 7. 本体投影：受管部署，不是整目录镜像

### 7.1 目标平台标识

每个目标的产物键至少包含：

```text
runtimeId = sha256(canonicalSerialize({
  bodyRevision,
  os, arch, libc,
  nodeVersion, nodeAbi,
  packageManagerVersion,
  dependencyLockDigest,
  installFlagsDigest,
  environmentFingerprint,
  runnerProtocolVersion
}))
```

Docker 的 `environmentFingerprint` 必须包括基础镜像 digest 和构建配方摘要；WSL 包括已验证的发行版/系统依赖环境标识。不能认为“都是 Linux”就能无条件共用含原生依赖的安装目录。

序列化必须稳定；不要把当前时间、runId、工作区路径放入 key。

另设 `installId`：只包含依赖图/锁、影响构建的程序源码、目标平台、Node、包管理器和安装选项；不包含无关 Profile 或非依赖型资源。单改本地扩展资源时 runtimeId 可以变化，但可继续引用同一 Linux 本地 `installs/<installId>`。受管安装的链接不得指向 Windows；涉及本地原生构建源码变化时必须更新 installId。GC 对这类引用也要计数。

### 7.2 部署流程

```text
读取 Windows 指定的 manifest
  → 探测目标 Node / 系统环境
  → 计算 runtimeId
  → ready 命中：复用，不安装、不复制整个本体
  → 未命中：建立本地 staging
  → 传入锁文件、封存资源和必要包输入
  → 在目标平台按锁准备依赖
  → 验证 Pi 版本、插件集合、依赖与资源摘要
  → 写 ready 并提交完整执行副本
```

禁止把 Windows 整个 `node_modules`、`.cmd`、`.ps1` 或原生二进制直接当作 Linux 产物。npm 支持 OS/CPU/libc 条件以及不同平台命令入口；目标平台安装需要适配。[S3]

支持冻结安装的依赖布局应使用类似 `npm ci` 的方式；它要求已有一致的 lock，不能被当成“自动解决缺失锁”的工具。[S4] 生成 lock 与冻结安装必须使用兼容 npm 版本和同样的影响依赖形态的选项。

**跨平台锁特别要求**：验证锁是否包含 Linux 需要的 optional/platform 依赖。锁不完整时，目标端不得自行重新解析 latest 或改写锁；返回宿主发布流程修复。允许平台条件选择安装集合，但所有选择必须可追溯到宿主批准的冻结输入。

首次准备未知平台需要新锁输入时，由 Host Manager 管理并记录这一流程。它不是第二套 Linux 维护端。`pix run` 的 ready 命中路径不做依赖解析。

### 7.3 Node 与安装脚本

Pix 的 Node 运行要求和 Pi 本体的 Node 运行要求分别检查；不要因为现有 Pix 文档写 Node >=18，就用 Node 18 启动任何新版 Pi。查询日的 Pi README 要求 Node 22.19+，具体应以所选包的 engines 和实测为准。[S5]

不自动升级用户系统 Node。目标不满足时给出具体需求和配置位置。包安装优先禁用生命周期脚本；确实需要原生构建的插件按用户级安装策略批准后执行。项目配置无权允许在 Windows 宿主运行额外安装脚本。

### 7.4 缓存验证与清理

ready 命中只读小型 manifest/ready 元数据和必要环境信息；不要每次遍历全部 node_modules。完整摘要校验放在部署完成或显式 `doctor --verify`。

readiness 只能在完整安装验证后写入。中断的 staging 永远不算 ready。

GC 只删除没有运行引用的安装缓存；保留当前版本及至少一个可回退版本。GC 不删除工作区、会话、认证变化或待回收 run。只读权限和摘要不是面对同权限恶意 WSL 进程的完整防篡改机制。

## 8. Runner、执行计划与进程启动

### 8.1 Runner 发布

从当前 Pix 发布包部署一个精简 Runner 到 WSL 本地目录。可新增内部入口 `bin/pix-runner.js`，但不要要求用户在 WSL 再安装一套独立维护的 Pix npm 全局包。

首次复制允许短暂访问 Windows 包文件；之后 Runner 应从 Linux 文件系统加载。同步复制必要 CommonJS 源码、模板和配方，并用包版本/内容摘要复用。

`PIX_PACKAGE_ROOT` 在目标端必须指向已部署的本地 Runner 包根，不继续指向 Windows 的 `/mnt/...` 安装目录。

### 8.2 计划契约

可用 JSDoc 描述，避免为本次重构全面迁移 TypeScript：

```js
/**
 * @typedef {Object} ExecutionPlan
 * @property {number} schemaVersion
 * @property {string} hostId
 * @property {string} runId
 * @property {'direct'|'sandbox'} backend
 * @property {'tty'|'pipe'} transport
 * @property {string} bodyRevision
 * @property {string} runtimeId
 * @property {string} profileRevision
 * @property {{id:string, sourceRoot:string, executionRoot:string}} workspace
 * @property {{directory:string, file:(string|null)}} session
 * @property {string[]} piArgs
 * @property {Object} approvedPolicy
 */
```

计划是经过 Host Manager 合并配置和校验后的结果。Runner 不再加载 WSL `~/.pixrc.json`，也不重新合并另一套宿主级配置。

计划不能包含任意可执行宿主 shell、未经授权的挂载或明文凭据。`sourceRoot` 供受信同步器映射使用，不意味着 Pi 得到 Windows 源目录访问权限。

### 8.3 传输与参数

优先 `spawn(executable, argv)`。WSL 用 `wsl.exe -d <distro> --exec <absoluteLinuxNode> <runner> ...` 等参数化入口；避免把项目路径和用户输入拼入 `bash -lic`。

必须处理空格、中文、引号、UNC、前导短横线与 `--`。Windows `.cmd` 包装需集中在平台适配层，不散落手工拼接命令。

先单独完成 prepare/计划传输，再启动 Pi。计划写入 WSL 本地受管文件；不要占用用户的 prompt stdin 来传控制数据。

需要映射的参数只处理已知路径型参数，如 `--session`、`--session-dir`、`-e`、`@file`，以及项目配置里的资源路径；不能对用户自然语言提示词做全局字符串路径替换。未知外部路径无法投影时明确报错或按已批准规则加入输入，不能默默读取宿主。

### 8.4 Direct 与协议输出

Direct 显式启动目标 Node 和受管 Pi 包中解析出的 CLI 入口，不使用 PATH 中任意 `pi`。CLI 入口从所选包的 metadata 得出，不硬编码未经核实的上游内部目录。

TTY 模式保持交互终端行为。pipe 模式保持 stdin/stdout/stderr 独立；Pix 的同步日志只写 stderr，stdout 留给 Pi 输出。Pi 官方 JSON/RPC 模式也要求 stdout 为协议记录。[S6]

进程封装应传递退出状态、Ctrl+C 与取消信号，控制子进程树。finally 中清理失败不能覆盖原 Pi 错误，也不能在子进程仍运行时删除其目录。

## 9. Profile 和运行状态的组合

每次运行生成本地 `runs/<runId>/agent`，作为 `PI_CODING_AGENT_DIR`。该变量是 Pi 官方支持的配置目录覆写方式。[S7]

Profile 中的逻辑资源/插件引用由 renderer 转成目标可访问的确定路径。不得把带有未固定远程包引用的原始 settings 直接复制过去，导致 Pi 启动时又自行下载另一组插件。

本体的依赖目录保留原有包结构，使扩展模块解析正确。加载方式以实际 Pi 版本支持的资源参数/配置为准，P0/P2 做兼容测试；避免把本地插件复制成孤立文件而丢失其依赖。

MVP 用复制小型配置/资源清单加目标本地链接或明确路径引用完成组合，不建设通用 overlay 文件系统。容器路径另外渲染；所有链接最终必须指向允许的 Linux 本地资源。

### 9.1 设置变化

运行中 `/settings` 等产生的变化保留为 run 的变更提案，不自动覆盖 Windows Profile。需要持久化时显式应用，并检查创建快照以来 Windows 配置是否变化。项目资源仍按 Pi 自身的 trust 机制及 Pix 策略处理；项目插件不自动升级成全局受管插件。

### 9.2 会话

使用稳定 workspaceId 与显式 session 目录/文件建立映射，不能把 Docker 固定的 `/workspace` 当作所有项目的唯一身份。使用所锁版本确实支持的参数；不强行升级 Pi 只为使用新接口。

MVP 对同一 workspace/session 采用单写者租约；跨后端恢复先停止旧进程、完成记录，再由新后端继续。恢复不意味着迁移后台 shell 进程、端口或内存状态。

退出后回收会话或保留可恢复引用；无法回收时 run 标记为 `uncollected`。不能因为已经记录 sessionId 就删除实际会话文件。

### 9.3 认证

认证数据单独管理，不进入 body、依赖锁、计划日志或缓存摘要。只向当前运行提供必要凭据。

OAuth refresh 等认证更新不能当作普通目录同步。MVP 对会修改同一认证记录的任务串行化；回收时用源版本检查、防冲突和显式批准流程处理。未批准或冲突的更新保留在权限受限的 run 状态中，并提示可能需要重新认证，不宣称无缝恢复已经实现。

只读挂载不能防止进程读取并泄露凭据。Sandbox 中配置与 auth 的写回规则和本体禁止写回规则必须分别实施。

## 10. 工作区投影：保留优化，收紧失效处理

继续使用 `workspace/projection.js`、`mutagen.js`、`sync.js`，保留 NTFS → Linux 本地副本和持久化缓存。

给编排层返回结构化结果，至少包括：

```text
workspaceId
sourceRoot
executionRoot
storageType
syncMode
hasPendingChanges
cleanupHandle
```

### 10.1 与本体更新彻底解耦

Pi R1 → R2 不改变 workspaceId，不重置 node_modules/build 缓存，不结束其他工作区的同步任务。工作区的依赖是项目自己的，不等同于 Pi/插件依赖。

继续排除 `node_modules`、`.pnpm-store`；其他排除项根据项目显式配置，不能粗暴排除所有 build 输出而丢弃用户希望回收的产物。

已有工作副本含未回收修改时，禁止用 `rsync --delete` 重新播种覆盖。`cp` 只能复制，不能假装提供删除对齐、冲突识别或事务式镜像功能。

### 10.2 两种明确写回政策

**日常实时模式**：保留同步引擎，新增配置默认选择冲突安全模式；旧显式冲突获胜配置保留兼容警告，不偷偷改变用户已选语义。是否改默认应写进迁移说明，不声称 v0.3.0 已经如此。

**审查回收模式**：运行期间不自动写回 Windows，退出时基于基线检查变更。没有实现安全自动回收时，最低可用行为是保留副本和差异报告，让用户显式回收；不得降级为无条件反向覆盖。

对任意文件：基线为 B、Windows 当前为 W、执行端为 A。仅 A 改变时可纳入批准写回；W 和 A 都改变且不相同时报告冲突。删除、重命名、文件/目录变更和大小写冲突必须同样检查。

本次不要求实现通用三方文本合并器；冲突显式保留即可。回收必须保护源根边界、符号链接/junction 和路径穿越。检查到不支持的链接、大小写冲突或不稳定源变化时停止自动写回；不能宣称对并发恶意路径替换的强安全性已经保证。

`.git` 对仓库分析有用途，不能简单删除后破坏 Git 工作流。可在播种时建立隔离工作副本所需元数据，但严禁盲目把执行端 `.git` 覆盖回 Windows；Git 历史/提交迁移应独立处理。最低版本仅回收工作树差异并保留执行端 Git 信息。

### 10.3 降级不越过用户边界

同步工具不可用时可以降到仍保持本地工作副本和已选写回安全性的实现；不得自动原路径直跑，更不能把审查回收变为自动覆盖。

新架构默认投影失败即失败。若保留已有“原路径执行”能力，必须由用户显式选择，并显示性能/权限影响；不得对本体副本采用这种回退。

## 11. Docker 后端

镜像按 Windows 发布的精确 Pi/插件版本和冻结依赖构建；不要继续在一个固定镜像标签里执行未固定版本的全局安装，然后只检查镜像存在。

优先把本体安装在匹配镜像的平台内部，镜像标签/label 包含 bodyRevision、依赖锁与配方摘要，运行记录记录实际 image ID/digest。不要直接把 WSL 的含原生模块 node_modules 复用到不同发行版/不同 Node ABI 的容器。

建议容器可见内容：

```text
/opt/pix/body       镜像中的确定版本程序与插件，正常运行不可写
/workspace         WSL Linux 本地工作副本，按任务批准为 rw/ro
/run/pix-agent     本次运行配置和状态目录，按需可写
```

禁止挂载 Windows 主安装、全局 Profile、整个宿主 HOME、Docker socket 或能够回调 Windows 任意命令的管理通道。必要额外挂载必须来自宿主用户级批准，不能由项目配置直接扩大。

采用非特权用户并处理 UID/GID 与工作区权限；程序目录需对运行用户不可写，或只读根文件系统配合必要 writable mounts。不能仅因为文件在镜像里就认为它不可修改。

TTY 分支使用与交互相符的终端参数；pipe 分支不分配 `-t`，按需保留 `-i`。不要让 RPC/JSON 协议通过伪终端串流。

Docker 不可用、镜像不匹配、构建失败时明确返回部署/执行失败；不能自动从 sandbox 切到 direct。这里是容器和挂载配置的边界，不等同独立高强度虚拟机隔离。

## 12. 配置、路径与权限

Windows 配置合并继续保持已支持的优先级概念：CLI > 项目 > 用户 > 默认，但安全约束由用户级策略决定。现有 WSL `~/.pixrc.json` 迁移后不再作为活跃权威来源。

项目配置只能请求权限或收紧范围，不能扩大 envAllowlist、宿主挂载、host network、privileged、额外 Docker 参数、安装脚本策略、Windows 管理入口或 PIX_HOME。原文中 envAllowlist 并集行为必须作为具体审计项修正，不能仅过滤 `security.*` 就认为权限都被保护。

本体、Profile、工作区和会话路径分别映射。WSL 路径必须检查真实落点和文件系统，而不仅用字符串是否以 `/mnt` 开头判断；覆盖符号链接绕回 NTFS 等情况。跨 Windows 路径标识按根目录身份和真实语义处理，不粗暴对全部路径小写化。

保留现有 UTF-16LE BOM 的 WSL 发行版列表解析、路径转换与 `/mnt` 守卫功能。守卫安装到 run 的配置/扩展集合，不再每次修改不可变本体目录；`--no-mnt-guard` 等现有显式行为需回归测试。

## 13. 文件级实施映射

新增文件名是建议，可按实际代码合并；禁止仅为模式分层创建空壳类。

| 文件/模块 | 动作 |
|---|---|
| `bin/pix.js` | parse-first；Windows host 路由；去掉无条件全部子命令 WSL 自举 |
| `bin/pix-runner.js`（新） | 仅处理目标环境的部署/执行计划，不能当成第二个用户管理 CLI |
| `src/cli/parse-args.js` | 识别 update/deploy/migrate 新语义，保护 `--` 和 Pi 参数兼容 |
| `src/cli/commands/update.js`（新增或重构） | 只编排 Windows 更新事务，不能调用 run 的自动自举路径 |
| `src/cli/commands/deploy.js`（新） | 显式部署当前发布版本 |
| `src/cli/commands/run.js` | Host 编排：current → ensureRuntime → workspace → plan → execute → collect |
| `src/host/resolve-home.js`（新） | Windows owner、主安装与 Profile 解析 |
| `src/host/update-body.js`（新） | 包适配器、候选构建、锁、发布及 current 切换 |
| `src/runtime/manifest.js`（新） | schema、稳定摘要、锁与目标键 |
| `src/runtime/projection.js`（新） | 本体部署、ready 命中、staging 提交；与 workspace/projection 分开 |
| `src/runtime/compose-agent.js`（新） | Profile 渲染、插件路径、run-local agentDir、状态处理 |
| `src/runtime/resolve-runtime.js` | 返回结构化 RuntimeDescriptor，而非仅 agentDir |
| `src/platform/wsl.js` | 分离探测、部署 Runner、执行 Runner、WSL→Windows 管理请求 |
| `src/platform/paths.js` | 真实存储落点、源/目标映射、链接与边界检查 |
| `src/config/*` | Windows 用户级配置；移除后端独立权威读取；强化特权键约束 |
| `src/executors/direct-executor.js` | 显式 Node + 受管 Pi 入口，不用全局 PATH pi |
| `src/executors/sandbox-executor.js` | 分开本体/工作区/run state，pipe/tty 参数分支 |
| `src/docker/image.js`、`docker/Dockerfile` | 使用发布清单和冻结依赖，校验实际镜像身份 |
| `src/workspace/*` | 保留投影/同步；结果结构化；未回收保护和安全降级 |
| `src/runtime/install-guard.js` | 只改本次运行扩展集合，不污染封存版本 |
| `src/process/spawn.js` | argv、pipe/tty、stderr 日志、取消与退出状态 |
| `commands/status.js`、`doctor.js` | Windows current / 目标 ready / 主体版本 / Node / pending runs 分开展示 |
| `commands/migrate.js`、迁移模块 | 显式 to-host 导入、备份、冲突报告及兼容提示 |
| `commands/install-shell-env.js` | 不再把裸 pi 指向共享或临时运行目录；保留受管块边界 |
| `package.json` | 核对发布白名单包含 Runner、新源码与资源；不顺手全量改技术栈 |

## 14. 内部接口

优先简单函数和可注入依赖，便于不启动真实 WSL 的单元测试。

```text
resolveHostContext(args, env) → HostContext
updateHostBody(host, options, deps) → UpdateResult
readPublishedBody(host) → BodyManifest
ensureRunner(host, target, deps) → RunnerDescriptor
ensureRuntime(manifest, target, deps) → RuntimeDescriptor
prepareWorkspace(context, options, deps) → WorkspaceDescriptor
composeRunAgent(profile, runtime, run, deps) → AgentDescriptor
buildExecutionPlan(...) → ExecutionPlan
executePlan(plan, deps) → ExecutionResult
collectRunState(run, result, deps) → CollectionResult
```

`RuntimeDescriptor` 至少返回 `runtimeId/bodyRevision/nodeExecutable/piEntrypoint/resourcesRoot/storageType`。

`UpdateResult` 分别记录 Pi、每个插件、Windows 发布结果；不把 skipped、failed、pending 合并成 success。

`ExecutionResult` 同时保存 Pi 退出状态、信号和基础设施错误。`CollectionResult` 保存已回收/待回收/冲突，不以“finally 执行过”代表数据已安全写回。

## 15. 迁移方案

迁移分为 inspect → backup → import → validate → activate。先输出报告，之后才允许写入。

采集 Windows 现有 Pi 路径、Windows `.pi/agent`、WSL `.pix/runtime/agent`、两端用户配置、项目配置、未回收工作副本、Mutagen 会话和 shell 受管块。

Windows 与 WSL 同名设置不同，不能按最后修改时间或笼统“Windows 优先”自动覆盖。逐类列出冲突，保留两侧原值及来源；无冲突数据可导入，有冲突保持未激活直到策略明确。

迁移会话按内容/身份去重并保留原 cwd 元数据。认证单独处理，不打印内容。Linux 原生依赖、node_modules、全局 bin、trust 信息不复制为 Windows 程序安装；从批准来源重建。

旧 Windows → WSL migrate 不能在没有说明时变成反向操作。新增显式 `--to-host`，旧入口给出兼容提示或保留 legacy 分支，禁止隐式删除旧运行时。

shell rc 只修改既有 Pix 标记块，先备份；不创建指向不可变安装或已结束 run 的环境变量。旧数据至少在用户确认新工作流和回收完整后才能清理。

## 16. 失败处理

| 错误标识 | 行为 |
|---|---|
| `HOST_UNAVAILABLE` | WSL 管理请求无法到 Windows；停止，不本地升级 |
| `UPDATE_FAILED` | 当前 Windows 发布版本不变，保留候选诊断 |
| `RUNTIME_DEPLOY_FAILED` | 新版本不启动，不隐式用旧版本或 NTFS 目录 |
| `RUNTIME_VERSION_MISMATCH` | 拒绝启动并报告 expected/actual |
| `WORKSPACE_CONFLICT` | 保留双方数据和基线，不覆盖冲突文件 |
| `RUN_UNCOLLECTED` | 保留会话/输出并在 status/doctor 提示 |
| `POLICY_VIOLATION` | 拒绝未经授权的 env、挂载、宿主调用或安装脚本 |
| `UNSUPPORTED_PLATFORM_PLUGIN` | 点名插件和缺失能力，停止对应目标部署 |

CLI 退出码沿用已存在的兼容约定，新增错误以稳定标识进入 JSON/记录。不猜测旧项目退出码。

## 17. 验收标准

### 17.1 核心行为

1. 在 Windows 上，禁用/移走测试环境的 WSL 和 Docker，`pix update` 仍能更新 Windows 受管 Pi 与插件；两个工具调用次数为零。
2. 更新完成后实际检查 Windows 主安装的 Pi 包版本、插件内容/版本和 manifest 一致；不能只有锁文件变化。
3. 候选插件安装失败时 current 不切换，旧 Pi 和插件仍可用。
4. 从受管 WSL shim 执行 update，请求到 Windows；WSL 内不执行独立全局升级。
5. 冷启动部署出对应 Linux 产物；直接运行记录 expected 与 actual Pi/插件一致。
6. 第二次同版本启动不运行 npm install/ci、不复制整个 body、不解析新的包版本。
7. Pi 或插件更新后只创建所需新执行副本；项目工作区和未回收数据仍在。
8. Docker 镜像的 bodyRevision/依赖输入与运行实际版本一致，不依赖固定标签存在即视为正确。
9. 运行的 Node、Pi、插件、agentDir 和 workspace 不通过链接落回 Windows 文件系统。
10. 容器内修改不会改写 Windows body/profile；旧共享 agentDir 已不作为默认可写挂载。
11. 会话、认证变化、工作区冲突在异常退出后可恢复，不被安装缓存清理。
12. 真实环境未能测试的项明确记录为 unverified，不能把 mock 通过写成 WSL/Docker 端到端通过。

### 17.2 性能测试方法

分别记录：宿主配置解析、Runner 准备、本体部署、Profile 物化、工作区准备、进程启动、运行本地文件操作、结果回收。

使用同一项目、相同排除规则、相同 Pi/Node/依赖，比较：

- WSL 直接读取 Windows 项目；
- 直接在相同 Linux 文件系统工作区运行；
- Pix 冷启动投影；
- Pix ready 命中的重复运行。

区分冷/热缓存，多次测量并报告样本数与中位数，不承诺固定倍数。运行阶段基线是第二项；部署和同步单独统计，不能从整次任务耗时中把它们隐藏。

硬性行为门槛：warm body install 次数 0、warm body 全量复制次数 0、仅改 Profile 时 body reinstall 次数 0、更新 body 时 workspace wipe 次数 0。

目标是移除常规读写的跨 Windows 文件系统依赖，不是“系统零额外开销”。同步仍有扫描、传输和资源竞争成本。[S1][S2]

## 18. 分期与非目标

按配套 Blueprint 的 P0–P7 实施，先得到 Windows update 不依赖 WSL 的小闭环，再逐步替换运行路径。中间阶段可保留明确 legacy 模式，但不能把它报告为最终一致架构。

本次不实现：进程热迁移、通用分布式锁、后台 daemon、远程多用户主控、通用文件系统 overlay、Studio bridge 集成、跨平台共享原生 node_modules、自动合并任意二进制冲突、默认升级系统 Node。

普通 Windows 原生运行可以后续作为第三个 executor，复用同一主版本；不作为本次 WSL/Docker 重构的前置条件。

## 19. 资料与来源

[S0] 用户提供的《Pix 项目架构文档》，v0.3.0。原文保存在 `../../references/pix-v0.3.0-architecture.md`。本文对“当前实现”的描述仅以该文档为依据。重点：§2 目录结构；§3.1 入口自举；§3.2 run 编排；§4 投影/同步；§5 Docker；§7 配置；§8 迁移命令。

[S1] Microsoft Learn，Working across Windows and Linux file systems。`https://learn.microsoft.com/en-us/windows/wsl/filesystems`。核查 2026-09-27；支撑本地文件系统存放与跨系统命令的注意事项。

[S2] Docker Docs，WSL 2 best practices。`https://docs.docker.com/desktop/features/wsl/best-practices/`。核查 2026-09-27；支撑 Linux 来源 bind mount 的性能约束。

[S3] npm Docs，package.json。`https://docs.npmjs.com/cli/v11/configuring-npm/package-json/`。核查 2026-09-27；支撑平台依赖和包入口不能盲目跨平台复制。

[S4] npm Docs，npm ci。`https://docs.npmjs.com/cli/v11/commands/npm-ci/`。核查 2026-09-27；支撑冻结锁安装、选项一致性和失败行为。

[S5] Pi 官方 README。`https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/README.md`。核查 2026-09-27；所选安装版本仍需重新验证 engines，不据此假定用户版本。

[S6] Pi 官方 CLI 文档。`https://pi.dev/docs/latest/cli`。核查 2026-09-27；支撑 update 的核心/扩展范围、会话参数、JSON/RPC 标准输出约定。版本相关接口以安装版本的帮助及实际行为为准。

[S7] Pi 官方环境变量文档。`https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/environment-variables.md`。核查 2026-09-27；支撑 `PI_CODING_AGENT_DIR`。
