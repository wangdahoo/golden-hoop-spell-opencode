// =============================================================================
// Spike: builtin plan agent Task 派发 + 分隔标记遵循探查
// Feature: s1-feat-006 | 对应方案 §3.2.2 + §5 R3/D3
// =============================================================================
//
// 【探查目标】(对应 AC §3.2.2 / features.json s1-feat-006)
//   验证 opencode 内置 Config.agent.plan 能否被 Task tool 派发、输出是否遵循
//   注入的 ghs 分隔标记契约。结论决定 feat-009 按 builtin 实现 还是 降级为
//   文档引导(对应 D3)。
//
// 【探查方法】
//   纯静态类型/协议分析(无真实 LLM 调用 —— 隔离 subagent 环境不具备 LLM 能力，
//   且方案明确「不需真正跑通完整 LLM 调用」)。依据来源:
//     1. opencode SDK 类型定义 node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts
//     2. 现有 ghs-plan-designer 派发链路 (src/prompts/plan-designer.ts +
//        shared/agents/ghs-plan-designer.md.template + src/lib/parse.ts)
//     3. Task tool 派发协议 (SubtaskPartInput)
//
// -----------------------------------------------------------------------------
// 【发现 1: Config.agent.plan 存在 —— C5 确认】
//
//   方案 §1.2 C5 引用「types.gen.d.ts:1273」—— 该行号对应 v4.1 定稿时所见
//   SDK 版本。当前本机安装版本行号漂移至 1112-1118，但结构不变:
//
//     // types.gen.d.ts:1112-1118 (本机版本)
//     agent?: {
//         plan?: AgentConfig;      // <-- 内置 plan agent 配置入口
//         build?: AgentConfig;
//         general?: AgentConfig;
//         explore?: AgentConfig;
//         [key: string]: AgentConfig | undefined;
//     };
//
//   AgentConfig 结构 (types.gen.d.ts:835-877) 与 ghs 自建 agent 同型:
//     { model?, temperature?, top_p?, prompt?, tools?, disable?, description?,
//       mode?: "subagent"|"primary"|"all", color?, maxSteps?, permission? }
//
//   即: 内置 plan agent 与 ghs-plan-designer 共用同一套配置 schema，opt-in 切换
//   不需要新的协议层。(机制二 §3.2.1 改造点(a) loadGhsConfig 加 planner_backend
//   合法，类型层面无障碍。)
//
// -----------------------------------------------------------------------------
// 【发现 2: Task tool 按字符串 agent name 派发 —— 派发内置 plan agent 无类型障碍】
//
//   Task tool 的协议载荷 SubtaskPartInput (types.gen.d.ts:1263-1269):
//
//     export type SubtaskPartInput = {
//         id?: string;
//         type: "subtask";
//         prompt: string;
//         description: string;
//         agent: string;   // <-- 关键: agent 是名字符串，非枚举
//     };
//
//   内置 agent 的 name 来自 Config.agent 的 map key —— 即内置 plan agent 的名字
//   就是 "plan"(与 "build"/"general"/"explore" 并列)。Agent 类型
//   (types.gen.d.ts:1399-1428) 的 name: string + builtIn: boolean 字段印证。
//
//   => 派发内置 plan agent = Task(prompt=..., description=..., agent="plan").
//      现有 ghs-plan-designer 派发 = Task(..., agent="ghs-plan-designer").
//      两者唯一差异是 agent name 字符串值。feat-009 的 getDesignerPrompt 选择器
//      产生的派发指令只需替换这个 name + 内嵌分隔标记契约说明即可。
//
// -----------------------------------------------------------------------------
// 【发现 3: 内置 plan agent 无预置 ghs 分隔标记 —— 须在派发指令内嵌契约】
//
//   现有 ghs-plan-designer 的分隔标记契约(<<<PLAN_START>>> / <<<PLAN_END>>>)
//   是**烘焙进 agent markdown** 的(shared/agents/ghs-plan-designer.md.template
//   line 87-117「Output format — delimiter contract (CRITICAL)」)。parser 侧
//   (src/lib/parse.ts parsePlan) 按 kind:"plan" 家族提取。
//
//   内置 plan agent 的 prompt = Config.agent.plan.prompt(用户自定义或系统默认)，
//   **不会**预置 ghs 分隔标记契约。直接复用则 parser 提取失败(R3 风险具现)。
//
//   缓解(方案 §3.2.1 选择器 + feat-008 的核心): 派发指令内嵌契约说明 ——
//   现有 PLAN_DESIGNER_PROMPT(src/prompts/plan-designer.ts:43-53)已经是这种
//   「派发指令携带契约」的形态:
//
//     分隔标记契约（硬性，parser 据此提取 plan）：
//     - plan 全文必须放在 `<<<PLAN_START>>>` 与 `<<<PLAN_END>>>` 之间...
//     - 不要把标记或内容包进 markdown 代码围栏...
//     - 不要翻译/改写标记...
//
//   feat-008 新增的 PLAN_DESIGNER_PROMPT_BUILTIN 沿用同一模式: 在派发 prompt
//   里把契约说明塞给内置 plan agent。**类型/协议层面完全可行** —— 派发 prompt
//   是任意字符串，契约说明可任意拼接。
//
// -----------------------------------------------------------------------------
// 【发现 4: LLM 是否遵循注入的分隔标记 —— 经验性问题，静态分析无法断言】
//
//   「派发指令里写了契约」≠「LLM 一定照办」。内置 plan agent 的 system prompt
//   (Config.agent.plan.prompt)可能与 ghs 分隔标记契约竞争 —— 若内置 prompt 强
//   势压过 dispatch prompt 的契约段，LLM 可能输出自由格式 → parser 落入
//   empty/malformed 分支。这是 R3 的本质，属于 LLM-compliance 经验问题。
//
//   隔离 subagent 环境无真实 LLM，无法跑通端到端验证。=> 归入「需手动 E2E 确认」。
//
// -----------------------------------------------------------------------------
// 【发现 5: 嵌套 Task 派发可行性 —— 主路径不依赖嵌套】
//
//   SubtaskPartInput 是标准消息协议的一部分;内置 plan agent 若其 tools 允许 Task
//   工具则可嵌套派发。但机制二的设计是**主 AI**(primary)派发内置 plan agent，
//   不是 subagent 嵌套 subagent。主 AI 恒有 Task 工具。=> 嵌套派发对机制二非关键
//   路径，本 spike 不深入。
//
// =============================================================================
// 【结论】 builtin 路径**可实现**(类型/协议层零障碍)，但 LLM 对注入分隔标记的
//         遵循度**需手动 E2E 确认**(对应 R3/D3)。
//
//   - Config.agent.plan 存在(C5 确认)，schema 与 ghs 自建 agent 同型。
//   - Task tool 按 agent name 字符串派发，内置 plan agent name="plan"。
//   - 分隔标记契约可经派发指令内嵌(feat-008 PLAN_DESIGNER_PROMPT_BUILTIN)。
//   - LLM 遵循度 = 经验问题，静态 spike 无法断言 → 归入手动 E2E。
//
// 【feat-009 决策】 按 builtin 实现(不降级为纯文档引导):
//   - feat-007 loadGhsConfig 加 planner_backend(默认 ghs-plan-designer)
//   - feat-008 PLAN_DESIGNER_PROMPT_BUILTIN + getDesignerPrompt 选择器
//   - feat-009 plan-review.ts 读取入口 + 两类错误处理
//   - D3 降级已内置在设计中:
//       (a) planner_backend 默认 ghs-plan-designer —— 用户不 opt-in 永不受影响;
//       (b) parsePlan empty/malformed 分支返回重试指令(R3 具现时的兜底);
//       (c) 最坏情况 builtin 仅作 shared/references/plan-designer.md 文档引导。
//
// 【需手动 E2E 确认的待办】(记入 E2E_CHECKLIST.md，feat-013 落地)
//   1. 在真实 OpenCode 会话设置 Config.agent.plan + ghs.json planner_backend=
//      "builtin-plan"，跑完整 plan 流程。
//   2. 断言内置 plan agent 输出含 <<<PLAN_START>>> + <<<PLAN_END>>> 且各占独立
//      一行(未被 markdown 围栏包裹、未翻译标记)。
//   3. 断言 parsePlan 提取成功 → ghs-plan-review(plan) 进入 review 流程。
//   4. 失败时断言 D3 兜底: parsePlan 返回 empty/malformed → 派发指令含重试提示。
//
// =============================================================================

