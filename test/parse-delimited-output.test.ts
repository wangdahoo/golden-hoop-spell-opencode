// Unit tests for `src/lib/scripts/parse-delimited-output.ts`.
//
// Implements Feature s2-feat-001 (P1 — open_ended parsing strategy +
// looksTruncated). These tests target the underlying parser directly (not
// the `src/lib/parse.ts` wrapper presets, which have their own coverage in
// parse.test.ts). Focus areas:
//   - open_ended strategy: START present, END absent → fallback_used +
//     START..EOF extraction with a descriptive warning.
//   - Decline paths: no START → fall through; paired START+END → decline
//     (exact_delimiter already wins).
//   - foundShortContent: open_ended hit below minLength falls through to
//     whole_body (status ends up `empty`, not `fallback_used`).
//   - ok path byte-stability: paired delimiters still resolve via
//     exact_delimiter with `ok` status — open_ended must not perturb it.
//   - looksTruncated: pure boolean per the documented contract.

import { expect, test, describe } from "bun:test";

import {
  parseDelimitedOutput,
  parseRaw,
  looksTruncated,
  type ParseRawOptions,
} from "../src/lib/scripts/parse-delimited-output.ts";

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const PLAN_START = "<<<PLAN_START>>>";
const PLAN_END = "<<<PLAN_END>>>";

const DEFAULT_MIN_LENGTH = 200;

/** Build a body long enough to clear DEFAULT_MIN_LENGTH after extraction. */
function longBody(prefix: string): string {
  return prefix + "\n" + "x".repeat(DEFAULT_MIN_LENGTH + 40);
}

/** Bare-bones parseRaw invocation with plan-kind tokens. */
function parsePlanRaw(
  text: string,
  overrides: Partial<ParseRawOptions> = {},
): ReturnType<typeof parseRaw> {
  return parseRaw(text, {
    kind: "plan",
    startToken: PLAN_START,
    endToken: PLAN_END,
    minLength: DEFAULT_MIN_LENGTH,
    completionSignal: "PLAN DESIGN COMPLETE",
    ...overrides,
  });
}

// -----------------------------------------------------------------------------
// open_ended strategy — AC #1: START present, END absent → fallback_used
// -----------------------------------------------------------------------------

describe("open_ended strategy (START present, END absent)", () => {
  test("AC1: extracts START..EOF with status=fallback_used, strategy=open_ended", () => {
    const body = longBody("truncated body");
    const truncated = `${PLAN_START}\n${body}`;
    // Sanity: this really is a truncation per looksTruncated.
    expect(looksTruncated(truncated, PLAN_START, PLAN_END)).toBe(true);

    const result = parsePlanRaw(truncated);

    expect(result.status).toBe("fallback_used");
    expect(result.strategy).toBe("open_ended");
    // Content must be everything after the START token (the body), trimmed.
    expect(result.content).toContain("truncated body");
    // The START token itself must not leak into the extracted content.
    expect(result.content).not.toContain(PLAN_START);
    expect(result.content).not.toContain(PLAN_END);
    // The signature warning must be present.
    expect(result.warnings).toContain(
      "open_ended: END missing, extracted START..EOF",
    );
    // And the extracted length clears the min length.
    expect(result.content.length).toBeGreaterThanOrEqual(DEFAULT_MIN_LENGTH);
  });

  test("AC1 (alt entrypoint): parseDelimitedOutput yields the same open_ended result", () => {
    const body = longBody("via public API");
    const truncated = `${PLAN_START}\n${body}`;
    const result = parseDelimitedOutput(truncated, {
      kind: "plan",
      completionSignal: "PLAN DESIGN COMPLETE",
    });
    expect(result.status).toBe("fallback_used");
    expect(result.strategy).toBe("open_ended");
    expect(result.content).toContain("via public API");
  });
});

// -----------------------------------------------------------------------------
// open_ended decline — AC #2: no START → fall through to whole_body
// -----------------------------------------------------------------------------

describe("open_ended decline (no START)", () => {
  test("AC2: text without START does not engage open_ended; whole_body handles it", () => {
    // A long body with no START token: open_ended declines, whole_body takes
    // over. Status is fallback_used (whole_body is not exact_delimiter).
    const text = longBody("no delimiters at all");
    const result = parsePlanRaw(text);
    expect(result.strategy).toBe("whole_body");
    expect(result.status).toBe("fallback_used");
    // open_ended's signature warning must NOT appear (it declined).
    expect(result.warnings).not.toContain(
      "open_ended: END missing, extracted START..EOF",
    );
    expect(result.content).toContain("no delimiters at all");
  });

  test("AC2 (empty-ish): short text with no START and no usable body → malformed", () => {
    // Nothing usable: no strategy finds content ≥ minLength, and none even
    // finds *short* content, so status is `malformed` (not `empty`).
    const result = parsePlanRaw("   ");
    expect(result.status).toBe("malformed");
    expect(result.strategy).toBe("none");
    expect(result.content).toBe("");
  });
});

