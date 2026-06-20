# Golden Hoop Spell for OpenCode

「紧箍咒」是为 [OpenCode](https://opencode.ai) 设计的多角色技术规划编排插件——把 Claude Code 插件 [`golden-hoop-spell`](https://github.com/anthropics/golden-hoop-spell)（参考来源）移植到 OpenCode 平台。

它通过 10 个 `ghs-*` 工具与 3 个内部子代理（context snapshot / plan designer / plan reviewer），把「需求 → 可执行技术计划 → sprint 拆分 → 落地编码 → 归档」的完整工作流固化在 IDE 内部。上下文提取由 [codegraph](https://github.com/cursor-ai/codegraph) MCP server 提供（可选，缺失时自动走 grep 回退）；所有状态都序列化到项目根目录的 `.ghs/` 目录，与源插件字节兼容。

> 插件已达功能完整状态：10 个 tool 全部实现，3 个子代理模板随包发布，端到端工作流（init → config → plan → sprint → code → status → archive）可用。

## 目录

- [安装](#安装)
- [前置依赖](#前置依赖)
- [R1：codegraph MCP server（可选）](#r1codegraph-mcp-server可选)
- [R3：模型配置工作流](#r3模型配置工作流)
- [工具词汇表（10 个 `ghs-*` tool）](#工具词汇表10-个-ghs--tool)
- [子代理词汇表（3 个 subagent）](#子代理词汇表3-个-subagent)
- [工作流](#工作流)
- [已知限制](#已知限制)
- [文档](#文档)

## 安装

本插件提供两条安装路径。安装前请先确认已满足 [前置依赖](#前置依赖)。

### 方式一：npm

```bash
bun add golden-hoop-spell-opencode
# 或
# npm install golden-hoop-spell-opencode
```

### 方式二：本地文件链接（开发/私用场景）

```bash
# 在你的目标项目里，指向本仓库的本地路径
bun add file:./path/to/golden-hoop-spell-opencode
```

### 启用插件

安装后，在目标项目的 `opencode.json`（或 `opencode.jsonc`）中声明该插件。完整示例见 [`shared/opencode.json.example`](./shared/opencode.json.example)：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["golden-hoop-spell-opencode"]
  // 若启用 codegraph MCP，再加 "mcp": { ... } 段（见下方 R1）
}
```

配置好后启动 OpenCode 会话，对 AI 说「调 ghs-init 初始化项目」即可开始。

## 前置依赖

- **仅 Bun 运行时**（开发/运行本插件本身）。插件是纯 TypeScript，由 OpenCode 通过 `@opencode-ai/plugin` SDK 加载，**无 Python 运行时依赖**（源插件的 11 个 Python 脚本已全部用 TypeScript 重写）。
- **OpenCode** ≥ 1.4.3（`@opencode-ai/plugin` peer dep 版本）。
- **可选**：`codegraph` CLI（见 [R1](#r1codegraph-mcp-server可选)）。缺失不影响基础工作流，仅退化为 grep 回退。
- **仅开发期**：本仓库的等价性测试套件（`test/equivalence/*.test.ts`）会调用源插件的 Python 脚本作为 oracle，需要 `python3` 在 PATH 上。这是开发依赖，**不影响**下游安装本插件的用户。

## R1：codegraph MCP server（可选）

codegraph 是本插件的上下文提取后端，提供符号级代码图谱（callers / callees / explore / impact 等）。它**可选**：

- **已安装 codegraph CLI**：在 `opencode.json` 中声明 MCP server，插件运行时会探测 `.codegraph/` 目录，存在则走 codegraph 路径（更精确的上下文）。
- **未安装 codegraph CLI**：插件自动走 grep 回退路径，工作流照常，仅上下文精度略低。

### 安装与声明

```jsonc
// opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["golden-hoop-spell-opencode"],
  "mcp": {
    "codegraph": {
      "type": "local",
      "command": ["codegraph", "serve", "--mcp"],
      "enabled": true
    }
  }
}
```

> **关于启动命令**：Phase 0 spike 验证发现，codegraph CLI 的正确启动子命令是 `codegraph serve --mcp`（而非早期规划文档推测的 `bun x codegraph-mcp`）。后者在没有全局安装 `codegraph` CLI 的环境下也能用——两条命令最终启动同一个 MCP server。详见 [`shared/SPIKE_RESULTS.md`](./shared/SPIKE_RESULTS.md) 的 spike #3。

> **关于 MCP tool 命名**：OpenCode 暴露给主 AI 的 codegraph tool 名称是 `codegraph_codegraph_*`（双层前缀，`<server_name>_<original_tool_name>`）。插件注入的系统提示用描述性措辞（"codegraph MCP tools"）而非硬编码这些名称，避免在不同 OpenCode 版本上失效。

## R3：模型配置工作流

3 个子代理（context / designer / reviewer）各自使用一个模型 ID，**用户可配置**。完整工作流：

1. **初始化**：调 `ghs-init` 后，插件自动从 [`shared/ghs.default.json`](./shared/ghs.default.json) 拷贝一份默认配置到 `<PROJECT_DIR>/.ghs/ghs.json`，并据此生成 `.opencode/agents/ghs-*.md`。

2. **编辑模型**：手动编辑 `.ghs/ghs.json` 的 `models.*` 字段。例如把上下文子代理换成更便宜的模型：

   ```json
   {
     "models": {
       "context": "anthropic/claude-haiku-4-20250514",
       "designer": "anthropic/claude-sonnet-4-20250514",
       "reviewer": "anthropic/claude-sonnet-4-20250514"
     }
   }
   ```

3. **同步**：调 `ghs-config` 工具，插件读取 `.ghs/ghs.json` 并重新渲染 `.opencode/agents/ghs-*.md` 的 `model:` frontmatter 字段。

4. **重启 OpenCode 会话**：OpenCode 在启动时读取 agent markdown，**无热重载**——修改模型后必须重启会话（结束当前 `opencode` 进程再起一个新的）才会生效。

### 默认模型

| 角色 | 字段 | 默认模型 | 选择理由 |
|---|---|---|---|
| context（上下文提取） | `models.context` | `zai-coding-plan/glm-4.5-air` | 结构化信息提取任务，便宜/快速的小模型即可 |
| designer（计划设计） | `models.designer` | `zhipuai-coding-plan/glm-4.6` | 体系结构推理需要较强模型 |
| reviewer（计划评审） | `models.reviewer` | `zhipuai-coding-plan/glm-4.6` | 与设计师同级，给出有价值的反对意见 |

> 默认值取自实际验证环境（智谱 / Z.AI 的 GLM 系列）。原 Claude Code 插件与早期规划文档假设 Anthropic 模型；本仓库默认值用 GLM 系列以便开箱即用，用户可按上文步骤切换。详见 [`shared/ghs.default.json.notes.md`](./shared/ghs.default.json.notes.md)。

## 工具词汇表（10 个 `ghs-*` tool）

每个工具返回一段纯文本字符串。所有工具接收可选的 `project_dir?` 覆盖（默认 = `context.worktree || context.directory`）。

| 工具 | 一句话说明 |
|---|---|
| `ghs-init` | 初始化项目：创建 `.ghs/`（含 `features.json` / `progress.md` / `ghs.json`）+ 自动生成 `.opencode/agents/ghs-*.md`。 |
| `ghs-config` | 读取 `.ghs/ghs.json` 并重新渲染 `.opencode/agents/ghs-*.md`（支持 `dry_run` 预览）；返回写入清单 + 解析的模型 ID + 重启提示。 |
| `ghs-plan-start` | plan 派发链入口：派发 `ghs-context-haiku` 子代理提取上下文快照，进入 plan 循环。 |
| `ghs-plan-review` | plan 循环驱动器（3 种模式：`snapshot` / `plan` / `review`），分别衔接上下文快照 → 设计师 → 评审员三步。 |
| `ghs-plan-finalize` | 把定稿计划写入 `.ghs/plans/` 并更新 `status.json`，结束 plan 循环。 |
| `ghs-sprint` | 按需求生成 sprint 骨架（feature 列表 + 依赖 + 验收标准），写入 `.ghs/features.json`；附带 sprint-planning 提示。 |
| `ghs-code` | 派发编码子代理按单 feature 落地实现；返回 feature-impl 提示，主 AI 继续派发 Task 完成编码。 |
| `ghs-status` | 报告当前项目状态：活跃 sprint、feature 完成统计、最近 session 历史。 |
| `ghs-archive` | 把状态为 `completed` 的 sprint 归档到 `.ghs/archived/`（仅归档已完成的）。 |
| `ghs-force-archive` | 强制归档**所有** sprint（含未完成的）；破坏性操作，带 nonce 确认门槛。 |

## 子代理词汇表（3 个 subagent）

3 个子代理都是 `hidden: true` 的内部编排角色，由 plan 工具通过 Task tool 派发，**不**出现在 `@` 补全里。模型 ID 由 `.ghs/ghs.json` 决定（见 [R3](#r3模型配置工作流)）。

| 子代理 | 模板文件 | 角色 |
|---|---|---|
| `ghs-context-haiku` | [`shared/agents/ghs-context-haiku.md.template`](./shared/agents/ghs-context-haiku.md.template) | 上下文快照提取——扫描代码库，产出一份精简的架构快照供后续设计与评审消费。 |
| `ghs-plan-designer` | [`shared/agents/ghs-plan-designer.md.template`](./shared/agents/ghs-plan-designer.md.template) | 计划设计师——把需求 + 上下文快照转化为可执行的技术计划。 |
| `ghs-plan-reviewer` | [`shared/agents/ghs-plan-reviewer.md.template`](./shared/agents/ghs-plan-reviewer.md.template) | 计划评审员——以架构师视角评审设计师产出的计划，返回 PASS/FAIL 裁决。 |

> `ghs-code` 的编码子代理同样由 Task tool 派发，但它是临时的（由 `ghs-code` 返回的 feature-impl 提示即时构造），不是随包发布的固定模板，故不在本表。

## Slash Commands（8 个 `/ghs-*` 命令）

插件安装后，8 个 `/ghs-*` 斜杠命令在**首次启动时自动注册**——通过 Plugin 的 `config` hook 注入 `cfg.command`，无需手动创建 `.md` 文件或额外重启。

| 命令 | 用法 | 说明 |
|---|---|---|
| `/ghs-init` | `/ghs-init <项目名>` | 初始化 ghs 追踪文件 |
| `/ghs-config` | `/ghs-config` | 重新生成子代理 markdown |
| `/ghs-plan-start` | `/ghs-plan-start` | 启动计划生成流程 |
| `/ghs-sprint` | `/ghs-sprint "<名称>" "<目标>"` | 创建新 sprint |
| `/ghs-code` | `/ghs-code [feature_id] [--parallel]` | 派发 feature 实现 |
| `/ghs-status` | `/ghs-status` | 查看项目状态 |
| `/ghs-archive` | `/ghs-archive [--dry-run\|--list]` | 归档已完成 sprint |
| `/ghs-force-archive` | `/ghs-force-archive <nonce>` | 强制归档所有 sprint |

> 内部 dispatcher 工具 `ghs-plan-review` 和 `ghs-plan-finalize` 不提供斜杠命令——它们由 plan 工作流自动衔接，不直接面向用户。

## 工作流

OpenCode 会话中的主 AI 驱动每一次状态转移，**通过 Task tool 派发隔离子代理完成 LLM 工作**。完整顺序：

```
ghs-init → ghs-config(可选) → ghs-plan-start → ghs-plan-review → ghs-plan-finalize
        → ghs-sprint → ghs-code → ghs-status → ghs-archive
```

1. **init**：调 `ghs-init` 创建 `.ghs/` + `.opencode/agents/ghs-*.md`。首次安装后**需重启 OpenCode 会话**使子代理定义生效。
2. **config（可选，按需）**：编辑 `.ghs/ghs.json` 改模型 ID → 调 `ghs-config` 重新生成 agent markdown → 重启会话生效。详见 [R3](#r3模型配置工作流)。
3. **plan**：`ghs-plan-start` 派发 `ghs-context-haiku` 提取上下文 → `ghs-plan-review(snapshot)` → 派发 `ghs-plan-designer` 出初稿 → `ghs-plan-review(plan)` → 派发 `ghs-plan-reviewer` 评审 → `ghs-plan-review(review)` → `ghs-plan-finalize` 定稿。
4. **sprint**：调 `ghs-sprint` 按定稿计划生成 sprint（含 feature 列表 + 依赖 + 验收标准）。
5. **code**：逐 feature 调 `ghs-code`，主 AI 据返回的提示继续派发 Task 完成编码。
6. **status**：随时调 `ghs-status` 查看进度。
7. **archive**：sprint 完成后调 `ghs-archive` 归档；若有未完成的 sprint 需清理，用 `ghs-force-archive`（带 nonce 确认）。

## 已知限制

以下限制源自规划文档 §5 风险表，用户在使用前应知晓：

- **`ghs-force-archive` 的 nonce 确认门槛弱于源插件**：源 Claude Code 插件用 `AskUserQuestion` 做强确认，本移植改用一次性 nonce 字符串门槛。这是破坏性操作（强制归档所有 sprint，含未完成的），用户调用前务必确认。
- **并行模式串行化（v1）**：`ghs-code --parallel` 的并行子代理当前按串行化实现，v1 优先保证正确性而非速度——没有真正的并发执行。
- **`ghs-config` 不校验模型 ID 合法性**：无法静态校验 provider/model 是否存在；若 `.ghs/ghs.json` 中配了非法模型 ID，OpenCode 在重启加载时会报错。`ghs-config` 的返回文本会附带警告提示。
- **修改模型后必须重启会话**：OpenCode 启动时读取 agent markdown，无热重载；编辑 `.ghs/ghs.json` 并调 `ghs-config` 后，必须结束并重新启动 OpenCode 进程才会生效。
- **plugin 根目录解析依赖 `import.meta.dir`**：在 npm 安装缓存场景下理论上存在解析风险（规划文档列为 Low/Medium），由 `src/lib/paths.ts` 相对模块文件解析缓解，Phase 5 的 npm pack 验证覆盖。
- **`ghs-plan-review` 的 3 参数歧义**：该工具接收 3 个可选文本参数（snapshot/plan/review 三模式），通过 Zod `.refine` 强制恰好一个非空消除歧义；调用时请明确指定模式。

## 文档

- [Phase 0 Spike 结果](./shared/SPIKE_RESULTS.md) — 5 个架构风险 spike 的验证记录 + 3 个与原规划文档的关键差异。
- [默认模型配置说明](./shared/ghs.default.json.notes.md) — 3 个默认模型 ID 的选择理由与自定义方式。
- [OpenCode 配置示例](./shared/opencode.json.example) — plugin + codegraph MCP 声明片段。
- [技术规划文档](./.ghs/plans/2026-06-20-opencode-port.md) — 完整的移植技术方案（架构 / 映射表 / 工具表面 / 风险表 / 测试策略）。sprint 归档后随 `.ghs/archived/` 一并保留。
- 参考文档（随包发布）：[context snapshot](./shared/references/context-snapshot-guide.md) · [plan designer](./shared/references/plan-designer.md) · [plan reviewer](./shared/references/plan-reviewer.md) · [coding agent](./shared/references/coding-agent.md) · [sprint agent](./shared/references/sprint-agent.md) · [examples](./shared/references/examples.md)
