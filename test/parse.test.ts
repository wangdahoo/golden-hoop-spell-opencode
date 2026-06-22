// Unit tests for `src/lib/parse.ts` (thin wrappers over parse-delimited-output).
//
// Implements Feature s3-feat-005 AC #2 ("exports a wrapper function that
// delegates to parse-delimited-output.ts"). The wrapper layer itself is
// intentionally trivial — the heavy parsing logic lives in the underlying
// parser. Here we assert:
//   - each preset (parsePlan / parseReview / parseContextSnapshot) wires the
//     right `kind`, completion signal, and default min length into the
//     underlying parser;
//   - the re-exports surface the expected symbols;
//   - extractVerdict pulls PASS/FAIL out of a review result and passes
//     bare verdicts / null through unchanged;
//   - overrides merge into the preset (callers can still customise).
//
// These are behavioural smoke tests of the *contract* the plan tools depend
// on, not a re-derivation of the parser's strategy cascade.

import { expect, test, describe } from "bun:test";

import {
  parsePlan,
  parseReview,
  parseContextSnapshot,
  extractVerdict,
  parseDelimitedOutput,
  serializeResult,
  PLAN_COMPLETION_SIGNAL,
  REVIEW_COMPLETION_SIGNAL,
  CONTEXT_SNAPSHOT_COMPLETION_SIGNAL,
  DEFAULT_MIN_LENGTH,
} from "../src/lib/parse";

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

/** Build a plan-family delimited blob longer than the min length. */
function planBlob(body: string): string {
  return `<<<PLAN_START>>>\n${body}\n<<<PLAN_END>>>`;
}

function reviewBlob(body: string): string {
  return `<<<REVIEW_START>>>\n${body}\n<<<REVIEW_END>>>`;
}

function contextBlob(body: string): string {
  return `<<<CONTEXT_SNAPSHOT_START>>>\n${body}\n<<<CONTEXT_SNAPSHOT_END>>>`;
}

/** Pad `prefix` with filler so the extracted content clears DEFAULT_MIN_LENGTH. */
function longBody(prefix: string): string {
  return prefix + "\n" + "x".repeat(DEFAULT_MIN_LENGTH + 40);
}

// -----------------------------------------------------------------------------
// Re-exports
// -----------------------------------------------------------------------------

describe("parse.ts re-exports", () => {
  test("parseDelimitedOutput and serializeResult are re-exported", () => {
    expect(typeof parseDelimitedOutput).toBe("function");
    expect(typeof serializeResult).toBe("function");
  });

  test("DEFAULT_MIN_LENGTH matches the parser's default", () => {
    expect(DEFAULT_MIN_LENGTH).toBe(200);
  });

  test("completion-signal constants are the expected strings", () => {
    expect(PLAN_COMPLETION_SIGNAL).toBe("PLAN DESIGN COMPLETE");
    expect(REVIEW_COMPLETION_SIGNAL).toBe("PLAN REVIEW COMPLETE");
    expect(CONTEXT_SNAPSHOT_COMPLETION_SIGNAL).toBe("CONTEXT SNAPSHOT COMPLETE");
  });
});

// -----------------------------------------------------------------------------
// parsePlan
// -----------------------------------------------------------------------------

describe("parsePlan", () => {
  test("extracts content from a <<<PLAN_START>>>...<<<PLAN_END>>> blob", () => {
    const body = longBody("Plan body");
    const result = parsePlan(planBlob(body));
    expect(result.status).toBe("ok");
    expect(result.strategy).toBe("exact_delimiter");
    expect(result.content).toContain("Plan body");
  });

  test("uses the PLAN DESIGN COMPLETE completion signal", () => {
    // Appending the signal after the end marker should be captured verbatim
    // on `completion_signal` and stripped from the content.
    const body = longBody("Plan body");
    const text =
      planBlob(body) + "\nPLAN DESIGN COMPLETE | Verdict: PASS | Severe: 0";
    const result = parsePlan(text);
    expect(result.completion_signal).toContain("PLAN DESIGN COMPLETE");
    expect(result.content).not.toContain("PLAN DESIGN COMPLETE");
  });

  test("honours a minLength override", () => {
    // Short body — passes with a tiny minLength, fails with the default.
    const short = planBlob("tiny");
    expect(parsePlan(short, { minLength: 1 }).status).toBe("ok");
    expect(parsePlan(short).status).not.toBe("ok");
  });
});

// -----------------------------------------------------------------------------
// parseReview
// -----------------------------------------------------------------------------

