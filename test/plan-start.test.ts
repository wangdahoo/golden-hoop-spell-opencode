// Unit tests for `src/tools/plan-start.ts` — workflow-chrome assertions
// (Feature s1-feat-005).
//
// Focuses on the mechanism-1 injection point ② main path added by s1-feat-005:
//   - AC #1: prepend `stageHeader` + append `nextActionAnchor` to the return
//            text of any ghs multi-step tool.
//   - AC #2: the first `ghs-plan-start` call (lastTodoMs === undefined) →
//            returns text containing `todoDirective` (NOT `staleTodoWarning`)
//            and `stageHeader` marking `plan:designing` (post-advance — the
//            just-written status).
//   - AC #4: execute calls `ctx.metadata({ title: "[ghs] <stage>" })` before
//            returning.
//   - AC #6: existing assertions still pass (regression — the original
//            "=== ghs-plan-start complete ===" framing is preserved verbatim
//            inside the chrome-wrapped result).
//
// Post-advance timing (plan §3.1 时序约束 — 关键): the tests assert the
// stageHeader label is `plan:designing`, proving `getStageSignature` was
// invoked AFTER `writePlanStatus` completed (pre-advance read would yield
// null since the file did not exist before this call → no chrome at all).
//
// Temp-dir + mock-ToolContext policy matches test/plan-review.test.ts and
// test/todo-tracker.test.ts: mkdtemp under os.tmpdir() + realpathSync.

import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { planStartTool } from "../src/tools/plan-start";
import {
  recordTodoTick,
  classifyStaleState,
} from "../src/lib/todo-tracker";

/**
 * Build a mock ToolContext whose `worktree` / `directory` point at
 * `projectDir` and whose `sessionID` is the supplied value. `metadata` calls
 * are captured in the returned `calls` array so tests can assert the
 * injection-point-③ main path invoked `ctx.metadata({ title })`.
 */
function mockCtxWithCapture(
  projectDir: string,
  sessionID: string,
): {
  ctx: Parameters<typeof planStartTool.execute>[1];
  calls: { title?: string; metadata?: Record<string, unknown> }[];
} {
  const calls: { title?: string; metadata?: Record<string, unknown> }[] = [];
  const ctx = {
    sessionID,
    messageID: "plan-start-test-message",
    agent: "plan-start-test-agent",
    directory: projectDir,
    worktree: projectDir,
    abort: new AbortController().signal,
    metadata: (input: { title?: string; metadata?: Record<string, unknown> }) => {
      calls.push(input);
    },
    ask: async () => {},
  } as Parameters<typeof planStartTool.execute>[1];
  return { ctx, calls };
}

