// Runtime lock primitives — behavior source of truth (Feature s1-feat-003).
//
// This module is the pure-function + schema layer for the ghs runtime lock
// (`.ghs/active.lock`). It is a faithful port of the design in
// docs/ghs/plans/2026-07-02-multi-pipeline-concurrency.md §3.2/§3.3 (Phase 2):
//   - `LockHolderSchema` (stage three-state incl. `leaf`, O2) — the on-disk
//     JSON shape of the lock file.
//   - `buildLockHolder` — pure constructor (pid from process.pid, ISO8601
//     acquired_at, ms epoch for staleness display).
//   - `parseLockContent` — tolerant parse (null/畸形/缺字段 → null).
//   - `classifyHolder` — three-state classification keyed on session_id
//     (the primary key; pid/timestamps are display-only, conclusion B).
//   - `renderConflictMessage` — the conflict copy surfaced to the user when a
//     cross-session lock collision occurs (takeover/wait/cancel, prose-contract
//     compliant — `toolName` is the full `ghs-*` name).
//
// Layering (AGENTS.md): behavior lives in `src/lib/scripts/` (pure, zod-validated,
// test-pinned); file I/O lives in the sibling tool-layer `src/lib/runtime-lock.ts`.
// This module does NO I/O. It is not wired into any tool yet (Phase 2 only).

import { z } from "zod";

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------

/**
 * The three stages that may hold the runtime lock (O2).
 *
 * - `sprint` / `code` — stage owners; they hold the lock across multiple tool
 *   invocations (sprint across append-feature planning, code across the
 *   dispatch→subagent→parse→update loop).
 * - `leaf` — a standalone leaf-writer (append-feature / update-feature-status)
 *   invoked outside any stage-owner pipeline degrades to a short-lived lock
 *   tagged `leaf`, so the label never falsely claims a sprint/code pipeline.
 */
export const LOCK_STAGES = ["sprint", "code", "leaf"] as const;
export type LockStage = (typeof LOCK_STAGES)[number];

/**
 * Zod schema for `.ghs/active.lock`.
 *
 * `strict()` rejects unknown fields so a corrupted/hand-edited lock file surfaces
 * immediately (parsed as null by {@link parseLockContent}, which treats schema
 * failure as "no usable lock"). Mirrors the `PlanStatusSchema` discipline in
 * `src/lib/state.ts`.
 *
 * Fields (plan §3.2):
 *   - `session_id`     — ctx.sessionID; the PRIMARY KEY for idempotency (same
 *                        session re-acquire = no-op) and ownership (cross-session
 *                        = conflict). Conclusions B.
 *   - `acquired_at`    — ISO8601 timestamp, human-readable display only.
 *   - `acquired_at_ms` — Date.now() epoch ms, display/staleness aid only.
 *   - `pid`            — process.pid, display aid only (NOT used for auto-staleness
 *                        or kill). conclusion B: staleness is a user decision.
 *   - `stage`          — three-state enum (O2).
 *   - `sprint_id`      — the holding sprint (required for `code`, back-filled
 *                        after `sprint` writes the skeleton); nullable.
 *   - `holder_label`   — human-readable label built by `buildLabel` (O1),
 *                        surfaced in conflict messages.
 *
 * `pid` + timestamps deliberately do NOT participate in automatic staleness
 * detection (conclusion B): a dead PID or old timestamp is surfaced to the user,
 * who decides takeover/wait/cancel.
 */
export const LockHolderSchema = z.strictObject({
  session_id: z.string().min(1),
  acquired_at: z.string().min(1),
  acquired_at_ms: z.number().int(),
  pid: z.number().int(),
  stage: z.enum(LOCK_STAGES),
  sprint_id: z.string().nullable(),
  holder_label: z.string().min(1),
});

export type LockHolder = z.infer<typeof LockHolderSchema>;

// -----------------------------------------------------------------------------
// Pure functions
// -----------------------------------------------------------------------------

