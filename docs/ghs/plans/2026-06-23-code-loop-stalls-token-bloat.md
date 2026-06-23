# 方案：把 code/sprint 阶段的「编排靠散文」收敛为「编排靠 tool」（修订轮次 round 2）

## 0. 问题概述

ghs 的 code/sprint 阶段把编排逻辑写进了工具返回的散文里，而非可调用的 tool。散文命令主 AI 执行一批状态变更操作（parse signal、update status、append feature），但这些操作要么没注册成 tool（Cat 1）、要么根本不存在（Cat 2）、要么缺循环指令（Cat 3）——闭环变成「主 AI 即兴判读 + 手改 JSON」，非确定、依赖模型、烧 token。

本方案分四个阶段（A→B→C→D），每阶段独立可落地、可回滚。核心原则：**补 tool，不补措辞**。

## 0.1 本轮修订摘要（round 2，针对评审 5 Medium + 4 Optimization）

| 评审项 | 落实位置 | 处理 |
|--------|---------|------|
| Medium #1（`tool.schema` 误判） | §9 风险矩阵 A 行；§2.3、§5.3 代码骨架 | 风险矩阵 A 行改「已澄清，无风险」并说明 `tool.schema` 即 zod；`update-feature-status` 的 `status`、`append-feature` 的 `category`/`priority`/`estimated_complexity` 全部改用 `tool.schema.enum([...])`，枚举值与纯函数 `as const` 数组同源 import |
| Medium #2（description 与纯函数不符） | §2.3 tool description | 去掉「Valid transitions」强声明，改为「Sets the feature status; the caller is responsible for transition legality」（方案 b，不改变纯函数契约） |
| Medium #3（循环终止信号未核实） | §3.2 引用 code.ts:242-260 确切文本；§3.4、§8、§10 | 已核实分支返回稳定 header `=== ghs-code: no ready features ===`（无需改分支）；循环指令显式引用该 token；加快照测试固化；收敛判据加终止信号断言 |
| Medium #4（共享模板 `<feature_id>` 多处替换风险） | §4.1 决策与理由；§4.2 dispatch 文本强化 | **保留** C 共享模板（token 收益每周期累积），dispatch 文本显式枚举全部 5 处 `<feature_id>` 出现；加快照测试固化「replace ALL」指令 |
| Medium #5（JSDoc 漏 init/config） | §6 代码层面 | 注释改为完整列表，**追加**三个新 tool 不删除 init/config |
| Opt #1（grep 假阳性） | §10 收敛判据 | grep 范围限定到 PROSE_FILES 并 `rg -v "ghs-|\.ts"` 排除文件名/import/注释；新增权威 `test/prose-contract.test.ts` |
| Opt #2（token 量化基线） | §4.1 | 补典型 N=3-5 的收益量级估算 |
| Opt #3（枚举统一 .enum()） | §2.3、§5.3 | 与 Medium #1 合并落实 |
| Opt #4（终止信号 + getStageSignature 回归） | §8 测试矩阵 | 加 `ready` 为空分支快照；加三个新 tool `getStageSignature` 返回 null 断言 |

---

## 1. 方案总览

| 阶段 | 对应缺口 | 改动摘要 | 新建文件 | 修改文件 |
|------|---------|---------|---------|---------|
| **A** | Cat 1 死函数 | 把 `parseCompletionSignal` / `updateFeatureStatus` 包成 tool，注册到 plugin.ts | 2 | 1 |
| **B** | Cat 3 单周期 | dispatch 文本 + NEXT_ACTION 加显式循环指令（引用确切终止 token） | 0 | 2 |
| **C** | token 膨胀 | `dispatchParallelPlan` 只渲染一次 prompt 模板（共享模板 + 强化替换指令） | 0 | 1 |
| **D** | Cat 2 纯手写 | 新增 `appendFeature` 纯函数 + `ghs-append-feature` tool，修 sprint 拆分 | 2 | 3 |

落地顺序：**A → B → C → D**。A 是关键（修 code 闭环），B 让 A 能连续跑，C 降 token，D 顺带修 sprint。

---

## 2. 阶段 A：注册 ghs-parse-completion-signal + ghs-update-feature-status

### 2.1 设计

两个纯函数已存在且签名稳定，套薄壳即可：

- `parseCompletionSignal(rawText, opts)` — 纯计算，无 IO，直接包装
- `updateFeatureStatus(featuresData, spec)` — 需读盘 + 写盘，tool 层负责持久化（与 `sprintTool` 调 `appendSprint` 的模式一致）

> **tool.schema 即 zod（Medium #1 已澄清）**：核对 `node_modules/@opencode-ai/plugin/dist/tool.d.ts:42-44`，`tool.schema = typeof z`——它是完整的 zod 命名空间（包内嵌 zod v4），`.array()` / `.enum()` / `.min()` / `.refine()` 全部可用。因此所有枚举字段直接用 `tool.schema.enum([...])`，与纯函数内 Zod `as const` 数组**同源 import**，形成 schema 层 + 纯函数层双重但同源校验。本阶段不存在「`.enum()` 可能不可用」的风险。

### 2.2 新建 `src/tools/parse-completion-signal.ts`

薄壳 tool：调纯函数 → 用 `serializeResult` 序列化为 JSON 字符串返回。无 project_dir（纯计算）。

```typescript
import { tool } from "@opencode-ai/plugin";
import {
  parseCompletionSignal,
  serializeResult,
} from "../lib/scripts/parse-completion-signal.ts";

export const parseCompletionSignalTool = tool({
  description:
    "Parse a coding subagent's raw output for the completion signal " +
    "(FEATURE COMPLETE: <id> / FEATURE BLOCKED: <id> - <reason>). " +
    "Returns a compact JSON object: { status, feature_id, reason, strategy, " +
    "warnings }. Call this after each coding subagent returns, before calling " +
    "ghs-update-feature-status.",
  args: {
    raw_text: tool.schema
      .string()
      .describe("The subagent's raw output text to parse."),
    feature_id: tool.schema
      .string()
      .describe(
        "The feature id the subagent was implementing (e.g. s5-feat-003).",
      ),
    min_length: tool.schema
      .number()
      .optional()
      .describe("Minimum raw text length to attempt parsing (default 50)."),
  },
  async execute(args: {
    raw_text: string;
    feature_id: string;
    min_length?: number;
  }): Promise<string> {
    const result = parseCompletionSignal(args.raw_text, {
      feature_id: args.feature_id,
      min_length: args.min_length,
    });
    return serializeResult(result);
  },
});
```

