// Unit tests for `src/tools/plan-review.ts` (Feature s3-feat-007).
//
// Covers every acceptance criterion:
//   - AC #1: exports planReviewTool with hyphenated key 'ghs-plan-review'
//            (registration is asserted indirectly by importing the const;
//             the key string is asserted in the plugin-registration feature
//             s3-feat-009 — here we assert the tool object exists + has the
//             expected arg surface).
//   - AC #2: args snapshot?/plan?/review?/project_dir? with Zod refine
//            forcing exactly one non-empty (the headline plan §5 risk fix).
//   - AC #3: snapshot → designer dispatch; plan → reviewer dispatch;
//            review → FAIL triggers retry/max-rounds, PASS → finalize.
//   - AC #4: uses parse.ts (parseContextSnapshot / parsePlan / parseReview).
//   - AC #5: updates status.json round counter.
//
// Temp-dir + mock-ToolContext policy matches test/state.test.ts and
// test/codegraph.test.ts: mkdtemp under os.tmpdir() + realpathSync to dodge
// the macOS /tmp → /private/tmp symlink surprise.

import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { planReviewTool, planReviewArgsSchema, MAX_BREACHES, setGhsConfigLoaderForTest } from "../src/tools/plan-review";
import {
  createInitialPlanStatus,
  writePlanStatus,
  plansDir,
  DEFAULT_MAX_ROUNDS,
  type PlanStatus,
} from "../src/lib/state";
import { DEFAULT_MIN_LENGTH } from "../src/lib/parse";
import {
  recordTodoTick,
  classifyStaleState,
} from "../src/lib/todo-tracker";

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

/** Build a delimited blob with a body long enough to clear DEFAULT_MIN_LENGTH. */
function longBody(prefix: string): string {
  return prefix + "\n" + "x".repeat(DEFAULT_MIN_LENGTH + 40);
}

function snapshotBlob(body: string): string {
  return `<<<CONTEXT_SNAPSHOT_START>>>\n${body}\n<<<CONTEXT_SNAPSHOT_END>>>`;
}

function planBlob(body: string): string {
  return `<<<PLAN_START>>>\n${body}\n<<<PLAN_END>>>`;
}

function reviewBlob(body: string, verdict: "PASS" | "FAIL"): string {
  return (
    `<<<REVIEW_START>>>\n${body}\n<<<REVIEW_END>>>\n` +
    `PLAN REVIEW COMPLETE | Verdict: ${verdict} | Severe: 0 Medium: 0 Optimization: 1`
  );
}

/** A minimal-but-valid status object used as the baseline. */
function baselineStatus(overrides: Partial<PlanStatus> = {}): PlanStatus {
  return {
    plan_id: "2026-06-20-test-plan",
    plan_file: "2026-06-20-test-plan.md",
    context_file: "2026-06-20-test-plan-context.md",
    round: 1,
    status: "designing",
    codegraph_available: false,
    max_rounds: DEFAULT_MAX_ROUNDS,
    max_rounds_breaches: 0,
    accepted_with_fail: false,
    keep_raw_on_success: false,
    created_at: "2026-06-20T10:00:00",
    updated_at: "2026-06-20T10:00:00",
    ...overrides,
  };
}

/** A mock ToolContext whose worktree/directory resolve to the temp project. */
function mockCtx(projectDir: string): Parameters<typeof planReviewTool.execute>[1] {
  return {
    sessionID: "test-session",
    messageID: "test-message",
    agent: "test-agent",
    directory: projectDir,
    worktree: projectDir,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  } as Parameters<typeof planReviewTool.execute>[1];
}

/**
 * Variant of {@link mockCtx} that pins `sessionID` to the supplied value and
 * captures every `ctx.metadata` call. Used by the workflow-chrome assertions
 * (Feature s1-feat-005) to verify the injection-point-③ main path sets
 * `title: "[ghs] <stage>"`.
 */
