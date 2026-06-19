# 将 golden-hoop-spell 移植到 OpenCode（Round 6 修订版）

> **Round 6 修订摘要** —— 用户在 Round 5 之上又下达了一条覆盖指令。这条指令要求把 subagent 的模型 ID 从 `opencode.json` 硬编码中抽出到一个用户可编辑的配置文件 `ghs.json` 中。
>
> | 指令 | 解决方式 | 章节 |
> |---|---|---|
> | **R3：模型 ID 不应写死，提供用户可编辑的 `ghs.json`** | **新增 `<PROJECT_DIR>/.ghs/ghs.json` 作为用户配置入口**，承载 3 个 subagent 的 `model` 字段（`models.context`、`models.designer`、`models.reviewer`）。`ghs-init` 在初始化项目时创建该文件并写入默认模型 ID。plugin 在运行时（`ghs-plan-start` execute 内）通过文件读取 + 软验证机制消费这些模型 ID。**关键决策**：OpenCode plugin SDK **不**暴露运行时修改 agent registry 的 API（plugin 只能注册 tool + 订阅 hook），`opencode.json` 在启动时一次性加载。因此本方案选择"**安装期代码生成**"路径 —— plugin 提供 `ghs-config` tool，读取 `<PROJECT_DIR>/.ghs/ghs.json` 并生成/更新 `.opencode/agents/ghs-*.md` 三份 Markdown agent 文件（含 `model` frontmatter）。该 tool 在 `ghs-init` 后被自动调用一次，并在用户修改 `ghs.json` 后可手动再次调用以同步。默认模型 ID 从 plugin 自带的 `shared/ghs.default.json` 兜底（出处：plugin SDK 源码 `https://github.com/sst/opencode/blob/dev/packages/plugin/src/index.ts`、OpenCode 文档 `https://opencode.ai/docs/plugins/` 列举的 hook 类型、`https://opencode.ai/docs/agents/` 关于 Markdown agent 文件 + `.opencode/agents/` 目录的说明）。 | §1.3, §2.3, §3.1, §3.2, §3.3, §3.4 D1/D2/D6, §3.5, §3.6, §4, §5, §6 |
> | **设计问题 Q1（`ghs.json` 位置）** | **已定**：`<PROJECT_DIR>/.ghs/ghs.json`（选项 a）。理由：(1) 与现有 `.ghs/` 状态模型一致，和 `features.json`/`progress.md` 同处一目录；(2) `resolveProjectDir()` 已知如何定位 `.ghs/`；(3) `ghs-init` 已负责创建 `.ghs/`，扩展它写入 `ghs.json` 是最小改动；(4) 避免 `<PROJECT_DIR>/ghs.json` 与项目根目录其他文件冲突；(5) 全局用户配置（`~/.config/ghs/`）作为 v2 增强项，v1 不做。 | §3.6 |
> | **设计问题 Q2（`ghs.json` schema）** | **已定**：最小可用 schema 仅含 `models.{context,designer,reviewer}` 三个字符串字段。`codegraph` MCP 命令、subagent 的 `temperature`/`steps`、`max_rounds` 等暂**不**外部化（避免过度设计；这些字段有强语义，硬编码在 plugin 自带的 Markdown 模板里更稳）。schema 用 Zod 在 `src/lib/config.ts` 校验。 | §3.4 D6, §3.6 |
> | **设计问题 Q3（plugin 如何消费 `ghs.json`）** | **已定（代码生成路径）**：经验证 OpenCode plugin SDK **不**提供运行时修改 agent registry 的 API —— plugin 函数返回的 `Hooks` 对象仅支持 `tool`、`event`、`tool.execute.before/after`、`experimental.session.compacting`、`experimental.chat.system.transform`。agent 定义只能通过 `opencode.json` 的 `agent.<name>` 或 `.opencode/agents/*.md` 静态声明，均在 plugin 加载前由 OpenCode 核心一次性读取。因此本方案选择：plugin 自带 3 份 Markdown agent 模板（`shared/agents/ghs-context-haiku.md.template` 等，含 `__GHS_MODEL__` 占位符），新增 `ghs-config` tool（也由 `ghs-init` 自动调用一次）读取 `.ghs/ghs.json`、做模板替换、把成品 `.md` 写入 `<PROJECT_DIR>/.opencode/agents/`。用户修改 `ghs.json` 后再次调用 `ghs-config` 即可同步。`shared/opencode.json.example` **不再**含 `agent.<name>` 段，仅保留 `plugin` + `mcp.codegraph`。 | §2.3, §3.3, §3.4 D6 |
> | **设计问题 Q4（默认值与兜底）** | **已定**：plugin 自带 `shared/ghs.default.json`，含 3 个默认模型 ID（`anthropic/claude-haiku-4-20250514` / `anthropic/claude-sonnet-4-20250514` × 2）。`ghs-init` 创建 `.ghs/ghs.json` 时若用户未指定，则拷贝默认值。`ghs-config` 读取时若 `.ghs/ghs.json` 缺失或字段为空，自动回退到 `shared/ghs.default.json`。**优先级**：用户显式配置 > plugin 自带默认值。模型 ID 仅在生成 `.opencode/agents/*.md` 时被填入；plugin 运行时（tool execute）**不**校验模型 ID 是否合法（OpenCode 自身在启动时会因未知 provider/model 报错，这是用户侧诊断信号）。 | §3.4 D6, §3.6 |
> | **设计问题 Q5（与 Round 5 架构的兼容性）** | **已定**：3 个 subagent 名称与角色不变（`ghs-context-haiku`/`ghs-plan-designer`/`ghs-plan-reviewer`）；Task tool 派发流不变；codegraph MCP 集成不变；11 个 TS 脚本移植不变；hyphenated tool naming 不变；中文翻译不变；path scrub 不变；transcription nonce gate 不变。唯一变化是：subagent 的声明载体从 `shared/opencode.json.example` 的 `agent.<name>` 段，迁移到 `<PROJECT_DIR>/.opencode/agents/ghs-*.md`（由 `ghs-config` 从模板 + `.ghs/ghs.json` 生成），且 `model` 字段值来自用户配置。 | §3.1, §3.4 D1/D2 |
> | **保留 Round 5 的既定决策** | codegraph MCP 集成（R1）、3 角色 dispatcher + 每任务模型选择（R2）、9 个 hyphenated `ghs-*` tool、转写 nonce 门槛、11 个 TS 脚本移植 + 等价性测试、`experimental.chat.system.transform` hook、全 TypeScript 运行时。这些与 Round 5 一致，未变。 | §3.3, §3.4 D2/D4/D5 |
>
> **Round 5 修订摘要**（为可追溯性保留 —— 关于 codegraph MCP 集成与 3 角色 dispatcher 的决策未变）：
>
> | 指令 | 解决方式 | 章节 |
> |---|---|---|
> | **R1：恢复 codegraph 集成** | plugin 在 `shared/opencode.json.example` 中声明 `mcp.codegraph`（`type: "local"`，`command: ["bun", "x", "codegraph-mcp"]`）；`ghs-plan-start` 在 Detection 阶段探测 `<PROJECT_DIR>/.codegraph/` 目录是否存在，再让主 AI 在 chat 中做一次 `codegraph_status` 探测；据此选择 Context Subagent 的 prompt 模板（codegraph 或 grep）。 | §1.3, §2.3, §3.4 D3, §3.5, §3.6 |
> | **R2：恢复多 agent + 多模型编排** | plugin 注册 3 个自定义 subagent；主 AI 经内置 Task tool 派发。**Round 6 修订**：subagent 声明从 `opencode.json` 迁移到 `.opencode/agents/*.md`，`model` 来自 `.ghs/ghs.json`。 | §3.4 D1, §3.3 |
>
> **Round 4 修订摘要**（为可追溯性保留 —— 翻译为中文；关于 9 个 tool 重命名、TS 全量移植等决策未变）：
>
> | 问题 | 解决方式 | 章节 |
> |---|---|---|
> | 翻译为中文 | 全文中文正文 + 英文代码/路径/标识符/技术术语。 | 全文 |
> | 连字符形式 `ghs-*` tool key（指令 D1，自 Round 3） | `Hooks.tool` 类型为 `{ [key: string]: ToolDefinition }`，key 是普通 string，连字符合法。Phase 0 spike 验证往返。 | §3.4 D2 |
> | 全 TypeScript 运行时（指令 D2，自 Round 3） | 11 个脚本全部移植为 `src/lib/scripts/*.ts`；等价性测试作为字节兼容性门槛。 | §3.3, §3.4 D4 |

---

## 1. 背景与目标

### 1.1 背景

`golden-hoop-spell`（GHS）是一套工作流纪律套件，最初作为 Claude Code plugin 构建。它强制执行一个结构化的软件交付循环 —— **init → plan → sprint → code → status → archive** —— 并由 `.ghs/` 下一个小而持久的磁盘状态模型提供支持。源 plugin 由 7 个以 Markdown 定义的 skill（以 `/ghs:<name>` 形式调用）、8 个 Python 3 辅助脚本（仅依赖标准库）、一个 **3 角色的 plan 生成 dispatcher**（主对话编排 `Plan` subagent 做设计 + `general-purpose` subagent 做评审 + `general-purpose`/`Explore` subagent 做 context 抽取，最多 `max_rounds` 轮），以及一个并行编码编排器组成。源 plugin 可选地集成 **codegraph MCP server**（通过 `.codegraph/` 目录 + codegraph MCP tool），用于在 context 抽取阶段获取预构建的代码知识图谱。