**关键决策**：返回 `serializeResult(result)`（即 `JSON.stringify(result, null, 2)`），与 `parseCompletionSignal` 的 Python CLI 输出格式一致。主 AI 拿到的是确定性结构化结果（~150 字节），无需对 subagent 全文（常上千 token）人工判读。

### 2.3 新建 `src/tools/update-feature-status.ts`

薄壳 tool：读 features.json → 调纯函数 → 写盘。与 `sprintTool` 的 IO 模式完全一致（`Bun.file().text()` + `JSON.parse` → 纯函数 → `Bun.write(JSON.stringify(..., null, 2) + "\n")`）。

> **Medium #1 + Opt #3 落实**：`status` 直接用 `tool.schema.enum(VALID_FEATURE_STATUSES)`，枚举值从纯函数模块同源 import，不再用 `.string()` 模拟。execute 签名随之用推断出的字面量联合类型，spec 构造去掉 `as` 强转。
>
> **Medium #2 落实**：description 去掉「Valid transitions: pending → in_progress → completed / blocked」强声明（纯函数 `updateFeatureStatus` 只校验枚举值 + feature 存在，不校验转换方向，见 `update-feature-status.ts:49-67 / 127-169`），改为「Sets the feature status; the caller is responsible for transition legality」，不改变纯函数既有契约、不引入 scope 蔓延。

```typescript
import { tool } from "@opencode-ai/plugin";
import type { ToolContext } from "@opencode-ai/plugin/tool";
import { join, resolve } from "node:path";

import {
  updateFeatureStatus,
  VALID_FEATURE_STATUSES,
} from "../lib/scripts/update-feature-status.ts";
import { resolveProjectDir } from "../lib/project.ts";

export const updateFeatureStatusTool = tool({
  description:
    "Update a single feature's status in features.json (reads → updates → " +
    "writes back to disk). Call this after ghs-parse-completion-signal returns " +
    "status 'completed' or 'blocked', to record the outcome. Sets the feature " +
    "status; the caller is responsible for transition legality — the underlying " +
    "writer validates the status enum value and feature existence, NOT the " +
    "direction of state transitions.",
  args: {
    feature_id: tool.schema
      .string()
      .describe(
        "Feature id to update (e.g. s5-feat-003). Must match ^s\\d{1,4}-feat-\\d{3}$.",
      ),
    status: tool.schema
      .enum(VALID_FEATURE_STATUSES)
      .describe(
        "New status. One of: pending | in_progress | completed | blocked. " +
        "No transition-direction guard — caller ensures legality.",
      ),
    blocked_reason: tool.schema
      .string()
      .optional()
      .describe("Required when status is 'blocked'."),
    project_dir: tool.schema
      .string()
      .optional()
      .describe(
        "Absolute path of the project root. Defaults to the opencode session's worktree/directory.",
      ),
  },
  async execute(
    args: {
      feature_id: string;
      status: "pending" | "in_progress" | "completed" | "blocked";
      blocked_reason?: string;
      project_dir?: string;
    },
    ctx: ToolContext,
  ): Promise<string> {
    const projectDir = args.project_dir
      ? resolve(args.project_dir)
      : resolveProjectDir(ctx);

    const featuresPath = join(projectDir, ".ghs", "features.json");
    const featuresFile = Bun.file(featuresPath);
    if (!(await featuresFile.exists())) {
      return [
        `❌ features.json not found at ${featuresPath}.`,
        "",
        "Run `ghs-init` first to bootstrap the .ghs/ tracking files.",
      ].join("\n");
    }

    let featuresData;
    try {
      featuresData = JSON.parse(await featuresFile.text());
    } catch (err) {
      return [
        `❌ Failed to parse ${featuresPath}: ${(err as Error).message}`,
      ].join("\n");
    }

    // The pure function's Zod schema re-validates the spec (format, enum,
    // blocked_reason refinement) — same-source double validation. On invalid
    // input it throws ZodError; let it propagate (same pattern as
    // sprintTool → appendSprint).
    const updated = updateFeatureStatus(featuresData, {
      feature_id: args.feature_id,
      status: args.status,
      ...(args.blocked_reason !== undefined
        ? { blocked_reason: args.blocked_reason }
        : {}),
    });

    await Bun.write(featuresPath, JSON.stringify(updated, null, 2) + "\n");

    return [
      `✅ Feature ${args.feature_id} status updated → ${args.status}.`,
      "",
      `Written to ${featuresPath}`,
    ].join("\n");
  },
});
```

**关键决策**：
- `status` 用 `tool.schema.enum(VALID_FEATURE_STATUSES)`——schema 层即 reject 非法值并给 LLM 友好错误（OpenCode 把 ZodError 转 tool error），枚举值与纯函数 `VALID_FEATURE_STATUSES`（`update-feature-status.ts:31-36`）同源 import，消除「string 模拟 enum」的技术债。
- `blocked_reason` 条件构造：仅当传入了才放进 spec（让 Zod 的 `.refine()` 校验 `status === "blocked"` 时必须存在）。
- 错误模式与 sprintTool 一致：文件不存在 → 返回错误文本字符串；数据校验失败 → 让 ZodError 自然上抛（OpenCode surface 为 tool error）。

### 2.4 修改 `src/plugin.ts`

在 tool 注册对象中新增两个 key（10 → 12 个 tool）：

```typescript
// 新增 import
import { parseCompletionSignalTool } from "./tools/parse-completion-signal.ts";
import { updateFeatureStatusTool } from "./tools/update-feature-status.ts";

// tool 对象新增（放在 ghs-code 之后，保持 workflow 顺序）
export const ghsPlugin: Plugin = async () => ({
  tool: {
    "ghs-init": initTool,
    "ghs-config": configTool,
    "ghs-plan-start": planStartTool,
    "ghs-plan-review": planReviewTool,
    "ghs-plan-finalize": planFinalizeTool,
    "ghs-sprint": sprintTool,
    "ghs-code": codeTool,
    "ghs-parse-completion-signal": parseCompletionSignalTool,      // NEW
    "ghs-update-feature-status": updateFeatureStatusTool,          // NEW
    "ghs-status": statusTool,
    "ghs-archive": archiveTool,
    "ghs-force-archive": forceArchiveTool,
  },
  // ... hooks 不变
});
```