describe("parseReview", () => {
  test("extracts content from a <<<REVIEW_START>>>...<<<REVIEW_END>>> blob", () => {
    const body = longBody("Review body");
    const result = parseReview(reviewBlob(body));
    expect(result.status).toBe("ok");
    expect(result.content).toContain("Review body");
  });

  test("populates verdict from the PLAN REVIEW COMPLETE signal line", () => {
    const body = longBody("Review body");
    const text =
      reviewBlob(body) + "\nPLAN REVIEW COMPLETE | Verdict: PASS | Severe: 0";
    const result = parseReview(text);
    expect(result.verdict).toBe("PASS");
    expect(result.completion_signal).toContain("Verdict: PASS");
  });

  test("returns FAIL verdict when the reviewer signals failure", () => {
    const body = longBody("Review body with a severe issue");
    const text =
      reviewBlob(body) + "\nPLAN REVIEW COMPLETE | Verdict: FAIL | Severe: 1";
    const result = parseReview(text);
    expect(result.verdict).toBe("FAIL");
  });

  test("verdict is null when no Verdict: marker is present", () => {
    const body = longBody("Review body");
    const result = parseReview(reviewBlob(body));
    expect(result.verdict).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// parseContextSnapshot
// -----------------------------------------------------------------------------

describe("parseContextSnapshot", () => {
  test("extracts content from a <<<CONTEXT_SNAPSHOT_START>>>...<<<CONTEXT_SNAPSHOT_END>>> blob", () => {
    const body = longBody("Snapshot body");
    const result = parseContextSnapshot(contextBlob(body));
    expect(result.status).toBe("ok");
    expect(result.content).toContain("Snapshot body");
  });

  test("uses the CONTEXT SNAPSHOT COMPLETE completion signal", () => {
    const body = longBody("Snapshot body");
    const text = contextBlob(body) + "\nCONTEXT SNAPSHOT COMPLETE";
    const result = parseContextSnapshot(text);
    expect(result.completion_signal).toContain("CONTEXT SNAPSHOT COMPLETE");
    expect(result.content).not.toContain("CONTEXT SNAPSHOT COMPLETE");
  });
});

// -----------------------------------------------------------------------------
// extractVerdict
// -----------------------------------------------------------------------------

describe("extractVerdict", () => {
  test("pulls the verdict out of a ParseResult", () => {
    const result = parseReview(
      reviewBlob(longBody("b")) + "\nPLAN REVIEW COMPLETE | Verdict: PASS",
    );
    expect(extractVerdict(result)).toBe("PASS");
  });

  test("passes a bare verdict string through unchanged", () => {
    expect(extractVerdict("FAIL")).toBe("FAIL");
    expect(extractVerdict("PASS")).toBe("PASS");
  });

  test("passes null through unchanged", () => {
    expect(extractVerdict(null)).toBeNull();
  });

  test("returns null when the result has no verdict", () => {
    const result = parseReview(reviewBlob(longBody("b")));
    expect(extractVerdict(result)).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Cross-check: wrapper delegates identically to the raw parser.
// -----------------------------------------------------------------------------

describe("preset wrappers delegate faithfully", () => {
  test("parsePlan(text) equals parseDelimitedOutput with the same preset", () => {
    const text = planBlob(longBody("body"));
    const viaWrapper = parsePlan(text);
    const viaRaw = parseDelimitedOutput(text, {
      kind: "plan",
      completionSignal: PLAN_COMPLETION_SIGNAL,
      minLength: DEFAULT_MIN_LENGTH,
    });
    expect(viaWrapper).toEqual(viaRaw);
  });

  test("parseReview(text) equals parseDelimitedOutput with the same preset", () => {
    const text = reviewBlob(longBody("body"));
    const viaWrapper = parseReview(text);
    const viaRaw = parseDelimitedOutput(text, {
      kind: "review",
      completionSignal: REVIEW_COMPLETION_SIGNAL,
      minLength: DEFAULT_MIN_LENGTH,
    });
    expect(viaWrapper).toEqual(viaRaw);
  });

  test("parseContextSnapshot(text) equals parseDelimitedOutput with the same preset", () => {
    const text = contextBlob(longBody("body"));
    const viaWrapper = parseContextSnapshot(text);
    const viaRaw = parseDelimitedOutput(text, {
      kind: "context_snapshot",
      completionSignal: CONTEXT_SNAPSHOT_COMPLETION_SIGNAL,
      minLength: DEFAULT_MIN_LENGTH,
    });
    expect(viaWrapper).toEqual(viaRaw);
  });
});
