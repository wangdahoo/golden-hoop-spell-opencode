// LLM-facing dispatch prompt for the coding subagent that implements a single
// feature.
//
// This constant is the dispatch text the main AI consumes after it selects a
// ready feature via the `ghs-code` tool (plan §3.5 / §3.7 step 5: code). It
// tells the main AI to use the Task tool to spawn an isolated coding subagent
// that implements ONE feature end-to-end (context-reset → read features.json →
// implement + verify AC → single commit → return EXACTLY ONE completion
// signal). The subagent's return signal is then parsed by
// `parse-completion-signal.ts` (s4-feat-001).
//
// It is NOT a verbatim copy of `shared/references/coding-agent.md` — that file
// is the human-readable reference doc (session protocol, parallel mode,
// testing requirements). This constant is the tight, command-style dispatch
// template the main chat AI reads from the `ghs-code` tool result and hands to
// the subagent. It distills coding-agent.md §Implementation Process +
// §Session Protocol + the §Critical Rules into the smallest prompt that
// reliably drives a single-feature implementation.
//
// Two placeholders MUST be substituted by the `ghs-code` tool before the main
// AI dispatches the subagent:
//   - `<PROJECT_DIR>`  → absolute project root (from `resolveProjectDir`)
//   - `<feature_id>`   → the selected feature's `id` (e.g. `s4-feat-004`)
// The prompt deliberately contains NO inline feature details — the subagent
// reads them from `.ghs/features.json` per Task step 1 (single source of
// truth). It also needs no `<sprint_id>` placeholder: the subagent locates its
// feature by `id == "<feature_id>"` across `sprints[].features[]`.
//
// Language policy (per CLAUDE.md): human-readable prose is 中文, code
// identifiers / field names / signal tokens / git commands stay English. The
// subagent is told to follow the same policy when it writes its commit message
// and any docs.

/**
 * Dispatch prompt template for the single-feature coding subagent.
 *
 * Returned as part of the `ghs-code` tool's output text so the main AI can
 * hand it (with `<PROJECT_DIR>` and `<feature_id>` substituted) to the Task
 * tool to spawn the implementer.
 *
 * Kept to ~900-1600 chars: enough to pin the context-reset stance, the
 * features.json-first feature lookup, the implement-and-verify loop, the
 * single-commit contract (explicit `git add` paths, no `.ghs/` writes), and
 * the hard completion-signal protocol; short enough to land in a tool result
 * without crowding it. For the full human-readable reference, see
 * `shared/references/coding-agent.md`.
 */
export const FEATURE_IMPL_PROMPT = `实现本项目的一个 feature。用 Task tool 派发一个隔离的 coding subagent 完成端到端实现，返回的完成信号由 ghs-parse-completion-signal tool 解析。详见 shared/references/coding-agent.md。

派发前请替换两个占位符（ghs-code tool 已注入）：\`<PROJECT_DIR>\`（项目根绝对路径）与 \`<feature_id>\`（所选 feature 的 id）。prompt 内不含任何 inline feature 细节——subagent 自己从 features.json 读取。

subagent prompt 正文（原样交给 Task tool）：

---
Implement ONE feature for this project.

## CONTEXT RESET - READ THIS FIRST
This is an isolated task. Disregard prior context, assume nothing, read files fresh, start clean.

## Your Task
1. 打开 \`<PROJECT_DIR>/.ghs/features.json\`，在 \`sprints[].features[]\` 中按 \`id == "<feature_id>"\` 找到你的 feature。读取它的 \`description\`/\`acceptance_criteria\`/\`technical_notes\`/\`files_affected\`——这些是你的唯一事实来源，不是 title。
2. 若所属 sprint 含 \`plan_ref\` 字段，打开该 plan 文件（相对项目根）并读取 \`technical_notes\` 引用的章节（例如 "参考 plan §3.3 ..." 即读 §3.3）。若 \`plan_ref\` 缺失或文件不存在，记一行 warning 后照 \`technical_notes\` 原文执行。
3. 读 \`<PROJECT_DIR>/.ghs/progress.md\` 了解近期项目上下文。
4. 按 coding-agent.md 工作流实现 feature，并验证全部 \`acceptance_criteria\` 已满足。
5. 运行 lint/build，然后做**恰好一次** commit：显式 \`git add <每个修改过的实现文件路径>\`（不要 \`git add -A\`/\`git add .\`，不要提交任何 \`.ghs/*\` 文件），commit message 为 \`feat(<scope>): <简述> (Feature: <feature_id>)\`。

## Feature ID
<feature_id>

## Critical Rules
- 不要修改任何 \`.ghs/\` 文件。可以 READ features.json，但 MUST NOT write。
- 只聚焦本 feature，不要 scope-creep 到其它 feature。
- 结尾输出 EXACTLY ONE 信号，独占一行：\`FEATURE COMPLETE: <feature_id>\` 或 \`FEATURE BLOCKED: <feature_id> - <原因>\`。禁止小写、禁止 "FEATURE COMPLETED"、禁止自然语言、禁止中文变体（如 "特性完成"）。
---

语言策略（与 CLAUDE.md 一致）：commit message 与任何文档用中文正文；代码标识符、字段名、枚举值、文件路径、日志/错误信息、完成信号 token 用英文。

收到 subagent 返回后，把原始输出按 Verification Phase 交给 ghs-parse-completion-signal tool 解析（\`status: completed | blocked | unknown\`），据此调 ghs-update-feature-status 更新 features.json 与 progress.md。unknown 时走 Format Recovery 重试，耗尽后用 AskUserQuestion 让用户裁决。`;