function mockCtxCaptured(
  projectDir: string,
  sessionID: string,
): {
  ctx: Parameters<typeof planReviewTool.execute>[1];
  calls: { title?: string; metadata?: Record<string, unknown> }[];
} {
  const calls: { title?: string; metadata?: Record<string, unknown> }[] = [];
  const ctx = {
    sessionID,
    messageID: "plan-review-chrome-message",
    agent: "plan-review-chrome-agent",
    directory: projectDir,
    worktree: projectDir,
    abort: new AbortController().signal,
    metadata: (input: { title?: string; metadata?: Record<string, unknown> }) => {
      calls.push(input);
    },
    ask: async () => {},
  } as Parameters<typeof planReviewTool.execute>[1];
  return { ctx, calls };
}

// -----------------------------------------------------------------------------
// planReviewArgsSchema — the Zod refine (AC #2, plan §5 risk row)
// -----------------------------------------------------------------------------

describe("planReviewArgsSchema refine", () => {
  test("accepts exactly one non-empty payload (snapshot)", () => {
    expect(() =>
      planReviewArgsSchema.parse({ snapshot: "x" }),
    ).not.toThrow();
  });

  test("accepts exactly one non-empty payload (plan)", () => {
    expect(() => planReviewArgsSchema.parse({ plan: "x" })).not.toThrow();
  });

  test("accepts exactly one non-empty payload (review)", () => {
    expect(() =>
      planReviewArgsSchema.parse({ review: "x" }),
    ).not.toThrow();
  });

  test("accepts the payload alongside project_dir", () => {
    expect(() =>
      planReviewArgsSchema.parse({ plan: "x", project_dir: "/p" }),
    ).not.toThrow();
  });

  test("rejects zero non-empty payloads", () => {
    expect(() => planReviewArgsSchema.parse({})).toThrow(/Exactly one/);
    expect(() => planReviewArgsSchema.parse({ snapshot: "" })).toThrow(/Exactly one/);
    expect(() => planReviewArgsSchema.parse({ snapshot: "   " })).toThrow(/Exactly one/);
  });

  test("rejects more than one non-empty payload", () => {
    expect(() =>
      planReviewArgsSchema.parse({ snapshot: "x", plan: "y" }),
    ).toThrow(/Exactly one/);
    expect(() =>
      planReviewArgsSchema.parse({ snapshot: "x", plan: "y", review: "z" }),
    ).toThrow(/Exactly one/);
  });
});

// -----------------------------------------------------------------------------
// planReviewTool — surface
// -----------------------------------------------------------------------------

describe("planReviewTool surface", () => {
  test("exports the tool with the expected arg keys", () => {
    expect(planReviewTool).toBeDefined();
    expect(planReviewTool.args).toBeDefined();
    // ZodRawShape: keys are the arg names.
    const keys = Object.keys(planReviewTool.args);
    expect(keys).toContain("snapshot");
    expect(keys).toContain("plan");
    expect(keys).toContain("review");
    expect(keys).toContain("project_dir");
  });

  test("MAX_BREACHES matches the source skill's hard cap (2)", () => {
    expect(MAX_BREACHES).toBe(2);
  });
});

// -----------------------------------------------------------------------------
// execute — no active plan
// -----------------------------------------------------------------------------

describe("execute with no active plan", () => {
  let tempRoot: string;
  beforeEach(async () => {
    tempRoot = realpathSync(await mkdtemp(join(tmpdir(), "ghs-pr-")));
  });
  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("returns a 'no plan in progress' message and does not throw", async () => {
    const result = await planReviewTool.execute(
      { plan: planBlob(longBody("body")) },
      mockCtx(tempRoot),
    );
    expect(result).toContain("没有进行中的 plan");
    expect(result).toContain("ghs-plan-start");
  });
});

// -----------------------------------------------------------------------------
// execute — snapshot mode (AC #3)
// -----------------------------------------------------------------------------