同时更新 `SYSTEM_HINT_TEXT`（`src/plugin.ts:84-101`）的 tool 列表，加入两个新 tool 名，使主 AI 在系统提示中能发现它们：

```
"Tools implemented: ghs-init, ghs-config, ghs-plan-start, ghs-plan-review, ghs-plan-finalize, ghs-sprint, ghs-code, ghs-parse-completion-signal, ghs-update-feature-status, ghs-status, ghs-archive, ghs-force-archive. "
```

### 2.5 测试

新建 `test/tools/parse-completion-signal.test.ts`：
- 解析 `FEATURE COMPLETE: s5-feat-003` → 返回 JSON 含 `"status": "completed"`
- 解析 `FEATURE BLOCKED: s5-feat-003 - lint fails` → 返回 JSON 含 `"status": "blocked"`, `"reason": "lint fails"`
- 解析无信号文本 → 返回 `"status": "unknown"`
- 短文本（< min_length）→ `"status": "unknown"` + warning

新建 `test/tools/update-feature-status.test.ts`：
- 正常：pending → completed（temp dir + seed features.json → 调 execute → 读回验证 status 已写入磁盘）
- 传非法 `status`（如 `"done"`）→ schema 层 reject（tool error / ZodError，无需传到纯函数）
- 文件不存在 → 返回 `❌` 错误文本
- feature_id 不存在 → ZodError/Error 上抛
- blocked 不带 reason → ZodError（`.refine()` 校验）
- **回归（Medium #2）**：断言 `completed → pending` 倒退**不被阻止**（纯函数不校验转换方向，行为符合 description 新措辞）

更新 `test/commands.test.ts`：SYSTEM_HINT_TEXT 的 tool 列表断言需加入两个新 tool 名。

---

## 3. 阶段 B：加显式循环指令

### 3.1 设计

当前 `NEXT_ACTION_CODE`（`code.ts:61-62`）只描述一个周期（dispatch → parse → update），无 repeat。主 AI 做完一个周期就停。

修改：把 dispatch 文本和 NEXT_ACTION anchor 改为引用**真实 tool 名** + 加显式循环指令，并显式引用 ghs-code 的确切终止 token。

### 3.2 修改 `src/tools/code.ts`

**(a) 更新 `NEXT_ACTION_CODE`（第 61-62 行）**——循环指令显式引用终止 token：

```typescript
const NEXT_ACTION_CODE =
  "dispatch coding subagent(s) via Task → call ghs-parse-completion-signal on each result → " +
  "call ghs-update-feature-status with {feature_id, status} → re-call ghs-code (same mode) " +
  "until it returns the '=== ghs-code: no ready features ===' banner";
```

> **Medium #3 已核实（终止信号确切文本）**：code.ts 的 `ready.length === 0` 分支（`code.ts:242-260`）当前返回的确切文本如下，其首行 header `=== ghs-code: no ready features ===` 是稳定、可 grep 的终止标记，**无需修改该分支**：
> ```
> === ghs-code: no ready features ===
>
> Project directory: <dir>
> [若存在 cycle：⚠️ Detected N dependency cycle(s) ...]
> 情况 A（skipped 为空）：当前 sprint 没有 pending feature（已全部完成，或 sprint 为空）。
> 情况 B（skipped 非空）：当前 sprint 有 N 个 feature 但无一 ready（依赖未完成、状态非 pending、或处于依赖环中）。
>               用 `ghs-status` 查看各 feature 状态与依赖。
> ```
> 循环指令把原来模糊的 `until it returns 'no ready features'` 替换为引用该 header banner 的确切 token，主 AI 可靠判读「sprint 完成」vs「被依赖阻塞」。

**(b) 更新 `codeTool.description`（第 144-152 行）**：把散文中的 `(parse-completion-signal)` / `updates the feature status` 改为真实 tool 名：

```typescript
description:
  "Entry point of the feature-implementation workflow. Reads features.json, finds the current " +
  "sprint's ready features (status pending AND all dependencies completed), and returns LLM-facing " +
  "dispatch guidance embedding the FEATURE_IMPL_PROMPT plus the selected feature's id/title/AC " +
  "summary — telling the main AI to spawn an isolated coding subagent via the Task tool. " +
  "Pass `parallel=true` to also get conflict-free parallel batches (dispatch plan). Pin a specific " +
  "feature with `feature_id`. The tool does NOT spawn the subagent or write features.json status " +
  "itself — after the subagent returns, the main AI calls ghs-parse-completion-signal then " +
  "ghs-update-feature-status, then re-calls ghs-code until it returns the " +
  "'=== ghs-code: no ready features ===' banner.",
```

**(c) 更新三个 dispatch 函数的散文引用**（循环指令统一引用确切终止 token）：

`dispatchPinnedFeature`（第 408-413 行附近）——把：
```
"subagent 返回后用 parse-completion-signal 解析其完成信号，再调 update-feature-status 更新该 feature 的 status。"
```
改为：
```
"subagent 返回后：调 ghs-parse-completion-signal 解析完成信号 → 调 ghs-update-feature-status 更新 status → 再次调 ghs-code（同 feature_id 或无参数）取下一个 ready feature，直到返回 '=== ghs-code: no ready features ===' banner。"
```

`dispatchSingleFeature`（第 544-549 行附近）——同上改法。

`dispatchParallelPlan`（第 506-510 行附近）——把：
```
"用 parse-completion-signal 逐个解析完成信号，再调 update-feature-status 更新对应 feature 的 status。"
```
改为：
```
"逐个调 ghs-parse-completion-signal 解析完成信号 → 调 ghs-update-feature-status 更新 status → 全部更新后再次调 ghs-code（parallel: true）取下一批，直到返回 '=== ghs-code: no ready features ===' banner。"
```

### 3.3 修改 `src/prompts/feature-impl.ts`

**(a) 第 48 行**：把散文中 `完成信号由 parse-completion-signal 解析` 改为 `完成信号由 ghs-parse-completion-signal tool 解析`。

**(b) 第 78 行**：把 `交给 parse-completion-signal 解析` 改为 `交给 ghs-parse-completion-signal tool 解析`。把 `据此更新 features.json` 改为 `据此调 ghs-update-feature-status 更新 features.json`。

> 注意：仅修改散文引用（line 48 / 78），不动 subagent prompt 正文（line 54-74）。正文中的 `<feature_id>` 占位符由 C 阶段共享模板处理（见 §4）。

