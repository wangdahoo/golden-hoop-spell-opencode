// Unit tests for src/prompts/file-transport.ts (Tier 1 of the loop-cost fix).
//
// `fileTransportDirective(absPath, kind)` is a pure function that renders the
// LLM-facing directive block appended to each subagent dispatch, telling the
// subagent to Write its delimited output to a staging file and the main AI
// that `ghs-plan-review` reads that file. These tests pin its per-kind output
// and assert the contract-critical tokens are present.
//
// Style follows test/workflow-chrome.test.ts: bun:test describe/test/expect,
// no IO, deterministic assertions.

import { expect, test, describe } from "bun:test";

import { fileTransportDirective } from "../src/prompts/file-transport";

describe("fileTransportDirective", () => {
  const path = "/proj/.ghs/plans/2026-06-23-x.plan.raw.md";

  test("renders for kind=plan with PLAN markers + signal + plan modeArg", () => {
    const out = fileTransportDirective(path, "plan");
    expect(out).toContain(path);
    expect(out).toContain("<<<PLAN_START>>>");
    expect(out).toContain("<<<PLAN_END>>>");
    expect(out).toContain("`PLAN DESIGN COMPLETE`");
    expect(out).toContain("ghs-plan-review(plan=...)");
    expect(out).toContain("Write");
  });

  test("renders for kind=review with REVIEW markers + verdict signal", () => {
    const out = fileTransportDirective(path, "review");
    expect(out).toContain("<<<REVIEW_START>>>");
    expect(out).toContain("<<<REVIEW_END>>>");
    expect(out).toContain("`PLAN REVIEW COMPLETE`");
    expect(out).toContain("ghs-plan-review(review=...)");
  });

  test("renders for kind=snapshot with CONTEXT_SNAPSHOT markers", () => {
    const out = fileTransportDirective(path, "snapshot");
    expect(out).toContain("<<<CONTEXT_SNAPSHOT_START>>>");
    expect(out).toContain("<<<CONTEXT_SNAPSHOT_END>>>");
    expect(out).toContain("`CONTEXT SNAPSHOT COMPLETE`");
    expect(out).toContain("ghs-plan-review(snapshot=...)");
  });

  test("always tells the subagent to write the file and print only the signal", () => {
    const out = fileTransportDirective(path, "plan");
    expect(out).toMatch(/用 Write 工具把完整输出/);
    expect(out).toMatch(/只输出完成信号/);
    // The inline (full-text) path is acknowledged as a fallback.
    expect(out).toMatch(/无须把全文贴进参数/);
  });

  test("is pure: same inputs → same output (no side effects)", () => {
    const a = fileTransportDirective(path, "plan");
    const b = fileTransportDirective(path, "plan");
    expect(a).toBe(b);
  });
});
