// Unit tests for `src/tools/code.ts` — workflow-chrome assertions
// (Feature s1-feat-005).
//
// The existing `test/integration/code-dispatch.test.ts` covers the dispatch
// guidance shape (s4-feat-005 AC #3). This file focuses narrowly on the
// mechanism-1 injection point ② main path added by s1-feat-005:
//   - AC #1: prepend `stageHeader` + append `nextActionAnchor` to the return
//            text of any ghs multi-step tool.
//   - AC #4: execute calls `ctx.metadata({ title: "[ghs] <stage>" })` before
//            returning.
//   - AC #5: code parallel mode → `todoDirective`'s stages list expands to
//            the batch's feature ids (plan §3.1 注入点② "code 并行场景的
//            todoDirective 按 batch 展开").
//
// For `ghs-code`, `getStageSignature` derives the stage purely from args
// (`code:<feature_id>` | `code:batch` | `code:default`) — no disk read — so
// the post-advance timing constraint is trivially satisfied. The tests
// therefore focus on shape, not timing.
//
// Temp-dir + mock-ToolContext policy matches test/integration/code-dispatch.test.ts.

import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { codeTool } from "../src/tools/code";

/** Minimal features.json fixture shape (mirrors code-dispatch.test.ts). */
interface FixtureFeature {
  id: string;
  title: string;
  status: string;
  dependencies?: string[];
  files_affected?: string[];
  acceptance_criteria?: string[];
}
interface FixtureSprint {
  id: string;
  status: string;
  features: FixtureFeature[];
}
interface FixtureData {
  project: string;
  sprints: FixtureSprint[];
  metadata: Record<string, unknown>;
}

async function seedFeatures(projectDir: string, data: FixtureData): Promise<void> {
  await mkdir(join(projectDir, ".ghs"), { recursive: true });
  await writeFile(
    join(projectDir, ".ghs", "features.json"),
    JSON.stringify(data),
  );
}

/**
 * Build a mock ToolContext with a pinned `sessionID` and a metadata-call
 * capture array. Mirrors the pattern in test/plan-start.test.ts.
 */
function mockCtxCaptured(
  projectDir: string,
  sessionID: string,
): {
  ctx: Parameters<typeof codeTool.execute>[1];
  calls: { title?: string; metadata?: Record<string, unknown> }[];
} {
  const calls: { title?: string; metadata?: Record<string, unknown> }[] = [];
  const ctx = {
    sessionID,
    messageID: "code-chrome-test-message",
    agent: "code-chrome-test-agent",
    directory: projectDir,
    worktree: projectDir,
    abort: new AbortController().signal,
    metadata: (input: { title?: string; metadata?: Record<string, unknown> }) => {
      calls.push(input);
    },
    ask: async () => {},
  } as Parameters<typeof codeTool.execute>[1];
  return { ctx, calls };
}

