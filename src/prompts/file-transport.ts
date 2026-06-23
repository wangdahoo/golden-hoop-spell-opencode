// File-transport dispatch directive (Tier 1 of the loop-cost fix).
//
// The plan loop's three subagents (context-explorer / plan-designer /
// plan-reviewer) historically returned their full delimited output through
// the OpenCode Task-return channel. That channel truncates long output,
// which silently corrupts the loop: the main AI relays a truncated payload
// to `ghs-plan-review`, the parser loses the END marker, and rounds are
// wasted on truncation rather than design (see
// `docs/issues/2026-06-23-plan-loop-slow-and-token-heavy.md`).
//
// File-based transport bypasses the lossy channel entirely: each subagent
// writes its full delimited output to a deterministic staging file (direct
// disk access via the Write tool — no truncation) and returns only a short
// completion signal. `ghs-plan-review` then reads the staging file as the
// primary parse source (see `readStagingOrInline` in plan-review.ts).
//
// This module renders the LLM-facing directive block that the plan tools
// append to each subagent dispatch. It is bilingual by role: the subagent
// instructions are embedded by the main AI into the Task prompt, while the
// main-AI-facing note tells it the tool reads the file so it need not relay
// the full text. Pure (no I/O) so it is trivially unit-testable.
//
// Language policy (CLAUDE.md): human-readable prose 中文; code identifiers,
// delimiter tokens, and file paths stay English.

import type { StagingKind } from "../lib/state.ts";

/**
 * Per-kind metadata: the delimiter tokens, the completion signal the
 * subagent prints, and the `ghs-plan-review` arg name that selects this
 * mode. Centralised so the directive text and the parser stay in lockstep.
 */
interface KindMeta {
  /** Literal START delimiter the subagent must emit. */
  startToken: string;
  /** Literal END delimiter the subagent must emit. */
  endToken: string;
  /** Completion signal line the subagent prints after the END marker. */
  signal: string;
  /** The `ghs-plan-review` payload arg that selects this mode. */
  modeArg: "snapshot" | "plan" | "review";
}

const KIND_META: Record<StagingKind, KindMeta> = {
  snapshot: {
    startToken: "<<<CONTEXT_SNAPSHOT_START>>>",
    endToken: "<<<CONTEXT_SNAPSHOT_END>>>",
    signal: "CONTEXT SNAPSHOT COMPLETE",
    modeArg: "snapshot",
  },
  plan: {
    startToken: "<<<PLAN_START>>>",
    endToken: "<<<PLAN_END>>>",
    signal: "PLAN DESIGN COMPLETE",
    modeArg: "plan",
  },
  review: {
    startToken: "<<<REVIEW_START>>>",
    endToken: "<<<REVIEW_END>>>",
    signal: "PLAN REVIEW COMPLETE",
    modeArg: "review",
  },
};

/**
 * Render the file-transport directive block for a subagent dispatch.
 *
 * The block is appended to a plan tool's dispatch directive (after the
 * existing subagent prompt). It tells the main AI two things:
 *   1. When spawning the subagent via the Task tool, add an instruction that
 *      the subagent must Write its full delimited output (markers + signal)
 *      to `stagingAbsPath`, then print only the signal in its reply.
 *   2. After the subagent finishes, call `ghs-plan-review(<modeArg>=...)`;
 *      the tool reads the staging file automatically, so the payload arg only
 *      needs a short mode indicator (e.g. the signal) — never the full text.
 *
 * @param stagingAbsPath - absolute path the subagent must write to (from
 *   `stagingPath(projectDir, planId, kind)`).
 * @param kind           - which subagent family is being dispatched.
 * @returns the directive block string (no leading/trailing newline).
 */
export function fileTransportDirective(
  stagingAbsPath: string,
  kind: StagingKind,
): string {
  const meta = KIND_META[kind];
  return [
    "--- 文件化传输（硬性 —— 绕开 Task 返回通道的截断）---",
    "派发 subagent 时，把以下要求加进 Task prompt：",
    `- 用 Write 工具把完整输出（含 ${meta.startToken} ... ${meta.endToken} 标记，以及完成信号）写入：`,
    `    ${stagingAbsPath}`,
    `- 然后在回复正文里只输出完成信号 \`${meta.signal}\`，不要重复全文。`,
    "subagent 写完后，调用 `ghs-plan-review(" + meta.modeArg + "=...)` 推进——",
    "工具会自动从上述文件读取完整原文；参数只需传一个短信号（如 `" + meta.signal + "`）指明模式，",
    "无须把全文贴进参数（贴全文的旧路径仍兼容，但优先走文件）。",
  ].join("\n");
}
