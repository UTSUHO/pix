# Agent Blueprint：Pix Windows 主控与双投影重构

状态：待实施。本文是执行任务单，不是功能完成报告。
前置设计：[架构修改方案](../dev-docs/pi-body-workspace-architecture.md)。
基线：[用户提供的 v0.3.0 文档](../../references/pix-v0.3.0-architecture.md)。

## A. 给编码智能体的任务

请在当前 Pix 仓库上做增量重构，不重写 Pi、不改变项目的基本技术栈。目标是：

> Windows 维护实际 Pi 主安装、插件和用户配置；本体按确定版本部署到 WSL / Docker，工作区独立投影到 Linux 文件系统。`pix update` 更新 Windows 主安装和插件；`pix run` 才准备目标执行环境。后端副本可重建，但会话与工作区修改不可当缓存丢弃。

先读实际代码，再按 P0–P7 顺序实施。每个阶段交付可测试的增量，不以创建空接口或大批 TODO 作为阶段完成。

所有命令示例都是**目标接口**，不是声称当前已支持。上游 Pi 的包布局、参数、更新范围须与实际安装版本核对。

## B. 不可违反的约束

1. 不让 Windows `pix update` 依赖 `wsl.exe`、Docker 或 WSL 中全局 Pi；Windows 主安装必须真的被更新。
2. 不把 Windows `node_modules` 原样镜像为 Linux 安装，不在正常运行时跨 `/mnt` 加载本体与插件。
3. 不在 WSL / Docker 独立追踪最新 Pi、最新插件或移动 Git 分支；执行副本只落实宿主批准的版本。
4. 不把 body 和 workspace 塞进一个双向同步目录。body 单向发布，workspace 有独立写回政策。
5. 不为了简化状态管理，把 Windows 全局 Profile、主安装或整个 agentDir 可写挂入容器。
6. 不修改正在被任务使用的版本目录；不在更新 body 时清空工作区和会话。
7. 不忽略部署、同步、回收异常；不静默回退到旧版本、NTFS 原路径或非沙箱模式。
8. 不自动改系统 PATH、无关 npm 全局 Pi、用户 shell rc 或原有配置；迁移先报告和备份。
9. 不引入后台 daemon、VS Code 集成或新的多用户系统作为本次前置条件。
10. 不把 mock 通过写成 Windows / WSL / Docker 实测通过。

## C. 工作方式与阶段完成条件

优先复用现有 `platform/`、`config/`、`executors/`、`workspace/`、`runtime/`。新增模块必须对应真实职责，可保持简单函数和 JSDoc。新增依赖需要说明为什么 Node 内置能力和现有外部工具不足。

测试使用临时目录、fake Pi/npm/WSL/Docker 适配器。未经明确授权，不在开发过程中更新用户真实 Pi、清空真实工作区、卸载扩展、写用户 shell rc 或迁移真实认证数据。

每阶段报告：实际改动文件、行为变化、执行的测试命令和结果、真实平台覆盖范围、未完成项。记录不确定的接口并用测试解决，不能凭文档猜测函数已经存在。

建议新增 `docs/dev-docs/pi-body-workspace-refactor-audit.md` 记录 P0 实际发现。它不是要求用户额外提供信息；先从仓库解决可查问题。

## P0. 基线审计与最小回归测试

### 读取范围

`bin/pix.js`；`package.json`；`src/cli/parse-args.js`；实际命令注册；`run/status/doctor/migrate/install-shell-env`；`config/*`；`platform/wsl.js`；两个 executor；`runtime/*`；`workspace/*`；Dockerfile 与镜像构建；`process/spawn.js`。

### 必须回答

- 现有 `pix update` 是独立命令、别名、插件命令，还是 Pi 参数透传？它最终更新谁、在哪个 OS、哪个路径？
- 是否所有子命令都在解析前 `reinvokeInWsl()`？有哪些特殊分支？
- Windows Pi 是 npm 全局安装、其他包管理器安装还是本地安装？哪些安装可通过现有代码发现？
- 插件来自 npm、Git、本地扩展目录或其他方式？配置与锁在哪里？
- Pi 版本和 Node 要求是什么？所选版本的 `update`、`--session`、`--session-dir`、资源加载和 agentDir 接口是什么？
- Direct 与 Docker 实际使用哪个 Node、哪个 Pi？是否可发生版本漂移？
- 工作区同步端点真正在哪侧扫描？现有 mirror-back/fallback 会不会覆盖未回收修改？
- 日志是否可能写入 JSON/RPC stdout？`-it` 是否固定？

### 交付

实际数据流图/文字、文档与源码差异、命令兼容表，以及最小 CLI/参数/配置回归测试。不要声称“已经定位升级失败根因”，除非有具体代码路径或复现实验支持。