describe("code workflow chrome (s1-feat-005)", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await (async () => {
      const { mkdtemp } = await import("node:fs/promises");
      const { realpathSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const raw = await mkdtemp(join(tmpdir(), "ghs-code-chrome-"));
      return realpathSync(raw);
    })();
  });
  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  test("AC #1 + #4 single mode: stageHeader 'code:<id>' prepended + ctx.metadata called", async () => {
    await seedFeatures(projectDir, {
      project: "test-project",
      sprints: [
        {
          id: "s-chrome",
          status: "in_progress",
          features: [
            {
              id: "s-chrome-feat-001",
              title: "Single feature for chrome test",
              status: "pending",
              dependencies: [],
              files_affected: ["src/a.ts"],
              acceptance_criteria: ["AC1"],
            },
          ],
        },
      ],
      metadata: { version: "1.0.0" },
    });

    const sid = "code-chrome-single-1";
    const { ctx, calls } = mockCtxCaptured(projectDir, sid);

    const result = await codeTool.execute({ project_dir: projectDir }, ctx);

    // stageHeader prepended with code:default (no feature_id, no parallel).
    expect(result).toContain("--- ghs stage: code:default ---");
    // Original body preserved.
    expect(result).toContain("=== ghs-code: feature ready ===");
    // nextActionAnchor appended.
    expect(result).toContain("▶ NEXT ACTION:");
    // Judgment-table row 2 ("never" — fresh session, no tick) → todoDirective.
    expect(result).toContain("TODO: call the `todowrite` tool");
    expect(result).not.toContain("STALE TODO:");
    // ctx.metadata called with [ghs] code:default.
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0].title).toBe("[ghs] code:default");
    expect(calls[0].metadata?.stage).toBe("code:default");
  });

  test("AC #4 pinned mode: stageHeader 'code:<feature_id>' + ctx.metadata", async () => {
    await seedFeatures(projectDir, {
      project: "test-project",
      sprints: [
        {
          id: "s-chrome",
          status: "in_progress",
          features: [
            {
              id: "s-chrome-feat-pin",
              title: "Pinned feature for chrome test",
              status: "pending",
              dependencies: [],
              files_affected: ["src/pin.ts"],
              acceptance_criteria: ["AC1"],
            },
          ],
        },
      ],
      metadata: { version: "1.0.0" },
    });

    const sid = "code-chrome-pin-1";
    const { ctx, calls } = mockCtxCaptured(projectDir, sid);

    const result = await codeTool.execute(
      { feature_id: "s-chrome-feat-pin", project_dir: projectDir },
      ctx,
    );

    expect(result).toContain("--- ghs stage: code:s-chrome-feat-pin ---");
    expect(result).toContain("▶ NEXT ACTION:");
    expect(calls[0].title).toBe("[ghs] code:s-chrome-feat-pin");
    expect(calls[0].metadata?.stage).toBe("code:s-chrome-feat-pin");
  });

  test("AC #5 parallel mode: stageHeader 'code:batch' + todoDirective expands batch feature ids", async () => {
    await seedFeatures(projectDir, {
      project: "test-project",
      sprints: [
        {
          id: "s-chrome",
          status: "in_progress",
          features: [
            {
              id: "s-chrome-feat-a",
              title: "Parallel feature A",
              status: "pending",
              dependencies: [],
              files_affected: ["src/a.ts"],
              acceptance_criteria: ["AC1"],
            },
            {
              id: "s-chrome-feat-b",
              title: "Parallel feature B",
              status: "pending",
              dependencies: [],
              files_affected: ["src/b.ts"],
              acceptance_criteria: ["AC1"],
            },
          ],
        },
      ],
      metadata: { version: "1.0.0" },
    });

    const sid = "code-chrome-parallel-1";
    const { ctx, calls } = mockCtxCaptured(projectDir, sid);

    const result = await codeTool.execute(
      { parallel: true, project_dir: projectDir },
      ctx,
    );

    // stageHeader marks code:batch (post-advance signature for parallel).
    expect(result).toContain("--- ghs stage: code:batch ---");
    // todoDirective expanded the ready-features list as the stages checklist
    // (plan §3.1 "code 并行场景的 todoDirective 按 batch 展开"). The single-
    // in_progress constraint marks the head; the rest render as pending.
    expect(result).toContain("code:s-chrome-feat-a");
    expect(result).toContain("code:s-chrome-feat-b");
    expect(result).toContain("[in_progress] code:s-chrome-feat-a");
    expect(result).toContain("[pending] code:s-chrome-feat-b");
    // nextActionAnchor appended.
    expect(result).toContain("▶ NEXT ACTION:");
    // ctx.metadata called with [ghs] code:batch.
    expect(calls[0].title).toBe("[ghs] code:batch");
    expect(calls[0].metadata?.stage).toBe("code:batch");
  });

  test("drift branch: prior 'code:default' baseline + tick → fresh (same stage, no staleTodoWarning)", async () => {
    // After a prior code call at "code:default" advanced lastStageSeenByTool,
    // a second call at the same stage is "fresh" — no staleTodoWarning. The
    // unconditional stageHeader + nextActionAnchor still apply.
    await seedFeatures(projectDir, {
      project: "test-project",
      sprints: [
        {
          id: "s-chrome",
          status: "in_progress",
          features: [
            {
              id: "s-chrome-feat-fresh",
              title: "Fresh-stage feature",
              status: "pending",
              dependencies: [],
              files_affected: ["src/fresh.ts"],
              acceptance_criteria: ["AC1"],
            },
          ],
        },
      ],
      metadata: { version: "1.0.0" },
    });

    const sid = "code-chrome-fresh-1";
    // Prime: tick + classify at code:default → lastStageSeenByTool=code:default.
    const { recordTodoTick, classifyStaleState } = await import(
      "../src/lib/todo-tracker"
    );
    recordTodoTick(sid);
    classifyStaleState(sid, "code:default");

    const { ctx, calls } = mockCtxCaptured(projectDir, sid);
    const result = await codeTool.execute({ project_dir: projectDir }, ctx);

    expect(result).toContain("--- ghs stage: code:default ---");
    expect(result).not.toContain("STALE TODO:");
    expect(result).not.toContain("TODO: call the `todowrite` tool");
    expect(result).toContain("▶ NEXT ACTION:");
    expect(calls[0].metadata?.stale).toBe("fresh");
  });

  test("s1-feat-003 AC: NEXT_ACTION_CODE embeds real tool names + loop + terminal banner", async () => {
    await seedFeatures(projectDir, {
      project: "test-project",
      sprints: [
        {
          id: "s-loop",
          status: "in_progress",
          features: [
            {
              id: "s-loop-feat-001",
              title: "Loop-instruction feature",
              status: "pending",
              dependencies: [],
              files_affected: ["src/a.ts"],
              acceptance_criteria: ["AC1"],
            },
          ],
        },
      ],
      metadata: { version: "1.0.0" },
    });

    const { ctx } = mockCtxCaptured(projectDir, "code-loop-instruction-1");
    const result = await codeTool.execute({ project_dir: projectDir }, ctx);

    // NEXT_ACTION_CODE must reference the real tool names + the re-call loop
    // + the exact terminal banner token (plan §3.2(a)).
    expect(result).toContain("ghs-parse-completion-signal");
    expect(result).toContain("ghs-update-feature-status");
    expect(result).toContain("re-call ghs-code");
    expect(result).toContain("=== ghs-code: no ready features ===");
  });
});