OpenCode（sst/opencode）是另一种不同的 agent 运行时，拥有自己的 plugin 模型与**原生的多 agent + 多模型编排能力**：
- **自定义 subagent**（经 `opencode.json` 的 `agent.<name>` 声明，或经 `<PROJECT_DIR>/.opencode/agents/*.md` Markdown 文件声明；主 agent 通过内置的 **Task tool** 派发工作给 subagent）。
- **MCP server 集成**（经 `opencode.json` 的 `mcp.<name>` 声明；MCP tool 自动暴露给 LLM）。
- **plugin 是 TypeScript/Bun 模块**，注册 custom tool 并订阅生命周期 event hook。

本方案将 GHS 移植到 OpenCode，**完整保留源 plugin 的核心架构能力**：(1) codegraph MCP 集成；(2) 3 角色 plan dispatcher + 每任务模型选择；(3) **Round 6 新增**：模型 ID 用户可配置（经 `.ghs/ghs.json`）。同时保留工作流语义、9 个 tool 表面，以及与 Claude Code 版本按字节兼容的 `.ghs/` 状态模型。**整个运行时都是 TypeScript —— 不发布也不调用任何 Python 脚本。**

### 1.2 目标

1. **可作为 OpenCode plugin 安装** —— 既可作为本地 `.opencode/plugins/` 文件，也可作为 npm 包（`golden-hoop-spell-opencode`）。
2. **9 个可被 AI 发现的 tool**，对应 7 个源 skill。所有 tool registry key 都采用源项目的连字符形式 `ghs-*` 约定（指令 D1，保留自 Round 3）。
3. **按字节兼容的 `.ghs/` 状态** —— `features.json`、`progress.md`、`plans/`、`archived/` schema 不变。等价性测试证明 TS 移植与源 Python 脚本输出按字节一致（指令 D2 §6）。
4. **保留工作流语义** —— sprint→plan→code→status→archive 行为、按严重程度分级的 plan 评审、max-rounds + 违约硬上限、并行批处理、格式恢复重试、用户决策处理。
5. **全 TypeScript 运行时**（指令 D2，保留自 Round 3）—— 全部 8 个源脚本和 3 个新增 writer 都被移植为 TS 模块。
6. **恢复 codegraph MCP 集成**（指令 R1，保留自 Round 5）。
7. **恢复 3 角色 plan dispatcher + 每任务模型选择**（指令 R2，保留自 Round 5）。
8. **模型 ID 用户可配置**（指令 R3，Round 6 新增）—— 3 个 subagent 的 `model` 不在 `opencode.json` 中硬编码，而是从用户可编辑的 `<PROJECT_DIR>/.ghs/ghs.json` 读取，由 `ghs-config` tool 经模板替换生成 `.opencode/agents/ghs-*.md`。用户修改 `ghs.json` 后再次调用 `ghs-config` 即可同步。

### 1.3 范围

**在范围内：**
- TypeScript plugin 模块，在连字符形式的 `ghs-*` registry key 下暴露 9 个 tool（Round 6 后变为 **10 个 tool** —— 新增 `ghs-config`；详见 §3.4 D2 修订说明）。
- **3 个自定义 subagent 的 Markdown 模板**（plugin 自带 `shared/agents/*.md.template`，含 `__GHS_MODEL__` 占位符；由 `ghs-config` 替换后写入用户项目的 `.opencode/agents/`）。
- **`shared/ghs.default.json`** —— plugin 自带的默认模型 ID 兜底文件。
- **codegraph MCP server 声明**（通过 `opencode.json` 的 `mcp.codegraph`；plugin 文档提供示例配置；运行时若缺失则走 grep 回退）。
- `src/lib/scripts/` 下的 11 个 TypeScript 模块 —— 8 个源 `.py` 文件的忠实移植 + 3 个新增 writer。
- `src/lib/config.ts` —— `.ghs/ghs.json` 的读取、Zod 校验、默认值回退、模板替换逻辑。
- `test/` 下的一套 `equivalence/` 测试框架，对源 `.py` 与 TS 移植运行相同的 fixture 输入并比对输出。
- 一个随 plugin 发布的 `shared/references/` 目录，供 AI 按需阅读（仅 Markdown 文档 —— 无 Python）。
- **3 角色 plan 模式**：主 chat AI 兼 dispatcher，通过 Task tool 派发给 3 个 subagent。
- 文档和一条可用的安装路径（本地 + npm）。

**不在范围内：**
- **发布或调用任何 Python 脚本**（指令 D2）。
- 在 tool execute 中进行进程内 LLM 调用（SDK `session.prompt` 在 v1.1.15+ 存在已知 hang 问题 —— issue #6573、#8528；我们走 Task tool 路径而非 SDK 路径）。
- 在 Claude Code marketplace 上架。
- 自行实现/打包 codegraph MCP server 二进制 —— 我们声明对它的依赖，由用户负责安装。
- **全局用户配置**（`~/.config/ghs/ghs.json`）—— v2 增强项，v1 仅支持 per-project `<PROJECT_DIR>/.ghs/ghs.json`。
- **运行时（plugin 加载后）动态修改 agent 模型 ID** —— OpenCode plugin SDK 不支持；本方案走"安装期代码生成"路径。

---

## 2. 现状分析

### 2.1 源 plugin（已存在的内容）

| 组件 | 位置 | 行为 |
|---|---|---|
| 7 个 SKILL.md 文件 | `plugin/skills/ghs-*/SKILL.md` | Claude Code agent 在 `/ghs:<name>` 被调用时读取的工作流指令 |
| 8 个 Python 脚本 | `plugin/shared/scripts/*.py` | 约 2432 LOC 需移植的 Python |
| 6 份参考文档 | `plugin/shared/references/*.md` | 工作流深度文档 |
| 2 个 asset 模板 | `plugin/shared/assets/{features.json,progress.md}` | 初始状态模板 |
| 3 角色 plan dispatcher | 位于 `ghs-plan/SKILL.md` 内 | 主对话编排 Plan-designer + Plan-reviewer + Context-extractor |
| codegraph 集成 | 位于 `ghs-plan/SKILL.md` 第 121-262 行 | Detection 阶段探测 + Context Subagent 内调用 codegraph tool |
| 并行编码 | 位于 `ghs-code/SKILL.md` + `parallel_utils.py` 内 | 批处理 + 后台 subagent 派发 |
| 清单 | `plugin.json`、`marketplace.json` | Claude Code plugin 元数据 |

### 2.2 目标项目（已存在的内容）

`<PROJECT_DIR>/` 只包含一个 `README.md` 和一个空的 `.ghs/`。尚无任何 OpenCode plugin 代码。

### 2.3 OpenCode 平台能力（已在 Round 6 重新核实）

已于 2026-06-20 直接对照以下来源核实：
- `https://opencode.ai/docs/plugins/`（plugin 函数签名、可用 hook 列表、加载顺序）
- `https://opencode.ai/docs/agents/`（agent 定义：JSON 与 Markdown 两种形式；`.opencode/agents/` 目录；`mode`/`model`/`prompt`/`permission`/`hidden`/`temperature`/`steps` 字段）
- `https://opencode.ai/docs/config/`（配置合并语义、`{env:VAR}` 与 `{file:path}` 变量替换、加载优先级）
- `https://opencode.ai/docs/mcp-servers/`（MCP server 声明）
- `https://opencode.ai/docs/custom-tools/`、`https://opencode.ai/docs/sdk/`
- SDK 源码 `https://github.com/sst/opencode/blob/dev/packages/plugin/src/index.ts`

**关键发现（Round 6 新增 —— 推翻"plugin 可在运行时修改 agent registry"的假设）：**

- **Plugin 函数返回的 `Hooks` 对象仅支持以下键**：`tool`（tool registry）、`event`（生命周期事件订阅）、`tool.execute.before` / `tool.execute.after`（tool 执行拦截）、`experimental.session.compacting`（压缩前注入 context）、`experimental.chat.system.transform`（系统提示变换）、`shell.env`（shell 环境变量注入）、`tui.prompt.append` / `tui.command.execute` / `tui.toast.show`（TUI 事件）。**没有任何键允许 plugin 在运行时注册、修改或删除 agent 定义**。agent 定义只能通过两种静态途径声明：(a) `opencode.json` 的 `agent.<name>` 段；(b) `<PROJECT_DIR>/.opencode/agents/*.md` 或 `~/.config/opencode/agents/*.md` 的 Markdown 文件。两者都在 plugin 加载**之前**由 OpenCode 核心读取完毕。
- **结论**：Round 5 在 `shared/opencode.json.example` 中硬编码 `agent.<name>.model` 的做法，本质上是"用户必须把整段 agent 配置合并到自己的 `opencode.json`"。Round 6 把这段配置迁移到 `.opencode/agents/*.md`（由 `ghs-config` tool 从模板 + `.ghs/ghs.json` 生成），既支持用户编辑模型 ID，又不要求用户手写整段 agent JSON。
- **变量替换 `{env:VAR}` 与 `{file:path}`**：OpenCode 文档明确支持在 `opencode.json` 顶层字段（如 `model`、`provider.*.options.apiKey`、`instructions`）使用这两种替换。但**文档未明确** `agent.<name>.model` 是否支持 `{env:VAR}` 替换 —— GitHub issue #19946 报告 `{env:VAR}` 在自定义 provider 的 `options.apiKey` 中存在 bug，说明变量替换并非在所有字段都可靠。**因此 Round 6 不依赖 `{env:VAR}` 替换 `agent.model`**，而是走代码生成路径（更可控、更易诊断）。
- **Markdown agent 文件**：OpenCode 原生支持 `.opencode/agents/*.md`，frontmatter 含 `description`、`mode`、`model`、`temperature`、`permission`、`steps` 等字段；文件正文为系统提示。文件名（去 `.md`）即为 agent 名。`hidden: true` 使其不在 `@` 自动补全中显示，但仍可被 Task tool 派发。这是 Round 6 subagent 声明的首选载体。
- **配置合并语义**：`opencode.json` 的多个来源（remote → global → project → `.opencode/` 目录 → inline env → managed）按优先级合并，后写覆盖先写。`.opencode/agents/*.md` 与 `opencode.json` 的 `agent.<name>` 段可共存 —— 同名 agent 以 Markdown 文件为准（更具体的来源优先）。