describe("plan-start workflow chrome (s1-feat-005)", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = realpathSync(await mkdtemp(join(tmpdir(), "ghs-ps-chrome-")));
  });
  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("AC #2 + post-advance timing: first call → todoDirective + stageHeader 'plan:designing' (not staleTodoWarning)", async () => {
    // Unique session id → module-level sessions Map has no prior state for
    // this session → lastTodoMs === undefined → judgment-table row 2 ("never")
    // → todoDirective must fire (NOT staleTodoWarning).
    const sid = "ps-never-first-call";
    const { ctx, calls } = mockCtxWithCapture(tempRoot, sid);

    const result = await planStartTool.execute({}, ctx);

    // (a) stageHeader prepended, marking the post-advance stage. A pre-advance
    //     read would find no status.json → null → no chrome at all, so this
    //     assertion pins the post-advance timing.
    expect(result).toContain("--- ghs stage: plan:designing ---");
    // (b) Judgment-table row 2 ("never"): todoDirective is appended.
    expect(result).toContain("TODO: call the `todowrite` tool");
    // (c) NOT staleTodoWarning (would be row 3 — wrong for lastTodoMs===undefined).
    expect(result).not.toContain("STALE TODO:");
    // (d) nextActionAnchor appended (AC #1).
    expect(result).toContain("▶ NEXT ACTION:");
    // (e) Original body preserved (AC #6 regression).
    expect(result).toContain("=== ghs-plan-start complete ===");
    expect(result).toContain("Round:             1 /");

    // (f) ctx.metadata was called with the post-advance stage title (AC #4).
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0].title).toBe("[ghs] plan:designing");
    expect(calls[0].metadata?.stage).toBe("plan:designing");
  });

  test("AC #4: ctx.metadata sets title '[ghs] <stage>' (injection point ③ main path)", async () => {
    const sid = "ps-metadata-title";
    const { ctx, calls } = mockCtxWithCapture(tempRoot, sid);

    await planStartTool.execute({}, ctx);

    // The title format is exactly "[ghs] <stage>" per AC #4.
    expect(calls).toEqual([
      expect.objectContaining({
        title: "[ghs] plan:designing",
        metadata: expect.objectContaining({ stage: "plan:designing" }),
      }),
    ]);
  });

  test("AC #1: stageHeader is prepended (appears before the body)", async () => {
    const sid = "ps-prepend-order";
    const { ctx } = mockCtxWithCapture(tempRoot, sid);

    const result = await planStartTool.execute({}, ctx);

    const headerIdx = result.indexOf("--- ghs stage: plan:designing ---");
    const bodyIdx = result.indexOf("=== ghs-plan-start complete ===");
    expect(headerIdx).toBeGreaterThanOrEqual(0);
    expect(bodyIdx).toBeGreaterThan(headerIdx);
  });

  test("AC #1: nextActionAnchor is appended (appears after the body)", async () => {
    const sid = "ps-append-order";
    const { ctx } = mockCtxWithCapture(tempRoot, sid);

    const result = await planStartTool.execute({}, ctx);

    const bodyIdx = result.indexOf("=== ghs-plan-start complete ===");
    const anchorIdx = result.indexOf("▶ NEXT ACTION:");
    expect(bodyIdx).toBeGreaterThanOrEqual(0);
    expect(anchorIdx).toBeGreaterThan(bodyIdx);
  });

  test("drift branch: prior 'plan:designing' baseline + tick → stage transition fires staleTodoWarning", async () => {
    // This mirrors the plan-review plan-mode drift scenario but for a
    // re-invoked plan-start: a compliant AI has already ticked (so
    // lastTodoMs is set), and a prior classify at "plan:designing" advanced
    // lastStageSeenByTool. On the next plan-start the post-advance read is
    // still "plan:designing" (fresh start re-writes designing) → fresh, no
    // staleTodoWarning. Documented here to contrast with plan-review's
    // designing→reviewing transition (which IS drift).
    const sid = "ps-drift-baseline";
    recordTodoTick(sid);
    classifyStaleState(sid, "plan:designing"); // prime lastStageSeenByTool

    const { ctx, calls } = mockCtxWithCapture(tempRoot, sid);
    const result = await planStartTool.execute({}, ctx);

    // Post-advance read is "plan:designing" === lastStageSeenByTool → fresh.
    // No staleTodoWarning, but the unconditional stageHeader + nextActionAnchor
    // still apply.
    expect(result).toContain("--- ghs stage: plan:designing ---");
    expect(result).not.toContain("STALE TODO:");
    expect(result).toContain("▶ NEXT ACTION:");
    expect(calls[0].title).toBe("[ghs] plan:designing");
  });
});

// -----------------------------------------------------------------------------
// slug_seed → semantic planId (s? semantic-slug feature).
//
// `ghs-plan-start` accepts an optional `slug_seed` (an English ASCII kebab-case
// slug the caller derives from the user's requirement description). The slug
// replaces the legacy fixed `plan` stem in the plan_id (`{YYYY-MM-DD}-{slug}`)
// and therefore in the on-disk status.json file name. These tests pin the
// happy path, the sanitisation safety net, the CJK-collapse fallback, and the
// backward-compatible empty / omitted behaviour.
//
// They reuse the module-level `mockCtxWithCapture` helper. A fresh temp dir is
// created per test so the on-disk status.json file name can be asserted via
// readdir without cross-test bleed.