### 通过条件

能用测试证明当前路由行为，并确定 P1/P2 应替换的实际位置。无真实用户数据变更。

## P1. 先修命令归属与 Windows HostContext

### 实施

1. `bin/pix.js` 改为解析 Pix 命令后再分流，保留无参数默认 run 和 `--` 透传。
2. 建立 `HostContext`，解析 Windows `PIX_HOME`、hostId、Profile、主安装和发布目录。
3. Windows 管理命令不调用 WSL 自举；status 可以报告 backend unavailable，不应整体崩溃。
4. WSL 用户入口识别受管 host 绑定；管理请求转回 Windows。没有绑定时明确失败，不新建 Linux owner。
5. 内部 Runner 和用户 CLI 分离；增加转发循环保护。
6. 把旧 run 路由临时保留为明确兼容路径，不能以此宣称最终双投影已完成。

### 测试

`route-windows-update`：设置 WSL/Docker 适配器为“一旦被调用立即抛错”，管理流程仍到达 Windows updater。

`route-windows-run`：只在执行命令请求时进入后端。

`route-wsl-update`：Windows bridge 恰好调用一次；Linux npm/global pi 调用次数为 0。

`route-no-host`：返回 HOST_UNAVAILABLE，无降级升级。

`route-argv`：空格、中文、引号、前导 `-`、`--`、原有 Pi 参数保留；拒绝项目设置覆盖 owner。

### 通过条件

升级路由不再受运行后端约束。此阶段不得伪造尚未实现的升级成功结果。

## P2. Windows 主安装与插件的发布事务

### 实施

1. 新增/重构 Windows updater，区分 Pi、受管插件、Pix 自身。
2. 建立 `spec → resolve → staging → validate → release → current` 流程。
3. Windows 受管 release 中安装真实 Pi；不能只写 manifest。
4. 确定版本、完整依赖锁、插件提交或源码摘要进入 manifest。
5. 保留显式 pin；本地源码不被 update 覆盖；更新结果区分 changed/skipped/failed。
6. 使用更新锁和单一 current 提交点；支持失败保留旧版本及中断后恢复诊断。
7. 通过源适配器覆盖 P0 已发现并承诺支持的插件来源。未知来源明确失败或报告不支持，不能丢失插件。
8. 管理目录之外的 npm 全局安装不被自动覆盖；需要导入时按 P6 机制处理。
9. 默认不调用 WSL/Docker。目标副本过期由版本比较得出，不必 update 当场连接它们。

### 测试

`update-real-host-artifact`：测试主目录里实际 Pi 和插件产物是新版本，current 与 manifest 匹配。

`update-without-backends`：没有 WSL/Docker 仍成功；相关调用计数为 0。

`update-partial-failure`：第二个插件安装失败，current 保持旧值。

`update-concurrent`：两个更新串行，不能发生 current 指向不完整目录。

`update-crash-points`：分别在安装后、ready 前、切换前注入失败；旧版本可用。

`update-pins-local`：固定版本被报告 skipped；本地扩展未被外部更新覆盖。

`update-node-mismatch`：所选 Pi Node 要求不满足时明确失败，不替换用户系统 Node。

`update-project-isolation`：当前仓库放置恶意 `.npmrc`/安装脚本，宿主更新仍只使用批准的受管配置和 staging。

### 通过条件

`pix update` 完整满足 Windows 本体和插件的语义；所有后端关闭不影响该行为。Pi 上游 update 命令的范围不能靠猜测。

## P3. Runner 与本体本地投影

### 实施

1. 从同一 Pix 包发布带版本/内容摘要的 Runner 到 WSL Linux 文件系统。
2. `runtime/manifest.js` 实现稳定摘要、schema 验证和目标平台键。
3. `runtime/projection.js` 实现 ensureRuntime：ready 命中复用；miss 才本地 staging/安装/验证/提交。分开 runtimeId 与依赖 installId，非依赖型资源变化可复用本地安装。
4. 按冻结输入在 Linux 准备依赖，检测平台 optional dependencies 和 Node ABI；不复制 Windows node_modules。
5. 未完整锁定的跨平台依赖返回宿主发布流程修复，不在目标 run 中静默重新解版本。
6. Direct 执行器使用 RuntimeDescriptor 中的绝对 Node 与 Pi 入口，不从 PATH 找 pi。
7. 运行期间不再从 `/mnt/...` 加载 Pix Runner、Pi 程序或插件。
8. `PIX_PACKAGE_ROOT` 改为目标已部署的本地根。

### 测试

`runtime-cold`：首次执行完成部署，ready 最后写入。

`runtime-warm`：第二次同版本启动 body copy=0、npm install/ci=0、包版本解析=0。

`runtime-version-change`：新版本得到新目录，旧目录不变。