describe("execute snapshot mode", () => {
  let tempRoot: string;
  beforeEach(async () => {
    tempRoot = realpathSync(await mkdtemp(join(tmpdir(), "ghs-pr-snap-")));
  });
  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("parses snapshot, persists context file, dispatches designer", async () => {
    const status = baselineStatus({ status: "designing" });
    await writePlanStatus(tempRoot, status);

    const result = await planReviewTool.execute(
      { snapshot: snapshotBlob(longBody("Arch snapshot")) },
      mockCtx(tempRoot),
    );

    // Dispatch instruction mentions plan-designer + Task tool.
    expect(result).toContain("plan-designer");
    expect(result).toContain("Mode:              snapshot");
    expect(result).toContain("snapshot 已提取");

    // Context file was persisted.
    const ctxPath = join(plansDir(tempRoot), status.context_file);
    const ctxText = await Bun.file(ctxPath).text();
    expect(ctxText).toContain("Arch snapshot");

    // Status updated_at advanced (round stays at 1 for snapshot).
    // (We don't assert the exact timestamp — just that the file was rewritten.)
  });

  test("on malformed snapshot, returns retry instruction + raw post-mortem", async () => {
    const status = baselineStatus({ status: "designing" });
    await writePlanStatus(tempRoot, status);

    const result = await planReviewTool.execute(
      { snapshot: "no delimiters here, just garbage" },
      mockCtx(tempRoot),
    );

    expect(result).toContain("解析失败");
    expect(result).toContain("ghs-context-explorer");
    expect(result).toContain(".raw");

    // The raw response was persisted for diagnosis.
    const rawPath = join(
      plansDir(tempRoot),
      status.context_file.replace(/\.md$/, ".raw"),
    );
    const rawText = await Bun.file(rawPath).text();
    expect(rawText).toContain("no delimiters here");
  });
});

// -----------------------------------------------------------------------------
// execute — plan mode (AC #3)
// -----------------------------------------------------------------------------

describe("execute plan mode", () => {
  let tempRoot: string;
  beforeEach(async () => {
    tempRoot = realpathSync(await mkdtemp(join(tmpdir(), "ghs-pr-plan-")));
  });
  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("parses plan, persists plan file, dispatches reviewer, flips status to reviewing", async () => {
    const status = baselineStatus({ status: "designing" });
    await writePlanStatus(tempRoot, status);

    const result = await planReviewTool.execute(
      { plan: planBlob(longBody("# 方案标题")) },
      mockCtx(tempRoot),
    );

    expect(result).toContain("Mode:              plan");
    expect(result).toContain("plan-reviewer");
    expect(result).toContain("Plan 已提取");

    // Plan file persisted.
    const planPath = join(plansDir(tempRoot), status.plan_file);
    expect(await Bun.file(planPath).text()).toContain("# 方案标题");

    // Status advanced to reviewing.
    const { readPlanStatus } = await import("../src/lib/state");
    const updated = await readPlanStatus(tempRoot, status.plan_id);
    expect(updated?.status).toBe("reviewing");
  });
});

// -----------------------------------------------------------------------------
// execute — review mode (AC #3 + AC #5 round counter)
// -----------------------------------------------------------------------------