// -----------------------------------------------------------------------------
// open_ended decline — AC #3: paired START+END → decline (exact wins)
// -----------------------------------------------------------------------------

describe("open_ended decline (paired START+END)", () => {
  test("AC3: open_ended returns null on paired delimiters; exact_delimiter wins", () => {
    const body = longBody("paired body");
    const text = `${PLAN_START}\n${body}\n${PLAN_END}`;
    const result = parsePlanRaw(text);
    expect(result.strategy).toBe("exact_delimiter");
    expect(result.status).toBe("ok");
    expect(result.content).toContain("paired body");
    // open_ended must not have emitted its warning.
    expect(result.warnings).not.toContain(
      "open_ended: END missing, extracted START..EOF",
    );
  });
});

// -----------------------------------------------------------------------------
// foundShortContent — AC #4: open_ended hit below minLength → whole_body
// -----------------------------------------------------------------------------

describe("open_ended short content falls through", () => {
  test("AC4: open_ended extract below minLength does not win; whole_body takes over", () => {
    // START present, END absent, but the extracted body is tiny. open_ended
    // finds something but it is too short → foundShortContent=true → loop
    // continues to whole_body, which returns the whole (long-ish) text.
    // We craft the input so whole_body's trimmed length ≥ minLength but
    // open_ended's (START..EOF) trimmed length < minLength.
    const tail = "x".repeat(DEFAULT_MIN_LENGTH + 10);
    // The text is long overall (so whole_body clears minLength), but the
    // START token appears near the very end so the START..EOF span is short.
    const text = tail + "\n" + PLAN_START + "\ntiny";
    expect(looksTruncated(text, PLAN_START, PLAN_END)).toBe(true);

    const result = parsePlanRaw(text);

    // open_ended's span ("tiny") is well under minLength, so it cannot win.
    expect(result.strategy).not.toBe("open_ended");
    // whole_body returns the full text (which clears minLength).
    expect(result.strategy).toBe("whole_body");
    expect(result.status).toBe("fallback_used");
    // foundShortContent was set by open_ended, so even though whole_body
    // found usable content, the run still flagged a short-content warning
    // for open_ended.
    expect(
      result.warnings.some((w) => w.startsWith("open_ended: extracted content too short")),
    ).toBe(true);
  });

  test("AC4 (degenerate): open_ended extract below minLength AND whole_body also short → empty", () => {
    // Everything is tiny: open_ended finds a short span, whole_body finds a
    // short span. foundShortContent=true → final status is `empty`.
    const text = PLAN_START + "\ntiny";
    const result = parsePlanRaw(text);
    expect(result.status).toBe("empty");
    expect(result.strategy).toBe("none");
  });
});

// -----------------------------------------------------------------------------
// looksTruncated — AC #5: pure boolean contract
// -----------------------------------------------------------------------------

describe("looksTruncated", () => {
  test("AC5: returns true when START present and END absent", () => {
    expect(
      looksTruncated(`${PLAN_START} some content`, PLAN_START, PLAN_END),
    ).toBe(true);
  });

  test("AC5: returns false when START present and END present (paired)", () => {
    expect(
      looksTruncated(
        `${PLAN_START} content ${PLAN_END}`,
        PLAN_START,
        PLAN_END,
      ),
    ).toBe(false);
  });

  test("AC5: returns false when START absent (regardless of END)", () => {
    expect(looksTruncated(`no start token here ${PLAN_END}`, PLAN_START, PLAN_END)).toBe(false);
    expect(looksTruncated("no tokens at all", PLAN_START, PLAN_END)).toBe(false);
  });

  test("AC5: is a pure function (no side effects)", () => {
    const input = `${PLAN_START} body`;
    const before = input;
    looksTruncated(input, PLAN_START, PLAN_END);
    expect(input).toBe(before); // input not mutated
  });
});

// -----------------------------------------------------------------------------
// AC #6: ok path byte-stability — open_ended does not perturb paired input
// -----------------------------------------------------------------------------

describe("ok path byte-stability", () => {
  test("AC6: paired delimiters resolve via exact_delimiter with ok status (open_ended inactive)", () => {
    const body = longBody("happy path body");
    const text = `${PLAN_START}\n${body}\n${PLAN_END}`;
    const result = parsePlanRaw(text);

    expect(result.status).toBe("ok");
    expect(result.strategy).toBe("exact_delimiter");
    // No fallback/truncation warnings on the clean path.
    expect(result.warnings).not.toContain(
      "open_ended: END missing, extracted START..EOF",
    );
    expect(result.warnings).not.toContain("whole_body fallback engaged");
    // Content is exactly the body between the delimiters.
    expect(result.content).toContain("happy path body");
  });

  test("AC6: cascade order — open_ended sits after code_fence, before whole_body", () => {
    // A truncation input (START, no END) that contains NO fenced code block.
    // code_fence declines (no fence) → open_ended wins. This proves open_ended
    // is reachable and positioned after code_fence.
    const body = longBody("order check");
    const text = `${PLAN_START}\n${body}`;
    const result = parsePlanRaw(text);
    expect(result.strategy).toBe("open_ended");
  });
});
