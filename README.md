# Golden Hoop Spell for OpenCode（紧箍咒）

[![OpenCode Plugin](https://img.shields.io/badge/OpenCode-Plugin-blue)](https://opencode.ai)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue)](https://www.typescriptlang.org)
[![Bun](https://img.shields.io/badge/Runtime-Bun-black)](https://bun.sh)

> 多角色技术规划编排插件，为 [OpenCode](https://opencode.ai) 设计。本插件是 Claude Code
> 插件 [`golden-hoop-spell`](https://github.com/anthropics/golden-hoop-spell)（参考来源）的
> 纯 TypeScript 移植版——无构建步骤、无 Python 运行时依赖，由 OpenCode 作为插件直接加载。

---

## 目录

- [简介](#简介)
- [核心特性](#核心特性)
- [安装](#安装)
- [快速开始](#快速开始)
- [工作流总览](#工作流总览)
- [工具一览](#工具一览)
- [三角色计划调度器](#三角色计划调度器)
- [配置](#配置)
- [codegraph MCP（可选）](#codegraph-mcp可选)
- [架构](#架构)
- [开发](#开发)

---

## 简介

「紧箍咒」给 AI 编码助手戴上一个结构化的工作纪律约束：它把一个软件交付过程拆成
**初始化 → 规划 → 拆分 → 编码 → 查看进度 → 归档** 六个阶段，每个阶段由专门的工具驱动，
工具返回文本末尾附带 `▶ NEXT ACTION` 锚点强制主 AI 按序推进，避免跳步、越权或丢失上下文。

插件通过 OpenCode 的插件机制注册 **10 个工具** + **8 个 slash command**，并在系统提示中
注入工作流纪律提示。计划阶段采用 **三角色调度器**（上下文快照 → 设计 → 评审）经 Task tool
派发隔离 subagent 完成；编码阶段同样以隔离 subagent 逐 feature 实现，支持并行无冲突批次。

所有计划/进度/归档状态持久化在项目内的 `.ghs/` 目录，是跨会话断线恢复的唯一真相来源。

---

## 核心特性

- **完整六阶段工作流** — init → plan → sprint → code → status → archive，每步工具自带下一步指引。
- **三角色计划调度器** — context-explorer（快照）→ plan-designer（设计）→ plan-reviewer（评审），
  三个 subagent 各司其职，模型 ID 可独立配置。
- **断线检测与恢复** — 基于 `status.json` 的阶段状态机自动检测 TODO 面板是否漂移，发出建设性提醒；
  `ghs-status` 随时可查，跨会话可从 `.ghs/progress.md` 恢复。
- **逐 feature 隔离实现** — `ghs-code` 为每个 feature 派发独立 coding subagent，天然隔离上下文；
  支持无冲突并行批次。
- **用户可配置模型** — `.ghs/ghs.json` 按角色指定 context / designer / reviewer 三个模型 ID，
  `ghs-config` 渲染对应 Markdown agent 文件，重启后生效。
- **codegraph MCP 感知** — 检测到 `.codegraph/` 时走 MCP 工具提取架构快照，否则自动回退 grep 路径。
- **忠实移植** — `src/lib/scripts/` 下的每个文件均源自 Python 原版的忠实移植，
  行为由完整测试套件覆盖。
- **纯 TypeScript / 零构建** — 无编译步骤，无 Python 运行时依赖，OpenCode 直接加载 `src/index.ts`。

---

## 安装

### 方式一：`opencode plugin` 命令（最简单）

```bash
opencode plugin golden-hoop-spell-opencode --global
```

该命令把包名写入全局配置 `~/.config/opencode/opencode.json` 的 `plugin` 数组，并将包下载缓存到 `~/.cache/opencode/packages/golden-hoop-spell-opencode@latest/`（别名 `opencode plug`，重启 OpenCode 后生效）。

执行后配置文件中会自动添加插件条目：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["golden-hoop-spell-opencode"]
}
```

### 方式二：本地安装（开发 / 未发布 / 内部共享）

两种本地加载方式：

**A. 引用本地路径**（`opencode.json` 的 `plugin` 数组写路径）：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:../path/to/golden-hoop-spell-opencode"]
}
```

**B. 放进插件目录**（启动时自动加载）：把入口文件放到 `.opencode/plugins/`（项目级）或 `~/.config/opencode/plugins/`（全局）。

### 合并 codegraph MCP（可选但推荐）

将以下 `mcp` 段合并到 `opencode.json`（注意是追加而非覆盖已有 `mcp` 条目）：

```json
{
  "mcp": {
    "codegraph": {
      "type": "local",
      "command": ["codegraph", "serve", "--mcp"],
      "enabled": true
    }
  }
}
```

> 完整示例见 `shared/opencode.json.example`。安装后重启 OpenCode 会话即可看到 10 个 `ghs-*` 工具。

---

## 快速开始

在 OpenCode 会话中，按以下顺序驱动插件（每步工具返回末尾的 `▶ NEXT ACTION` 锚点会告诉你下一步）：

```
1. ghs-init           → 初始化 .ghs/ 目录结构与 subagent 文件
2. ghs-config         → 渲染 agent markdown（通常 init 已自动完成，改模型后需重跑）
3. ghs-plan-start     → 启动三角色计划调度（派发 context-explorer subagent）
4. ghs-plan-review    → 三模式循环：snapshot → plan → review（含多轮修订）
5. ghs-plan-finalize  → 评审通过后落盘计划到 .ghs/plans/
6. ghs-sprint         → 将计划拆解为原子 feature，追加到 features.json
7. ghs-code           → 逐 feature 派发 coding subagent 实现（支持并行模式）
8. ghs-status         → 随时查看进度（只读，安全）
9. ghs-archive        → 归档已完成的 sprint 到 .ghs/archived/
```

> 8 个 slash command（`/ghs-init` 等）在插件加载时自动注册。其余工具通过自然语言或直接工具调用触发。

---

## 工作流总览

```
┌──────────┐   ┌────────────┐   ┌──────────────────────────────────────┐   ┌────────────┐
│ ghs-init │──▶│ ghs-config │──▶│ 3-Role Plan Dispatcher               │──▶│ ghs-sprint │
└──────────┘   └────────────┘   │ plan-start → plan-review →           │   └─────┬──────┘
                                │ plan-finalize                        │         │
                                └──────────────────────────────────────┘         ▼
                                                                           ┌──────────┐
                                                                           │ ghs-code │ (per-feature / parallel)
                                                                           └─────┬────┘
                                                                                 │
                                                ┌────────────────────────────────┼────────────────────────┐
                                                ▼                                ▼                        ▼
                                        ┌──────────────┐                 ┌──────────────┐       ┌───────────────────┐
                                        │ ghs-status   │                 │ ghs-archive  │       │ ghs-force-archive │
                                        │ (read-only)  │                 │ (completed)  │       │ (force all)       │
                                        └──────────────┘                 └──────────────┘       └───────────────────┘
```

**阶段状态持久化在 `.ghs/` 目录**：

| 路径 | 用途 |
|------|------|
| `.ghs/features.json` | 项目元数据 + 所有 sprint 及其 feature（id / 验收标准 / 依赖 / 状态 / `files_affected`） |
| `.ghs/progress.md` | 每个会话的进度日志（最近会话在前），含明确的下一步记录 |
| `.ghs/ghs.json` | 用户配置（模型 ID + `planner_backend`） |
| `.ghs/plans/` | 已定稿的计划 markdown + 计划调度状态 `status.json` |
| `.ghs/archived/` | 归档的已完成 sprint |

---

## 工具一览

插件注册 **10 个工具**（hyphenated key，如 `ghs-init`）：

| 工具 | 阶段 | 作用 |
|------|------|------|
| `ghs-init` | 初始化 | 引导创建 `.ghs/features.json`、`.ghs/progress.md`、`.ghs/ghs.json`，复制 subagent 模板 + SKILL.md |
| `ghs-config` | 配置 | 从 `.ghs/ghs.json` 读取模型 ID，渲染 / 更新 `.opencode/agents/ghs-*.md` 三份 agent 文件 |
| `ghs-plan-start` | 规划 | 启动计划调度，探测 codegraph 可用性，派发 `ghs-context-explorer` subagent 提取架构快照 |
| `ghs-plan-review` | 规划 | 三模式核心循环：`snapshot`（解析快照→派发 designer）/ `plan`（解析设计→派发 reviewer）/ `review`（PASS→finalize / FAIL→修订） |
| `ghs-plan-finalize` | 规划 | 评审通过后将计划落盘到 `.ghs/plans/<日期>-<slug>.md`，标记 `approved` |
| `ghs-sprint` | 拆分 | 自动归档已完成 sprint，生成下一 sprint id，创建空 sprint 骨架，返回拆解 prompt |
| `ghs-code` | 编码 | 查找当前 sprint 的就绪 feature（pending + 依赖已完成），返回 feature-impl prompt 供主 AI 派发 coding subagent；支持 `parallel=true` 无冲突并行批次 |
| `ghs-status` | 查询 | 只读报告：每个 sprint 的 feature 计数、进行中 feature、下一个就绪 feature、近期 progress.md 条目 |
| `ghs-archive` | 归档 | 将状态为 `completed` 的 sprint 迁移到 `.ghs/archived/` 并从 features.json 移除 |
| `ghs-force-archive` | 归档 | ⚠️ 强制归档所有 sprint（含 in_progress / blocked），需 `ghs-archive` 先签发的 nonce 令牌确认 |

**自动注册的 slash command**：`/ghs-init`、`/ghs-config`、`/ghs-plan-start`、`/ghs-sprint`、
`/ghs-code`、`/ghs-status`、`/ghs-archive`、`/ghs-force-archive`。

---

## 三角色计划调度器

计划阶段（`ghs-plan-start` → `ghs-plan-review` → `ghs-plan-finalize`）是一个逻辑完整的
**多角色调度循环**，三个 subagent 通过 Task tool 派发，各自隔离运行：

```
ghs-plan-start
  │  探测 codegraph 可用性（.codegraph/ 存在？）
  └─▶ 派发 ghs-context-explorer subagent
        │  提取架构快照（codegraph MCP 工具 或 grep 兜底）
        └─▶ 输出 CONTEXT_SNAPSHOT 包裹的快照
              │
ghs-plan-review(snapshot=<快照>)
  │  解析快照 → 派发 ghs-plan-designer subagent
  └─▶ 输出 PLAN_START/PLAN_END 包裹的计划
        │
ghs-plan-review(plan=<计划>)
  │  解析计划 → 派发 ghs-plan-reviewer subagent
  └─▶ 输出 REVIEW_VERDICT（PASS / FAIL + 评审意见）
        │
        ├─ FAIL → 带修订意见回到 designer（多轮，受 max-rounds 限制）
        └─ PASS → ghs-plan-review(review=<评审>)
                   │
ghs-plan-finalize(plan_content=<定稿计划>)
  └─▶ 落盘到 .ghs/plans/，状态标记 approved
```

- **ghs-context-explorer** — 快速提取项目架构上下文（用 `models.context` 配置的轻量模型）。
- **ghs-plan-designer** — 将需求 + 快照转为可执行的技术计划（用 `models.designer`）。
- **ghs-plan-reviewer** — 从架构视角评审计划，返回 PASS / FAIL（用 `models.reviewer`）。

三个 subagent 的 prompt 模板位于 `src/prompts/`，agent markdown 模板位于 `shared/agents/*.md.template`，
由 `ghs-config` 渲染到 `.opencode/agents/ghs-*.md` 供 OpenCode 在启动时加载。**agent 改名（或升级插件）
后需重跑 `ghs-config` 重新渲染 `.opencode/agents/`，并重启 OpenCode**（agent markdown 仅启动加载、无热
重载）；建议一并清理 `.opencode/agents/` 下残留的、与当前 agent 列表不再对应的旧名 agent md（orphan
agent，功能无害但易混淆）。

---

## 配置

### `.ghs/ghs.json`

用户配置文件（可选，缺失时全部使用默认值）：

```jsonc
{
  "models": {
    "context": "zhipuai-coding-plan/glm-4.5-air",   // 上下文快照 subagent（建议轻量模型）
    "designer": "zhipuai-coding-plan/glm-4.6",       // 计划设计 subagent
    "reviewer": "zhipuai-coding-plan/glm-4.6"        // 计划评审 subagent
  },
  "planner_backend": "ghs-plan-designer"             // 或 "builtin-plan"
}
```

**字段级回退规则**：

- `.ghs/ghs.json` 不存在 → 三个模型字段全部来自 `shared/ghs.default.json`。
- 存在但缺某个字段 / 值为空字符串 → 该字段回退默认值。
- 未知顶层字段 → Zod `.strict()` 拒绝并报错（如把 `"models"` 拼成 `"model"`）。

`planner_backend` 决定计划设计阶段走哪条路径：默认 `ghs-plan-designer`（自建三角色调度）；
设为 `builtin-plan` 则改用 OpenCode 内置 `Config.agent.plan`。非法值由 Zod strict schema 上抛报错；
内置 agent 输出不带 ghs 分隔标记时，解析失败会重试，最坏情况可切回默认 backend。

**修改模型后的生效步骤**：

1. 编辑 `.ghs/ghs.json`。
2. 调用 `ghs-config`（或 `/ghs-config`）—— 渲染更新 `.opencode/agents/ghs-*.md`。
3. **重启 OpenCode 会话** —— agent markdown 仅启动时加载，无热重载。

> 默认配置见 `shared/ghs.default.json`，示例见 `shared/ghs.json.example`。

---

## codegraph MCP（可选）

插件在 `ghs-plan-start` 时探测 `.codegraph/` 目录是否存在：

- **存在** → plan 流程走 codegraph MCP 工具（`codegraph_codegraph_explore` 等）提取精确架构快照。
- **不存在** → 自动回退 grep 路径，不报错。

codegraph MCP 独立于本插件，需另行安装并通过 `opencode.json` 的 `mcp` 段配置
（见 [安装](#安装)）。不配置也不影响核心工作流，只是架构快照精度降低。

---

## 架构

```
src/
├── index.ts              # 入口：default-export ghsPlugin
├── plugin.ts             # Plugin 实现：注册 10 工具 + 8 命令 + event/system hook
├── tools/                # 每个工具一个模块（薄编排层）
│   ├── init.ts  config.ts  plan-start.ts  plan-review.ts  plan-finalize.ts
│   ├── sprint.ts  code.ts  status.ts  archive.ts  force-archive.ts
├── lib/
│   ├── scripts/          # Python 脚本的 TS 移植（行为真相来源）
│   ├── config.ts         # 加载/合并 ghs.json + 渲染 agent 模板
│   ├── codegraph.ts      # codegraph 可用性探测
│   ├── commands.ts       # slash command 定义
│   ├── paths.ts          # pluginRoot() 解析（via import.meta.dir）
│   ├── project.ts        # projectDir 解析（via ToolContext）
│   ├── todo-tracker.ts   # 断线检测状态机
│   ├── workflow-chrome.ts# 四纯函数：stageHeader / todoDirective / nextActionAnchor / staleTodoWarning
│   ├── state.ts          # .ghs/ 状态读写
│   ├── parse.ts          # 分隔标记解析
│   └── nonce.ts          # force-archive nonce 令牌
└── prompts/              # LLM prompt 模板（英文）

shared/                   # 随包发布的资产（npm pack 包含）
├── agents/               # subagent markdown 模板 ×3（.md.template）
├── skill/ghs/SKILL.md    # ghs 编排 skill（复制到 .opencode/skill/）
├── references/           # 参考文档 ×6（coding-agent / plan-designer / plan-reviewer 等）
├── assets/               # features.json + progress.md 模板
├── ghs.default.json      # 默认模型配置
├── ghs.json.example      # 用户配置示例
└── opencode.json.example # 完整 opencode.json 配置示例
```

**关键设计约束**：

- **插件根路径**通过 `import.meta.dir` 解析（`src/lib/paths.ts`），绝不依赖 `process.cwd()` 或
  `__dirname`——这是 npm cache / `file:` 安装下资产正确解析的前提。
- **代码标识符 / 日志 / 错误信息 / LLM prompt 用英文**；人类可读输出（对话、文档、commit message）
  用中文（详见 `CLAUDE.md` 语言策略）。
- **`.ghs/` 被 gitignore**，除了 `test/fixtures/.ghs/`（等价性测试的标准夹具）。

---

## 开发

### 环境要求

- [Bun](https://bun.sh) 运行时
- TypeScript 5.6+

### 常用命令

```bash
# 类型检查
bun run typecheck          # tsc --noEmit（tsconfig.json 设 noEmit）

# 全量测试
bun test
```

### 项目布局（不随包发布）

`test/`、`.ghs/`、`bun.lock`、`tsconfig.json` — 排除在 tarball 之外。
`package.json` 的 `files` 白名单为 `["src", "shared"]`，发布产物不含任何 `.py` 文件
（`//packVerified` 标记记录了完整的发布清单与文件计数）。入口 `main → src/index.ts → default-export ghsPlugin`。
