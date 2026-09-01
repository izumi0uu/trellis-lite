# Trellis Lite

Trellis Lite 是 [Trellis](https://github.com/mindfold-ai/Trellis) 的独立精简
fork。它保留 Trellis 的任务、spec、workspace 记忆和安全更新模型，但只支持
**Codex** 与 **Oh My Pi（OMP）**，并为智能体的改动范围和验证行为设置明确
上限。

这不是 Mindfold 官方 Trellis 包。npm 包名和可执行命令都刻意分开，因此
Lite 与官方 Trellis 可以共存，不会互相覆盖。

[English](./README.md) ·
[Releases](https://github.com/izumi0uu/trellis-lite/releases) ·
[上游 Trellis](https://github.com/mindfold-ai/Trellis)

## Lite 改了什么

| 范围 | Trellis Lite 的行为 |
| --- | --- |
| 平台 | 只保留 Codex 和 OMP；其他活动平台集成均已删除。 |
| 改动范围 | 每个正式任务选择 `P0–P3`，从“只改明确要求”到“大范围重构”。 |
| 代码验证 | 前后端共用一个 `V0–V3` 证据等级；推荐聚焦验证，也可以延期。 |
| 浏览器/UI 验证 | 独立选择 `U0–U3`；`U0` 表示完全不做浏览器或 UI 验证。 |
| UI driver | `U1–U3` 默认使用 Ego Lite；若不可用，只提醒用户，不自动安装或静默换工具。 |
| E2E 工具 | 只有用户明确选择时，才运行 Playwright、Cypress、Selenium 或项目 E2E 套件。 |
| Checker | 默认关闭；report 模式只读、只运行一次，不能形成“修复—复查”循环。 |
| OMP 约束 | 原生运行时门禁执行当前 profile，并把内部熔断上限与 Agent 的证据计划分开。 |
| Codex 约束 | 项目说明、hooks 与 Codex 自身 sandbox/approval 边界共同携带 profile。 |
| 上游策略 | 以 Trellis 0.6.16 为独立基线，不承诺继续同步上游。 |

选择结果写入 `.trellis/tasks/<task>/task.json` 的 `lite` 字段。planning 任务在
记录有效 profile 之前会 fail closed，不能直接进入实现。

## Profile 与验证证据

先选择一个输入快捷方式：

- `quick`：`P0 / V0 / U0 / checker off`。
- `focused`（推荐）：`P1 / V1 / U0 / checker off`。
- `release`：`P2 / V3 / U0 / checker off`。
- `custom`：逐项选择。

preset 本身不会持久化。Trellis 只记录解析后的 P/V/U/checker/driver 与路径
字段；U 仍可独立覆盖。

`P` 控制允许改什么：

- `P0`：只实现明确要求，限制为最少必要文件。
- `P1`：允许与该改动直接相关的小范围整理或防御处理。
- `P2`：允许在声明的任务边界内进行常规跨层实现。
- `P3`：允许用户明确授权的大范围重构或架构调整。

`V` 同时选择前端和后端代码证据，不授权浏览器/UI 自动化：

- `V0`：延期代码验证。
- `V1`：针对改动行为或文件运行一个聚焦证据批次。
- `V2`：只运行预先选定的相关检查，每项一次。
- `V3`：只运行预先选定的发布就绪清单，每项一次。

`U` 是独立的浏览器/UI 选择：

- `U0`：延期浏览器、组件行为、截图与 E2E 证据。
- `U1`：用 Ego Lite 对改动路径做一次聚焦交互。
- `U2`：运行选定的用户流程及其相关边界或错误状态。
- `U3`：只运行预先选定的较广 UI 清单，每条流程一次。

即使选择 `V3 + U0`，UI 验证仍然延期；`U1–U3` 也不会自动授权
Playwright、Cypress 或 Selenium。

Agent 的唯一权威规则是
[验证合同](./.trellis/workflow.md#verification-contract)。它分别报告已交付实现、
验证证据、延期证据与发布就绪状态。每项获批检查只运行一次；任何失败后，
Agent 都先报告并等待用户新的自然语言授权，再修复或复验。OMP 无法判断命令
是否通过，因此“失败即停并询问”属于 Agent 合同。

OMP 只把数字上限当内部熔断器，未使用余量不是证据目标。熔断触发后，用户可在
OMP 输入框放行下一条匹配的验证动作：

```text
/trellis-authorize-verification code
/trellis-authorize-verification ui
```

同一时间只能挂起一次放行；消费后，用户可以再次授权。这个命令不能绕过
`V0`、`U0`、已选 UI driver 或任务已经批准的证据范围，正常的 Agent tool
loop 也不能直接调用它。

## 安装 CLI

需要 Node.js 18.17+、Python 3.9+ 与 pnpm 10。

当前标准安装方式是从 GitHub 的 v1.1.0 tag 构建并链接。安装只创建
`trellis-lite` 和 `tll`，不会覆盖机器上已有的 `trellis`：

```bash
git clone --branch v1.1.0 --depth 1 https://github.com/izumi0uu/trellis-lite.git
cd trellis-lite
./scripts/install-cli.sh

trellis-lite --version
tll --version
```

开发版本可以 clone `main` 后运行同一个安装脚本。脚本会安装依赖、构建两个
workspace，然后用全局 npm link 指向当前 checkout；它不会使用 `sudo`、不会
发布包，也不会占用 `trellis`/`tl` 命令。

只删除 Lite 的全局链接：

```bash
npm unlink --global trellis-lite
```

npm 包名已确定为 `trellis-lite` 和 `trellis-lite-core`。在 v1.1.0 尚未出现在
公共 npm registry 之前，应继续使用 GitHub 安装方式。

## 初始化项目

```bash
# Codex
trellis-lite init --codex -u your-name

# OMP
trellis-lite init --omp -u your-name

# 同时安装两者
trellis-lite init --codex --omp -u your-name
```

已有项目使用 `trellis-lite update` 刷新托管文件。tasks、specs、workspace
journals 与 session history 都属于用户数据，更新和迁移不得删除它们。更新命令
还会自动迁移已知旧 Lite profile 的活跃任务；无法识别的 profile 只警告、
不写入，旧 `checker: "on"` 会改为 `off`，避免已执行过的 checker 再跑一次。

## 接管已有 Trellis 项目

不要先删除项目里的 `.trellis/`，也不要先运行官方 `trellis uninstall`。Lite
会原地接管已有文档：

```bash
cd /path/to/project

# 完全只读的兼容性与冲突检查
trellis-lite adopt --dry-run --codex --omp

# 建立项目外备份、迁移并逐字节核对用户数据
trellis-lite adopt --codex --omp --yes
```

只需要一个集成时，仅传 `--codex` 或 `--omp`。不传平台参数时，`adopt` 使用
模板清单中已经登记的受支持平台。

公开接管边界刻意保持单一：来源版本必须是官方最后一个稳定版 Trellis
`0.6.16`。更早版本需要先通过显式的一次性迁移步骤升级；`0.7.0-beta.*`、
未知 fork 和其他版本都不会被 `adopt` 接受。已经进入 Trellis Lite 版本线的
项目使用 `trellis-lite update`，不再运行 `adopt`。

默认备份位置在项目旁边的
`.trellis-lite-backups/<project>-<timestamp>/`。也可以用 `--backup-dir` 指定
其他项目外目录。遇到不支持的版本或无法识别的本地差异时，命令会在任何写入前
停止；开始写入后若失败，则从已验证快照恢复所有托管根目录。

所有项目接管并检查完成后，可以单独卸载机器上的官方 Trellis 全局 CLI。
卸载全局 CLI 不会删除项目文档；删除 `.trellis/` 才会。

## 与官方 Trellis 共存

| 产品 | npm 包 | 命令 |
| --- | --- | --- |
| Trellis Lite | `trellis-lite` | `trellis-lite`、`tll` |
| 官方 Trellis | `@mindfoldhq/trellis` | `trellis`、`tl` |

Lite 项目不要误用 `trellis update`。Lite CLI 的帮助、更新提醒和后续命令都会
显示完整的 `trellis-lite ...`。

## 支持边界

| 能力 | Codex | OMP |
| --- | --- | --- |
| 项目集成 | `.codex/` | `.omp/` |
| 共享 skills | `.agents/skills/` | `.agents/skills/` |
| 上下文注入 | Python hooks | 原生 TypeScript extension |
| 会话记忆 | `~/.codex/sessions/` | OMP 位于 `~/.pi/agent/sessions/` 的兼容存储 |
| Channel worker 进程 | Codex | 暂不提供 |

`.pi` 是 OMP 当前采用的底层会话存储格式，不表示 Lite 支持独立 Pi Agent。

仓库仍保留历史 migration manifests 和少量 uninstall scrubbers，以便上游
Trellis 创建的项目能安全清理旧平台托管文件。它们只是兼容性数据，不属于
活动平台支持。

## 开发与发行校验

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm build
pnpm test
node packages/cli/scripts/release-preflight.js verify-packed-cli
```

## 协议与来源

Trellis Lite 基于
[mindfold-ai/Trellis](https://github.com/mindfold-ai/Trellis)，保留原始 Git 历史和
版权信息，继续使用 [AGPL-3.0](./LICENSE)。