### 3.4 测试

更新 `test/code.test.ts`：
- 断言 `NEXT_ACTION_CODE` 输出包含 `ghs-parse-completion-signal`、`ghs-update-feature-status`、`re-call ghs-code`、`=== ghs-code: no ready features ===` 关键词

更新 `test/integration/code-dispatch.test.ts`：
- 三个场景（pinned / parallel / single）的 dispatch 文本断言包含真实 tool 名 + 循环指令 + 终止 token
- 断言不再包含裸 `parse-completion-signal`（无 `ghs-` 前缀的旧引用）

**新增（Medium #3 / Opt #4）终止信号快照测试** `test/code-no-ready.test.ts`：
- seed 一个全部 completed 的 sprint（ready 为空）→ 调 `codeTool.execute` → 断言返回文本首行为 `=== ghs-code: no ready features ===`（固化终止 header，防止后续重构悄悄改掉）
- seed 一个全 blocked/依赖未完成的 sprint（ready 为空、skipped 非空）→ 断言同样 header + skipped 提示

---

## 4. 阶段 C：dispatchParallelPlan token 瘦身

### 4.1 设计与决策（含 Medium #4 评估 + Opt #2 量化）

当前 `dispatchParallelPlan`（`code.ts:470-516`）对每个 ready feature 整段渲染 `renderFeatureImplPrompt(projectDir, brief.id)`（~1.5KB）。N 个 feature = N 份重复 prompt。

**Opt #2 token 量化基线**：实测 `FEATURE_IMPL_PROMPT` 渲染后约 1.5KB（≈400 token）。典型 sprint 的 parallel 批次 N=3-5 feature，C 阶段每周期省 `(N-1)×1.5KB` ≈ 3-6KB（≈800-1600 token）；且 tool 结果常驻 input context，整个 code 阶段多轮循环累积放大（一个 15-feature sprint 走 5 轮 parallel ≈ 累计省 4-5K token）。

**Medium #4 决策：保留共享模板 + 强化替换指令（评审选项 a），不降级。** 理由：
1. token 收益每周期产生、随 input 增长累积放大，非一次性；
2. `<feature_id>` 出现位置**固定且已知**（subagent 正文 5 处、分布于 4 行：line 61 `id == "<feature_id>"`、line 65 commit message `(Feature: <feature_id>)`、line 68 `## Feature ID` 段、line 73 完成信号 `FEATURE COMPLETE: <feature_id>` / `FEATURE BLOCKED: <feature_id>`），把「tool 一次性 `.replaceAll`」换成「主 AI 手动替换」的风险，用**显式枚举全部出现位置**的 dispatch 指令可完全消除；
3. 即便主 AI 仍漏一处，最坏情况（subagent 输出字面 `<feature_id>` → parse 返回 `unknown`）已被既有 Format Recovery 重试循环兜住，损失有界；
4. 选项 b（按 batch 渲染）batch 内多 feature 仍需主 AI 替换 `<feature_id>`，风险与共享方案相同却不省 token，无收益。

因此：只渲染一次 prompt 模板（`<PROJECT_DIR>` 替换、`<feature_id>` 留为字面占位符），末尾统一输出；各 feature 只列 brief。dispatch 文本显式枚举全部 `<feature_id>` 出现位置，要求主 AI 派发每个 Task 前做**全量替换**。

### 4.2 修改 `src/tools/code.ts`

**(a) 新增共享渲染函数**（替代 per-feature 的 `renderFeatureImplPrompt` 调用）：

```typescript
/**
 * Render FEATURE_IMPL_PROMPT once with <PROJECT_DIR> substituted but
 * <feature_id> left as a literal placeholder. The main AI replaces ALL
 * <feature_id> occurrences per Task dispatch call (see the explicit
 * enumeration in dispatchParallelPlan).
 */
function renderFeatureImplPromptShared(projectDir: string): string {
  return FEATURE_IMPL_PROMPT.replace(/<PROJECT_DIR>/g, projectDir);
}
```

**(b) 重构 `dispatchParallelPlan`（第 470-516 行）**——batch 内每个 feature 只输出 brief，不再嵌 `renderFeatureImplPrompt`；所有 batch 之后统一输出一次共享 prompt，并附**显式全量替换指令**（Medium #4 落实）：

