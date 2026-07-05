// Leaf-writer serialized-write helper (Feature s1-feat-006, Phase 3b / M1).
//
// The leaf writers (`ghs-append-feature` / `ghs-update-feature-status`) do NOT
// acquire the runtime lock themselves when invoked inside a stage-owner
// pipeline (sprint / code already holds it). Instead they pre-validate
// ownership before every disk write — this is the M1 "承重墙": once a session
// is taken over, its next leaf write is REJECTED here, preventing the
// takeover-then-double-write that would otherwise corrupt features.json /
// progress.md.
//
// Decision tree (plan §4 Phase 3, O2/O3):
//   - validateLockHeld ok:true          → already inside a held-lock pipeline;
//                                         run performWrite directly (no release —
//                                         the stage owner owns the lock).
//   - validateLockHeld reason:held_by_other → refuse: return the conflict
//                                         message (anti-double-write wall).
//   - validateLockHeld reason:not_held  → standalone invocation; degrade to a
//                                         short-lived `leaf` lock (O2) around
//                                         performWrite, then release.
//
// `performWrite` MUST encapsulate EVERY disk write the tool performs (O3) —
// for `update-feature-status` that is BOTH features.json and progress.md — so
// the validate/lock gate covers the full write surface (a bare write outside
// performWrite would bypass the wall).

import type { ToolContext } from "@opencode-ai/plugin/tool";
import {
  validateLockHeld,
  acquireLock,
  releaseLock,
  buildLabel,
} from "./runtime-lock.ts";
import { renderConflictMessage } from "./scripts/runtime-lock.ts";

/**
 * Run a leaf writer's disk writes under the runtime-lock discipline.
 *
 * @param ctx           - the tool's ToolContext (supplies sessionId + label).
 * @param projectDir    - absolute project root (locates `.ghs/active.lock`).
 * @param performWrite  - closure performing ALL of the tool's disk writes and
 *                        returning the tool's result text. Called at most once.
 * @param toolName      - full `ghs-*` tool name, surfaced in the conflict
 *                        message's takeover instruction (prose-contract).
 */
export async function writeFeaturesSerialized(
  ctx: ToolContext,
  projectDir: string,
  performWrite: () => Promise<string>,
  toolName: string,
): Promise<string> {
  const attemptedAction = `${toolName} 写入`;

  const v = await validateLockHeld({ projectDir, sessionId: ctx.sessionID });
  if (v.ok) {
    return performWrite();
  }
  if (v.reason === "held_by_other") {
    return renderConflictMessage(v.holder!, attemptedAction, toolName);
  }

  const acq = await acquireLock({
    projectDir,
    sessionId: ctx.sessionID,
    stage: "leaf",
    sprintId: null,
    holderLabel: buildLabel(ctx),
  });
  if (!acq.acquired) {
    return renderConflictMessage(acq.holder, attemptedAction, toolName);
  }
  try {
    return await performWrite();
  } finally {
    await releaseLock({ projectDir, sessionId: ctx.sessionID });
  }
}