`runtime-resource-only`：仅非依赖型扩展资源变化，新 runtime 可复用原 installId；本地原生构建源码变化则不能复用。

`runtime-platform-key`：Node ABI/libc/目标镜像配方变化不会错误复用安装。

`runtime-lock-incomplete`：缺少平台依赖时报错，不改写锁、不追踪 latest。

`runtime-path-shadowing`：PATH 上放置伪 Pi，实际启动仍使用受管入口。

`runtime-symlink-ntfs`：本体路径绕经链接落到 Windows 文件系统时拒绝。

`runtime-interrupted`：残留 staging 不被识别为 ready。

### 通过条件

WSL Direct 在受管 Linux 副本内运行对应版本；warm 路径没有全量程序复制和重新安装。

## P4. Profile、工作区和运行状态解耦

### 实施

1. Host Manager 合并配置并创建计划；Runner 不读取独立 WSL 用户配置。
2. 分开 bodyRevision/profileRevision/workspaceId/runId；本体变化不改变项目身份。
3. `compose-agent.js` 为每个 run 准备本地 agentDir；设置/插件引用转换为确定的目标路径。
4. 守卫注入 run 的资源集合，不重写 body 版本目录。
5. 复用 workspace 投影和 Mutagen；返回明确 sourceRoot/executionRoot/待回收状态。
6. 防止重新播种覆盖未回收修改，防止本体 GC 清理项目。
7. 明确实时同步与审查回收的边界。自动回收未完成时保留副本/差异报告，不用 mirror-back 覆盖代替。
8. 建立最小稳定会话映射和单写者保护；认证变化单独保存与冲突处理。
9. 用户设置变化只更新 Profile 快照，不重装 Pi/npm 插件。

### 测试

`profile-only-change`：改设置，Profile 更新，但 npm/body install=0。

`workspace-survives-update`：Pi 升级前后的项目修改、缓存、workspaceId 保持。

`workspace-double-change`：Windows 与代理同时改同一文件，保留冲突，不覆盖。

`workspace-uncollected`：异常退出后再次运行不会清空旧副本。

`workspace-no-raw-fallback`：投影失败不自动原路径运行。

`session-mapping`：两个项目即使容器内都叫 `/workspace`，会话目录不同。

`session-lock`：同一会话不能两个后端并发写。

`auth-not-in-body`：认证变化不改变 bodyRevision，也不出现在日志/manifest。

`profile-writeback`：运行时修改不自动覆盖 Windows Profile。

### 通过条件

程序、配置、工作区、状态分别管理。错误与取消路径不会丢数据。无法无缝回收 OAuth 的限制在输出中明确体现。

## P5. Docker 采用同一发布清单

### 实施

1. Dockerfile/构建上下文接收冻结 body 输入；镜像中创建目标平台安装。
2. 镜像身份包含 bodyRevision、锁和配方；实际执行记录 image ID/digest。
3. 不再默认共享整个可写 agentDir；本体不可写，工作区/run state 独立挂载。
4. 工作区来源是 WSL Linux 本地文件系统，不是 Windows bind mount。
5. 非特权用户与 UID/GID/挂载权限匹配；禁止把容器标为“强安全”却给 privileged/docker.sock/宿主 HOME。
6. 分开 tty/pipe：RPC/JSON 不使用 `-t`，日志进入 stderr。
7. Docker 出错不退到 Direct；禁止容器暴露 Windows update bridge。

### 测试

`docker-manifest-match`：镜像与当前发布版本一致，错版本明确失败。

`docker-platform-install`：原生依赖在匹配镜像内安装，不复用不兼容 WSL node_modules。

`docker-mount-boundary`：没有 Windows 主安装/全局 Profile/整个 HOME/docker.sock 挂载。

`docker-body-readonly`：运行用户不能修改程序区；工作区能按批准权限写。

`docker-rpc-clean`：stdout 全部是 Pi 协议记录，安装/同步提示在 stderr。

`docker-no-fallback`：镜像构建失败不执行 Direct。

### 通过条件

Direct 与 Sandbox 具有共同版本来源，不再只是共用一个用户目录。Docker 路径有实际端到端覆盖，或明确标注平台测试待验证。

## P6. 迁移与诊断

### 实施

1. `migrate --to-host --dry-run` 收集原 Windows/WSL 配置、版本、资源、会话、工作副本和 shell 块信息。
2. 显式 apply 先备份；冲突保留双方，不按 mtime 猜赢家。
3. 不把 Linux node_modules/bin/trust 数据当 Windows 程序导入。
4. 旧 migrate 行为显式兼容，不静默反向；旧运行时不自动删除。
5. install-shell-env 不指向不可变 release 或已结束 run；仅修改 Pix 标记块。
6. status/doctor 分开显示 host current、每个目标 ready、Node/Pi/插件版本与 pending/uncollected。
7. 诊断工具检查真实文件系统落点、运行引用和未回收数据，提供明确恢复指引。