// 类型层探针: 自包含最小类型素描(从 types.gen.d.ts:835-877 / 1112-1118 /
// 1263-1269 / 1399-1428 摘取关键字段)，证明「Config.agent.plan 存在 + Task
// 派发内置 plan agent 类型合法」。
//
// 为何不 `import type { ... } from "@opencode-ai/sdk/..."`: 本文件被 tsconfig.json
// exclude(spikes/)且不在 package.json files，不入包、不被 src import —— 仅作文档
// 性静态断言。自包含类型素描避免依赖外部模块解析(standalone tsc 解析 .d.ts 路径
// 脆弱)，且字段名/结构直接摘自 SDK 类型源，结论可独立核对。
//
// 核对方式: 对照 node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts 行号
// (见 SPIKE_META.sdkLine* 字段)。

// ---- SDK 类型素描(摘关键字段，非完整) ----
type AgentConfigProbe = {
  model?: string;
  prompt?: string;
  mode?: "subagent" | "primary" | "all";
  // ... 见 types.gen.d.ts:835-877
};
type ConfigProbe = {
  agent?: {
    plan?: AgentConfigProbe; // <-- 内置 plan agent 入口 (types.gen.d.ts:1113)
    build?: AgentConfigProbe;
    general?: AgentConfigProbe;
    explore?: AgentConfigProbe;
    [key: string]: AgentConfigProbe | undefined;
  };
};
type AgentProbe = {
  name: string; // <-- Task 派发用的 agent 字符串 (builtIn plan agent → "plan")
  builtIn: boolean;
  mode: "subagent" | "primary" | "all";
  prompt?: string;
  // ... 见 types.gen.d.ts:1399-1428
};
type SubtaskPartInputProbe = {
  id?: string;
  type: "subtask";
  prompt: string;
  description: string;
  agent: string; // <-- 关键: agent 是名字符串，非枚举 (types.gen.d.ts:1268)
};

