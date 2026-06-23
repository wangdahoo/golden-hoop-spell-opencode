// Unit tests for `src/lib/todo-tracker.ts` (Feature s1-feat-002).
//
// Implements the断线检测 (disconnect detection) stage state machine from
// plan §3.1. Covers every acceptance criterion:
//   - AC #1: recordTodoTick updates lastTodoMs only, not lastStageSeenByTool.
//   - AC #2: getStageSignature for plan-review reads post-advance status
//            ('plan:<status>').
//   - AC #3: getStageSignature returns null for terminal status or no active
//            plan.
//   - AC #4: getStageSignature for code returns 'code:<id>' from
//            feature_id / batch args.
//   - AC #5: getStageSignature for init/config/sprint/status/archive returns
//            null.
//   - AC #6: classifyStaleState covers all four judgment-table rows.
//   - AC #7: judgment-table + getStageSignature branches covered; assertions
//            reference NO wall-clock threshold.
//   - AC #8: bun run typecheck passes (verified separately).
//
// Session-isolation policy: the module-level `sessions` Map persists across
// tests within this file. Each test uses a UNIQUE sessionID to avoid cross-
// test contamination (no reset hook is exported — the three-function surface
// is the spec). getStageSignature tests share a temp project dir per test
// (mkdtemp + realpathSync, matching test/state.test.ts conventions).
//
// Note on wall-clock independence (AC #7): every classifyStaleState assertion
// checks a stage-string label, never an elapsed-time threshold. The 120s-style
// heuristic from earlier draft designs is deliberately absent — the judgment
// table is pure value comparison.

import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  recordTodoTick,
  getStageSignature,
  classifyStaleState,
} from "../src/lib/todo-tracker";
import {
  createInitialPlanStatus,
  writePlanStatus,
  plansDir,
  type PlanStatus,
} from "../src/lib/state";

// -----------------------------------------------------------------------------
// Temp project dir fixture (shared by getStageSignature tests).
// -----------------------------------------------------------------------------

let projectDir: string;