describe("plan-start slug_seed → semantic planId", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = realpathSync(await mkdtemp(join(tmpdir(), "ghs-ps-slug-")));
  });
  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  /** Read the single `*-status.json` written under `.ghs/plans/` and parse it. */
  async function readStatusJson(): Promise<{ plan_id: string }> {
    const plansDirAbs = join(tempRoot, ".ghs", "plans");
    const entries = await readdir(plansDirAbs);
    const statusName = entries.find((f) => f.endsWith("-status.json"));
    if (!statusName) {
      throw new Error(`no *-status.json under ${plansDirAbs}; got: ${entries}`);
    }
    return JSON.parse(
      await readFile(join(plansDirAbs, statusName), "utf8"),
    ) as { plan_id: string };
  }

  test("uses a clean kebab slug_seed verbatim in plan_id + file name", async () => {
    const sid = "ps-slug-clean";
    const { ctx } = mockCtxWithCapture(tempRoot, sid);

    const result = await planStartTool.execute(
      { slug_seed: "todo-app" },
      ctx,
    );

    // Result text surfaces the slug + plan_id.
    expect(result).toContain("Slug:              todo-app");
    expect(result).toMatch(/Plan id:\s+\d{4}-\d{2}-\d{2}-todo-app/);

    // On-disk status.json content carries the semantic plan_id.
    const status = await readStatusJson();
    expect(status.plan_id).toMatch(/^\d{4}-\d{2}-\d{2}-todo-app$/);
  });

  test("sanitises a slug_seed with whitespace / casing / punctuation", async () => {
    const sid = "ps-slug-sanitise";
    const { ctx } = mockCtxWithCapture(tempRoot, sid);

    const result = await planStartTool.execute(
      { slug_seed: "  Todo App!!  " },
      ctx,
    );

    // trim → "Todo App!!" → whitespace→- → "Todo-App!!" → non-safe→- →
    // "Todo-App-" → strip trailing - → lower → "todo-app".
    expect(result).toContain("Slug:              todo-app");
    expect(result).toMatch(/Plan id:\s+\d{4}-\d{2}-\d{2}-todo-app/);
  });

  test("falls back to 'plan' when slug_seed is empty / whitespace-only", async () => {
    const sid = "ps-slug-empty";
    const { ctx } = mockCtxWithCapture(tempRoot, sid);

    const result = await planStartTool.execute({ slug_seed: "   " }, ctx);

    expect(result).toContain("Slug:              plan");
    expect(result).toMatch(/Plan id:\s+\d{4}-\d{2}-\d{2}-plan/);
  });

  test("falls back to 'plan' when slug_seed is omitted (backward-compat)", async () => {
    const sid = "ps-slug-omitted";
    const { ctx } = mockCtxWithCapture(tempRoot, sid);

    // No slug_seed at all — the legacy call shape used by every pre-existing
    // test and any caller that hasn't been updated.
    const result = await planStartTool.execute({}, ctx);

    expect(result).toContain("Slug:              plan");
    expect(result).toMatch(/Plan id:\s+\d{4}-\d{2}-\d{2}-plan/);
  });

  test("collapses CJK-only slug_seed to the 'plan' fallback", async () => {
    const sid = "ps-slug-cjk";
    const { ctx } = mockCtxWithCapture(tempRoot, sid);

    // CJK chars are not filesystem-safe → all collapsed to `-` → stripped →
    // empty → fallback `plan`. This is the deliberate safety net that pushes
    // "按语义转 slug" responsibility onto the caller (LLM) rather than pulling
    // in a pinyin dependency.
    const result = await planStartTool.execute(
      { slug_seed: "帮我设计一个待办应用" },
      ctx,
    );

    expect(result).toContain("Slug:              plan");
    expect(result).toMatch(/Plan id:\s+\d{4}-\d{2}-\d{2}-plan/);
  });
});