// ---- 探针 A: Config.agent.plan 字段存在(compile-time) ----
// 若未来 SDK 移除 plan 字段，此赋值类型报错 → spike 失效信号。
const _probeA = (cfg: ConfigProbe): AgentConfigProbe | undefined =>
  cfg.agent?.plan;

// ---- 探针 B: 内置 plan agent 的 Agent.builtIn 标记 ----
// builtIn=true 即内置;name 即 Task 派发用的 agent 字符串。
const _probeB = (a: AgentProbe): "plan-dispatchable" | "not-builtin" =>
  a.builtIn && a.name === "plan" ? "plan-dispatchable" : "not-builtin";

// ---- 探针 C: Task 派发内置 plan agent 的载荷形态(compile-time) ----
// 证明 agent:"plan" 是合法 SubtaskPartInput —— 无类型障碍。
const _probeC: SubtaskPartInputProbe = {
  type: "subtask",
  description: "Dispatch builtin plan agent with ghs delimiter contract embedded",
  agent: "plan", // <-- 内置 plan agent name
  prompt: [
    "<内嵌的 ghs 分隔标记契约说明，由 feat-008 PLAN_DESIGNER_PROMPT_BUILTIN 产生>",
    "",
    "分隔标记契约（硬性，parser 据此提取 plan）：",
    "- plan 全文必须放在 `<<<PLAN_START>>>` 与 `<<<PLAN_END>>>` 之间，两个标记各占独立一行",
    "- 不要把标记或内容包进 markdown 代码围栏（不要用三反引号包裹）",
    "- 不要翻译/改写标记：禁止 `《《PLAN_START》》`、`<<PLAN_START>>`、`<<< PLAN_START >>>` 等变体",
    "- 使用字面 ASCII 字符 `<`、`>`、`_`",
    "- 正确示例：",
    "    <<<PLAN_START>>>",
    "    # 方案标题",
    "    ...正文...",
    "    <<<PLAN_END>>>",
    "    PLAN DESIGN COMPLETE",
  ].join("\n"),
};

// 防止「unused」静默: 导出一个常量标明 spike 元数据(不入包，仅本文件可见)。
export const SPIKE_META = {
  featureId: "s1-feat-006",
  verdict: "implementable-with-manual-e2e" as const,
  planRefs: ["§3.2.2", "§5 R3", "§5 D3"],
  sdkLineConfigAgentPlan: 1113, // 本机版本(方案 v4.1 引用 1273)
  sdkLineSubtaskPartInput: 1263,
  // 结论复述(供编排者写入 progress.md):
  summary:
    "builtin 路径可实现(Config.agent.plan 存在 + Task 按 name 派发 + 契约可内嵌" +
    "派发指令);LLM 对注入分隔标记的遵循度需手动 E2E 确认(对应 R3/D3)。feat-009 " +
    "按 builtin 实现，D3 降级(默认 ghs-plan-designer + parsePlan malformed 兜底)" +
    "已内置在设计中。",
};