### 测试

`migration-dry-run`：零写入用户数据。

`migration-conflict`：Windows/WSL 不同值保留报告，没有静默覆盖。

`migration-repeat`：重复执行不创建重复会话或覆盖备份。

`shell-block`：仅预期受管块变化，其他 shell 内容字节保持。

`status-pending`：Windows R2/WSL R1 时显示 pending，不显示全同步。

`gc-protection`：活跃 body、session、workspace、未回收 run 不被清理。

### 通过条件

旧用户可看清并迁移到新模式；版本不一致和待回收状态不再被掩盖。

## P7. 集成、性能与交付

### 集成场景

| 场景 | 预期 |
|---|---|
| Windows 首次维护 | 主安装/插件/Profile 在 Windows，后端未部署可正常报告 |
| 后端不可用时 update | Windows 更新成功，目标显示 pending |
| 首次 direct | 本地部署并按同一版本启动 |
| 第二次 direct | body 无安装与全量复制 |
| 仅改 settings | 无依赖重新安装 |
| 升级插件 | 新 body/runtime；已有 workspace 与 session 不变 |
| direct → sandbox | 同版本、路径正确、会话有明确恢复规则 |
| 容器启动失败 | 不执行 Direct，不损坏工作区 |
| 运行中 Ctrl+C | 进程结束受控，状态保留，输出可恢复 |
| Windows 用户同时编辑 | 冲突显式处理，不无条件镜像覆盖 |
| WSL shell update | 转发到 Windows，不产生第二套维护环境 |
| 主版本更新中仍有任务 | 旧任务使用旧完整目录，新任务使用已提交版本 |

### 性能记录

为 prepare/ensureRuntime/composeAgent/workspace/start/collect 记录分段时长和关键操作计数。

同一仓库对照测试：WSL 读 Windows 目录、WSL 原生目录、Pix 冷启动、Pix warm。分别统计扫描、安装、构建或仓库读取、单文件同步延迟。记录版本、缓存状态、样本数、中位数及测试环境。

不要求虚构一个速度提升比例。硬门槛是：warm body reinstall=0、warm body fullCopy=0、Profile-only reinstall=0、body-update workspace-wipe=0。

### 最终交付格式

```text
实现摘要
- 哪些阶段已完成，哪些未完成

修改文件
- 路径 + 实际职责变化

CLI 行为
- update / deploy / run / migrate 的新增与兼容项

测试
- 命令、结果、测试平台
- mock 与真实平台测试分别列出

迁移
- 用户原数据如何保留
- 冲突与恢复方式

性能
- 分阶段时长、关键操作计数、测试条件

限制
- 未验证平台、未支持插件类型、认证/会话恢复限制
```

不得仅提交架构说明而宣称实现完成；不得未运行测试却说全部通过。

## D. 最小可用切片与收敛规则

优先完成 P0–P3，得到“Windows update 独立成功 + WSL 按版本部署 + warm 复用”的可验证核心。它是第一里程碑，不等同整个任务完成。

随后完成 P4–P7，才把新架构设为默认；在工作区写回保护和容器挂载尚未验证时，不用新一致性标签掩盖 legacy 行为。

没有某个平台的测试能力时，继续完成可做的实现、单元测试和验收脚本，报告具体未验证项。不要因此擅自缩减用户的 Windows 主控目标，也不要引入假实现让测试表面通过。

## E. 提交前自查

- [ ] parseArgs 在任何自动进入 WSL 的动作之前。
- [ ] `pix update` 默认覆盖 Windows Pi 与受管插件，而不是只更新 Pix 或只更新 Pi。
- [ ] 实际 Windows 主安装存在并与发布清单一致。
- [ ] WSL 与 Docker 不自行决定新的 Pi/插件版本。
- [ ] body、Profile、workspace、run state 有独立路径与生命周期。
- [ ] Direct 不依赖 PATH 中任意 pi；Docker 不只依赖一个可变镜像标签。
- [ ] 无 Windows node_modules 直接跨平台复用。
- [ ] 本体正常运行路径没有 `/mnt` 及其链接回绕。
- [ ] warm 启动不安装依赖、不全量复制本体。
- [ ] 更新 body 不清空工作区或会话。
- [ ] pipeline/stdin 与协议 stdout 未被计划或日志污染。
- [ ] 旧 agentDir、迁移和 shell rc 有明确兼容说明。
- [ ] 任何部署失败都不静默降级。
- [ ] 所有待回收修改在取消/崩溃后仍能定位与恢复。
- [ ] 真实运行验证和未验证项明确分开。
