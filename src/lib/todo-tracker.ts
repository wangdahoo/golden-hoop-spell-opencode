// Stage state machine for the Todo-Anchored Workflow disconnect detection
// (plan §3.1 断线检测).
//
// This module maintains in-process per-session tracking state and exposes
// three functions used by the plugin's event hook (feat-003) and the ghs
// multi-step tool execute handlers (feat-005) to detect when the main AI has
// drifted away from the workflow's current stage without updating its todo
// checklist.
//
// Design rationale (plan §3.1 断线检测):
//   - Signal source: the on-disk `status.json` `status` field (NOT wall-clock).
//     The stage state machine is authoritative progress written by ghs tools
//     themselves — no sub-agent timing coupling, no "reset on restart"
//     problem, reuses the existing inter-tool coupling point.
//   - The judgment table (4 rows, first-match-wins) lives in
//     classifyStaleState and does NOT depend on any wall-clock threshold.
//   - Timing constraint (enforced by callers in feat-005, not here):
//     getStageSignature is invoked AFTER the tool handler completes its
//     writePlanStatus / equivalent state write, so it reads the POST-advance
//     status field. That post-advance read is the self-consistency premise
//     for the two key properties (first call → todoDirective; stage
//     transition → staleTodoWarning).

import { findActivePlanStatus } from "../tools/plan-review.ts";
import type { PlanStatusValue } from "./state.ts";

// -----------------------------------------------------------------------------
// Terminal-status check (mirrors src/tools/plan-review.ts isTerminal).
// -----------------------------------------------------------------------------

/**
 * Whether a plan lifecycle state is terminal (no further transitions).
 *
 * Verbatim copy of the `isTerminal` predicate in
 * `src/tools/plan-review.ts:181`. Kept local rather than imported to avoid
 * widening plan-review.ts's export surface within this feature's scope. The
 * terminal set is fixed by the `PlanStatusValue` enum in state.ts
 * (`approved` / `rejected` / `aborted`), so duplication is safe — a drift
 * between the two copies would surface as a state-machine regression in
 * plan-review.test.ts long before it could mask a disconnect-detection bug.
 */
function isTerminal(status: PlanStatusValue): boolean {
  return status === "approved" || status === "rejected" || status === "aborted";
}

// -----------------------------------------------------------------------------
// In-process session tracking state.
// -----------------------------------------------------------------------------

/**
 * Per-session tracking record used by the disconnect-detection state machine.
 *
 *   - `lastTodoMs`:          timestamp of the most recent `todo.updated` event
 *                            for this session (set by recordTodoTick).
 *                            `undefined` until the first todo.updated fires.
 *   - `lastStageSeenByTool`: the stage signature observed the last time a ghs
 *                            multi-step tool executed for this session. `null`
 *                            until the first classifyStaleState call advances
 *                            it to the supplied currentStage.
 */
interface SessionState {
  lastTodoMs: number | undefined;
  lastStageSeenByTool: string | null;
}

/**
 * Module-level session tracker, keyed by opencode session id.
 *
 * Lives in-process only — intentionally NOT persisted to disk. A plugin
 * reload resets all sessions, which is the correct behaviour for disconnect
 * detection (a restart means the todo-checklist state is gone anyway, so
 * re-issuing a constructive todoDirective via the `never` branch is the
 * right thing to do).
 */
const sessions = new Map<string, SessionState>();

// -----------------------------------------------------------------------------
// recordTodoTick — event hook entry point (feat-003 calls this on todo.updated).
// -----------------------------------------------------------------------------

/**
 * Record a `todo.updated` tick for the given session.
 *
 * Updates ONLY `lastTodoMs` to `Date.now()` — does NOT touch
 * `lastStageSeenByTool` (plan §3.1: the event hook maintains the timestamp;
 * stage comparison/advancement is a separate concern owned by
 * classifyStaleState). This is the headline invariant verified by the
 * matching acceptance criterion.
 *
 * Creates the session entry on first observation.
 */
export function recordTodoTick(sessionID: string): void {
  let state = sessions.get(sessionID);
  if (state === undefined) {
    state = { lastTodoMs: undefined, lastStageSeenByTool: null };
    sessions.set(sessionID, state);
  }
  state.lastTodoMs = Date.now();
}

// -----------------------------------------------------------------------------
// getStageSignature — derive the current stage from disk (post-advance read).
// -----------------------------------------------------------------------------

