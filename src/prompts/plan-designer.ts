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
- context snapshot 路径或全文（上一轮 ghs-context-haiku 的产物）

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
