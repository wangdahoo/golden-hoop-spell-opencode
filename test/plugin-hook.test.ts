// tool.execute.after hook tests (Feature s1-feat-004, plan §3.1 注入点③ 兜底 /
// channel B + §5 R4 gate).
//
// The plugin registers a `tool.execute.after` hook as the FALLBACK path for
// mechanism-1 injection point ③ (tool-card stage annotation). The MAIN path
// is `ctx.metadata()` inside each ghs tool's execute (feat-005, channel A);
// this hook is decoupled best-effort visual chrome that runs after execute.
//
// Two invariants this file enforces (mirroring the feature's ACs):
//
//   1. R4 GATE — non-ghs tools (todowrite / read / bash / write / glob / grep)
//      MUST be no-ops: the hook returns on its first line before touching
//      `output`, so other plugins' / built-in tool cards are never polluted.
//   2. ANNOTATION — ghs-* tools with a derivable stage get
//      `output.title = "[ghs] <stage>"` + a metadata blob. Tools whose stage
//      is null (single-step ghs tools, or read failure) are skipped, leaving
//      output untouched (graceful degradation, R7).
//
// Test strategy: invoke the hook the SAME way the plugin exposes it (via
// `ghsPlugin({} as never)` then call `hooks["tool.execute.after"]`), with
// mocked `{ input, output }` payloads. Stage derivation is made deterministic
// by using `ghs-code` with a `feature_id` arg — `getStageSignature` derives
// `code:<id>` PURELY from args (no filesystem read), so the assertion is
// independent of on-disk plan state.

import { expect, test, describe } from "bun:test";
import { ghsPlugin } from "../src/plugin";

/**
 * The shape of the `output` arg passed to the `tool.execute.after` hook
 * (index.d.ts:217-226): title / output / metadata are all mutable.
 */
interface HookOutput {
  title: string;
  output: string;
  metadata: unknown;
}

/**
 * Build a fresh output object with sentinel values, so a no-op hook leaves
 * them unchanged (detectable) and an annotating hook overwrites them.
 */
function freshOutput(): HookOutput {
  return {
    title: "__SENTINEL_TITLE__",
    output: "__SENTINEL_OUTPUT__",
    metadata: { __sentinel: true },
  };
}

/**
 * Convenience: run the plugin's `tool.execute.after` hook against a sample
 * tool invocation and return the resulting output object.
 */
async function runHook(
  tool: string,
  args: Record<string, unknown>,
  sessionID = "test-session",
): Promise<HookOutput> {
  const hooks = await ghsPlugin({} as never);
  const fn = hooks["tool.execute.after"];
  expect(fn).toBeDefined();
  const output = freshOutput();
  await fn!(
    { tool, sessionID, callID: "call-1", args } as never,
    output as never,
  );
  return output;
}

// -----------------------------------------------------------------------------
// R4 gate — non-ghs tools are no-ops.
// -----------------------------------------------------------------------------

describe("tool.execute.after R4 gate (non-ghs tools are no-op)", () => {
  // Representative sample of built-in / other-plugin tools that must NEVER be
  // annotated by the ghs hook. Covers the tools explicitly named in the plan
  // §5 R4 row + the acceptance criterion (todowrite / read / bash).
  const NON_GHS_TOOLS = [
    "todowrite",
    "read",
    "bash",
    "write",
    "glob",
    "grep",
    "edit",
    "webfetch",
    "task",
  ];

  for (const tool of NON_GHS_TOOLS) {
    test(`${tool}: output unchanged (no-op)`, async () => {
      const before = freshOutput();
      const after = await runHook(tool, { some: "arg" });
      // Deep-equal to the sentinel initial state — the hook returned before
      // touching any field.
      expect(after).toEqual(before);
    });
  }

  test("gate is prefix-specific: a tool named 'ghsify' (no dash) is also no-op", async () => {
    // `startsWith("ghs-")` requires the dash — a hypothetical "ghsify" tool
    // must not be mistaken for a ghs tool.
    const before = freshOutput();
    const after = await runHook("ghsify", {});
    expect(after).toEqual(before);
  });

  test("empty tool name is no-op", async () => {
    const before = freshOutput();
    const after = await runHook("", {});
    expect(after).toEqual(before);
  });
});