describe("execute review mode", () => {
  let tempRoot: string;
  beforeEach(async () => {
    tempRoot = realpathSync(await mkdtemp(join(tmpdir(), "ghs-pr-rev-")));
  });
  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("PASS: persists review, sets pending_approval, instructs finalize", async () => {
    const status = baselineStatus({ status: "reviewing" });
    await writePlanStatus(tempRoot, status);

    const result = await planReviewTool.execute(
      { review: reviewBlob(longBody("Review body"), "PASS") },
      mockCtx(tempRoot),
    );

    expect(result).toContain("Review PASS");
    expect(result).toContain("ghs-plan-finalize");

    const { readPlanStatus } = await import("../src/lib/state");
    const updated = await readPlanStatus(tempRoot, status.plan_id);
    expect(updated?.status).toBe("pending_approval");
    expect(updated?.review_file).toBe(`${status.plan_id}-review.md`);
  });

  test("FAIL below max_rounds: increments round, sets revising, dispatches designer revise", async () => {
    const status = baselineStatus({
      status: "reviewing",
      round: 1,
      max_rounds: 5,
    });
    await writePlanStatus(tempRoot, status);

    const result = await planReviewTool.execute(
      { review: reviewBlob(longBody("Has severe issue"), "FAIL") },
      mockCtx(tempRoot),
    );

    expect(result).toContain("Review FAIL");
    expect(result).toContain("revising");
    expect(result).toContain("round 1 → 2");
    expect(result).toContain("ghs-plan-designer");

    const { readPlanStatus } = await import("../src/lib/state");
    const updated = await readPlanStatus(tempRoot, status.plan_id);
    expect(updated?.round).toBe(2);
    expect(updated?.status).toBe("revising");
    expect(updated?.max_rounds_breaches).toBe(0); // not breached yet
  });

  test("FAIL at soft cap (round >= max_rounds, breaches < MAX): surfaces 3-way user decision", async () => {
    const status = baselineStatus({
      status: "reviewing",
      round: 5,
      max_rounds: 5,
      max_rounds_breaches: 0,
    });
    await writePlanStatus(tempRoot, status);

    const result = await planReviewTool.execute(
      { review: reviewBlob(longBody("Severe"), "FAIL") },
      mockCtx(tempRoot),
    );

    expect(result).toContain("软上限");
    expect(result).toContain("三选一");
    expect(result).toContain("继续修订");
    expect(result).toContain("接受当前方案");
    expect(result).toContain("终止");

    // Round NOT advanced — the user must opt into the breach first.
    const { readPlanStatus } = await import("../src/lib/state");
    const updated = await readPlanStatus(tempRoot, status.plan_id);
    expect(updated?.round).toBe(5);
    expect(updated?.status).toBe("pending_approval");
  });

  test("FAIL at hard cap (breaches >= MAX): surfaces 2-way decision, no continue", async () => {
    const status = baselineStatus({
      status: "reviewing",
      round: 5,
      max_rounds: 5,
      max_rounds_breaches: MAX_BREACHES,
    });
    await writePlanStatus(tempRoot, status);

    const result = await planReviewTool.execute(
      { review: reviewBlob(longBody("Severe"), "FAIL") },
      mockCtx(tempRoot),
    );

    expect(result).toContain("硬上限");
    expect(result).toContain("二选一");
    expect(result).not.toContain("继续修订（一次性 breach）");
  });

  test("FAIL with missing verdict: treated as format deviation, retry path", async () => {
    const status = baselineStatus({ status: "reviewing" });
    await writePlanStatus(tempRoot, status);

    // Review blob without the PLAN REVIEW COMPLETE | Verdict: line.
    const noVerdict =
      `<<<REVIEW_START>>>\n${longBody("Review body")}\n<<<REVIEW_END>>>`;

    const result = await planReviewTool.execute(
      { review: noVerdict },
      mockCtx(tempRoot),
    );

    expect(result).toContain("解析失败");
    expect(result).toContain("ghs-plan-reviewer");
  });
});

// -----------------------------------------------------------------------------
// execute — active-plan discovery picks the non-terminal status
// -----------------------------------------------------------------------------