```typescript
function dispatchParallelPlan(
  ready: Feature[],
  projectDir: string,
  cycleWarning: string,
): string {
  const batches = buildBatches(ready);
  const briefs = ready.map(toBrief);

  const lines: string[] = [];
  lines.push("=== ghs-code: parallel dispatch plan ===");
  lines.push("");
  lines.push(`Project directory: ${projectDir}`);
  if (cycleWarning) {
    lines.push(cycleWarning.trimEnd());
    lines.push("");
  }
  lines.push(
    `当前 sprint 有 ${ready.length} 个 ready feature，分成 ${batches.length} 个无文件冲突批次：`,
  );
  lines.push("");

  batches.forEach((batch, batchIdx) => {
    lines.push(`## Batch ${batchIdx + 1}（${batch.length} feature，文件无冲突，可并发派发）`);
    lines.push("");
    for (const feat of batch) {
      const brief = briefs.find((b) => b.id === (feat["id"] as string | undefined));
      if (!brief) continue;
      lines.push(`### ${brief.id} — ${brief.title}`);
      lines.push(formatBrief(brief));
      lines.push("");
    }
  });

  // 共享 prompt 模板——只渲染一次。主 AI 派发每个 Task 前必须全量替换 <feature_id>。
  lines.push("--- feature-impl dispatch prompt (shared template) ---");
  lines.push(
    "⚠️ 下方模板中 <feature_id> 为字面占位符，ghs-code 未预填。派发每个 feature 的 Task 前，" +
    "必须将模板中【所有】<feature_id> 出现替换为目标 feature id（共 5 处，分布于 4 行）：",
  );
  lines.push("  1. feature 查找：id == \"<feature_id>\"");
  lines.push("  2. commit message：(Feature: <feature_id>)");
  lines.push("  3. ## Feature ID 段：<feature_id>");
  lines.push("  4. 完成信号：FEATURE COMPLETE: <feature_id> 与 FEATURE BLOCKED: <feature_id>");
  lines.push("  漏替换任一处会导致 subagent prompt 内部不一致 → parse 返回 unknown → 触发重试。");
  lines.push("");
  lines.push(renderFeatureImplPromptShared(projectDir));
  lines.push("");

  lines.push(
    "每个 feature 独立派发 coding subagent（各 Task call 互不依赖）。所有 subagent 返回后，",
  );
  lines.push(
    "逐个调 ghs-parse-completion-signal 解析完成信号 → 调 ghs-update-feature-status 更新 status → 全部更新后再次调 ghs-code（parallel: true）取下一批，直到返回 '=== ghs-code: no ready features ===' banner。",
  );
  lines.push(
    "并行 git 守则：每个 subagent 显式 `git add <实现文件路径>` 做**恰好一次** commit（禁 `git add -A`/`add .`/`reset`，禁提交 `.ghs/*`），避免兄弟 commit 被 orphan。",
  );
  return lines.join("\n");
}
```

**关键决策**：`dispatchSingleFeature` 和 `dispatchPinnedFeature` 不改渲染逻辑——单 feature 只渲染一次 prompt，无 N×膨胀问题，保持 `<feature_id>` 预替换（主 AI 直接复制即用，无多处替换风险）。

### 4.3 测试

更新 `test/integration/code-dispatch.test.ts` parallel 场景：
- 断言 `--- feature-impl dispatch prompt` 只出现 **1 次**（而非 N 次）
- 断言各 batch feature brief（id/title）仍存在
- 断言共享模板含 `<feature_id>` 字面占位符（未被替换）
- **新增（Medium #4）**：断言 dispatch 文本含显式全量替换指令关键词 `所有` / `共 5 处` / `FEATURE COMPLETE: <feature_id>`（固化强化指令，防止后续重构悄悄删掉）

---

## 5. 阶段 D：新增 ghs-append-feature

### 5.1 设计

全仓无 `append-feature` 函数。sprint 拆分靠主 AI 手写 JSON 塞进 features.json（零 schema 校验）。新增纯函数 + tool 修复此缺口。

### 5.2 新建 `src/lib/scripts/append-feature.ts`

仿 `append-sprint.ts` 的设计模式（纯函数、Zod 校验、immutable、无 IO）。

> **Opt #3 同源**：`VALID_CATEGORIES` / `VALID_PRIORITIES` / `VALID_COMPLEXITIES` 必须 `export`（`as const`），供 tool 层 `.enum()` 同源 import。

```typescript
import { z } from "zod";

type JsonObject = Record<string, unknown>;
export type FeaturesData = JsonObject;
export type Sprint = JsonObject;
export type Feature = JsonObject;

const SPRINT_ID_PATTERN = /^s\d{1,4}$/;
const FEATURE_ID_PATTERN = /^s\d{1,4}-feat-\d{3}$/;

// ⬇ export 给 tool 层 .enum() 同源使用（Opt #3）
export const VALID_CATEGORIES = ["core", "ui", "api", "auth", "data", "infra"] as const;
export const VALID_PRIORITIES = ["high", "medium", "low"] as const;
export const VALID_COMPLEXITIES = ["small", "medium", "large"] as const;

export const AppendFeatureSpecSchema = z.object({
  sprint_id: z
    .string()
    .regex(SPRINT_ID_PATTERN, "sprint_id must match ^s\\d{1,4}$"),
  feature: z.object({
    id: z
      .string()
      .regex(FEATURE_ID_PATTERN, "feature id must match ^s\\d{1,4}-feat-\\d{3}$"),
    category: z.enum(VALID_CATEGORIES),
    priority: z.enum(VALID_PRIORITIES),
    title: z.string().min(1),
    description: z.string().min(1),
    acceptance_criteria: z.array(z.string()).min(1),
    technical_notes: z.string().optional(),
    dependencies: z.array(z.string()).default([]),
    estimated_complexity: z.enum(VALID_COMPLEXITIES),
    files_affected: z.array(z.string()).default([]),
  }),
});

export type AppendFeatureSpec = z.infer<typeof AppendFeatureSpecSchema>;

export function appendFeature(
  featuresData: FeaturesData,
  spec: AppendFeatureSpec,
): FeaturesData {
  const validated = AppendFeatureSpecSchema.parse(spec);

  const sprints = Array.isArray(featuresData.sprints)
    ? (featuresData.sprints as Sprint[])
    : [];

  // Locate target sprint
  const sprintIdx = sprints.findIndex((s) => s.id === validated.sprint_id);
  if (sprintIdx === -1) {
    throw new Error(`Sprint '${validated.sprint_id}' not found`);
  }

  const targetSprint = sprints[sprintIdx];
  const features = Array.isArray(targetSprint.features)
    ? (targetSprint.features as Feature[])
    : [];

  // Uniqueness check
  if (features.some((f) => f.id === validated.feature.id)) {
    throw new Error(
      `Feature '${validated.feature.id}' already exists in sprint '${validated.sprint_id}'`,
    );
  }

  // Build the new feature with status: "pending" (matches SPRINT_PLANNING_PROMPT convention)
  const newFeature: Feature = {
    ...validated.feature,
    status: "pending",
  };

  // Immutable rebuild: clone path from root to the new feature
  const updatedFeatures = [...features, newFeature];
  const updatedSprint: Sprint = { ...targetSprint, features: updatedFeatures };
  const updatedSprints = [...sprints];
  updatedSprints[sprintIdx] = updatedSprint;

  return { ...featuresData, sprints: updatedSprints };
}
```

**关键决策**：
- `status` 硬编码为 `"pending"`——新追加的 feature 恒为 pending（`SPRINT_PLANNING_PROMPT` 指示 "status 初始为 pending"），tool 不接受外部 status 参数。
- `feature_id` 由主 AI 提供（非自动生成）——AI 在拆分时需要控制 id 分配以设置 `dependencies[]`（dependency 链引用 feature_id），自动生成会破坏依赖关系建模。
- `acceptance_criteria` 至少 1 条（`.min(1)`）——无 AC 的 feature 不可测，违反 SPRINT_PLANNING_PROMPT 的可测原则。
- `dependencies` / `files_affected` 默认 `[]`——使用 `.default([])`。

### 5.3 新建 `src/tools/append-feature.ts`

薄壳 tool：展平 feature 字段为 tool args（主 AI 调用更自然），内部组装 `AppendFeatureSpec` 调纯函数。

> **Medium #1 + Opt #3 落实**：`category` / `priority` / `estimated_complexity` 全部用 `tool.schema.enum([...])`，枚举值从纯函数模块同源 import，execute 签名用推断字面量联合类型，spec 构造去掉 `as` 强转。

```typescript
import { tool } from "@opencode-ai/plugin";
import type { ToolContext } from "@opencode-ai/plugin/tool";
import { join, resolve } from "node:path";

