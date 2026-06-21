// Unit tests for src/lib/workflow-chrome.ts (Feature s1-feat-001).
//
// workflow-chrome.ts provides the four pure functions that render the text
// "chrome" mechanism-1 (plan §3.1 injection point ②) prepends/appends to ghs
// multi-step tool return strings:
//   - stageHeader(stage)                 -> stage banner
//   - todoDirective(stages, currentIdx)  -> build/refresh todo checklist
//   - nextActionAnchor(action)           -> ▶ NEXT ACTION handoff
//   - staleTodoWarning(expectedStage)    -> drift warning
//
// There is no Python oracle (workflow-chrome is a net-new TS module, out of
// equivalence scope per plan §5 R6), so these are pure behavioural tests.
// Coverage map:
//   - one inline snapshot per function ...... describe("snapshots")
//   - defensive boundary (no-throw) ......... describe("todoDirective defensive boundary")
//   - semantic markers (non-empty + text) ... describe("semantic markers")
//
// Style follows test/nonce.test.ts (s5-feat-002) / test/project.test.ts
// (s5-feat-002): bun:test describe/test/expect, no `.ghs/` or IO dependency,
// deterministic assertions. Inline snapshots keep the expected output inside
// this single test file (no external .snap file), so the feature stays
// self-contained in its two files_affected.

import { expect, test, describe } from "bun:test";

import {
  stageHeader,
  todoDirective,
  nextActionAnchor,
  staleTodoWarning,
} from "../src/lib/workflow-chrome";

// =============================================================================
// Snapshot assertions (acceptance criterion #3)
// =============================================================================
//
// One inline snapshot per function. Each captures the exact rendered output so
// downstream feat-005 (which prepends/appends these strings) can rely on the
// shape. If a function's output intentionally changes, re-running bun test in
// update mode rewrites the snapshot.

describe("workflow-chrome snapshots (s1-feat-001)", () => {
  test("stageHeader renders the stage banner", () => {
    expect(stageHeader("plan:designing")).toMatchInlineSnapshot(
      `"--- ghs stage: plan:designing ---"`,
    );
  });

  test("todoDirective renders the checklist with the current stage in_progress", () => {
    expect(
      todoDirective(["plan:designing", "plan:reviewing", "plan:approved"], 1),
    ).toMatchInlineSnapshot(`
      "TODO: call the \`todowrite\` tool to build a stage checklist, then keep
       it in sync as each ghs stage advances:
        [completed] plan:designing
        [in_progress] plan:reviewing
        [pending] plan:approved"
    `);
  });

  test("nextActionAnchor renders the ▶ NEXT ACTION anchor", () => {
    expect(
      nextActionAnchor("call ghs-plan-review with the snapshot"),
    ).toMatchInlineSnapshot(`"▶ NEXT ACTION: call ghs-plan-review with the snapshot"`);
  });

  test("staleTodoWarning renders the drift warning", () => {
    expect(staleTodoWarning("plan:reviewing")).toMatchInlineSnapshot(`
      "STALE TODO: the ghs stage advanced to \`plan:reviewing\` but the
       right-panel todo was not refreshed. Call the \`todowrite\` tool now: mark
       the previous stage completed and \`plan:reviewing\` in_progress."
    `);
  });
});

// =============================================================================
// Defensive boundary (acceptance criterion #2)
// =============================================================================
//
// todoDirective(stages, currentIdx) MUST NOT throw when currentIdx is out of
// bounds or stages is empty — a chrome-injection failure must never break the
// surrounding tool call. Out-of-range currentIdx renders no in_progress marker
// (and no completed marker unless currentIdx exceeds the valid range).

describe("todoDirective defensive boundary (s1-feat-001)", () => {
  test("empty stages returns a non-empty string and does not throw", () => {
    const call = (): string => todoDirective([], 0);
    expect(call).not.toThrow();
    const out = call();
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });

  test("currentIdx above last index does not throw and marks nothing in_progress", () => {
    const call = (): string => todoDirective(["a", "b"], 99);
    expect(call).not.toThrow();
    const out = call();
    expect(out).not.toContain("[in_progress]");
    // everything before the (out-of-range) cursor counts as completed
    expect(out).toContain("[completed]");
  });

  test("negative currentIdx does not throw and marks everything pending", () => {
    const call = (): string => todoDirective(["a", "b"], -1);
    expect(call).not.toThrow();
    const out = call();
    expect(out).not.toContain("[in_progress]");
    expect(out).not.toContain("[completed]");
    expect(out).toContain("[pending]");
  });
});

// =============================================================================
// Semantic markers (acceptance criterion #1)
// =============================================================================
//
// Each function returns a non-empty string containing its semantic marker:
// stage label / in_progress annotation / ▶ NEXT ACTION / expected stage ref.

describe("workflow-chrome semantic markers (s1-feat-001)", () => {
  test("stageHeader embeds the stage label", () => {
    const out = stageHeader("code:s1-feat-005");
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain("code:s1-feat-005");
  });

  test("todoDirective marks the current stage in_progress", () => {
    const out = todoDirective(["plan:designing"], 0);
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain("plan:designing");
    expect(out).toContain("[in_progress]");
  });

  test("nextActionAnchor contains the ▶ NEXT ACTION anchor and the action", () => {
    const out = nextActionAnchor("call ghs-plan-finalize");
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain("▶ NEXT ACTION");
    expect(out).toContain("call ghs-plan-finalize");
  });

  test("staleTodoWarning references the expected stage", () => {
    const out = staleTodoWarning("plan:reviewing");
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain("plan:reviewing");
  });
});