**其余 Round 5 关键发现（保留不变）：**
- 自定义 subagent（`mode: "subagent"`）+ Task tool 派发（R2）—— OpenCode 原生支持。
- MCP server 集成（R1）—— `mcp.<name>` 声明，MCP tool 自动暴露给 LLM。
- plugin 不能在 tool execute 内调 SDK `session.prompt`（issue #6573、#8528）；走 Task tool 路径。

**重要边界**：插件 **不能** 在 tool `execute` 内部直接调用 SDK 的 `session.prompt()`；也 **不能** 在 plugin 函数中修改 agent registry。正确路径是：plugin 注册 tool + MCP server + system.transform hook；subagent 经 `.opencode/agents/*.md` 静态声明；主 chat AI 用 Task tool 派发；tool `execute` 仅做文件 I/O、解析、状态写入、模板替换、返回结构化指引。

---

## 3. 方案设计

### 3.1 整体架构

```
                 OpenCode chat UI
                       │
                       │ user prompt (e.g. "plan the auth refactor")
                       ▼
            ┌────────────────────────────────────────────┐
            │   OpenCode primary AI (Build agent)        │  ← dispatcher 角色
            │   - invokes ghs-plan-start tool            │     (源: 主对话)
            │   - reads returned dispatch instructions   │
            │   - uses Task tool to dispatch subagents:  │
            │       • ghs-context-haiku   (model from    │  ← Context Subagent
            │                              .ghs/ghs.json)│
            │       • ghs-plan-designer   (model from    │  ← Plan Designer
            │                              .ghs/ghs.json)│
            │       • ghs-plan-reviewer   (model from    │  ← Plan Reviewer
            │                              .ghs/ghs.json)│
            │   - invokes ghs-plan-review again to parse │
            │     subagent output + persist artifacts    │
            │   - invokes ghs-sprint / ghs-code / etc.   │
            └──────────┬─────────────────────────────────┘
                       │ Task tool dispatch (subagent sessions are isolated)
                       │ + ghs-* tool calls (in-process TS only — no shell-out)
                       ▼
   ┌─────────────────────────────────────────────────────────────────┐
   │   ghs-opencode plugin  (src/plugin.ts)                          │
   │                                                                 │
   │   tool registry (10 tools, hyphenated keys):                    │
   │     ghs-init, ghs-status,                                       │
   │     ghs-archive, ghs-force-archive,                             │
   │     ghs-sprint, ghs-code,                                       │
   │     ghs-plan-start, ghs-plan-review, ghs-plan-finalize,         │
   │     ghs-config  ← Round 6 新增：从 .ghs/ghs.json 生成            │
   │                  .opencode/agents/ghs-*.md                      │
   │                                                                 │
   │   each tool.execute:                                            │
   │     1. resolve project dir (worktree > directory)               │
   │     2. import + call TS modules from src/lib/scripts            │
   │     3. return structured text — NO LLM calls                    │
   │                                                                 │
   │   experimental.chat.system.transform hook:                      │
   │     push one-line hint listing all 10 tools + 3 subagents       │
   │                                                                 │
   │   src/lib/scripts/ (all-TS, no Python): 11 modules              │
   │   src/lib/config.ts ← Round 6 新增：ghs.json 读取/校验/兜底      │
   │   src/prompts/ (prompt templates for subagents + tools)         │
   │                                                                 │
   │   shared/references/*.md  ← verbatim from source                │
   │   shared/assets/*.json    ← verbatim from source                │
   │   shared/agents/*.md.template  ← Round 6 新增：含 __GHS_MODEL__  │
   │   shared/ghs.default.json  ← Round 6 新增：默认模型 ID           │
   │   shared/opencode.json.example ← 仅 plugin + mcp.codegraph      │
   │                                    (不再含 agent.<name> 段)     │
   └─────────────────────────────────────────────────────────────────┘
           │                                    │
           │ plugin ships templates + defaults; │ plugin detects at runtime
           │ ghs-init + ghs-config generate     │ via filesystem probe
           │ .opencode/agents/*.md from         │
           │ .ghs/ghs.json                      │
           ▼                                    ▼
   .ghs/ghs.json                            .codegraph/  (optional;
   .ghs/features.json                       codegraph MCP server
   .ghs/progress.md                         reads this; absent →
   .opencode/agents/ghs-context-haiku.md    grep fallback path)
   .opencode/agents/ghs-plan-designer.md
   .opencode/agents/ghs-plan-reviewer.md
```

**关键架构原则（指令 R1 + R2 + R3）：**

1. **主 chat 中的 AI 是 dispatcher**。它读取 `ghs-plan-start` 返回的 dispatch 指引，用内置 **Task tool** 派发已注册的 subagent。subagent 的会话是隔离的，输出回到主 AI。
2. **每任务模型选择**。3 个 subagent 各带独立的 `model` 配置 —— **Round 6 修订**：这些 model ID 不在 `opencode.json` 中硬编码，而是从 `<PROJECT_DIR>/.ghs/ghs.json` 读取，由 `ghs-config` tool 在安装期写入 `<PROJECT_DIR>/.opencode/agents/ghs-*.md` 的 frontmatter。
3. **codegraph 经 MCP 声明**（与 Round 5 一致）。
4. **tool execute 永不调用 LLM，也永不修改 agent registry**。所有 LLM 工作发生在 subagent 会话中（由主 AI 经 Task tool 触发）。tool 只做：项目目录解析、调用 TS 脚本模块、读取/校验 `ghs.json`、模板替换生成 agent Markdown 文件、返回结构化文本。
5. **保留 Round 3 的 TS 全量移植**。11 个脚本模块按字节忠实移植；等价性测试作为字节兼容性门槛。
6. **Round 6 新增：模型 ID 用户可配置**。`ghs.json` 是唯一的模型 ID 真相来源；`ghs-config` 是从 `ghs.json` 到 `.opencode/agents/*.md` 的单向同步器。

### 3.2 映射表 —— 源概念 → 目标实现（Round 6 修订）

| 源（Claude Code） | 目标（OpenCode） | 备注 |
|---|---|---|
| `/ghs:init` skill | `ghs-init` tool | **Round 6 修订**：除了创建 `.ghs/features.json` 等，还创建 `.ghs/ghs.json`（从 `shared/ghs.default.json` 拷贝默认值）+ 自动调用 `ghs-config` 生成 `.opencode/agents/ghs-*.md` |
| `/ghs:status` skill | `ghs-status` tool | 调用 `status.ts` 的 `status()` |
| `/ghs:archive` skill | `ghs-archive` tool | 调用 `archiveSprint({dryRun?, list?})` |
| `/ghs:force-archive` skill | `ghs-force-archive` tool | 调用 `archiveSprint({force: true})`；带转写 nonce 门槛 |
| `/ghs:sprint` skill | `ghs-sprint` tool | 与 Round 5 一致 |
| `/ghs:code` skill | `ghs-code` tool | 与 Round 5 一致 |
| `/ghs:plan` skill（3 角色 dispatcher） | `ghs-plan-start` + `ghs-plan-review` + `ghs-plan-finalize` tool + **3 个 `.opencode/agents/*.md` subagent** | **Round 6 修订**：subagent 不再在 `opencode.json` 中声明，而是经 `ghs-config` 从模板 + `ghs.json` 生成 Markdown 文件 |
| `Agent` tool（spawn subagent） | **Task tool**（dispatch subagent） | OpenCode 内置；一一对应 |
| **`Plan` subagent_type** | **`ghs-plan-designer` subagent**（`.opencode/agents/ghs-plan-designer.md`，`mode: "subagent"`，`model` 来自 `ghs.json`，`hidden: true`） | Round 6 修订；prompt body 从源 `plan-designer.md` 移植到模板 |
| **`general-purpose` reviewer subagent** | **`ghs-plan-reviewer` subagent**（`.opencode/agents/ghs-plan-reviewer.md`） | 同上 |
| **Context Subagent** | **`ghs-context-haiku` subagent**（`.opencode/agents/ghs-context-haiku.md`） | 同上；单一 subagent，prompt 模板按 codegraph 可用性切换 |
| `model: "haiku"` on Context Subagent | `ghs.json` 的 `models.context` 字段（默认 `anthropic/claude-haiku-4-20250514`） | Round 6 修订；用户可改 |
| reviewer / designer 的默认模型 | `ghs.json` 的 `models.designer` / `models.reviewer` 字段（默认 `anthropic/claude-sonnet-4-20250514`） | Round 6 修订；用户可改 |
| codegraph MCP（`.codegraph/` + MCP tool） | **`mcp.codegraph`**（`type: "local"`，`command: [...]`） | 与 Round 5 一致；声明仍在 `opencode.json`（与 agent 声明解耦） |
| SKILL.md 正文 | tool `description` + plugin 内附带的 `references/*.md` + `shared/agents/*.md.template`（subagent prompt body 模板） | Round 6 修订：从 `.md` 改为 `.md.template`（含 `__GHS_MODEL__` 占位符） |
| `${CLAUDE_PLUGIN_ROOT}` | `import.meta.dir`（Bun） | plugin 知道自己的安装路径 |
| 11 个 Python 脚本 | 11 个 TS 模块 | 与 Round 5 一致 |
| `AskUserQuestion`（同步阻塞） | 主 AI 在 tool 调用之间于 chat 中询问用户 | 与 Round 5 一致 |
| **（无源对应）** | **`ghs-config` tool + `src/lib/config.ts`** | **Round 6 新增**：读取 `ghs.json`、模板替换、生成 `.opencode/agents/*.md` |

