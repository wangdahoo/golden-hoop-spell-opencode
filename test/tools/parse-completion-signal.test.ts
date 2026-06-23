// Tool-level tests for `src/tools/parse-completion-signal.ts` (Feature s1-feat-001).
//
// Exercises the thin-shell tool end-to-end: args → execute → serialised JSON
// string. The underlying pure-function cascade is covered exhaustively in the
// Python-parity tests; here we assert the four AC scenarios the feature gates
// on (completed / blocked / unknown / short-text) flow through the tool layer
// and come back as parseable JSON via `serializeResult`.

import { expect, test, describe } from "bun:test";

import { parseCompletionSignalTool } from "../../src/tools/parse-completion-signal";

/**
 * Minimal mock ToolContext. The tool is pure-computation and never touches
 * the context, but the `tool()` return type declares a 2-arg execute
 * signature, so TS requires a second argument at the call site.
 */
const ctx = {
  sessionID: "parse-completion-signal-test",
  messageID: "msg",
  agent: "agent",
  directory: "/tmp",
  worktree: "/tmp",
  abort: new AbortController().signal,
  metadata: () => {},
  ask: async () => {},
} as Parameters<typeof parseCompletionSignalTool.execute>[1];

/** Pad `signalLine` with filler so the total length clears the default
 *  min-length gate (50). The signal line itself stays intact. */
function padBody(signalLine: string): string {
  return signalLine + "\n" + "x".repeat(80);
}

describe("ghs-parse-completion-signal tool (s1-feat-001)", () => {
  test("FEATURE COMPLETE signal → status completed", async () => {
    const raw = padBody("FEATURE COMPLETE: s1-feat-001");
    const out = await parseCompletionSignalTool.execute(
      {
        raw_text: raw,
        feature_id: "s1-feat-001",
      },
      ctx,
    );
    const parsed = JSON.parse(out);
    expect(parsed.status).toBe("completed");
    expect(parsed.feature_id).toBe("s1-feat-001");
  });

  test("FEATURE BLOCKED signal → status blocked with reason", async () => {
    const raw = padBody("FEATURE BLOCKED: s1-feat-001 - lint fails");
    const out = await parseCompletionSignalTool.execute(
      {
        raw_text: raw,
        feature_id: "s1-feat-001",
      },
      ctx,
    );
    const parsed = JSON.parse(out);
    expect(parsed.status).toBe("blocked");
    expect(parsed.reason).toContain("lint fails");
  });

  test("no signal in plain prose → status unknown", async () => {
    const raw =
      "This is a plain prose response with no completion signal anywhere " +
      "in the text, just a description of what the subagent did.";
    const out = await parseCompletionSignalTool.execute(
      {
        raw_text: raw,
        feature_id: "s1-feat-001",
      },
      ctx,
    );
    const parsed = JSON.parse(out);
    expect(parsed.status).toBe("unknown");
  });

  test("short text below min_length → status unknown", async () => {
    const out = await parseCompletionSignalTool.execute(
      {
        raw_text: "FEATURE COMPLETE: s1-feat-001",
        feature_id: "s1-feat-001",
        min_length: 99999,
      },
      ctx,
    );
    const parsed = JSON.parse(out);
    expect(parsed.status).toBe("unknown");
  });
});
