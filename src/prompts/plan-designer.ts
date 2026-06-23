// LLM-facing dispatch instruction for the `ghs-plan-designer` subagent.
//
// This constant is the dispatch text the main AI consumes after it returns a
// snapshot via `ghs-plan-review(snapshot)` (plan §3.5 / §3.7 step: Task:
// ghs-plan-designer). It tells the main AI to use the Task tool to dispatch
// the `ghs-plan-designer` subagent, what input to feed it (the context
// snapshot + the requirement), and the hard delimiter protocol the designer
// must obey so `parse-delimited-output.ts` (s3-feat-003) can extract its
// output in the subsequent `ghs-plan-review(plan)` call.
//
// It is NOT a verbatim copy of `shared/references/plan-designer.md` — that
// file is the human-readable reference doc baked into the designer
// subagent's own prompt body (s3-feat-001 template). This constant is the
// tight, command-style dispatch directive the main chat AI reads from the
// tool result to drive the plan loop forward.
//
// Language policy (per CLAUDE.md): human-readable prose is 中文, code
// identifiers / field names / delimiter tokens stay English.

/**
 * Dispatch instruction for the plan-designer subagent.
 *
 * Returned as part of a plan tool's output text so the main AI immediately
 * knows how to spawn `ghs-plan-designer` via the Task tool and what output
 * contract to enforce.
 *
 * Kept to ~600-1200 chars: enough to pin the delimiter protocol, the
 * snapshot-first working approach, the completion signal, and the language
 * policy; short enough to land in a tool result without crowding it. For the
 * full human-readable reference, see `shared/references/plan-designer.md`.
 */
export const PLAN_DESIGNER_PROMPT = `接下来请用 Task tool 派发 \`ghs-plan-designer\` subagent 设计技术方案。subagent 收到的是 context snapshot + 需求描述，产出一份可执行的技术 plan。详见 shared/references/plan-designer.md。

输入给 subagent（拼在 Task 派发的 prompt 里）：
- 需求描述（用户原始需求 + 任何已澄清的约束）
- context snapshot 路径或全文（上一轮 ghs-context-explorer 的产物）

工作方式（务必让 subagent 遵守）：
- 先读 context snapshot，再按需补读个别源文件；snapshot 已覆盖架构概览/模块职责/数据模型时不要再全文复读
- 方案须与现有架构一致、分阶段可执行、可回滚、可测试
- 若需要用户澄清无法从代码/需求推断的事项，首行输出 \`QUESTION: <问题>\`

分隔标记契约（硬性，parser 据此提取 plan）：
- plan 全文必须放在 \`<<<PLAN_START>>>\` 与 \`<<<PLAN_END>>>\` 之间，两个标记各占独立一行
- 不要把标记或内容包进 markdown 代码围栏（不要用三反引号包裹）
- 不要翻译/改写标记：禁止 \`《《PLAN_START》》\`、\`<<PLAN_START>>\`、\`<<< PLAN_START >>>\` 等变体
- 使用字面 ASCII 字符 \`<\`、\`>\`、\`_\`
- 正确示例：
    <<<PLAN_START>>>
    # 方案标题
    ...正文...
    <<<PLAN_END>>>
    PLAN DESIGN COMPLETE

完成信号：设计完成输出 \`PLAN DESIGN COMPLETE\`；需用户澄清输出 \`QUESTION: <具体问题>\`（不要用 QUESTION 替代你自己的技术判断）。

输出语言策略（与 CLAUDE.md 一致）：方案正文/章节标题/风险描述用中文；代码标识符、字段名、枚举值、文件路径、日志/错误信息用英文。

收到 subagent 的分隔标记输出后，请把整段（含标记）原样作为 \`plan\` 参数调用 \`ghs-plan-review\` 进入 plan 模式评审。`;

// -----------------------------------------------------------------------------
// Mechanism 二 §3.2.1 改造点(派发 prompt 选择器) — Feature s1-feat-008
// -----------------------------------------------------------------------------
//
// When `planner_backend === "builtin-plan"`, the main AI dispatches the opencode
// BUILT-IN `plan` agent (Config.agent.plan, name="plan") instead of the ghs-
// self-built `ghs-plan-designer` subagent. The built-in agent has NO pre-baked
// ghs delimiter contract (its system prompt is whatever Config.agent.plan.prompt
// says or the SDK default), so the contract MUST be embedded in the dispatch
// prompt itself for `parsePlan` (src/lib/parse.ts) to extract the agent's
// output. Spike s1-feat-006 verified this is feasible: Task dispatches by agent
// name string, and the dispatch prompt is arbitrary text the contract can be
// concatenated into. LLM compliance with the injected contract is an empirical
// question deferred to manual E2E (plan §5 R3 / D3).
//
// Language policy (AGENTS.md): LLM-facing prompts use English — so the BUILTIN
// prompt below is English, while PLAN_DESIGNER_PROMPT above (predating this
// policy clarification) stays Chinese and untouched.