import {
  appendFeature,
  VALID_CATEGORIES,
  VALID_PRIORITIES,
  VALID_COMPLEXITIES,
} from "../lib/scripts/append-feature.ts";
import { resolveProjectDir } from "../lib/project.ts";

export const appendFeatureTool = tool({
  description:
    "Append a single feature (status: pending) to a sprint in features.json " +
    "(reads → appends → writes back to disk). Call this repeatedly during " +
    "sprint planning to decompose the sprint goal into atomic features. " +
    "The feature id format must be s{N}-feat-{NNN} matching the sprint.",
  args: {
    sprint_id: tool.schema
      .string()
      .describe("Target sprint id (e.g. s5). Must match ^s\\d{1,4}$."),
    feature_id: tool.schema
      .string()
      .describe("Feature id (e.g. s5-feat-001). Must match ^s\\d{1,4}-feat-\\d{3}$."),
    category: tool.schema
      .enum(VALID_CATEGORIES)
      .describe("Feature category. One of: core | ui | api | auth | data | infra."),
    priority: tool.schema
      .enum(VALID_PRIORITIES)
      .describe("Feature priority. One of: high | medium | low."),
    title: tool.schema.string().min(1).describe("Feature title (中文)."),
    description: tool.schema
      .string()
      .min(1)
      .describe("Feature description (中文, the single source of truth for the subagent)."),
    acceptance_criteria: tool.schema
      .array(tool.schema.string())
      .min(1)
      .describe("Acceptance criteria (Given/When/Then format, at least 1)."),
    technical_notes: tool.schema
      .string()
      .optional()
      .describe("Implementation guidance / pointers (中文)."),
    dependencies: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("Feature ids this depends on (must be completed first)."),
    estimated_complexity: tool.schema
      .enum(VALID_COMPLEXITIES)
      .describe("Complexity estimate. One of: small (<2h) | medium (2-4h) | large (4h+)."),
    files_affected: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("Files this feature will touch (for parallel batch conflict detection)."),
    project_dir: tool.schema
      .string()
      .optional()
      .describe(
        "Absolute path of the project root. Defaults to the opencode session's worktree/directory.",
      ),
  },
  async execute(
    args: {
      sprint_id: string;
      feature_id: string;
      category: "core" | "ui" | "api" | "auth" | "data" | "infra";
      priority: "high" | "medium" | "low";
      title: string;
      description: string;
      acceptance_criteria: string[];
      technical_notes?: string;
      dependencies?: string[];
      estimated_complexity: "small" | "medium" | "large";
      files_affected?: string[];
      project_dir?: string;
    },
    ctx: ToolContext,
  ): Promise<string> {
    const projectDir = args.project_dir
      ? resolve(args.project_dir)
      : resolveProjectDir(ctx);

    const featuresPath = join(projectDir, ".ghs", "features.json");
    const featuresFile = Bun.file(featuresPath);
    if (!(await featuresFile.exists())) {
      return [
        `❌ features.json not found at ${featuresPath}.`,
        "",
        "Run `ghs-init` first to bootstrap the .ghs/ tracking files.",
      ].join("\n");
    }

    let featuresData;
    try {
      featuresData = JSON.parse(await featuresFile.text());
    } catch (err) {
      return [
        `❌ Failed to parse ${featuresPath}: ${(err as Error).message}`,
      ].join("\n");
    }

    const updated = appendFeature(featuresData, {
      sprint_id: args.sprint_id,
      feature: {
        id: args.feature_id,
        category: args.category,
        priority: args.priority,
        title: args.title,
        description: args.description,
        acceptance_criteria: args.acceptance_criteria,
        ...(args.technical_notes !== undefined
          ? { technical_notes: args.technical_notes }
          : {}),
        dependencies: args.dependencies ?? [],
        estimated_complexity: args.estimated_complexity,
        files_affected: args.files_affected ?? [],
      },
    });

    await Bun.write(featuresPath, JSON.stringify(updated, null, 2) + "\n");

    return [
      `✅ Feature ${args.feature_id} appended to sprint ${args.sprint_id} (status: pending).`,
      "",
      `Written to ${featuresPath}`,
    ].join("\n");
  },
});
```

### 5.4 修改 `src/plugin.ts`

注册第三个新 tool（12 → 13 个 tool）：

```typescript
import { appendFeatureTool } from "./tools/append-feature.ts";