describe("active-plan discovery", () => {
  let tempRoot: string;
  beforeEach(async () => {
    tempRoot = realpathSync(await mkdtemp(join(tmpdir(), "ghs-pr-disc-")));
  });
  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("skips terminal (approved) plans and uses the active one", async () => {
    const approved = baselineStatus({
      plan_id: "2026-06-20-old",
      plan_file: "2026-06-20-old.md",
      context_file: "2026-06-20-old-context.md",
      status: "approved",
    });
    const active = baselineStatus({
      plan_id: "2026-06-20-new",
      plan_file: "2026-06-20-new.md",
      context_file: "2026-06-20-new-context.md",
      status: "designing",
    });
    await writePlanStatus(tempRoot, approved);
    await writePlanStatus(tempRoot, active);

    const result = await planReviewTool.execute(
      { snapshot: snapshotBlob(longBody("body")) },
      mockCtx(tempRoot),
    );

    // The active plan's id is surfaced in the header.
    expect(result).toContain("Active plan:       2026-06-20-new");
    // The approved plan's context file is NOT touched.
    const oldCtx = join(plansDir(tempRoot), approved.context_file);
    expect(await Bun.file(oldCtx).exists()).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Workflow chrome (Feature s1-feat-005) — post-advance drift assertions
// -----------------------------------------------------------------------------
//
// AC #3 (plan §4 Phase 1 post-advance timing): plan-review plan mode on the
// success path must return text containing `staleTodoWarning` with expected
// stage `plan:reviewing` (post-advance — handlePlanMode just wrote
// `status="reviewing"` to status.json). The setup is explicit per the AC:
//   (a) first call recordTodoTick to set lastTodoMs (else lastTodoMs===
//       undefined → "never" branch → todoDirective, NOT staleTodoWarning);
//   (b) then prime lastStageSeenByTool to "plan:designing" as the drift
//       baseline (else no drift → fresh → no staleTodoWarning).
// With both in place, handlePlanMode's post-advance write of `reviewing`
// makes getStageSignature read "plan:reviewing" !== baseline "plan:designing"
// → row 3 drift → staleTodoWarning("plan:reviewing").

describe("plan-review workflow chrome (s1-feat-005)", () => {
  let tempRoot: string;
  beforeEach(async () => {
    tempRoot = realpathSync(await mkdtemp(join(tmpdir(), "ghs-pr-chrome-")));
  });
  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("AC #3 plan mode drift: stageHeader 'plan:reviewing' + staleTodoWarning(post-advance)", async () => {
    // Active plan in `designing` (the pre-advance state handlePlanMode will
    // transition away from when it writes `reviewing`).
    const status = baselineStatus({ status: "designing" });
    await writePlanStatus(tempRoot, status);

    // Unique session id so the module-level sessions Map carries no prior
    // state from other tests in this file.
    const sid = "pr-chrome-drift-1";
    // (a) Set lastTodoMs via recordTodoTick — required to escape the "never"
    //     branch (judgment-table row 2).
    recordTodoTick(sid);
    // (b) Prime lastStageSeenByTool to "plan:designing" — the drift baseline.
    //     classifyStaleState advances lastStageSeenByTool as a side effect.
    classifyStaleState(sid, "plan:designing");

    const { ctx, calls } = mockCtxCaptured(tempRoot, sid);
    const result = await planReviewTool.execute(
      { plan: planBlob(longBody("# Drift Test Plan")) },
      ctx,
    );

    // (1) Post-advance stageHeader: handlePlanMode wrote `status="reviewing"`
    //     to disk; getStageSignature ran AFTER that write → "plan:reviewing".
    //     A pre-advance read would yield "plan:designing" (the input state).
    expect(result).toContain("--- ghs stage: plan:reviewing ---");
    // (2) Drift branch fired staleTodoWarning referencing the post-advance
    //     stage. NOT todoDirective (would be the "never" branch).
    expect(result).toContain("STALE TODO:");
    expect(result).toContain("plan:reviewing");
    expect(result).not.toContain("TODO: call the `todowrite` tool to build");
    // (3) nextActionAnchor still appended.
    expect(result).toContain("▶ NEXT ACTION:");
    // (4) Original body preserved (AC #6 regression — existing assertions
    //     still hold inside the chrome-wrapped result).
    expect(result).toContain("Plan 已提取");
    expect(result).toContain("Mode:              plan");
    // (5) ctx.metadata called with the post-advance stage title (AC #4).
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0].title).toBe("[ghs] plan:reviewing");
    expect(calls[0].metadata?.stage).toBe("plan:reviewing");
    expect(calls[0].metadata?.stale).toBe("drift");
  });

  test("first plan-review call (no prior tick) → todoDirective, NOT staleTodoWarning", async () => {
    // Judgment-table row 2: lastTodoMs === undefined → never → todoDirective.
    // This is the "constructive first nudge" branch — it must NOT fire the
    // staleTodoWarning (which would be a semantically-inverted "stage already
    // advanced" warning before any stage has ever been observed).
    const status = baselineStatus({ status: "designing" });
    await writePlanStatus(tempRoot, status);

    const sid = "pr-chrome-never-1";
    // No recordTodoTick — lastTodoMs is undefined.
    const { ctx, calls } = mockCtxCaptured(tempRoot, sid);
    const result = await planReviewTool.execute(
      { plan: planBlob(longBody("# First Call Plan")) },
      ctx,
    );

    expect(result).toContain("--- ghs stage: plan:reviewing ---");
    expect(result).toContain("TODO: call the `todowrite` tool");
    expect(result).not.toContain("STALE TODO:");
    expect(result).toContain("▶ NEXT ACTION:");
    expect(calls[0].title).toBe("[ghs] plan:reviewing");
    expect(calls[0].metadata?.stale).toBe("never");
  });

  test("no active plan → judgment-table row 1 → no chrome at all (body verbatim)", async () => {
    // No status.json seeded → findActivePlanStatus returns null → tool's
    // "no plan in progress" branch → getStageSignature returns null → no
    // chrome, no ctx.metadata call.
    const sid = "pr-chrome-inactive-1";
    const { ctx, calls } = mockCtxCaptured(tempRoot, sid);

    const result = await planReviewTool.execute(
      { plan: planBlob(longBody("# No Plan")) },
      ctx,
    );

    expect(result).toContain("没有进行中的 plan");
    expect(result).not.toContain("--- ghs stage:");
    expect(result).not.toContain("TODO: call the `todowrite`");
    expect(result).not.toContain("STALE TODO:");
    expect(result).not.toContain("▶ NEXT ACTION:");
    expect(calls).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------
// planner_backend dispatch resolution (Feature s1-feat-009)
// -----------------------------------------------------------------------------
//
// Mechanism 二 §3.2.1 改造点(b): the two designer-dispatch points
// (handleSnapshotMode success + handleReviewMode revise branch) read
// `.ghs/ghs.json` via loadGhsConfig and pass `config.planner_backend` to
// getDesignerPrompt. Default backend returns the existing PLAN_DESIGNER_PROMPT
// (byte-equivalent regression); builtin-plan returns PLAN_DESIGNER_PROMPT_BUILTIN.
//
// Two-class error handling: default-file error (msg contains "ghs.default.json")
// → fall back + warning; user ghs.json invalid → re-throw.

describe("planner_backend dispatch resolution (s1-feat-009)", () => {
  let tempRoot: string;
  beforeEach(async () => {
    tempRoot = realpathSync(await mkdtemp(join(tmpdir(), "ghs-pr-backend-")));
  });
  afterEach(async () => {
    // Always restore the real loader so the seam never bleeds into sibling
    // tests (the sessions Map / loader are module-level singletons).
    setGhsConfigLoaderForTest(null);
    await rm(tempRoot, { recursive: true, force: true });
  });

  /** Write a `.ghs/ghs.json` fixture under the temp project root. */
  async function writeGhsJson(dir: string, obj: unknown): Promise<void> {
    await mkdir(join(dir, ".ghs"), { recursive: true });
    await writeFile(join(dir, ".ghs", "ghs.json"), JSON.stringify(obj));
  }

  test("AC #1 default backend (no ghs.json) → ghs-plan-designer dispatch (regression)", async () => {
    const status = baselineStatus({ status: "designing" });
    await writePlanStatus(tempRoot, status);

    const result = await planReviewTool.execute(
      { snapshot: snapshotBlob(longBody("Arch snapshot")) },
      mockCtx(tempRoot),
    );

    // Default dispatch: the self-built ghs-plan-designer subagent prompt.
    expect(result).toContain("ghs-plan-designer");
    expect(result).toContain("Task tool");
    // NOT the opt-in builtin prompt.
    expect(result).not.toContain("BUILT-IN");
    // No fallback warning on the normal path.
    expect(result).not.toContain("落回默认");
  });

  test("AC #2 planner_backend=builtin-plan → builtin dispatch with embedded contract (snapshot)", async () => {
    await writeGhsJson(tempRoot, {
      models: { context: "m-c", designer: "m-d", reviewer: "m-r" },
      planner_backend: "builtin-plan",
    });
    const status = baselineStatus({ status: "designing" });
    await writePlanStatus(tempRoot, status);

    const result = await planReviewTool.execute(
      { snapshot: snapshotBlob(longBody("Arch snapshot")) },
      mockCtx(tempRoot),
    );

    // Builtin prompt: English, dispatches the built-in `plan` agent.
    expect(result).toContain("BUILT-IN");
    expect(result).toContain('agent: "plan"');
    // Embedded delimiter contract (referred to by marker name in the prompt).
    expect(result).toContain("<<<PLAN_START>>>");
    expect(result).toContain("<<<PLAN_END>>>");
    // NOT the default Chinese self-built dispatch opening.
    expect(result).not.toContain("派发 `ghs-plan-designer`");
  });

  test("AC #2 review revise branch also honours planner_backend=builtin-plan", async () => {
    await writeGhsJson(tempRoot, {
      models: { context: "m-c", designer: "m-d", reviewer: "m-r" },
      planner_backend: "builtin-plan",
    });
    const status = baselineStatus({
      status: "reviewing",
      round: 1,
      max_rounds: 5,
    });
    await writePlanStatus(tempRoot, status);

    const result = await planReviewTool.execute(
      { review: reviewBlob(longBody("Severe issue"), "FAIL") },
      mockCtx(tempRoot),
    );

    // Revise round advanced + builtin designer dispatch emitted.
    expect(result).toContain("revising");
    expect(result).toContain("round 1 → 2");
    expect(result).toContain("BUILT-IN");
    expect(result).toContain('agent: "plan"');
  });

  test("AC #3 default-file error (msg contains ghs.default.json) → falls back + warning at end", async () => {
    setGhsConfigLoaderForTest(async () => {
      throw new Error(
        "Failed to read ghs.default.json: file not found at /shared/ghs.default.json",
      );
    });
    const status = baselineStatus({ status: "designing" });
    await writePlanStatus(tempRoot, status);

    // Unique session so chrome state is isolated; no recordTodoTick →
    // "never" branch → the ▶ NEXT ACTION anchor is present, letting us prove
    // the warning is appended AFTER it (i.e. at the very end).
    const sid = "pr-backend-warn-1";
    const { ctx } = mockCtxCaptured(tempRoot, sid);

    const result = await planReviewTool.execute(
      { snapshot: snapshotBlob(longBody("Arch snapshot")) },
      ctx,
    );

    // Fell back to the default ghs-plan-designer dispatch (still functional).
    expect(result).toContain("ghs-plan-designer");
    expect(result).toContain("Task tool");
    // Warning concatenated INTO the returned string (not console.*, per C2).
    expect(result).toContain("ghs.default.json");
    expect(result).toContain("落回默认");
    // The warning lands at the END — strictly after the ▶ NEXT ACTION anchor.
    const anchorIdx = result.lastIndexOf("▶ NEXT ACTION");
    const warnIdx = result.lastIndexOf("ghs.default.json");
    expect(anchorIdx).toBeGreaterThan(-1);
    expect(warnIdx).toBeGreaterThan(anchorIdx);
  });

  test("AC #3 default-file error on revise branch → falls back + warning at end", async () => {
    setGhsConfigLoaderForTest(async () => {
      throw new Error(
        "Failed to parse ghs.default.json at /shared/ghs.default.json: invalid JSON",
      );
    });
    const status = baselineStatus({
      status: "reviewing",
      round: 1,
      max_rounds: 5,
    });
    await writePlanStatus(tempRoot, status);

    const sid = "pr-backend-warn-revise-1";
    const { ctx } = mockCtxCaptured(tempRoot, sid);
    const result = await planReviewTool.execute(
      { review: reviewBlob(longBody("Severe"), "FAIL") },
      ctx,
    );

    expect(result).toContain("revising");
    // Fell back to the default designer dispatch.
    expect(result).toContain("ghs-plan-designer");
    // Warning present and after the anchor.
    const anchorIdx = result.lastIndexOf("▶ NEXT ACTION");
    const warnIdx = result.lastIndexOf("ghs.default.json");
    expect(anchorIdx).toBeGreaterThan(-1);
    expect(warnIdx).toBeGreaterThan(anchorIdx);
  });

  test("AC #4 user ghs.json JSON-parse error → re-thrown, not swallowed", async () => {
    setGhsConfigLoaderForTest(async () => {
      throw new Error(
        "Failed to parse ghs.json at /p/.ghs/ghs.json: invalid JSON — Unexpected token",
      );
    });
    const status = baselineStatus({ status: "designing" });
    await writePlanStatus(tempRoot, status);

    await expect(
      planReviewTool.execute(
        { snapshot: snapshotBlob(longBody("Arch snapshot")) },
        mockCtx(tempRoot),
      ),
    ).rejects.toThrow(/ghs\.json/);
  });

  test("AC #4 user ghs.json ZodError (no file label) → re-thrown", async () => {
    setGhsConfigLoaderForTest(async () => {
      throw new Error(
        "Invalid config: planner_backend — Invalid enum value. Expected 'ghs-plan-designer' | 'builtin-plan', received 'typo-plan'",
      );
    });
    const status = baselineStatus({ status: "designing" });
    await writePlanStatus(tempRoot, status);

    await expect(
      planReviewTool.execute(
        { snapshot: snapshotBlob(longBody("Arch snapshot")) },
        mockCtx(tempRoot),
      ),
    ).rejects.toThrow(/Invalid enum value/);
  });
});

// -----------------------------------------------------------------------------
// Truncation recovery nudge (Feature s2-feat-002, Phase 2)
// -----------------------------------------------------------------------------
//
// When a subagent output looks truncated (START present, END absent), the
// retry path and the open_ended success path append a best-effort nudge
// pointing the caller at the saved tool-output file so it can recover the
// full text. The ok/exact success path and the non-truncated retry path stay
// byte-identical to pre-Phase-2 output.

describe("truncation recovery nudge (s2-feat-002)", () => {
  let tempRoot: string;
  beforeEach(async () => {
    tempRoot = realpathSync(await mkdtemp(join(tmpdir(), "ghs-pr-trunc-")));
  });
  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  /** PLAN_START present, END absent, body long enough for open_ended to succeed. */
  function truncatedPlanBlob(body: string): string {
    return `<<<PLAN_START>>>\n${body}`;
  }

  test("AC #1 retry path + looksTruncated=true → retry body contains tool-output recovery guidance", async () => {
    const status = baselineStatus({ status: "designing" });
    await writePlanStatus(tempRoot, status);

    // START present, END absent, but the body is far too short → open_ended
    // finds too-short content (foundShortContent) → status=empty → retry
    // path. looksTruncated(rawText, START, END) === true.
    const truncatedShort = "<<<PLAN_START>>>\nshort body";

    const result = await planReviewTool.execute(
      { plan: truncatedShort },
      mockCtx(tempRoot),
    );

    // Retry body present.
    expect(result).toContain("解析失败");
    // Recovery nudge appended.
    expect(result).toContain("疑似截断");
    expect(result).toContain("Full output saved to");
  });

  test("AC #2 retry path + looksTruncated=false → no nudge (existing retry body unchanged)", async () => {
    const status = baselineStatus({ status: "designing" });
    await writePlanStatus(tempRoot, status);

    // No delimiters at all → looksTruncated=false, status=empty → retry path.
    const noDelimiters = "no delimiters here, just short garbage";

    const result = await planReviewTool.execute(
      { plan: noDelimiters },
      mockCtx(tempRoot),
    );

    expect(result).toContain("解析失败");
    // No recovery nudge — bytes identical to pre-Phase-2 retry body.
    expect(result).not.toContain("疑似截断");
    expect(result).not.toContain("Full output saved to");
  });

  test("AC #3 open_ended success (START no END, long body) → ✅ line followed by nudge", async () => {
    const status = baselineStatus({ status: "designing" });
    await writePlanStatus(tempRoot, status);

    const result = await planReviewTool.execute(
      { plan: truncatedPlanBlob(longBody("# Truncated Plan")) },
      mockCtx(tempRoot),
    );

    // Success branch taken (not retry): open_ended extracted START..EOF.
    expect(result).toContain("Plan 已提取");
    expect(result).toContain("strategy: open_ended");
    // Nudge present.
    expect(result).toContain("疑似截断");
    expect(result).toContain("Full output saved to");
    // Nudge lands AFTER the ✅ success-marker line.
    const checkIdx = result.indexOf("Plan 已提取");
    const nudgeIdx = result.indexOf("疑似截断");
    expect(checkIdx).toBeGreaterThan(-1);
    expect(nudgeIdx).toBeGreaterThan(checkIdx);
  });

  test("AC #4 ok exact success (paired delimiters) → no nudge (ok path bytes unchanged)", async () => {
    const status = baselineStatus({ status: "designing" });
    await writePlanStatus(tempRoot, status);

    const result = await planReviewTool.execute(
      { plan: planBlob(longBody("# Exact Plan")) },
      mockCtx(tempRoot),
    );

    expect(result).toContain("Plan 已提取");
    expect(result).toContain("strategy: exact_delimiter");
    // No nudge — ok/exact path byte-identical to pre-Phase-2.
    expect(result).not.toContain("疑似截断");
    expect(result).not.toContain("Full output saved to");
  });
});