// -----------------------------------------------------------------------------
// Annotation — ghs-* tools with a derivable stage get titled.
// -----------------------------------------------------------------------------

describe("tool.execute.after annotation (ghs-* tools)", () => {
  test("ghs-code with feature_id sets title `[ghs] code:<id>` + metadata", async () => {
    // getStageSignature derives `code:<feature_id>` PURELY from args — no FS
    // read — so this assertion is deterministic regardless of on-disk state.
    const after = await runHook("ghs-code", { feature_id: "s1-feat-004" });
    expect(after.title).toBe("[ghs] code:s1-feat-004");
    expect(after.metadata).toEqual({
      ghsStage: "code:s1-feat-004",
      source: "tool.execute.after",
    });
    // The hook must NOT clobber the tool's text output channel.
    expect(after.output).toBe("__SENTINEL_OUTPUT__");
  });

  test("ghs-code with parallel=true sets title `[ghs] code:batch`", async () => {
    const after = await runHook("ghs-code", { parallel: true });
    expect(after.title).toBe("[ghs] code:batch");
    expect((after.metadata as { ghsStage: string }).ghsStage).toBe(
      "code:batch",
    );
  });

  test("ghs-code title always carries the [ghs] prefix", async () => {
    const after = await runHook("ghs-code", { feature_id: "xyz-999" });
    expect(after.title.startsWith("[ghs] ")).toBe(true);
    expect(after.title).toContain("code:");
  });

  test("every ghs-* tool that gets annotated has a `[ghs]`-prefixed title", async () => {
    // Sweep a few ghs-code variants; all annotated titles must carry [ghs].
    const samples: Array<{ args: Record<string, unknown>; stage: string }> = [
      { args: { feature_id: "f-1" }, stage: "code:f-1" },
      { args: { feature_id: "f-2" }, stage: "code:f-2" },
      { args: { parallel: true }, stage: "code:batch" },
      { args: {}, stage: "code:default" },
    ];
    for (const { args, stage } of samples) {
      const after = await runHook("ghs-code", args);
      expect(after.title).toBe(`[ghs] ${stage}`);
    }
  });
});

// -----------------------------------------------------------------------------
// Graceful skip — ghs tools whose stage is null leave output untouched.
// -----------------------------------------------------------------------------

describe("tool.execute.after graceful skip (stage === null)", () => {
  // Single-step ghs tools: getStageSignature returns null → hook skips,
  // leaving output untouched. This is the correct behaviour: there is no
  // meaningful stage to annotate for init/config/sprint/status/archive.
  const SINGLE_STEP_GHS_TOOLS = [
    "ghs-init",
    "ghs-config",
    "ghs-sprint",
    "ghs-status",
    "ghs-archive",
    "ghs-force-archive",
  ];

  for (const tool of SINGLE_STEP_GHS_TOOLS) {
    test(`${tool}: stage null → output unchanged (skip)`, async () => {
      const before = freshOutput();
      const after = await runHook(tool, {});
      expect(after).toEqual(before);
    });
  }

  test("ghs-code without feature_id/parallel still annotates (code:default)", async () => {
    // ghs-code ALWAYS derives a non-null stage, so even with empty args it
    // annotates rather than skipping — this distinguishes it from the
    // single-step tools above.
    const after = await runHook("ghs-code", {});
    expect(after.title).toBe("[ghs] code:default");
  });
});

// -----------------------------------------------------------------------------
// Hook registration smoke test.
// -----------------------------------------------------------------------------

describe("tool.execute.after hook registration", () => {
  test("ghsPlugin exposes a tool.execute.after hook", async () => {
    const hooks = await ghsPlugin({} as never);
    expect(typeof hooks["tool.execute.after"]).toBe("function");
  });

  test("hook does not throw on a minimal non-ghs invocation", async () => {
    // Belt-and-suspenders: the gate must not throw even for edge inputs.
    await expect(runHook("todowrite", {})).resolves.toBeDefined();
  });
});