// tool 对象新增（放在 ghs-sprint 之后，sprint 拆分的自然延伸）
"ghs-sprint": sprintTool,
"ghs-append-feature": appendFeatureTool,        // NEW
"ghs-code": codeTool,
```

更新 `SYSTEM_HINT_TEXT` tool 列表加入 `ghs-append-feature`。

### 5.5 修改散文引用点

**`src/tools/sprint.ts`（第 205-207 行）**——把：
```
"Next: decompose the sprint goal into atomic features and append each via",
"`update-feature-status` (initial status: pending). Then flip the sprint status",
"to in_progress once you start coding.",
```
改为：
```
"Next: decompose the sprint goal into atomic features and append each via",
"`ghs-append-feature` (status defaults to pending). Once all features are appended,",
"update the sprint status to in_progress, then call `ghs-code` to start implementation.",
```

**`src/prompts/sprint-planning.ts`（第 27 行）**——把：
```
逐个用 update-feature-status 追加（status 初始为 pending）
```
改为：
```
逐个用 ghs-append-feature 追加（status 默认为 pending，schema 校验 id/category/priority 等字段）
```

### 5.6 测试

新建 `test/append-feature.test.ts`（纯函数测试）：
- 正常追加：空 sprint → append → sprint.features 含新 feature，status="pending"
- sprint 不存在 → 抛 Error
- feature_id 重复 → 抛 Error
- spec 缺必填字段 → ZodError
- illegal enum value（category="foo"）→ ZodError
- immutable：输入对象不被修改

新建 `test/tools/append-feature.test.ts`（tool 集成测试）：
- 正常追加到 temp dir → 读回 features.json 验证
- 传非法 `category`（如 "foo"）→ schema 层 reject（tool error / ZodError）
- 文件不存在 → 错误文本
- sprint 不存在 → 错误（ZodError/Error）

更新 `test/commands.test.ts`：SYSTEM_HINT_TEXT 断言加入 `ghs-append-feature`。

---

## 6. Stage 推断决策：getStageSignature 对新 tool 的处理

**结论：三个新 tool 全部归类为单步工具（`getStageSignature` 返回 `null`），不纳入 stage 推断。**

**理由**：

| 新 tool | 性质 | 为什么返回 null |
|---------|------|----------------|
| `ghs-parse-completion-signal` | 纯计算 | 无状态变更，不触发阶段转换。它是 code 阶段内的子操作。 |
| `ghs-update-feature-status` | 原子写盘 | 它是 code 阶段内的子操作（dispatch→parse→**update**→re-call）。如果把 `code:<feature_id>` 作为它的 stage，那么在两次 `ghs-code` 调用之间穿插 `ghs-update-feature-status` 会造成 `lastStageSeenByTool` 的 false drift——`classifyStaleState` 会误判为 stage 变更，发出虚假 `staleTodoWarning`。 |
| `ghs-append-feature` | 原子写盘 | 它是 sprint-planning 阶段的子操作。`ghs-sprint` 已返回 null（单步），planning 阶段的 todo 面板由 `ghs-sprint` 的 `todoDirective` 引导。如果给 `ghs-append-feature` 一个 stage，会与 `ghs-sprint` 的 null 产生不一致。 |

**代码层面**：`getStageSignature`（`todo-tracker.ts:132-169`）的末尾 `return null` 已覆盖所有未列出的 tool 名。三个新 tool 自然落入此分支，**不需要修改 `todo-tracker.ts` 的 if-else 逻辑**——只需更新 JSDoc 注释。

> **Medium #5 落实**：当前注释（`todo-tracker.ts:167`）为 `// init / config / sprint / status / archive / force-archive — single-step.`。修订为（**追加**三个新 tool，不删除 init/config）：
> ```
> // init / config / sprint / append-feature / parse-completion-signal /
> // update-feature-status / status / archive / force-archive — single-step.
> ```

**兜底 hook 无影响**：`plugin.ts:189-208` 的 `tool.execute.after` hook 首行门禁 `if (!input.tool.startsWith("ghs-")) return;` 仍通过；`getStageSignature` 对新 tool 返回 null → hook 提前 return，不做 stage 标注——正确行为。

---

## 7. 散文引用点全量更新清单

汇总所有需更新的散文引用（确保修复后无「命令主 AI 调用不存在的 tool」的祈使句）：

| 文件 | 行 | 旧引用 | 新引用 | 阶段 |
|------|-----|--------|--------|------|
| `code.ts` | 61-62 | `NEXT_ACTION_CODE`: "parse the completion signal and update feature status" | 含 `ghs-parse-completion-signal` → `ghs-update-feature-status` → re-call `ghs-code` until `=== ghs-code: no ready features ===` banner | B |
| `code.ts` | 150-152 | `description`: "(parse-completion-signal) and updates the feature status" | `ghs-parse-completion-signal` then `ghs-update-feature-status`, then re-call until banner | B |
| `code.ts` | 408-413 | `dispatchPinnedFeature`: "用 parse-completion-signal 解析…再调 update-feature-status" | 真实 tool 名 + 循环指令 + 终止 token | B |
| `code.ts` | 506-510 | `dispatchParallelPlan`: "用 parse-completion-signal…再调 update-feature-status" | 真实 tool 名 + 循环指令 + 终止 token | B |
| `code.ts` | 470-516 | `dispatchParallelPlan`: per-feature `renderFeatureImplPrompt` | 共享模板渲染一次 + 显式全量替换指令 | C |
| `code.ts` | 544-549 | `dispatchSingleFeature`: "用 parse-completion-signal…再调 update-feature-status" | 真实 tool 名 + 循环指令 + 终止 token | B |
| `feature-impl.ts` | 48 | "完成信号由 parse-completion-signal 解析" | `ghs-parse-completion-signal tool` | B |
| `feature-impl.ts` | 78 | "交给 parse-completion-signal 解析…据此更新 features.json" | `ghs-parse-completion-signal tool`… `ghs-update-feature-status` | B |
| `sprint.ts` | 205-207 | "append each via update-feature-status" | `ghs-append-feature` | D |
| `sprint-planning.ts` | 27 | "逐个用 update-feature-status 追加" | `ghs-append-feature` | D |
| `plugin.ts` | 86 | SYSTEM_HINT tool 列表 (10 tools) | 13 tools | A+D |

---

## 8. 测试矩阵

| 阶段 | 测试文件 | 类型 | 覆盖内容 |
|------|---------|------|---------|
| A | `test/tools/parse-completion-signal.test.ts` | 新建 | tool execute → serializeResult JSON (completed/blocked/unknown) |
| A | `test/tools/update-feature-status.test.ts` | 新建 | tool execute → 读盘→纯函数→写盘；非法 status schema reject；文件缺失；feature 不存在；blocked 缺 reason；**completed→pending 倒退不被阻止（Medium #2）** |
| A | `test/commands.test.ts` | 更新 | SYSTEM_HINT tool 列表含两个新 tool |
| B | `test/code.test.ts` | 更新 | NEXT_ACTION_CODE 含循环指令 + 真实 tool 名 + 终止 token |
| B | `test/integration/code-dispatch.test.ts` | 更新 | 三场景 dispatch 文本含真实 tool 名 + 循环 + 终止 token；无裸 `parse-completion-signal` |
| B | `test/code-no-ready.test.ts` | **新建（Opt #4 / Medium #3）** | `ready` 为空分支快照，固化 `=== ghs-code: no ready features ===` header（skipped 空/非空两情形） |
| C | `test/integration/code-dispatch.test.ts` | 更新 | parallel dispatch 只渲染 1 次 prompt 模板；共享模板含 `<feature_id>` 字面；含显式全量替换指令（`所有`/`共 5 处`/`FEATURE COMPLETE: <feature_id>`）（Medium #4） |
| D | `test/append-feature.test.ts` | 新建 | 纯函数 appendFeature (正常/sprint 不存在/重复/缺字段/illegal enum/immutable) |
| D | `test/tools/append-feature.test.ts` | 新建 | tool execute → 读盘→纯函数→写盘；非法 category schema reject |
| D | `test/commands.test.ts` | 更新 | SYSTEM_HINT tool 列表含 ghs-append-feature |
| 全局 | `test/prose-contract.test.ts` | **新建（Opt #1）** | 程序化断言 PROSE_FILES 中每个 tool-name stem（parse-completion-signal / update-feature-status / append-feature）的非注释、非 import 行均带 `ghs-` 前缀 |
| 全局 | `test/todo-tracker.test.ts` | 更新（Opt #4） | 断言三个新 tool 名调 `getStageSignature` 返回 null（防未来误加 stage 分支引入 false drift） |