### 3.3 Plugin 清单与打包（Round 6 修订）

**布局**（目标项目）：

```
ghs-opencode/
├── opencode.json                  # demo project config: 仅 plugin + mcp.codegraph（不含 agent.<name>）
├── package.json                   # name: golden-hoop-spell-opencode, type: module
├── README.md                      # install + usage (Bun-only runtime prereq; optional codegraph MCP)
├── tsconfig.json
├── src/
│   ├── index.ts                   # plugin entry — exports default Plugin
│   ├── plugin.ts                  # Plugin function: registers 10 tools + system.transform hook
│   ├── tools/
│   │   ├── init.ts                # ghs-init (Round 6: also creates .ghs/ghs.json + invokes config sync)
│   │   ├── status.ts              # ghs-status
│   │   ├── archive.ts             # ghs-archive
│   │   ├── force-archive.ts       # ghs-force-archive
│   │   ├── sprint.ts              # ghs-sprint
│   │   ├── code.ts                # ghs-code
│   │   ├── plan-start.ts          # ghs-plan-start
│   │   ├── plan-review.ts         # ghs-plan-review
│   │   ├── plan-finalize.ts       # ghs-plan-finalize
│   │   └── config.ts              # ghs-config  ← Round 6 新增
│   ├── lib/
│   │   ├── paths.ts               # resolve plugin root via import.meta.dir
│   │   ├── project.ts             # resolveProjectDir(ctx)
│   │   ├── assets.ts              # loadAsset(name)
│   │   ├── state.ts               # status.json read/write for plan dispatcher
│   │   ├── parse.ts               # thin wrappers re-exporting parseDelimitedOutput / parseCompletionSignal
│   │   ├── nonce.ts               # generate/transcribe nonce for ghs-force-archive gate
│   │   ├── codegraph.ts           # detectCodegraph(projectDir) → probes .codegraph/ dir
│   │   ├── config.ts              # ← Round 6 新增：loadGhsConfig / validateGhsConfig / resolveModel / renderAgentTemplate
│   │   └── scripts/               # ALL 11 SCRIPT PORTS — no Python anywhere
│   │       ├── init-project.ts
│   │       ├── resolve-project-dir.ts
│   │       ├── validate-structure.ts
│   │       ├── status.ts
│   │       ├── archive-sprint.ts
│   │       ├── parallel-utils.ts
│   │       ├── parse-completion-signal.ts
│   │       ├── parse-delimited-output.ts
│   │       ├── append-sprint.ts
│   │       ├── update-feature-status.ts
│   │       └── append-progress-session.ts
│   └── prompts/
│       ├── plan-designer.ts
│       ├── plan-reviewer.ts
│       ├── context-codegraph.ts
│       ├── context-grep.ts
│       ├── feature-impl.ts
│       └── sprint-planning.ts
├── shared/                        # shipped inside the plugin
│   ├── references/*.md            # 6 docs verbatim
│   ├── assets/{features.json,progress.md}
│   ├── agents/                    # Round 6 修订：模板文件（含 __GHS_MODEL__ 占位符）
│   │   ├── ghs-context-haiku.md.template
│   │   ├── ghs-plan-designer.md.template
│   │   └── ghs-plan-reviewer.md.template
│   ├── ghs.default.json           # ← Round 6 新增：默认模型 ID 兜底
│   ├── ghs.json.example           # ← Round 6 新增：用户可参考的示例配置
│   ├── opencode.json.example      # Round 6 修订：仅 plugin + mcp.codegraph（不含 agent 段）
│   └── SPIKE_RESULTS.md           # Phase 0 spike outcomes
└── test/
    ├── fixtures/                  # sample .ghs/ trees + sample .opencode/agents/ trees
    ├── equivalence/               # .py-vs-.ts diff harness (requires python3 in dev only)
    ├── integration/               # agent-spawn + MCP-server + multi-model + config-sync tests
    └── *.test.ts                  # bun test
```

**`shared/ghs.default.json`**（Round 6 新增 —— plugin 自带的默认模型 ID）：

```json
{
  "$schema": "https://golden-hoop-spell-opencode/ghs.json.schema.json",
  "models": {
    "context": "anthropic/claude-haiku-4-20250514",
    "designer": "anthropic/claude-sonnet-4-20250514",
    "reviewer": "anthropic/claude-sonnet-4-20250514"
  }
}
```

**`shared/ghs.json.example`**（Round 6 新增 —— 用户参考示例，含注释式说明）：

```json
{
  "$schema": "https://golden-hoop-spell-opencode/ghs.json.schema.json",
  "models": {
    "context": "anthropic/claude-haiku-4-20250514",
    "designer": "anthropic/claude-sonnet-4-20250514",
    "reviewer": "anthropic/claude-sonnet-4-20250514"
  }
}
```

> 用户应把此文件复制到 `<PROJECT_DIR>/.ghs/ghs.json` 并按需修改模型 ID。模型 ID 格式为 `provider/model-id`（如 `anthropic/claude-haiku-4-20250514`、`openai/gpt-5`、`opencode/gpt-5.1-codex`）。修改后调用 `ghs-config` tool 同步到 `.opencode/agents/`。

**`shared/agents/ghs-context-haiku.md.template`**（Round 6 新增 —— 含 `__GHS_MODEL__` 占位符的模板；其余两个字段同理）：

```markdown
---
description: GHS Context Subagent — extracts architecture snapshot for plan generation. Dispatched by ghs-plan-start workflow.
mode: subagent
model: __GHS_MODEL_CONTEXT__
prompt: You are a GHS Context Subagent. [完整 prompt body，从源 PROMPT_TEMPLATE_CODEGRAPH / PROMPT_TEMPLATE_GREP 移植，含分隔标记契约 <<<CONTEXT_SNAPSHOT_START>>> / <<<CONTEXT_SNAPSHOT_END>>>]
permission:
  edit: deny
  bash: allow
  task:
    "*": deny
hidden: true
temperature: 0.1
steps: 30
---
```

> 模板中 `__GHS_MODEL_CONTEXT__` / `__GHS_MODEL_DESIGNER__` / `__GHS_MODEL_REVIEWER__` 三个占位符由 `ghs-config` 在生成时替换为 `ghs.json` 中对应的模型 ID。

