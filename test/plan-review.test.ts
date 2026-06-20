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

import { planReviewTool, planReviewArgsSchema, MAX_BREACHES } from "../src/tools/plan-review";
import {
  createInitialPlanStatus,
  writePlanStatus,
  plansDir,
  DEFAULT_MAX_ROUNDS,
  type PlanStatus,
} from "../src/lib/state";
import { DEFAULT_MIN_LENGTH } from "../src/lib/parse";

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
function mockCtx(projectDir: string) {
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
    expect(result).toContain("ghs-context-haiku");
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