/**
 * Derive the current workflow stage signature for a ghs tool invocation.
 *
 * **Plan-family tools** (`ghs-plan-start` / `ghs-plan-review` /
 * `ghs-plan-finalize`) → read the ACTIVE plan's `status.json` `status` field
 * (post-advance — the caller is responsible for invoking this after its own
 * `writePlanStatus` call) and return `"plan:${statusValue}"`.
 *
 * **code tool** (`ghs-code`) → `"code:${feature_id | "batch" | "default"}"`
 * derived purely from args (no filesystem read): `feature_id` when pinned,
 * `"default"` when `parallel === false` (explicit single-feature opt-out),
 * else `"batch"` — parallel batch dispatch is the DEFAULT (a bare `ghs-code`
 * call with no args returns the batch plan).
 *
 * Returns `null` when:
 *   - the tool is not stage-tracked (init / config / sprint / status /
 *     archive / force-archive — all single-step);
 *   - there is no active plan (`findActivePlanStatus === null`);
 *   - the active plan is in a terminal state (`approved` / `rejected` /
 *     `aborted`) — avoids a post-finalize semantic-mismatch staleTodoWarning;
 *   - reading `status.json` throws (R7 — defensive try/catch returns null on
 *     any I/O or parse failure rather than propagating, matching the
 *     findActivePlanStatus filesystem-missing fallback semantics).
 *
 * @param toolName   - full hyphenated tool name (e.g. `"ghs-plan-review"`).
 * @param projectDir - absolute project root (locates `.ghs/plans/`).
 * @param args       - the tool's raw args; only consulted for `ghs-code`.
 */
export async function getStageSignature(
  toolName: string,
  projectDir: string,
  args: Record<string, unknown>,
): Promise<string | null> {
  if (
    toolName === "ghs-plan-start" ||
    toolName === "ghs-plan-review" ||
    toolName === "ghs-plan-finalize"
  ) {
    let status;
    try {
      status = await findActivePlanStatus(projectDir);
    } catch {
      // R7: status.json read failure (I/O or Zod parse) → null, do not
      // propagate. Disconnect detection degrades to "inactive" for this
      // call, which is the safe no-op outcome.
      return null;
    }
    if (status === null) return null;
    if (isTerminal(status.status)) return null;
    return `plan:${status.status}`;
  }

  if (toolName === "ghs-code") {
    const featureId = args["feature_id"];
    if (typeof featureId === "string" && featureId.trim().length > 0) {
      return `code:${featureId}`;
    }
    if (args["parallel"] === false) {
      return `code:default`;
    }
    return `code:batch`;
  }

  // init / config / sprint / append-feature / parse-completion-signal /
  // update-feature-status / status / archive / force-archive — single-step.
  return null;
}

// -----------------------------------------------------------------------------
// classifyStaleState — the 4-row judgment table (plan §3.1).
// -----------------------------------------------------------------------------

/**
 * Classify the todo-stage alignment for a session against the supplied
 * current stage signature (the output of {@link getStageSignature}).
 *
 * Implements the plan §3.1 judgment table (first-match-wins, evaluated
 * strictly via value comparisons — NO wall-clock threshold is consulted):
 *
 *   1. `currentStage === null`                → `"inactive"`
 *      Single-step tool / terminal status / read failure — not participating.
 *   2. `lastTodoMs === undefined`             → `"never"`
 *      Session has never recorded a todo.updated — constructive first nudge.
 *   3. `lastStageSeenByTool !== currentStage` → `"drift"`
 *      Stage advanced but the todo did not follow — stale warning.
 *   4. `lastStageSeenByTool === currentStage` → `"fresh"`
 *      Current stage's todo is already maintained.
 *
 * Side effect: after classifying, advances `lastStageSeenByTool` to
 * `currentStage` (when currentStage !== null). This is the "比较，再更新后者"
 * step from plan §3.1 — classifyStaleState both reads AND advances the
 * tracking state so the disconnect-detection state machine is self-contained
 * in exactly the three exported functions (recordTodoTick / getStageSignature
 * / classifyStaleState) without needing a separate setter. The classification
 * itself uses the PRE-update value, so the four branches above are exactly
 * the judgment table.
 */
export function classifyStaleState(
  sessionID: string,
  currentStage: string | null,
): "never" | "drift" | "fresh" | "inactive" {
  if (currentStage === null) {
    return "inactive";
  }

  let state = sessions.get(sessionID);
  if (state === undefined) {
    state = { lastTodoMs: undefined, lastStageSeenByTool: null };
    sessions.set(sessionID, state);
  }

  let result: "never" | "drift" | "fresh";
  if (state.lastTodoMs === undefined) {
    result = "never";
  } else if (state.lastStageSeenByTool !== currentStage) {
    result = "drift";
  } else {
    result = "fresh";
  }

  // Advance tracking: record that we've now seen this stage (plan §3.1
  // "比较，再更新后者"). Subsequent calls at the same stage → fresh.
  state.lastStageSeenByTool = currentStage;

  return result;
}