**`shared/opencode.json.example`**（Round 6 修订 —— **移除** `agent.<name>` 段，仅保留 `plugin` + `mcp.codegraph`）：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["golden-hoop-spell-opencode"],
  "mcp": {
    "codegraph": {
      "type": "local",
      "command": ["bun", "x", "codegraph-mcp"],
      "enabled": true
    }
  }
}
```

> **变化说明**：Round 5 的 `opencode.json.example` 含 3 个 `agent.<name>` 段，每段硬编码一个模型 ID。Round 6 移除这 3 段 —— subagent 不再经 `opencode.json` 声明，而是经 `<PROJECT_DIR>/.opencode/agents/ghs-*.md` 声明（由 `ghs-config` 从模板 + `ghs.json` 生成）。用户安装步骤变为：(1) 把 `plugin` + `mcp.codegraph` 段合并到 `opencode.json`；(2) 调用 `ghs-init`（自动创建 `.ghs/ghs.json` + 生成 `.opencode/agents/`）；或手动调用 `ghs-config` 同步。

**`package.json`** 要点（与 Round 5 一致）：
- `"name": "golden-hoop-spell-opencode"`
- `"type": "module"`
- `"main": "src/index.ts"`（Bun 直接运行 TS）
- **没有 `dependencies`** —— `tool.schema` + Zod 已足以覆盖全部 10 个 tool schema。
- `"peerDependencies": { "@opencode-ai/plugin": "*" }`（仅类型）
- `"devDependencies": { "@types/bun": "*", "bun-types": "*", "zod": "*" }`；`python3` 列在 devDependencies 中作为仅文档说明。
- `"files": ["src", "shared"]`（用于 npm 发布 —— 含 `shared/agents/*.md.template` 和 `shared/ghs.default.json`）

**安装路径**（Round 6 修订）：
- **本地**：把 `src/index.ts`（或整个仓库）复制/软链接到某个项目的 `.opencode/plugins/ghs.ts`；把 `shared/opencode.json.example` 中的 `plugin` + `mcp` 段合并到该项目的 `opencode.json`；调用 `ghs-init`（或让主 AI 调用）—— 它会创建 `.ghs/ghs.json` + 自动调用 `ghs-config` 生成 `.opencode/agents/ghs-*.md`。
- **npm**：`npm publish` 该仓库；用户在 `opencode.json` 中添加 `"plugin": ["golden-hoop-spell-opencode"]`，合并 `mcp` 段；调用 `ghs-init`。

### 3.4 关于架构张力的决策

#### 决策 1：3 角色 plan dispatcher —— 多 agent 派发（R2 恢复 + R3 修订模型来源）

**已选**：plugin 经 `ghs-config` tool 在用户项目 `<PROJECT_DIR>/.opencode/agents/` 下生成 3 个 Markdown agent 文件；主 chat 中的 AI 经内置 Task tool 派发；tool `execute` 只做 dispatch 指引组装、subagent 输出解析、artifact 持久化、状态机推进。

**Round 6 修订要点**：subagent 的 `model` 字段不再硬编码在 `shared/opencode.json.example`，而是：
1. 用户在 `<PROJECT_DIR>/.ghs/ghs.json` 中配置（默认值由 `ghs-init` 从 `shared/ghs.default.json` 拷贝）。
2. `ghs-config` tool 读取 `ghs.json`、做模板替换（`__GHS_MODEL_CONTEXT__` → `models.context` 的值，以此类推）、把成品 `.md` 写入 `<PROJECT_DIR>/.opencode/agents/ghs-context-haiku.md` 等。
3. OpenCode 启动时扫描 `.opencode/agents/` 目录，加载这 3 份 Markdown 文件为 subagent。
4. 主 AI 用 Task tool 派发时，subagent 用 frontmatter 中 `model` 字段指定的模型。

**3 个 subagent 的契约（Round 6 修订 —— model 来源改为 `ghs.json`）：**

| subagent | model 来源 | 工具权限 | 输出契约 | 对应源 |
|---|---|---|---|---|
| `ghs-context-haiku` | `ghs.json.models.context`（默认 haiku-class） | `read`、`glob`、`grep`、`bash`（read-only）、`codegraph_*`（仅 codegraph 路径） | 在分隔标记之间输出 snapshot 文本 | Context Subagent |
| `ghs-plan-designer` | `ghs.json.models.designer`（默认 sonnet-class） | `read`、`glob`、`grep`、`bash`（read-only） | 在 `<<<PLAN_START>>>...<<<PLAN_END>>>` 之间输出 plan 文本；首行可能是 `QUESTION: <text>` | `Plan` subagent |
| `ghs-plan-reviewer` | `ghs.json.models.reviewer`（默认 sonnet-class） | `read`、`glob`、`grep`、`bash`（read-only） | 在 `<<<REVIEW_START>>>...<<<REVIEW_END>>>` 之间输出 review 文本；含 `Verdict: PASS\|FAIL` | `general-purpose` reviewer |

> **占位符说明**：上表中出现的 `<<<PLAN_START>>>` 与 `<<<PLAN_END>>>` 是 plan-designer 输出契约的分隔标记（详见 §3.4 D1 末段），不是本计划文档自身的边界标记。本计划文档自身的边界标记为 `<<<PLAN_START>>>` / `<<<PLAN_END>>>`，二者同名但语境不同（前者是 subagent 输出契约，后者是 dispatcher 解析器输入）。

**3 个 plan tool 的角色（与 Round 5 一致，execute 语义不变）：**

- **`ghs-plan-start`**：解析项目目录；探测 codegraph 可用性；生成 `plan_id`；写初始 `status.json`；返回 `plan_id`、`context_file` 路径、`references_dir`、**Task-tool dispatch 指引**。
- **`ghs-plan-review`**：多用途循环中段。args：`plan_id`（必填）、`snapshot_text?`、`plan_text?`、`review_text?`（恰好一个非空；Zod `.refine`）。每个分支调用 `parseDelimitedOutput({kind, ...})` 解析、写入文件、返回下一步 dispatch 指引。
- **`ghs-plan-finalize`**：把 plan 复制到 `docs/ghs/plans/`、设置状态、返回 git-commit 指令。

**关键不变量**：tool execute **永不** 调用 LLM，**永不** 修改 agent registry。所有 LLM 工作由主 AI 经 Task tool 触发的 subagent 会话完成。所有 agent 定义修改只能经 `ghs-config` tool 在用户显式调用时发生（写入 `.opencode/agents/*.md`），且需用户重启 OpenCode 会话才能生效（因为 agent 在启动时加载）。

#### 决策 2：tool 表面 —— 10 个 tool（Round 6 新增 `ghs-config`），连字符形式 `ghs-*`（指令 D1）

Round 6 在 Round 5 的 9 个 tool 基础上**新增 1 个 tool**：`ghs-config`。总计 **10 个 tool**：

`ghs-init`、`ghs-status`、`ghs-archive`、`ghs-force-archive`、`ghs-sprint`、`ghs-code`、`ghs-plan-start`、`ghs-plan-review`、`ghs-plan-finalize`、**`ghs-config`**。

**为何新增 `ghs-config`**：Round 5 把模型 ID 硬编码在 `opencode.json.example`，用户安装时一次性合并即可。Round 6 把模型 ID 外部化到 `ghs.json` 后，需要一个同步机制把 `ghs.json` 的内容应用到 `.opencode/agents/*.md`。这个同步机制必须是 user-invocable tool（而非自动 hook），因为：(a) 用户修改 `ghs.json` 后需手动触发同步；(b) tool 调用对用户可见（避免"幽灵修改"用户 `opencode/agents/` 目录）；(c) tool 返回结构化诊断（哪些文件被改、模型 ID 是否合法等）。

**`ghs-init` 的自动调用**：`ghs-init` 在创建 `.ghs/ghs.json` 后会自动调用 `ghs-config` 的内部函数（不是 tool 调用，而是直接 `import` 并调用 `syncAgents()`）—— 这样首次初始化即可生成 `.opencode/agents/`。后续修改 `ghs.json` 后用户需手动调用 `ghs-config` tool。

#### 决策 3：codegraph —— 经 MCP 声明 + 运行时探测（R1 恢复，与 Round 5 一致）

**已选**：plugin 在 `shared/opencode.json.example` 中声明 `mcp.codegraph`（`type: "local"`，`command: ["bun", "x", "codegraph-mcp"]`）；`ghs-plan-start` 在运行时探测 `<PROJECT_DIR>/.codegraph/` 目录是否存在，并据此选择 Context Subagent 的 prompt 模板。

（与 Round 5 §3.4 D3 完全一致，此处不重复。）

#### 决策 4：全 TypeScript 运行时 —— 11 个脚本移植，无 Python（指令 D2，与 Round 5 一致）

（与 Round 5 §3.4 D4 完全一致，此处不重复。）

#### 决策 5：SKILL.md 文件 + 系统提示 + subagent prompt（与 Round 5 一致 + Round 6 扩展 hook 提示）

- 每个 tool 的 `description` 字段携带该 skill 的触发语义。
- 工作流正文拆分为 TS 层代码（过程性步骤）+ `shared/references/*.md`（判断）+ `shared/agents/*.md.template`（subagent prompt body 模板，含 `__GHS_MODEL__` 占位符）。
- `experimental.chat.system.transform` hook 注入一行提示，列出全部 **10 个 tool** + 3 个 subagent + 工作流顺序 + **Round 6 新增**：`ghs-config` 用于同步模型配置。

```typescript
"experimental.chat.system.transform": async (input, output) => {
  output.system.push(
    "GHS workflow tools: ghs-init, ghs-status, ghs-archive, ghs-force-archive, " +
    "ghs-sprint, ghs-code, ghs-plan-start, ghs-plan-review, ghs-plan-finalize, " +
    "ghs-config (sync .ghs/ghs.json → .opencode/agents/*.md). " +
    "GHS subagents (dispatch via Task tool): ghs-context-haiku (snapshot), " +
    "ghs-plan-designer (plan design), ghs-plan-reviewer (plan review). " +
    "Workflow: init → plan (start → [Task: ghs-context-haiku] → review(snapshot) → " +
    "[Task: ghs-plan-designer] → review(plan) → [Task: ghs-plan-reviewer] → review(review) → finalize) → " +
    "sprint → code → status → archive. " +
    "Models are configured in .ghs/ghs.json; run ghs-config after editing."
  );
}
```

#### 决策 6：模型 ID 用户可配置（指令 R3 —— Round 6 新增）

**已选方案**：`<PROJECT_DIR>/.ghs/ghs.json` 作为唯一模型 ID 真相来源；`shared/ghs.default.json` 作为 plugin 自带默认值；`ghs-config` tool 作为同步器（从 `ghs.json` + 模板生成 `.opencode/agents/*.md`）。

**为何选择"代码生成"而非"运行时注入"或"变量替换"：**

| 方案 | 可行性 | 选用与否 |
|---|---|---|
| (a) plugin 函数运行时修改 agent registry | **不可行** —— OpenCode plugin SDK 不暴露此 API（已核实，详见 §2.3） | 不选 |
| (b) `opencode.json` 用 `{env:VAR}` 替换 `agent.<name>.model` | **未文档化可靠** —— OpenCode 文档仅明确 `{env:VAR}` 在顶层 `model`、`provider.*.options.apiKey`、`instructions` 可用；issue #19946 报告 `{env:VAR}` 在某些嵌套字段有 bug。`agent.<name>.model` 的支持未经验证 | 不选（风险过高） |
| (c) `opencode.json` 用 `{file:path}` 替换 `agent.<name>.model` | **未文档化** —— 同上，且把模型 ID 放在单独小文件里反而更碎 | 不选 |
| (d) **代码生成 `.opencode/agents/*.md`** | **可行且可靠** —— Markdown agent 文件是 OpenCode 原生支持的一等公民；frontmatter 字段（含 `model`）经 `ghs-config` 写入即生效；用户可见、可编辑、可 diff | **选用** |
| (e) 把整段 agent JSON 也外部化到 `ghs.json`，让 `ghs-config` 生成 `opencode.json` 的 `agent.<name>` 段 | **可行但冗余** —— 用户既已能直接编辑 `.opencode/agents/*.md`，再额外生成 JSON 段是双重真相来源 | 不选 |

**`ghs.json` schema（最小可用）：**

```typescript
// src/lib/config.ts
import { z } from "zod";

export const GhsConfigSchema = z.object({
  $schema: z.string().optional(),
  models: z.object({
    context: z.string().min(1).describe("Model ID for ghs-context-haiku subagent, e.g. 'anthropic/claude-haiku-4-20250514'"),
    designer: z.string().min(1).describe("Model ID for ghs-plan-designer subagent"),
    reviewer: z.string().min(1).describe("Model ID for ghs-plan-reviewer subagent"),
  }),
}).strict();

export type GhsConfig = z.infer<typeof GhsConfigSchema>;
```

**`src/lib/config.ts` 的核心函数：**

```typescript
// 读取 .ghs/ghs.json；若缺失或字段为空，回退到 shared/ghs.default.json
export async function loadGhsConfig(projectDir: string, pluginRoot: string): Promise<GhsConfig> {
  const userConfigPath = path.join(projectDir, ".ghs", "ghs.json");
  const defaultConfigPath = path.join(pluginRoot, "shared", "ghs.default.json");
  
  let userRaw: unknown = {};
  if (await fileExists(userConfigPath)) {
    userRaw = JSON.parse(await Bun.file(userConfigPath).text());
  }
  const defaultRaw = JSON.parse(await Bun.file(defaultConfigPath).text());
  
  // 字段级合并：用户配置覆盖默认值
  const merged = {
    models: {
      context: userRaw?.models?.context || defaultRaw.models.context,
      designer: userRaw?.models?.designer || defaultRaw.models.designer,
      reviewer: userRaw?.models?.reviewer || defaultRaw.models.reviewer,
    },
  };
  
  return GhsConfigSchema.parse(merged);  // Zod 校验
}

// 模板替换：读取 shared/agents/*.md.template，把 __GHS_MODEL_<ROLE>__ 替换为对应模型 ID
export async function renderAgentTemplate(
  templateName: "ghs-context-haiku" | "ghs-plan-designer" | "ghs-plan-reviewer",
  config: GhsConfig,
  pluginRoot: string,
): Promise<string> {
  const templatePath = path.join(pluginRoot, "shared", "agents", `${templateName}.md.template`);
  const template = await Bun.file(templatePath).text();
  
  return template
    .replace(/__GHS_MODEL_CONTEXT__/g, config.models.context)
    .replace(/__GHS_MODEL_DESIGNER__/g, config.models.designer)
    .replace(/__GHS_MODEL_REVIEWER__/g, config.models.reviewer);
}

// 同步：读取 ghs.json → 渲染 3 份模板 → 写入 .opencode/agents/*.md
export async function syncAgents(projectDir: string, pluginRoot: string): Promise<{
  written: string[];
  models: { context: string; designer: string; reviewer: string };
  defaults_used: boolean;
}> {
  const config = await loadGhsConfig(projectDir, pluginRoot);
  const defaults_used = !(await fileExists(path.join(projectDir, ".ghs", "ghs.json")));
  
  const agentsDir = path.join(projectDir, ".opencode", "agents");
  await fs.mkdir(agentsDir, { recursive: true });
  
  const written: string[] = [];
  for (const name of ["ghs-context-haiku", "ghs-plan-designer", "ghs-plan-reviewer"] as const) {
    const content = await renderAgentTemplate(name, config, pluginRoot);
    const outPath = path.join(agentsDir, `${name}.md`);
    await Bun.write(outPath, content);
    written.push(outPath);
  }
  
  return { written, models: config.models, defaults_used };
}
```

**优先级与兜底**：
- 用户显式配置（`.ghs/ghs.json` 中非空字段）> plugin 自带默认值（`shared/ghs.default.json`）。
- 若 `.ghs/ghs.json` 完全缺失：`loadGhsConfig` 全部回退到默认值，`syncAgents` 返回 `defaults_used: true` 提示用户。
- 若 `.ghs/ghs.json` 部分字段为空：该字段回退到默认值，其他字段用用户值。
- 若 `.ghs/ghs.json` JSON 格式错误：`loadGhsConfig` 抛错，`ghs-config` tool 返回错误信息（不写入任何文件）。
- 模型 ID 合法性（如 `provider/model-id` 是否存在）：**plugin 不校验**。OpenCode 启动加载 `.opencode/agents/*.md` 时若遇到未知 provider/model 会自行报错，这是用户侧诊断信号。`ghs-config` 仅做格式校验（非空字符串）。

### 3.5 tool 表面设计（详细，Round 6 新增 `ghs-config`）

每个 tool 返回一个普通字符串。所有 tool 接收 `project_dir?`（可选覆盖；默认 = `context.worktree || context.directory`）。

#### `ghs-init`（Round 6 修订）
- **args**：`project_name: string`、`description?: string`、`project_dir?: string`、`force?: boolean`
- **execute**：
  1. `await initProject({projectName, description, projectDir, force})`。
  2. `await validateFeaturesJson({projectDir})`。
  3. **Round 6 新增**：若 `<PROJECT_DIR>/.ghs/ghs.json` 不存在，从 `shared/ghs.default.json` 拷贝（用户后续可编辑）。
  4. **Round 6 新增**：`await syncAgents(projectDir, pluginRoot)` —— 自动生成 `.opencode/agents/ghs-*.md`。
  5. 返回成功文本 + "Next: invoke `ghs-plan-start` to plan. Edit `.ghs/ghs.json` to change subagent models, then run `ghs-config` to sync."

#### `ghs-config`（Round 6 新增）
- **args**：`project_dir?: string`、`dry_run?: boolean`
- **execute**：
  1. 解析项目目录；若 `.ghs/` 缺失则报错（提示先调 `ghs-init`）。
  2. `const result = await syncAgents(projectDir, pluginRoot)`（若 `dry_run == true`，仅渲染不写入，返回预览 diff）。
  3. 返回结构化文本：
     - 写入的文件列表（`written`）。
     - 解析后的模型 ID（`models`）。
     - 是否使用了默认值（`defaults_used`）。
     - 若 `defaults_used == true`，附加提示："No `.ghs/ghs.json` found — used plugin defaults. Edit `.ghs/ghs.json` to customize, then re-run `ghs-config`."
     - 提示用户："Restart your OpenCode session for the new agent definitions to take effect."

#### 其余 8 个 tool（与 Round 5 §3.5 一致）
- `ghs-status`、`ghs-archive`、`ghs-force-archive`、`ghs-sprint`、`ghs-code`、`ghs-plan-start`、`ghs-plan-review`、`ghs-plan-finalize` —— 行为不变。

### 3.6 状态管理（Round 5 + Round 6 新增 `ghs.json`）

- `.ghs/` 位于解析出的项目根目录。
- **Round 6 新增**：`.ghs/ghs.json` 加入 `.ghs/` 状态文件家族：
  - 由 `ghs-init` 创建（从 `shared/ghs.default.json` 拷贝）。
  - 由用户手动编辑（修改 `models.*` 字段）。
  - 由 `ghs-config` tool 读取（不做修改 —— `ghs-config` 只读 `ghs.json`，写 `.opencode/agents/*.md`）。
  - 不进 `.gitignore`（与 `features.json`、`progress.md` 一致 —— 项目级配置应纳入版本控制）。
- `.ghs/features.json`、`.ghs/progress.md`、`.ghs/plans/`、`.ghs/archived/` 与 Round 5 一致。
- **Round 6 新增**：`.opencode/agents/ghs-{context-haiku,plan-designer,plan-reviewer}.md` 是 `ghs-config` 的输出产物。建议纳入版本控制（与 `.ghs/ghs.json` 一致 —— 团队成员共享相同的模型配置）。
- `state.ts` 处理 plan dispatcher 的 `status.json`（与 Round 5 一致，含 R1 的 `codegraph_available` 字段）。
- 其他临时文件与 Round 5 一致。

### 3.7 工作流保留（与 Round 5 一致 + Round 6 新增 config 同步步骤）

OpenCode chat 中的主 AI 驱动每一次状态转移，**通过 Task tool 派发隔离 subagent 完成 LLM 工作**：

1. **init**：主 AI 调 `ghs-init` → plugin 创建 `.ghs/`（含 `ghs.json`）+ 自动调 `syncAgents` 生成 `.opencode/agents/ghs-*.md` → **用户需重启 OpenCode 会话使 agent 定义生效**（首次安装时）。
2. **config（可选，按需）**：用户编辑 `.ghs/ghs.json` 修改模型 ID → 主 AI 调 `ghs-config` → plugin 重新生成 `.opencode/agents/ghs-*.md` → 用户重启会话。
3. **plan**：（与 Round 5 §3.7 步骤 2 完全一致 —— `ghs-plan-start` → Task: `ghs-context-haiku` → `ghs-plan-review(snapshot)` → Task: `ghs-plan-designer` → `ghs-plan-review(plan)` → Task: `ghs-plan-reviewer` → `ghs-plan-review(review)` → `ghs-plan-finalize`）。
4. **sprint**：（与 Round 5 一致）。
5. **code**：（与 Round 5 一致）。
6. **status**：（与 Round 5 一致）。
7. **archive**：（与 Round 5 一致）。

---

## 4. 实现步骤

### 阶段依赖图（Round 6 修订）

```
P0 (spikes: 5 项 — tool key / system.transform / subagent+Task / codegraph MCP / config-sync)
   │
   ├──► P1 (scaffold + 5 stateless script ports + 4 stateless tools + config.ts)
   │       │
   │       ├──► P2 (3 writer ports + sprint tool) ──► P4 (2 parser ports + code tool)
   │       │                                           │
   │       └──► P3 (parse-delimited-output port + plan tools + 3 agent templates + codegraph.ts) ◄──┘
   │                                       │
   │                                       ▼
   └──────────────────────────────────► P5 (packaging + docs + integration tests)
```

### Phase 0：spikes（R1 + R2 + R3 + 保留自 Round 3）

- [ ] **spike #1：连字符 tool key**（保留自 Round 3）：20 行 plugin 注册 `"ghs-spike-test"`；确认加载 / 出现在 tool 列表 / AI 能调用 / JSON 往返。记录到 `shared/SPIKE_RESULTS.md`。
- [ ] **spike #2：`experimental.chat.system.transform` 形状**（保留自 Round 3）：实现 hook push "SPIKE MARKER"；问 AI "repeat any system-prompt markers"；确认到达。
- [ ] **spike #3（R2 关键）：自定义 subagent + Task tool 派发**：在 `.opencode/agents/test-subagent.md` 中声明一个 test subagent（`mode: "subagent"`，`model: "anthropic/claude-haiku-4-20250514"`，`hidden: true`，简单 prompt）。在 chat 中让主 AI "Use the Task tool to dispatch the test subagent"。确认：(a) subagent 会话被创建并隔离；(b) subagent 用 haiku 模型；(c) subagent 响应回到主 AI；(d) 主 AI 能引用该响应；(e) **Round 6 新增**：subagent 的 Markdown 文件经手动编辑 `model` 字段后，重启会话能用新模型（验证 Markdown agent 是 subagent 声明的有效载体）。**若 Task tool 不能可靠派发 subagent，则 R2 的核心假设失败，需回到用户决策**。
- [ ] **spike #4（R1 关键）：codegraph MCP server 声明 + tool 暴露**：在 `opencode.json` 中声明 `mcp.codegraph`。确认：(a) MCP server 进程被启动；(b) 其 tool 出现在主 AI 的可用 tool 列表中；(c) 主 AI 能调用该 tool；(d) 在 subagent 的 prompt 中显式禁止某 MCP tool 调用时，subagent 是否遵守；(e) 可选：在 subagent `permission` 中用 glob 限制 MCP tool 是否有效。
- [ ] **spike #5（R3 关键 —— Round 6 新增）：Markdown agent 模板替换 + 重启生效**：(a) 写一份 `ghs-test.md.template` 含 `__GHS_MODEL_TEST__` 占位符；(b) 用 TS 脚本读取模板、替换占位符、写入 `.opencode/agents/ghs-test.md`；(c) 重启 OpenCode；(d) 确认 `ghs-test` subagent 用替换后的模型 ID 加载（检查日志或派发后看 model ID）；(e) 修改模板中的 `model` 值，重新生成 + 重启，确认新值生效。**若 Markdown agent 文件不能可靠地被 OpenCode 加载，或修改后不能经重启生效，则 R3 的"代码生成"路径失败，需回退到把模型 ID 留在 `opencode.json`（接受硬编码）或尝试 `{env:VAR}` 替换**。
- [ ] **验收**：5 条 spike 结果均已记录；确认连字符 key 可用；system-transform 到达 AI；Task tool 能可靠派发 subagent + Markdown agent 是有效载体；MCP server 能声明并暴露 tool；**模板替换 + 重启生效路径可靠**。

### Phase 1：脚手架 + 5 个无状态脚本移植 + 4 个无状态 tool + config.ts（Round 6 修订）

- [ ] 创建 `package.json`、`tsconfig.json`、`opencode.json`、`README.md` 骨架（仅 Bun 前置依赖；可选 codegraph MCP）。
- [ ] 从源逐字复制 `shared/assets/{features.json, progress.md}` 和 `shared/references/*.md`。
- [ ] **Round 6 新增**：创建 `shared/ghs.default.json`（含 3 个默认模型 ID）和 `shared/ghs.json.example`。
- [ ] 实现 `src/lib/paths.ts`、`project.ts`、`assets.ts`、`nonce.ts`。
- [ ] **Round 6 新增**：实现 `src/lib/config.ts`（`loadGhsConfig` / `validateGhsConfig` / `renderAgentTemplate` / `syncAgents`），含 Zod schema。
- [ ] 按 Round 3 §3.4 D4 移植 5 个无状态脚本。
- [ ] 实现 `src/tools/init.ts`（**Round 6 修订**：含创建 `.ghs/ghs.json` + 自动调 `syncAgents`）、`status.ts`、`archive.ts`、`force-archive.ts`。
- [ ] **Round 6 新增**：实现 `src/tools/config.ts`（`ghs-config` tool）。
- [ ] 实现 `src/plugin.ts`，注册 5 个 tool（4 + config）+ `experimental.chat.system.transform` hook。
- [ ] 等价性测试：`test/equivalence/{init,resolve,validate,status,archive}.test.ts`。
- [ ] **Round 6 新增单元测试**：`test/config.test.ts` —— 测 `loadGhsConfig` 的字段级回退、`renderAgentTemplate` 的占位符替换、`syncAgents` 的写入路径、Zod 校验对非法输入的拒绝。
- [ ] 验证：放入临时项目的 `.opencode/plugins/ghs.ts`，端到端 init → 检查 `.ghs/ghs.json` 与 `.opencode/agents/ghs-*.md` 生成正确。

### Phase 2：3 个 writer 移植 + sprint tool（与 Round 5 一致）

- [ ] 从源复制 `shared/references/{sprint-agent.md, examples.md}`。
- [ ] 移植 `append-sprint.ts`、`update-feature-status.ts`、`append-progress-session.ts`。
- [ ] 移植 sprint 分解提示到 `src/prompts/sprint-planning.ts`。
- [ ] 实现 `src/tools/sprint.ts`。
- [ ] 等价性测试 + 端到端 init → sprint → status。

### Phase 3：parse-delimited-output 移植 + plan tool + 3 个 agent 模板 + codegraph（R1+R2+R3 核心）

- [ ] 从源复制 `shared/references/{context-snapshot-guide.md, plan-designer.md, plan-reviewer.md}`。
- [ ] **R2+R3**：编写 3 个 subagent prompt body 模板到 `shared/agents/{ghs-context-haiku.md.template, ghs-plan-designer.md.template, ghs-plan-reviewer.md.template}`。这些模板逐字或轻度裁剪自源的 `PROMPT_TEMPLATE_CODEGRAPH`、`PROMPT_TEMPLATE_GREP`、`plan-designer.md`、`plan-reviewer.md`，frontmatter 中 `model` 字段用 `__GHS_MODEL_<ROLE>__` 占位符，prompt body 显式包含分隔标记契约 + 输出语言策略（中文正文 + 英文标识符）。
- [ ] **R3**：编写 `shared/opencode.json.example`（**仅** `plugin` + `mcp.codegraph`，**不含** `agent.<name>` 段）。
- [ ] **R1**：实现 `src/lib/codegraph.ts`（`detectCodegraph(projectDir)`）。
- [ ] 按 Round 3 §3.4 D4 移植 `src/lib/scripts/parse-delimited-output.ts`。
- [ ] 实现 `src/lib/state.ts`（plan dispatcher 的 status.json 读写，含 R1 的 `codegraph_available` 字段）。
- [ ] 实现 `src/lib/parse.ts`。
- [ ] 移植提示模板到 `src/prompts/plan-designer.ts`、`plan-reviewer.ts`、`context-codegraph.ts`、`context-grep.ts`。
- [ ] 按 §3.5 实现 `src/tools/plan-start.ts`、`plan-review.ts`、`plan-finalize.ts`。
- [ ] 更新 `src/plugin.ts`，注册全部 10 个 tool。
- [ ] 等价性测试：`test/equivalence/parse-delimited-output.test.ts`。
- [ ] **R2 集成测试**：`test/integration/plan-dispatch.test.ts` —— 端到端跑 plan 循环，断言 3 个 subagent 都被 Task tool 派发、模型 ID 正确（从 `ghs.json` 解析）、`.ghs/plans/` 产物 schema 正确。
- [ ] **R1 集成测试**：`test/integration/codegraph-paths.test.ts` —— 两条路径（codegraph / grep）都跑。
- [ ] **R3 集成测试**：`test/integration/config-sync.test.ts` —— Round 6 新增：(a) `ghs-init` 后 `.ghs/ghs.json` 与 `.opencode/agents/ghs-*.md` 都存在且模型 ID 等于默认值；(b) 修改 `.ghs/ghs.json` 的 `models.context` 后调 `ghs-config`，`.opencode/agents/ghs-context-haiku.md` 的 `model` 字段更新；(c) `.ghs/ghs.json` 缺失时 `ghs-config` 用默认值；(d) `.ghs/ghs.json` JSON 格式错误时 `ghs-config` 返回错误且不写入；(e) `dry_run` 模式不写入文件。
- [ ] **验证**：FAIL 触发一轮修订；max-rounds + 违约上限会终止；Format Recovery 重试路径；**修改 `ghs.json` 后调 `ghs-config` 能正确同步**。

### Phase 4：parse-completion-signal + parallel-utils 移植 + code tool（与 Round 5 一致）

- [ ] 移植 `parse-completion-signal.ts`、`parallel-utils.ts`。
- [ ] 从源复制 `shared/references/coding-agent.md`。
- [ ] 移植 feature-impl 提示到 `src/prompts/feature-impl.ts`。
- [ ] 实现 `src/tools/code.ts`。
- [ ] 等价性测试 + 验证。

### Phase 5：打包 + 文档 + 集成测试（Round 6 修订）

- [ ] 定稿 `package.json`（`"files": ["src", "shared"]`，确保含 `shared/agents/*.md.template` 与 `shared/ghs.default.json`）。
- [ ] 撰写 `README.md`：安装（本地 + npm）、前置依赖（仅 Bun 运行时）、**R1** codegraph MCP 可选安装说明、**R3** 模型配置工作流（编辑 `.ghs/ghs.json` → 调 `ghs-config` → 重启会话）、10 个 tool 词汇表、3 个 subagent 词汇表、工作流、已知限制。
- [ ] 补充 `test/*.test.ts`（bun test）覆盖：`resolveProjectDir`、`parse` 封装、`state.ts`、`nonce.ts`、`codegraph.ts`、**`config.ts`**（含 5 个 R3 子用例）、11 个 TS 脚本冒烟测试。
- [ ] **R1+R2+R3 集成测试套件**：`test/integration/` 下补全 plan-dispatch、codegraph-paths、multi-model-orchestration、**config-sync**（Round 6 新增）4 个测试。
- [ ] 验证：`npm pack` → tarball 含 `src/` + `shared/`（无 `.py`）；通过 `"plugin": ["file:../ghs-opencode"]` 在全新项目中安装 + 合并 `opencode.json.example` 的 `plugin` + `mcp` 段到该项目 `opencode.json` + 调 `ghs-init`（自动生成 `.ghs/ghs.json` + `.opencode/agents/`）+ 安装 codegraph MCP server；跑完整 init→plan→sprint→code→status→archive 循环；**额外验证**：修改 `.ghs/ghs.json` 的 `models.context` → 调 `ghs-config` → 重启 → 确认 context-haiku 用新模型。

---

## 5. 风险与缓解措施

| 风险 | 可能性 | 影响 | 缓解措施 |
|---|---|---|---|
| **用户在 `ghs.json` 中配置了非法模型 ID**（如拼写错误的 provider、不存在的 model） | **Medium** | **Medium** | `ghs-config` 不校验模型 ID 合法性（无法静态校验，OpenCode 自身会在加载时报错）；返回警告提示用户"重启后若 OpenCode 报未知 provider/model 错误，请检查 `.ghs/ghs.json` 中的模型 ID"。Phase 0 spike #5 验证 Markdown agent 文件能被 OpenCode 加载。 |
| **Markdown agent 文件不被 OpenCode 加载**（如目录路径错误、frontmatter 格式错误） | **Low** | **High** | Phase 0 spike #5 在任何真实代码使用该机制前先验证。**通过标准**：手写一份 `.opencode/agents/test.md`，重启 OpenCode，`@test` 能补全或 Task tool 能派发。若失败，回退方案：把模型 ID 留在 `opencode.json` 的 `agent.<name>` 段（接受一定程度的硬编码，由 `ghs-config` 直接生成 `opencode.json` 片段而非 Markdown）。 |
| **修改 `ghs.json` 后用户忘记调 `ghs-config` 或忘记重启会话** | **High** | **Low** | `ghs-config` tool 的返回文本明确提示"Restart your OpenCode session for the new agent definitions to take effect"。`experimental.chat.system.transform` hook 注入的提示也包含"Models are configured in .ghs/ghs.json; run ghs-config after editing"。 |
| **Task tool 不能可靠派发 subagent**（R2 核心假设） | **Low** | **High** | Phase 0 spike #3 在任何真实代码使用该机制前先验证。 |
| **codegraph MCP server 命令在不同环境下不可用**（R1） | **Medium** | **Medium** | plugin 把 codegraph 声明为可选依赖；运行时 `detectCodegraph()` 探测 `.codegraph/` 目录；缺失则自动走 grep 回退路径。 |
| **subagent 不能限制 MCP tool 调用** | **Medium** | **Low** | 与源 plugin 一致 —— 靠 prompt 软约束。Phase 0 spike #4 验证。 |
| **`.opencode/agents/*.md` 与用户既有同名 agent 冲突** | **Low** | **Low** | `ghs-config` 写入前检查文件是否已存在且 frontmatter 含 `description` 以 `GHS ` 开头（标识为 GHS 生成）；若是第三方 agent 则拒绝覆盖并提示用户重命名。 |
| OpenCode 的 tool 发现机制漏掉正确的 `ghs-*` tool | Medium | Medium | `experimental.chat.system.transform` hook 注入一行提示列出全部 10 个 tool + 3 个 subagent。 |
| 多模型编排的成本 | Low | Low | 这正是源 plugin 的设计 —— 与源一致，不是新风险。 |
| TS 移植引入与源 Python 脚本的行为漂移 | Medium | High | 等价性测试套件；CI 门槛。 |
| `parse-delimited-output.py` 的回退策略移植不平凡 | Medium | High | 按 Round 3 §3.4 D4 逐行移植；移植源自带的 26KB 测试文件为 fixture。 |
| JS 正则语义与 Python `re` 存在细微差异 | Medium | Medium | JS 支持 `m`/`s` 标志；在等价性测试中验证。 |
| JSON 序列化按字节兼容性 | Low | Medium | `JSON.stringify(obj, null, 2)` 与 Python `json.dump(indent=2)` + `ensure_ascii=False` 匹配。 |
| `ghs-force-archive` 确认可被绕过 | Medium | High | 转写 nonce 门槛；文档化为弱于源 `AskUserQuestion`。 |
| 并行模式串行化（无真正并发） | High | Low | 接受。v1 正确性 > 速度。 |
| plugin 根目录解析（`import.meta.dir`）在 npm 安装缓存下失效 | Low | Medium | `paths.ts` 相对模块文件解析；Phase 5 npm-pack 测试验证。 |
| tool 内的 `git commit` 让用户措手不及 | Low | Medium | tool 不自动提交；返回指令。 |
| `ghs-plan-review` 的歧义（3 个可选文本参数） | Medium | Medium | Zod `.refine` 强制恰好一个非空；description 明确三种模式。 |

**从 Round 5 风险表移除/修订的内容**：
- ~~"`{file:...}` prompt 路径在 npm 安装下解析失败"~~ —— **Round 6 消除**：subagent prompt 不再依赖 `{file:...}` 引用（Round 5 用 `{file:./node_modules/.../ghs-*.md}` 引用 plugin 内的 prompt body）；Round 6 把 prompt body 直接内联在 `.opencode/agents/ghs-*.md` 的 Markdown 正文中（由模板生成），不依赖跨包文件路径。
- ~~"model IDs in opencode.json.example are hardcoded"~~ —— **Round 6 消除**（这是 R3 的核心目标）：模型 ID 现从 `ghs.json` 读取，不再硬编码。

---

## 6. 测试策略

- **等价性测试**（指令 D2 §6）：`test/equivalence/*.test.ts` 对每个源 `.py` 及其 TS 移植运行相同 fixture 输入并逐字节比对输出。
- **单元测试**（buntest）：
  - `resolveProjectDir`、`parse` 封装、`state.ts`、`nonce.ts`、`codegraph.ts`。
  - **Round 6 新增 `config.ts` 测试**（`test/config.test.ts`）：
    - (a) `loadGhsConfig`：用户配置完整 → 用用户值。
    - (b) `loadGhsConfig`：`.ghs/ghs.json` 缺失 → 全部回退到 `shared/ghs.default.json`，`defaults_used == true`。
    - (c) `loadGhsConfig`：部分字段为空 → 该字段回退，其他用用户值。
    - (d) `loadGhsConfig`：`.ghs/ghs.json` JSON 格式错误 → 抛错。
    - (e) `loadGhsConfig`：`.ghs/ghs.json` 含未知顶层字段 → Zod `.strict()` 拒绝。
    - (f) `renderAgentTemplate`：`__GHS_MODEL_CONTEXT__` / `__GHS_MODEL_DESIGNER__` / `__GHS_MODEL_REVIEWER__` 三个占位符都被正确替换。
    - (g) `renderAgentTemplate`：模板中无占位符时原样返回（不报错）。
    - (h) `syncAgents`：写入 3 份 `.md` 到 `.opencode/agents/`，路径正确。
    - (i) `syncAgents`：`.opencode/agents/` 不存在时自动创建。
    - (j) `syncAgents`：`dry_run == true` 时不写入文件，返回预览内容。
  - 11 个 TS 脚本冒烟测试。
- **集成测试**：
  - `test/integration/plan-dispatch.test.ts`（R2）：端到端跑 3-tool plan 循环。
  - `test/integration/codegraph-paths.test.ts`（R1）：两条路径（codegraph / grep）。
  - `test/integration/multi-model-orchestration.test.ts`（R2）：断言每个 subagent 用对的模型（从 `ghs.json` 解析）。
  - `test/integration/mcp-server.test.ts`（R1）：声明 `mcp.codegraph`，断言其 tool 出现 + 可调用。
  - `test/integration/agent-spawn.test.ts`（R2）：Task tool 派发的 subagent 会话隔离。
  - **Round 6 新增 `test/integration/config-sync.test.ts`（R3）**：
    - (a) `ghs-init` 后 `.ghs/ghs.json` 存在且等于 `shared/ghs.default.json` 内容；`.opencode/agents/ghs-{context-haiku,plan-designer,plan-reviewer}.md` 都存在且 frontmatter 的 `model` 等于默认值。
    - (b) 修改 `.ghs/ghs.json` 的 `models.context` 为 `"openai/gpt-5"` → 调 `ghs-config` → `.opencode/agents/ghs-context-haiku.md` 的 frontmatter `model` 变为 `"openai/gpt-5"`，其他两个文件不变。
    - (c) 删除 `.ghs/ghs.json` → 调 `ghs-config` → 三个 `.md` 都用默认值，返回 `defaults_used: true`。
    - (d) 把 `.ghs/ghs.json` 改为非法 JSON → 调 `ghs-config` → 返回错误，三个 `.md` 不被修改。
    - (e) `ghs-config({dry_run: true})` → 三个 `.md` 不被修改，返回预览 diff。
    - (f) 在 `.opencode/agents/` 已有非 GHS 的同名文件（如手写的 `ghs-context-haiku.md` 且 frontmatter description 不以 "GHS " 开头）→ `ghs-config` 拒绝覆盖并返回提示。
- **端到端手动测试**：在真实 OpenCode 会话中跑完整 init→plan→sprint→code→status→archive 循环，覆盖本地 plugin 与 npm plugin 两种安装路径 + codegraph 可用与不可用两种场景 + **Round 6 新增**：修改 `ghs.json` 模型 ID 后调 `ghs-config` 同步 + 重启会话验证新模型生效。
- **兼容性测试**：取一个由 Claude Code GHS 产出的 `.ghs/`，对其运行 OpenCode `ghs-status` / `ghs-archive`；确认无需迁移（注意：Claude Code GHS 的 `.ghs/` 不含 `ghs.json`，OpenCode `ghs-init` 也不会触碰既有 `.ghs/` —— 用户需手动调 `ghs-config` 用默认值生成 `.opencode/agents/`）。

### 实现的关键文件

- <PROJECT_DIR>/src/lib/config.ts
- <PROJECT_DIR>/src/tools/config.ts
- <PROJECT_DIR>/src/tools/init.ts
- <PROJECT_DIR>/shared/agents/ghs-context-haiku.md.template
- <PROJECT_DIR>/shared/ghs.default.json