/**
 * Construct a `LockHolder` (pure; no I/O).
 *
 * - `pid` is sourced from `process.pid` (win32/posix both support it; display only).
 * - `acquired_at` is the ISO8601 timestamp of `now` (default `new Date()`).
 * - `acquired_at_ms` is `now.getTime()` (epoch ms).
 *
 * @param args.sessionId    - ctx.sessionID, the primary key.
 * @param args.stage        - one of `sprint` / `code` / `leaf` (O2).
 * @param args.sprintId     - the holding sprint id, or null (sprint stage writes
 *                            skeleton first, back-fills later).
 * @param args.holderLabel  - human-readable label (O1: `${agent}@${sessionID.slice(-6)}`).
 * @param args.now          - injection point for deterministic tests.
 */
export function buildLockHolder(args: {
  sessionId: string;
  stage: LockStage;
  sprintId: string | null;
  holderLabel: string;
  now?: Date;
}): LockHolder {
  const now = args.now ?? new Date();
  return {
    session_id: args.sessionId,
    acquired_at: now.toISOString(),
    acquired_at_ms: now.getTime(),
    pid: process.pid,
    stage: args.stage,
    sprint_id: args.sprintId,
    holder_label: args.holderLabel,
  };
}

/**
 * Parse raw lock-file content into a validated `LockHolder`, or `null`.
 *
 * Tolerant by design (plan §3.5): a missing file (raw === null), malformed JSON,
 * or a schema failure all collapse to `null` so a corrupted lock does NOT block
 * acquisition — the caller treats null as "no lock" and may acquire. The
 * corruption is implicitly surfaced because the next conflict message will lack
 * the stale holder's metadata.
 */
export function parseLockContent(raw: string | null): LockHolder | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = LockHolderSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/**
 * Three-state ownership classification (plan §3.3).
 *
 * - `none`          — no current holder (null).
 * - `held_by_self`  — current holder's session_id matches → idempotent re-acquire.
 * - `held_by_other` — a different session holds → conflict (user decides).
 */
export type ConflictKind = "none" | "held_by_self" | "held_by_other";

export function classifyHolder(
  current: LockHolder | null,
  sessionId: string,
): ConflictKind {
  if (current === null) return "none";
  return current.session_id === sessionId ? "held_by_self" : "held_by_other";
}

/**
 * Render the cross-session conflict message (plan §3.4 流程 2).
 *
 * Lists the other holder's metadata (holder_label / pid / acquired_at / stage /
 * sprint_id) and offers the user a three-way choice (takeover / wait / cancel).
 * The takeover branch instructs "重调 <toolName> 带 takeover=true" — `toolName`
 * MUST be the full `ghs-*` name (e.g. `ghs-code`) so the prose-contract (bare
 * tool-name stems must be `ghs-` prefixed) holds.
 *
 * No automatic staleness judgement (conclusion B): PID + timestamp are presented
 * to aid the user's decision, never auto-applied.
 *
 * @param other            - the current (other-session) holder.
 * @param attemptedAction  - short Chinese description of what the caller tried.
 * @param toolName         - the full `ghs-*` tool name to re-invoke with takeover.
 */
export function renderConflictMessage(
  other: LockHolder,
  attemptedAction: string,
  toolName: string,
): string {
  const sprintPart =
    other.sprint_id === null ? "（无 sprint）" : `（sprint ${other.sprint_id}）`;
  return [
    `❌ 另一流水线正持有 ghs 运行期锁，本次操作（${attemptedAction}）已被拒绝。`,
    `   持有者 (holder_label): ${other.holder_label}`,
    `   阶段 (stage): ${other.stage}${sprintPart}`,
    `   进程 PID: ${other.pid}`,
    `   获取于 (acquired_at): ${other.acquired_at}`,
    `请在 chat 中选择：`,
    `  - 接管 (takeover)：重调 ${toolName} 带 takeover=true，覆盖该锁`,
    `      （原窗口的后续写入将被 leaf-writer 写前 validate 拒绝）`,
    `  - 等待 (wait)：等对方释放后再重调 ${toolName}`,
    `  - 取消 (cancel)：放弃本次`,
    `▶ NEXT ACTION: 由用户在 chat 中决策后，重调 ${toolName}（takeover=true）或等待。`,
  ].join("\n");
}
