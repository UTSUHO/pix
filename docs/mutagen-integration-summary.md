# Mutagen 集成实现总结

## 目标

在 pix 中集成 Mutagen，使 Windows 项目文件能实时看到 pi 在 WSL 内部产生的更改，同时保持 WSL ext4 上的高效文件 I/O。

## 实现状态

已实现核心功能，处于本地验证阶段。

## 设计概述

- **默认启用 Mutagen 连续同步**：当项目目录位于 Windows NTFS（`/mnt/...`）时，pix 默认尝试使用 Mutagen 在 WSL ext4 副本与 Windows 源目录之间建立连续双向同步。
- **WSL 副本作为权威端（Alpha）**：同步模式默认为 `two-way-resolved`，WSL 副本（Alpha）在冲突中胜出，确保 pi 的更改不会被 Windows 侧的并发编辑覆盖。
- **rsync/cp 作为保底**：当 Mutagen 未安装、创建会话失败或初始同步超时时，自动回退到原有的 `rsync`/`cp` 投影模式。
- **Mutagen 作为外部依赖**：用户需自行在 WSL 环境中安装 Mutagen（`mutagen` 命令需在 WSL PATH 中）。不再自动下载二进制。

## 新增与修改的文件

### 新增文件

- `src/workspace/mutagen.js`
  - 检测 WSL PATH 中的 `mutagen` 命令
  - 创建/恢复/暂停/终止 Mutagen 会话
  - 按 `pix-<hash>` 命名会话，保证跨次运行稳定
  - 轮询同步状态到 `Watching`
  - 将 `workspace.exclude` 映射为 Mutagen ignore 规则

- `src/workspace/sync.js`
  - 高层同步编排器
  - 根据配置在 Mutagen 连续同步与 `rsync`/`cp` 投影之间选择
  - 在启动前对 WSL 副本做初始种子复制
  - 在退出时按 `keepAlive` 策略清理会话

### 修改文件

- `src/config/defaults.js`
  - `workspace.sync.enabled` 默认 `true`
  - `workspace.sync.strategy` 默认 `'mutagen'`
  - `workspace.sync.keepAlive` 默认 `'terminate'`
  - `workspace.sync.mode` 默认 `'two-way-resolved'`

- `src/config/schema.js`
  - 新增 `workspace.sync.*` 配置校验

- `src/cli/parse-args.js`
  - 新增 CLI 标志：`--sync`、`--no-sync`、`--sync-strategy`、`--sync-keep-alive`、`--sync-mode`

- `src/cli/commands/run.js`
  - 使用 `sync.prepareWorkspace()` / `sync.cleanupWorkspace()` 替换原有投影/回写逻辑

- `src/cli/commands/status.js`
  - 显示 Mutagen 可用性、版本、当前工作区会话状态

- `src/cli/commands/doctor.js`
  - 检查 Mutagen 是否可用
  - 检测陈旧的 `pix-* 会话

- `bin/pix.js`
  - 更新帮助文本，加入同步相关选项

## 配置示例

```json
{
  "workspace": {
    "projection": true,
    "mirrorBack": true,
    "exclude": ["node_modules", ".pnpm-store"],
    "sync": {
      "enabled": true,
      "strategy": "mutagen",
      "keepAlive": "terminate",
      "mode": "two-way-resolved",
      "exclude": []
    }
  }
}
```

## CLI 用法

```bash
# 默认使用 Mutagen 同步
pix

# 强制使用传统 rsync/cp 投影
pix --no-sync

# 指定同步后会话生命周期
pix --sync-keep-alive pause

# 指定同步模式
pix --sync-mode two-way-safe
```

## 验证结果

| 测试项 | 结果 | 备注 |
|--------|------|------|
| `node bin/pix.js --help` | 通过 | 帮助文本包含同步选项 |
| `node bin/pix.js status` | 通过 | 正确显示 Mutagen 可用性、版本、会话状态 |
| `node bin/pix.js doctor` | 通过 | 正确检查 Mutagen 和陈旧会话；Docker mount 问题为环境原有 |
| `node bin/pix.js --dry-run` | 通过 | 输出 Mutagen create / run pi / terminate 流程 |
| `node bin/pix.js --dry-run --no-sync` | 通过 | 输出 rsync 投影 + mirrorBack 流程 |
| 手动创建 Mutagen 会话 | 通过 | `mutagen sync create` 成功，状态为 `Watching for changes` |
| 手动终止 Mutagen 会话 | 通过 | `mutagen sync terminate` 成功 |

## 已知问题

1. **Docker mount 测试失败**：在测试环境中 `Docker can mount runtime: no`，这是环境配置问题，与 Mutagen 集成无关。
2. **未做端到端实时同步测试**：尚未在 pi 实际运行期间验证 Windows ↔ WSL 文件双向实时同步。

## 下一步

1. 运行一次真实的 `pix --direct`（或 `--sandbox`），在 pi 运行期间测试 Windows 侧能否实时看到 WSL 副本中的文件变更。
2. 更新 README，添加 Mutagen 安装说明和同步配置说明。
3. 考虑为 Mutagen 相关函数添加单元测试（项目当前无测试框架）。
