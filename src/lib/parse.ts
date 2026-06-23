// Thin convenience wrappers around `src/lib/scripts/parse-delimited-output.ts`.
//
// The delimited-output parser is the core extraction primitive the plan
// dispatcher uses to pull structured content out of subagent responses. The
// underlying `parseDelimitedOutput()` is fully generic (arbitrary `kind`,
// custom tokens, configurable min length). The three plan tools
// (`ghs-plan-review` in its three modes) all want the *same* canned
// configuration — one per subagent output family — so this module centralises
// those presets. That keeps the tool layer readable and makes the delimiter /
// signal / min-length contract a single source of truth.
//
// This file deliberately adds NO new parsing logic — every behaviour path
// delegates to the ported parser. Style follows s2-feat-001: pure re-exports
// + thin wrappers, no I/O, no `process.exit`, no `console.log`.

import {
  parseDelimitedOutput,
  type ParseDelimitedOutputArgs,
  type ParseResult,
  type Verdict,
} from "./scripts/parse-delimited-output.ts";

// -----------------------------------------------------------------------------
// Re-exports — give the plan tools a single import surface for the parser.
// -----------------------------------------------------------------------------

export {
  parseDelimitedOutput,
  serializeResult,
  looksTruncated,
  type ParseDelimitedOutputArgs,
  type ParseResult,
  type ParseStatus,
  type ParseStrategy,
  type Verdict,
} from "./scripts/parse-delimited-output.ts";

// -----------------------------------------------------------------------------
// Completion-signal constants per subagent family.
// -----------------------------------------------------------------------------

/**
 * Completion-signal line the `plan-designer` subagent prints at the end of its
 * response. The parser strips this line (and anything after) from the
 * extracted content and surfaces it in `ParseResult.completion_signal`.
 *
 * Mirrors the source skill's `PLAN DESIGN COMPLETE` signal (the parser's
 * `stripCompletionSignal` helper is line-anchored and word-boundary aware, so
 * trailing variables like `| Verdict: PASS` ride along on the same line).
 */
export const PLAN_COMPLETION_SIGNAL = "PLAN DESIGN COMPLETE";

/**
 * Completion-signal line the `plan-reviewer` subagent prints. Carries the
 * `Verdict: PASS|FAIL` marker the dispatcher keys off.
 */
export const REVIEW_COMPLETION_SIGNAL = "PLAN REVIEW COMPLETE";

/**
 * Completion-signal line the `ghs-context-explorer` subagent prints when it
 * finishes emitting the architecture snapshot.
 */
export const CONTEXT_SNAPSHOT_COMPLETION_SIGNAL = "CONTEXT SNAPSHOT COMPLETE";

// -----------------------------------------------------------------------------
// Preset wrappers — one per subagent output family.
// -----------------------------------------------------------------------------

/**
 * Default minimum stripped-content length. Subagent outputs shorter than this
 * after extraction are classified as `empty` (the parser found *something* but
 * it was too short to be a real artefact) rather than `ok`. Mirrors the
 * parser's own `DEFAULT_MIN_LENGTH`; re-exposed here so tool-layer callers can
 * reference a named constant instead of magic-numbering `200`.
 */
export const DEFAULT_MIN_LENGTH = 200;

/**
 * Parse a `plan-designer` subagent response.
 *
 * Pre-configures the `kind: "plan"` delimiter family (`<<<PLAN_START>>>` /
 * `<<<PLAN_END>>>`), the `PLAN DESIGN COMPLETE` completion signal, and the
 * default min length. The caller just hands over the raw subagent text.
 *
 * @param text       - raw response from the `ghs-plan-designer` subagent.
 * @param overrides  - optional per-call overrides (e.g. a larger `minLength`
 *                     for a plan expected to be long). Merged into the preset.
 */
export function parsePlan(
  text: string,
  overrides: Partial<ParseDelimitedOutputArgs> = {},
): ParseResult {
  return parseDelimitedOutput(text, {
    kind: "plan",
    completionSignal: PLAN_COMPLETION_SIGNAL,
    minLength: DEFAULT_MIN_LENGTH,
    ...overrides,
  });
}

/**
 * Parse a `plan-reviewer` subagent response.
 *
 * Pre-configures the `kind: "review"` delimiter family
 * (`<<<REVIEW_START>>>` / `<<<REVIEW_END>>>`) and the `PLAN REVIEW COMPLETE`
 * completion signal. The parser automatically extracts the `Verdict: PASS|FAIL`
 * marker for review-kind input and surfaces it on `ParseResult.verdict`; use
 * {@link extractVerdict} to pull it out cleanly.
 *
 * @param text       - raw response from the `ghs-plan-reviewer` subagent.
 * @param overrides  - optional per-call overrides.
 */
export function parseReview(
  text: string,
  overrides: Partial<ParseDelimitedOutputArgs> = {},
): ParseResult {
  return parseDelimitedOutput(text, {
    kind: "review",
    completionSignal: REVIEW_COMPLETION_SIGNAL,
    minLength: DEFAULT_MIN_LENGTH,
    ...overrides,
  });
}

/**
 * Parse a `ghs-context-explorer` subagent response.
 *
 * Pre-configures the `kind: "context_snapshot"` delimiter family
 * (`<<<CONTEXT_SNAPSHOT_START>>>` / `<<<CONTEXT_SNAPSHOT_END>>>`) and the
 * `CONTEXT SNAPSHOT COMPLETE` completion signal.
 *
 * @param text       - raw response from the `ghs-context-explorer` subagent.
 * @param overrides  - optional per-call overrides.
 */
export function parseContextSnapshot(
  text: string,
  overrides: Partial<ParseDelimitedOutputArgs> = {},
): ParseResult {
  return parseDelimitedOutput(text, {
    kind: "context_snapshot",
    completionSignal: CONTEXT_SNAPSHOT_COMPLETION_SIGNAL,
    minLength: DEFAULT_MIN_LENGTH,
    ...overrides,
  });
}

// -----------------------------------------------------------------------------
// Verdict helper
// -----------------------------------------------------------------------------

/**
 * Extract a `PASS` / `FAIL` verdict from a review parse result.
 *
 * The parser already populates `ParseResult.verdict` for `kind: "review"`
 * input; this helper just narrows the type and gives callers a single
 * expression (`extractVerdict(result)`) instead of reaching into the result
 * object directly. Returns `null` when no verdict marker was found — the
 * dispatcher treats that as "reviewer did not emit a verdict" and prompts for
 * a retry.
 *
 * Accepts either a full `ParseResult` or a bare `Verdict` so callers that
 * already destructured the field can pass it through unchanged.
 */
export function extractVerdict(
  input: ParseResult | Verdict,
): Verdict {
  if (input === null) {
    return null;
  }
  if (typeof input === "string") {
    return input;
  }
  return input.verdict;
}