beforeEach(async () => {
  const raw = await mkdtemp(join(tmpdir(), "ghs-todo-tracker-"));
  projectDir = realpathSync(raw);
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

/** Minimal valid status object, matching the baseline pattern in state.test.ts. */
function baselineStatus(overrides: Partial<PlanStatus> = {}): PlanStatus {
  return {
    plan_id: "2026-06-22-test-plan",
    plan_file: "2026-06-22-test-plan.md",
    context_file: "2026-06-22-test-plan-context.md",
    round: 1,
    status: "designing",
    codegraph_available: false,
    max_rounds: 5,
    max_rounds_breaches: 0,
    accepted_with_fail: false,
    keep_raw_on_success: false,
    created_at: "2026-06-22T10:00:00",
    updated_at: "2026-06-22T10:00:00",
    ...overrides,
  };
}

// =============================================================================
// recordTodoTick (AC #1)
// =============================================================================
//
// The headline invariant: recordTodoTick updates lastTodoMs but does NOT touch
// lastStageSeenByTool. We verify this indirectly via classifyStaleState: after
// a tick, a classify at any non-null stage must be "drift" (NOT "never", which
// would mean lastTodoMs was unset; NOT "fresh", which would mean
// lastStageSeenByTool was preset to the current stage).

describe("recordTodoTick (s1-feat-002)", () => {
  test("updates lastTodoMs without touching lastStageSeenByTool", () => {
    const sid = "rtt-invariant-1";
    recordTodoTick(sid);

    // lastTodoMs is set (else this would be "never"); lastStageSeenByTool is
    // still null (else this would be "fresh"). Only "drift" satisfies both.
    const result = classifyStaleState(sid, "plan:designing");
    expect(result).toBe("drift");
  });

  test("creates the session entry on first call", () => {
    const sid = "rtt-create-1";
    // Before any tick: classify is "never" (lastTodoMs undefined).
    expect(classifyStaleState(sid, "plan:designing")).toBe("never");

    // After tick: lastTodoMs is set → classify no longer returns "never" for
    // a non-null stage (it returns "drift" because lastStageSeenByTool, which
    // the prior classify call advanced to "plan:designing", now matches —
    // wait, the prior "never" call advanced lastStageSeenByTool to
    // "plan:designing", so post-tick classify at the same stage is "fresh").
    recordTodoTick(sid);
    expect(classifyStaleState(sid, "plan:designing")).toBe("fresh");
  });

  test("does not clear lastStageSeenByTool on repeat calls", () => {
    const sid = "rtt-preserve-1";
    // Prime: tick + classify at stage A advances lastStageSeenByTool to A.
    recordTodoTick(sid);
    classifyStaleState(sid, "plan:designing"); // → drift, sets lastSeen=A

    // Tick again. If recordTodoTick cleared lastStageSeenByTool, the next
    // classify at the SAME stage would be "drift" (null !== A). It must stay
    // "fresh" (A === A), proving lastStageSeenByTool was untouched.
    recordTodoTick(sid);
    expect(classifyStaleState(sid, "plan:designing")).toBe("fresh");
  });
});

// =============================================================================
// getStageSignature — plan-family tools (AC #2, #3)
// =============================================================================

describe("getStageSignature - plan-family (s1-feat-002)", () => {
  test("plan-review returns 'plan:<status>' from active status.json", async () => {
    await writePlanStatus(projectDir, baselineStatus({ status: "reviewing" }));
    const sig = await getStageSignature(
      "ghs-plan-review",
      projectDir,
      {},
    );
    expect(sig).toBe("plan:reviewing");
  });

  test("plan-start returns 'plan:designing' for a fresh plan", async () => {
    await writePlanStatus(projectDir, baselineStatus({ status: "designing" }));
    const sig = await getStageSignature(
      "ghs-plan-start",
      projectDir,
      {},
    );
    expect(sig).toBe("plan:designing");
  });

  test("plan-finalize returns 'plan:pending_approval' pre-finalize", async () => {
    await writePlanStatus(
      projectDir,
      baselineStatus({ status: "pending_approval" }),
    );
    const sig = await getStageSignature(
      "ghs-plan-finalize",
      projectDir,
      {},
    );
    expect(sig).toBe("plan:pending_approval");
  });

  test("plan-review with 'revising' returns 'plan:revising'", async () => {
    await writePlanStatus(projectDir, baselineStatus({ status: "revising" }));
    const sig = await getStageSignature(
      "ghs-plan-review",
      projectDir,
      {},
    );
    expect(sig).toBe("plan:revising");
  });

  // AC #3: terminal statuses → null (avoids post-finalize staleTodoWarning).
  for (const terminal of ["approved", "rejected", "aborted"] as const) {
    test(`terminal status '${terminal}' returns null`, async () => {
      await writePlanStatus(
        projectDir,
        baselineStatus({ status: terminal }),
      );
      const sig = await getStageSignature(
        "ghs-plan-review",
        projectDir,
        {},
      );
      expect(sig).toBe(null);
    });
  }

  test("no active plan (empty plans dir) returns null", async () => {
    // No status.json written → findActivePlanStatus returns null.
    const sig = await getStageSignature(
      "ghs-plan-review",
      projectDir,
      {},
    );
    expect(sig).toBe(null);
  });

  test("corrupt status.json (read failure, R7) returns null", async () => {
    // Write a status file whose name matches the scan pattern but whose
    // body is unparseable JSON. readPlanStatus throws → findActivePlanStatus
    // propagates → getStageSignature's try/catch swallows → null.
    const dir = plansDir(projectDir);
    await mkdir(dir, { recursive: true });
    const corruptPath = join(dir, "2026-06-22-test-plan-status.json");
    await writeFile(corruptPath, "{not valid json");
    const sig = await getStageSignature(
      "ghs-plan-review",
      projectDir,
      {},
    );
    expect(sig).toBe(null);
  });
});

// =============================================================================
// getStageSignature — code tool (AC #4)
// =============================================================================

describe("getStageSignature - code (s1-feat-002)", () => {
  test("code with feature_id returns 'code:<feature_id>'", async () => {
    const sig = await getStageSignature("ghs-code", projectDir, {
      feature_id: "s1-feat-002",
    });
    expect(sig).toBe("code:s1-feat-002");
  });

  test("code with parallel=true returns 'code:batch'", async () => {
    const sig = await getStageSignature("ghs-code", projectDir, {
      parallel: true,
    });
    expect(sig).toBe("code:batch");
  });

  test("code with no args returns 'code:default'", async () => {
    const sig = await getStageSignature("ghs-code", projectDir, {});
    expect(sig).toBe("code:default");
  });

  test("code prefers feature_id over parallel when both set", async () => {
    const sig = await getStageSignature("ghs-code", projectDir, {
      feature_id: "s1-feat-001",
      parallel: true,
    });
    expect(sig).toBe("code:s1-feat-001");
  });

  test("code with empty-string feature_id falls through to parallel/default", async () => {
    // An empty/whitespace feature_id is treated as absent.
    const sigParallel = await getStageSignature("ghs-code", projectDir, {
      feature_id: "   ",
      parallel: true,
    });
    expect(sigParallel).toBe("code:batch");

    const sigDefault = await getStageSignature("ghs-code", projectDir, {
      feature_id: "",
    });
    expect(sigDefault).toBe("code:default");
  });
});

// =============================================================================
// getStageSignature — single-step tools + unknown (AC #5)
// =============================================================================

describe("getStageSignature - single-step + unknown (s1-feat-002)", () => {
  const singleStep = [
    "ghs-init",
    "ghs-config",
    "ghs-sprint",
    "ghs-status",
    "ghs-archive",
    "ghs-force-archive",
  ];
  for (const toolName of singleStep) {
    test(`${toolName} returns null`, async () => {
      const sig = await getStageSignature(toolName, projectDir, {});
      expect(sig).toBe(null);
    });
  }

  test("unknown / untracked tool returns null", async () => {
    const sig = await getStageSignature("ghs-mystery", projectDir, {});
    expect(sig).toBe(null);
  });

  test("empty tool name returns null", async () => {
    const sig = await getStageSignature("", projectDir, {});
    expect(sig).toBe(null);
  });
});

// =============================================================================
// getStageSignature — new Cat-1/Cat-2 tools (s1-feat-006, plan §6 / Opt #4)
// =============================================================================
//
// The three tools registered in sprint s1 (ghs-parse-completion-signal,
// ghs-update-feature-status, ghs-append-feature) are single-step sub-
// operations within the code / sprint stages. They must NOT be stage-tracked
// (getStageSignature returns null), otherwise classifyStaleState would emit
// false drift warnings when the main AI interleaves them between ghs-code /
// ghs-sprint calls (plan §6 rationale).

describe("getStageSignature - new single-step tools (s1-feat-006)", () => {
  const newSingleStep = [
    "ghs-parse-completion-signal",
    "ghs-update-feature-status",
    "ghs-append-feature",
  ];
  for (const toolName of newSingleStep) {
    test(`${toolName} returns null`, async () => {
      const sig = await getStageSignature(toolName, projectDir, {});
      expect(sig).toBe(null);
    });
  }
});

// =============================================================================
// classifyStaleState — judgment table four rows (AC #6)
// =============================================================================
//
// Each test uses a unique sessionID to avoid cross-test Map contamination.
// No assertion references any elapsed-time / wall-clock value — all four
// branches are exercised via pure value comparisons (AC #7).

describe("classifyStaleState - judgment table (s1-feat-002)", () => {
  test("row 1: currentStage === null → 'inactive'", () => {
    const sid = "cls-inactive-1";
    // Even with a prior tick, a null stage short-circuits to inactive.
    recordTodoTick(sid);
    expect(classifyStaleState(sid, null)).toBe("inactive");
  });

  test("row 1: null stage is inactive regardless of prior state", () => {
    const sid = "cls-inactive-2";
    recordTodoTick(sid);
    classifyStaleState(sid, "plan:designing"); // advances lastSeen
    expect(classifyStaleState(sid, null)).toBe("inactive");
  });

  test("row 2: lastTodoMs === undefined → 'never' (fresh session, no tick)", () => {
    const sid = "cls-never-1";
    expect(classifyStaleState(sid, "plan:designing")).toBe("never");
  });

  test("row 2: 'never' keeps firing when the AI never calls todowrite", () => {
    // A non-compliant AI that ignores todowrite nudges should receive the
    // CONSTRUCTIVE todoDirective on every call, never the stale warning.
    const sid = "cls-never-2";
    expect(classifyStaleState(sid, "plan:designing")).toBe("never");
    // Side effect advanced lastStageSeenByTool → "plan:designing", but
    // lastTodoMs is STILL undefined, so row 2 still wins on the next call.
    expect(classifyStaleState(sid, "plan:designing")).toBe("never");
  });

  test("row 3: lastTodoMs set, lastStageSeenByTool !== currentStage → 'drift'", () => {
    const sid = "cls-drift-1";
    recordTodoTick(sid);
    // lastStageSeenByTool is null (no prior classify), currentStage is non-null.
    expect(classifyStaleState(sid, "plan:reviewing")).toBe("drift");
  });

  test("row 3: stage transition (designing → reviewing) triggers drift", () => {
    // Mirrors plan §3.1 property (ii): a compliant AI ticks todo at
    // designing, then the plan advances to reviewing. The first classify
    // at reviewing must be drift.
    const sid = "cls-drift-2";
    recordTodoTick(sid);
    // Prime lastStageSeenByTool to "plan:designing" (simulating the prior
    // tool call having classified at the designing stage).
    classifyStaleState(sid, "plan:designing"); // → fresh or drift, advances lastSeen
    // Now the stage advances to reviewing.
    expect(classifyStaleState(sid, "plan:reviewing")).toBe("drift");
  });

  test("row 4: lastTodoMs set, lastStageSeenByTool === currentStage → 'fresh'", () => {
    const sid = "cls-fresh-1";
    recordTodoTick(sid);
    // First classify at designing: drift (lastSeen=null !== designing) +
    // advances lastSeen to designing.
    classifyStaleState(sid, "plan:designing");
    // Second classify at the SAME stage: fresh.
    expect(classifyStaleState(sid, "plan:designing")).toBe("fresh");
  });

  test("row 4: 'fresh' holds across repeated calls at the same stage", () => {
    const sid = "cls-fresh-2";
    recordTodoTick(sid);
    classifyStaleState(sid, "plan:designing");
    expect(classifyStaleState(sid, "plan:designing")).toBe("fresh");
    expect(classifyStaleState(sid, "plan:designing")).toBe("fresh");
  });

  test("full lifecycle: never → drift → fresh → drift → fresh", () => {
    // End-to-end exercise of the state machine across a stage transition.
    const sid = "cls-lifecycle-1";

    // Stage A (plan:designing). AI has not yet created a todo.
    expect(classifyStaleState(sid, "plan:designing")).toBe("never");

    // AI creates todo (todo.updated fires).
    recordTodoTick(sid);

    // Still stage A — now fresh (lastSeen was advanced to A by the never call).
    expect(classifyStaleState(sid, "plan:designing")).toBe("fresh");

    // Stage advances to B (plan:reviewing). Todo not yet updated for B.
    expect(classifyStaleState(sid, "plan:reviewing")).toBe("drift");

    // AI updates todo for B.
    recordTodoTick(sid);

    // Now fresh at B.
    expect(classifyStaleState(sid, "plan:reviewing")).toBe("fresh");
  });
});

// =============================================================================
// Wall-clock independence (AC #7 structural check)
// =============================================================================

describe("no wall-clock threshold (s1-feat-002)", () => {
  test("classification depends only on stage alignment, not elapsed time", () => {
    // Two sessions, both ticked, both at the same stage. The classification
    // is identical regardless of when the tick happened — there is no
    // "stale after N seconds" branch in the judgment table.
    const sidA = "cls-clock-a";
    const sidB = "cls-clock-b";

    recordTodoTick(sidA);
    recordTodoTick(sidB);

    // Prime both to the same stage.
    classifyStaleState(sidA, "plan:designing");
    classifyStaleState(sidB, "plan:designing");

    // Both fresh at the same stage — time-agnostic.
    expect(classifyStaleState(sidA, "plan:designing")).toBe(
      classifyStaleState(sidB, "plan:designing"),
    );
    expect(classifyStaleState(sidA, "plan:designing")).toBe("fresh");
  });

  test("the four judgment-table branches exhaust the classification space", () => {
    // Structural assertion: classifyStaleState's return type is exactly the
    // 4-label union, and every label is reachable (exercised by the tests
    // above). This test documents the contract — no "stale-by-timeout" fifth
    // label exists.
    const labels = new Set<string>();
    const sid = "cls-exhaust-1";

    labels.add(classifyStaleState(sid, null)); // inactive
    labels.add(classifyStaleState(sid + "-never", "plan:designing")); // never

    recordTodoTick(sid + "-drift");
    labels.add(classifyStaleState(sid + "-drift", "plan:designing")); // drift

    recordTodoTick(sid + "-fresh");
    classifyStaleState(sid + "-fresh", "plan:designing"); // prime
    labels.add(classifyStaleState(sid + "-fresh", "plan:designing")); // fresh

    expect(labels).toEqual(
      new Set(["inactive", "never", "drift", "fresh"]),
    );
  });
});