/**
 * Named constants for the two delimiter tokens. PLAN_DESIGNER_PROMPT_BUILTIN
 * refers to the markers by name (plan §3.2.1: "只用名称指代起始/结束分隔标记,
 * 不写死字面量") rather than hardcoding the literal inline.
 *
 * PLAN_DESIGNER_PROMPT (above) keeps its inline literals unchanged — do NOT
 * retrofit (regression-free).
 */
const PLAN_START_MARKER = "<<<PLAN_START>>>";
const PLAN_END_MARKER = "<<<PLAN_END>>>";

/**
 * Dispatch instruction for the BUILT-IN `plan` agent.
 *
 * Isomorphic to {@link PLAN_DESIGNER_PROMPT} in shape (dispatch → input →
 * working approach → delimiter contract → completion signal → language policy
 * → next step) but does NOT duplicate the full body — only the delimiter-
 * contract segment is shared (referred to by marker name via the constants
 * above). Surrounding framing is English per the LLM-facing-prompt language
 * policy.
 *
 * Used by `getDesignerPrompt("builtin-plan")`; wired into plan-review.ts by
 * feat-009.
 */
export const PLAN_DESIGNER_PROMPT_BUILTIN = `Next, dispatch the BUILT-IN \`plan\` agent via the Task tool (agent: "plan") to design the technical plan. The agent receives a context snapshot + the requirement and produces an executable technical plan.

Input to feed the agent (concatenate into the Task dispatch prompt):
- Requirement description (user's original requirement + any clarified constraints)
- Context snapshot path or full text (produced by the previous ghs-context-explorer run)

Working approach (ensure the agent follows):
- Read the context snapshot first, then selectively read individual source files only as needed; do not re-read entire files when the snapshot already covers architecture overview / module responsibilities / data model
- The plan must be consistent with the existing architecture, phased, executable, rollback-safe, and testable
- If an item cannot be inferred from code/requirement and needs user clarification, output \`QUESTION: <question>\` on the first line

Delimiter contract (HARD requirement — the built-in agent does NOT have this contract pre-baked, so it MUST be honoured from this dispatch prompt; the parser extracts the plan by these tokens):
- The full plan text MUST be placed between \`${PLAN_START_MARKER}\` and \`${PLAN_END_MARKER}\`, each marker on its own line
- Do NOT wrap the markers or content in markdown code fences (no triple backticks)
- Do NOT translate or rewrite the markers; use literal ASCII characters \`<\`, \`>\`, \`_\`
- Correct example:
    ${PLAN_START_MARKER}
    # Plan Title
    ...body...
    ${PLAN_END_MARKER}
    PLAN DESIGN COMPLETE

Completion signal: output \`PLAN DESIGN COMPLETE\` when design is done; output \`QUESTION: <specific question>\` if user clarification is needed (do not use QUESTION as a substitute for your own technical judgement).

Output language policy (consistent with CLAUDE.md): plan body / section headings / risk descriptions in 中文; code identifiers, field names, enum values, file paths, and log/error strings in English.

After receiving the agent's delimited output, pass the entire segment (markers included) verbatim as the \`plan\` argument to \`ghs-plan-review\` to enter plan-mode review.`;

/**
 * Select the plan-designer dispatch prompt based on the configured backend.
 *
 * @param backend - value of `config.planner_backend` from `loadGhsConfig`
 *                  (z.enum(["ghs-plan-designer", "builtin-plan"])). The literal
 *                  union is used here (rather than importing the zod type) to
 *                  keep this prompt module decoupled from config.ts.
 * @returns `PLAN_DESIGNER_PROMPT` for the default ghs self-built subagent path;
 *          `PLAN_DESIGNER_PROMPT_BUILTIN` for the opt-in built-in `plan` agent.
 *
 * Mechanism 二 §3.2.1 改造点(b): plan-review.ts reads `planner_backend` via
 * `loadGhsConfig` and passes it here. The default path preserves the existing
 * output unchanged (regression-free); the builtin path is pure opt-in.
 */
export function getDesignerPrompt(backend: "ghs-plan-designer" | "builtin-plan"): string {
  return backend === "builtin-plan" ? PLAN_DESIGNER_PROMPT_BUILTIN : PLAN_DESIGNER_PROMPT;
}