**验证命令**（AGENTS.md 规定，无 lint / 无 CI）：
```bash
bun run typecheck && bun test
```

---

## 9. 风险与回滚

| 阶段 | 风险 | 等级 | 缓解 |
|------|------|------|------|
| A | ~~`tool.schema` 不支持 `.array()` / `.enum()`~~ | **已澄清，无风险（Medium #1）** | `node_modules/@opencode-ai/plugin/dist/tool.d.ts:42-44` 确认 `tool.schema = typeof z`（即 zod v4 本身），`.array()` / `.enum()` / `.min()` / `.refine()` 全部可用。本 plan 的 `append-feature` `acceptance_criteria: .array(.string()).min(1)`、`status`/`category`/`priority`/`estimated_complexity` 的 `.enum([...])` 均直接使用，与纯函数 `as const` 数组同源 import。风险矩阵原「逗号分隔 string + split」退化方案废弃。 |
| A | ZodError 上抛导致 tool result 不友好 | 低 | 与 sprintTool→appendSprint 模式一致（均不 catch ZodError）。OpenCode surface 为 tool error，主 AI 可据此修正参数重试。`.enum()` 在 schema 层就 reject 非法值，错误更早更友好。 |
| A | `ghs-update-feature-status` 无转换方向保护（Medium #2） | 低（已通过 description 措辞澄清） | 纯函数 `updateFeatureStatus` 只校验枚举值 + feature 存在（`update-feature-status.ts:49-67/127-169`），不校验转换方向。description 已去掉「Valid transitions」强声明，改为「caller is responsible for transition legality」，与实现一致。工作流里主 AI 通常只在 parse 后调一次，幂等写无害；测试固化「倒退不被阻止」行为符合新契约。 |
| B | 循环指令被主 AI 忽略（模型遵循度） | 中 | 这是 best-effort nudge（机制一特性）。但与原版不同：现在每步是真实 tool（A 阶段保证），确定性闭环不依赖循环指令遵循度——主 AI 做完一个周期即使停了，用户再 `/ghs-code` 也是走 tool 而非手改 JSON。循环指令只是减少手动干预频率。 |
| B | 循环终止信号判读（Medium #3） | 低（已核实） | code.ts:242-260 的 `ready.length === 0` 分支返回稳定 header `=== ghs-code: no ready features ===`，循环指令显式引用该确切 token；`test/code-no-ready.test.ts` 快照固化该 header，防止后续重构悄悄改掉。 |
| C | 共享模板含 `<feature_id>` 占位符，主 AI 漏替换（Medium #4） | 低 | dispatch 文本**显式枚举全部 5 处出现**（feature 查找 / commit message / Feature ID 段 / 完成信号 ×2）并警告「漏替换 → parse unknown → 重试」；`test/integration/code-dispatch.test.ts` 固化该强化指令。最坏情况被既有 Format Recovery 重试循环兜住，损失有界。已评估 token 收益（N=3-5 每周期省 3-6KB）值得保留共享方案。 |
| D | AI 生成的 feature_id 格式/编号不一致 | 低 | 纯函数 Zod schema 校验 `^s\d{1,4}-feat-\d{3}$`，非法格式直接 reject。 |
| 全局 | 回滚 | — | 每阶段独立：A 回滚 = 从 plugin.ts 删 2 个 key + 删 2 个文件；B 回滚 = revert code.ts/feature-impl.ts 文本 + 删 test/code-no-ready.test.ts；C 回滚 = revert dispatchParallelPlan；D 回滚 = 从 plugin.ts 删 1 个 key + 删 2 个文件 + revert sprint.ts/sprint-planning.ts 文本。 |

---

## 10. 收敛判据

修复后重新执行启发式审计：工具返回文本里不应再有任何「命令主 AI 执行一个不存在的 tool」的祈使句，且循环终止信号稳定可判读。

> **Opt #1 落实（grep 假阳性）**：把 grep 范围限定到 PROSE_FILES（仅含会产出散文指令的文件，不含 `src/lib/scripts/*.ts` 文件名/import），并用 `rg -v "ghs-|\.ts|^\s*//"` 排除文件名后缀、import、注释行。权威校验由 `test/prose-contract.test.ts` 程序化完成（§8），下述 grep 为快速人工审计。

```bash
PROSE_FILES="src/tools/code.ts src/tools/sprint.ts src/prompts/feature-impl.ts src/prompts/sprint-planning.ts"

# 1. 终止信号 header 稳定存在且唯一（Medium #3）
rg -n "=== ghs-code: no ready features ===" src/tools/code.ts
# expect: 1 match（被 test/code-no-ready.test.ts 快照固化）

# 2. 循环指令存在
rg -n "re-call.*ghs-code|until.*no ready" src/tools/code.ts
# expect: ≥1 match

# 3. PROSE_FILES 中无裸 tool-name stem（无 ghs- 前缀、非文件名、非 import、非注释）
rg -n "parse-completion-signal|update-feature-status|append-feature" $PROSE_FILES \
  | rg -v "ghs-|\.ts|^\s*//|^\s*\*"
# expect: 空输出（每条散文引用都带 ghs- 前缀）
#   说明：仍可能残留极少注释行误报，以 test/prose-contract.test.ts 为准

# 4. 共享模板全量替换指令存在（Medium #4）
rg -n "所有.*<feature_id>|共 5 处|FEATURE COMPLETE: <feature_id>" src/tools/code.ts
# expect: ≥1 match

# 5. 类型 + 测试全绿
bun run typecheck && bun test
```

**两条硬性「不做什么」（不变）**：
1. 不把循环 / 递归派发塞进 `ghs-code.execute()`（请求/响应模型约束）——循环仍由主 AI 驱动（re-call `ghs-code`）。
2. 不把业务逻辑塞进 tool `execute`——薄壳只做读盘→调纯函数→写盘（仿 sprintTool→appendSprint）。