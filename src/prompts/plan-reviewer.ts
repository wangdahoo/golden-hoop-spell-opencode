// LLM-facing dispatch instruction for the `ghs-plan-reviewer` subagent.
//
// This constant is the dispatch text the main AI consumes after it returns a
// plan via `ghs-plan-review(plan)` (plan §3.5 / §3.7 step: Task:
// ghs-plan-reviewer). It tells the main AI to use the Task tool to dispatch
// the `ghs-plan-reviewer` subagent, what input to feed it (the plan + the
// context snapshot), and the hard delimiter protocol + verdict line the
// reviewer must obey so `parse-delimited-output.ts` (s3-feat-003) can extract
// its output and the dispatcher can read PASS/FAIL in the subsequent
// `ghs-plan-review(review)` call.
//
// It is NOT a verbatim copy of `shared/references/plan-reviewer.md` — that
// file is the human-readable reference doc baked into the reviewer
// subagent's own prompt body (s3-feat-001 template). This constant is the
// tight, command-style dispatch directive the main chat AI reads from the
// tool result.
//
// Language policy (per CLAUDE.md): human-readable prose is 中文, code
// identifiers / field names / delimiter tokens stay English.

/**
 * Dispatch instruction for the plan-reviewer subagent.
 *
 * Returned as part of a plan tool's output text so the main AI immediately
 * knows how to spawn `ghs-plan-reviewer` via the Task tool and what output
 * contract to enforce (delimiter + verdict line).
 *
 * Kept to ~600-1300 chars: enough to pin the delimiter protocol, the
 * verdict line format, the severity taxonomy, the snapshot-first review
 * approach, and the language policy. For the full human-readable reference,
 * see `shared/references/plan-reviewer.md`.
 */
export const PLAN_REVIEWER_PROMPT = `接下来请用 Task tool 派发 \`ghs-plan-reviewer\` subagent 评审技术方案。subagent 从架构师视角审查 plan 的可行性/完整性/可执行性，产出带严重度分级的评审报告。详见 shared/references/plan-reviewer.md。

输入给 subagent（拼在 Task 派发的 prompt 里）：
- 待评审的 plan 全文（上一轮 ghs-plan-designer 的产物）
- context snapshot 路径或全文（用于核对 plan 与现有架构的一致性）

工作方式（务必让 subagent 遵守）：
- 先读 context snapshot 建立架构基线，再读 plan，按架构上下文逐条评估
- 只在需要核对 plan 中某条具体断言时才补读源文件
- 每条反馈必须带严重度：Severe（会导致 bug/数据丢失/安全漏洞/逻辑不自洽）/ Medium（方向对但实现路径有问题）/ Optimization（不影响实现但能提质）
- 你是 guardian 不是 grader：反馈要帮 designer 改进方案，但真正的架构缺陷绝不能放过

分隔标记契约（硬性，parser 据此提取 review）：
- review 报告全文必须放在 \`<<<REVIEW_START>>>\` 与 \`<<<REVIEW_END>>>\` 之间，两个标记各占独立一行
- 不要把标记或内容包进 markdown 代码围栏（不要用三反引号包裹）
- 不要翻译/改写标记：禁止 \`《《REVIEW_START》》\`、\`<<REVIEW_START>>\`、\`<<< REVIEW_START >>>\` 等变体
- 使用字面 ASCII 字符 \`<\`、\`>\`、\`_\`

裁决行（硬性，dispatcher 据此读 PASS/FAIL）：
- 紧跟 \`<<<REVIEW_END>>>\` 之后，独占一行输出：
  \`REVIEW COMPLETE | Verdict: PASS|FAIL | Severe: X Medium: Y Optimization: Z\`
- PASS = 仅 Optimization 项、无 Severe/Medium；FAIL = 存在任一 Severe/Medium
- 缺失或格式错误的裁决行会被 dispatcher 重试

完成信号：评审完成输出上述裁决行；需用户澄清（真·业务抉择）输出 \`QUESTION: <具体问题>\`。

输出语言策略（与 CLAUDE.md 一致）：评审报告正文/章节标题/问题描述用中文；代码标识符、字段名、严重度枚举（Severe/Medium/Optimization）、Verdict 值（PASS/FAIL）用英文。

收到 subagent 的分隔标记输出后，请把整段（含标记 + 裁决行）原样作为 \`review\` 参数调用 \`ghs-plan-review\` 进入 review 模式判定。PASS 则推进到 \`ghs-plan-finalize\`；FAIL 则触发 designer 修订（附评审报告）。`;
