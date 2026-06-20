// Equivalence test for parse-delimited-output.ts vs parse_delimited_output.py.
//
// Implements Feature s3-feat-003. Strategy mirrors the other equivalence
// suites (init / resolve / status / archive / validate): the TS port is
// invoked as a library function, the Python source is invoked as a
// subprocess (its CLI wraps the same `parse_raw` library function and emits
// the result as JSON), and the parsed JSON objects are compared.
//
// The Python fixture
//   /Users/tom/github/golden-hoop-spell/plugin/shared/scripts/test_parse_delimited_output.py
// enumerates 25 cases (17 in the main `ParseHelperUnitTests` class + 3
// verdict + 2 completion-signal + 1 generic + 3 input-source + 1 min-length
// boundary + exit-code cases). This suite ports every `parse_raw`-based case
// (the library-function cases; the CLI-input-source and exit-code cases are
// CLI-layer concerns not part of the TS port's contract, which is a pure
// library). Each case runs BOTH the TS port and the Python oracle on the
// same raw text + options and asserts the two result objects are deep-equal.
//
// Coverage (per the feature's acceptance criteria):
//   - 正常分隔输出 (exact_delimiter — plan/review/context_snapshot)
//   - 缺失分隔符 (whole_body / pure-markdown fallback)
//   - 部分隔符 (normalized_delimiter — Chinese quotes / whitespace / fewer brackets)
//   - 嵌套/转义边界 (code_fence wrapping, nested fence with literal delimiters)
//   - additional_files_read stripping, thinking-tag stripping, verdict extraction,
//     multi-kind isolation, empty-vs-malformed distinction, min-length boundary.

import { expect, test, describe } from "bun:test";

import {
  parseRaw,
  parseDelimitedOutput,
} from "../../src/lib/scripts/parse-delimited-output";
import {
  runPython,
  makeTempDir,
  cleanupTemp,
} from "./_helpers";

// Long enough body to clear the default 200-char min length. Byte-identical
// to the LONG_BODY constant in the Python fixture.
const LONG_BODY =
  "# Plan Title\n\n" +
  "## Background\n" +
  "This section explains why we are doing this work and what motivates it.\n\n" +
  "## Goals\n" +
  "Goal one is to ship the helper. Goal two is to make it deterministic.\n\n" +
  "## Architecture\n" +
  "We expose a single Python entry point that takes raw text and emits JSON.\n" +
  "Strategies are tried in priority order and the first one that yields enough\n" +
  "content wins.\n";

// Common plan delimiter pair (matches TOKEN_BY_KIND["plan"]).
const PLAN_START = "<<<PLAN_START>>>";
const PLAN_END = "<<<PLAN_END>>>";
const REVIEW_START = "<<<REVIEW_START>>>";
const REVIEW_END = "<<<REVIEW_END>>>";
const CONTEXT_SNAPSHOT_START = "<<<CONTEXT_SNAPSHOT_START>>>";
const CONTEXT_SNAPSHOT_END = "<<<CONTEXT_SNAPSHOT_END>>>";

/** Options shape passed to both the TS port and the Python CLI. */
interface CaseOpts {
  kind: string;
  startToken: string;
  endToken: string;
  minLength: number;
  completionSignal: string | null;
}

/**
 * Run the Python oracle's `parse_raw` via its CLI wrapper and return the
 * parsed result object. The CLI emits `json.dumps(result, ensure_ascii=False,
 * indent=2)` on stdout and exits 0 on ok/fallback_used, 1 on empty/malformed.
 */
async function pyParseRaw(
  rawText: string,
  opts: CaseOpts,
): Promise<Record<string, unknown>> {
  const tmp = await makeTempDir("ghs-eq-parse-");
  try {
    const args = [
      "--kind", opts.kind,
      "--input-string", rawText,
      "--start-token", opts.startToken,
      "--end-token", opts.endToken,
      "--min-length", String(opts.minLength),
    ];
    if (opts.completionSignal) {
      args.push("--completion-signal", opts.completionSignal);
    }
    // allowNonZero: empty/malformed cases exit 1 but still emit valid JSON.
    const r = await runPython(
      "parse_delimited_output.py",
      args,
      tmp,
      true,
    );
    expect(r.exitCode === 0 || r.exitCode === 1).toBe(true);
    const parsed = JSON.parse(r.stdout);
    return parsed as Record<string, unknown>;
  } finally {
    await cleanupTemp(tmp);
  }
}

/**
 * Run BOTH the TS port and the Python oracle on the same input and assert
 * deep equality of the full result object (status, content, strategy,
 * completion_signal, verdict, warnings, meta).
 */
async function expectEquivalent(
  rawText: string,
  opts: CaseOpts,
): Promise<void> {
  const tsResult = parseRaw(rawText, opts);
  const pyResult = await pyParseRaw(rawText, opts);
  // Compare as `unknown` so `toEqual` performs a structural deep-equal without
  // requiring the Python-derived `Record<string, unknown>` to satisfy the
  // TS port's `ParseResult` nominal shape.
  expect(tsResult as unknown).toEqual(pyResult);
}

describe("parse-delimited-output equivalence", () => {
  // ------------------------------------------------------------------
  // 1. exact_delimiter success — plan kind
  // ------------------------------------------------------------------
  test("01 exact match (plan) — full result deep-equal to Python", async () => {
    const raw = `${PLAN_START}\n${LONG_BODY}\n${PLAN_END}\nPLAN DESIGN COMPLETE\n`;
    await expectEquivalent(raw, {
      kind: "plan",
      startToken: PLAN_START,
      endToken: PLAN_END,
      minLength: 200,
      completionSignal: "PLAN DESIGN COMPLETE",
    });
  });

  // ------------------------------------------------------------------
  // 2. exact_delimiter success — review kind
  // ------------------------------------------------------------------
  test("02 exact match (review) — full result deep-equal to Python", async () => {
    const raw = `${REVIEW_START}\n${LONG_BODY}\n${REVIEW_END}\n`;
    await expectEquivalent(raw, {
      kind: "review",
      startToken: REVIEW_START,
      endToken: REVIEW_END,
      minLength: 150,
      completionSignal: "REVIEW COMPLETE",
    });
  });

  // ------------------------------------------------------------------
  // 3. exact_delimiter success — context_snapshot kind
  // ------------------------------------------------------------------
  test("03 exact match (context_snapshot) — full result deep-equal to Python", async () => {
    const body =
      "## Repo Layout\n" +
      "- src/ contains the core helpers\n" +
      "- tests/ covers them\n" +
      "- docs/ holds the architecture notes\n" +
      "- entry point is run.sh in the project root\n";
    const raw = `${CONTEXT_SNAPSHOT_START}\n${body}\n${CONTEXT_SNAPSHOT_END}\n`;
    await expectEquivalent(raw, {
      kind: "context_snapshot",
      startToken: CONTEXT_SNAPSHOT_START,
      endToken: CONTEXT_SNAPSHOT_END,
      minLength: 100,
      completionSignal: null,
    });
  });

  // ------------------------------------------------------------------
  // 4. normalized_delimiter — Chinese variant 《《PLAN_START》》
  // ------------------------------------------------------------------
  test("04 normalized Chinese quotes — warnings offsets match Python", async () => {
    const raw = `《《PLAN_START》》\n${LONG_BODY}\n《《PLAN_END》》\n`;
    await expectEquivalent(raw, {
      kind: "plan",
      startToken: PLAN_START,
      endToken: PLAN_END,
      minLength: 200,
      completionSignal: null,
    });
  });

  // ------------------------------------------------------------------
  // 5. normalized_delimiter — extra spaces <<< PLAN_START >>>
  // ------------------------------------------------------------------
  test("05 normalized extra whitespace — deep-equal to Python", async () => {
    const raw = `<<< PLAN_START >>>\n${LONG_BODY}\n<<< PLAN_END >>>\n`;
    await expectEquivalent(raw, {
      kind: "plan",
      startToken: PLAN_START,
      endToken: PLAN_END,
      minLength: 200,
      completionSignal: null,
    });
  });

  // ------------------------------------------------------------------
  // 6. normalized_delimiter — fewer brackets <<PLAN_START>>
  // ------------------------------------------------------------------
  test("06 normalized fewer brackets — deep-equal to Python", async () => {
    const raw = `<<PLAN_START>>\n${LONG_BODY}\n<<PLAN_END>>\n`;
    await expectEquivalent(raw, {
      kind: "plan",
      startToken: PLAN_START,
      endToken: PLAN_END,
      minLength: 200,
      completionSignal: null,
    });
  });

  // ------------------------------------------------------------------
  // 7. code_fence — bare code-fence wrap, exact_delimiter inside
  // ------------------------------------------------------------------
  test("07 code-fence wrapped exact inside — STRATEGY 1 wins", async () => {
    const raw = "```\n" + `${PLAN_START}\n${LONG_BODY}\n${PLAN_END}\n` + "```\n";
    await expectEquivalent(raw, {
      kind: "plan",
      startToken: PLAN_START,
      endToken: PLAN_END,
      minLength: 200,
      completionSignal: null,
    });
  });

  // ------------------------------------------------------------------
  // 8. code_fence — pure fence, no delimiters
  // ------------------------------------------------------------------
  test("08 pure code fence (no delimiters) — code_fence fallback", async () => {
    const raw = "```\n" + `${LONG_BODY}\n` + "```\n";
    await expectEquivalent(raw, {
      kind: "plan",
      startToken: PLAN_START,
      endToken: PLAN_END,
      minLength: 200,
      completionSignal: null,
    });
  });

  // ------------------------------------------------------------------
  // 9. nested code fence — exact_delimiter still wins (max-span selection)
  // ------------------------------------------------------------------
  test("09 nested code fence with literal delimiters — max-span wins", async () => {
    const raw =
      "```python\n" +
      'TOKENS = {"start": "<<<PLAN_START>>>", "end": "<<<PLAN_END>>>"}\n' +
      "```\n\n" +
      `${PLAN_START}\n${LONG_BODY}\n${PLAN_END}\n`;
    await expectEquivalent(raw, {
      kind: "plan",
      startToken: PLAN_START,
      endToken: PLAN_END,
      minLength: 200,
      completionSignal: null,
    });
  });

  // ------------------------------------------------------------------
  // 10. whole_body — pure markdown fallback
  // ------------------------------------------------------------------
  test("10 pure markdown whole_body fallback — deep-equal to Python", async () => {
    const raw = LONG_BODY;
    await expectEquivalent(raw, {
      kind: "plan",
      startToken: PLAN_START,
      endToken: PLAN_END,
      minLength: 200,
      completionSignal: null,
    });
  });

  // ------------------------------------------------------------------
  // 11. whole_body — legacy <thinking>...</thinking>
  // ------------------------------------------------------------------
  test("11 legacy thinking tag stripped by whole_body — deep-equal", async () => {
    const raw = `<thinking>internal reasoning here</thinking>\n${LONG_BODY}\n`;
    await expectEquivalent(raw, {
      kind: "plan",
      startToken: PLAN_START,
      endToken: PLAN_END,
      minLength: 200,
      completionSignal: null,
    });
  });

  // ------------------------------------------------------------------
  // 12. whole_body — antml thinking tag
  // ------------------------------------------------------------------
  test("12 antml thinking tag stripped by whole_body — deep-equal", async () => {
    const raw =
      `<antml:thinking>anthropic-internal chain of thought</antml:thinking>\n` +
      `${LONG_BODY}\n`;
    await expectEquivalent(raw, {
      kind: "plan",
      startToken: PLAN_START,
      endToken: PLAN_END,
      minLength: 200,
      completionSignal: null,
    });
  });

  // ------------------------------------------------------------------
  // 13. malformed — only thinking tags, no real content
  // ------------------------------------------------------------------
  test("13 thinking-only input is malformed — deep-equal", async () => {
    const raw =
      "<thinking>I am just thinking out loud and not producing any " +
      "deliverable content for the dispatcher.</thinking>\n";
    await expectEquivalent(raw, {
      kind: "plan",
      startToken: PLAN_START,
      endToken: PLAN_END,
      minLength: 200,
      completionSignal: null,
    });
  });

  // ------------------------------------------------------------------
  // 14. malformed — only completion signal
  // ------------------------------------------------------------------
  test("14 completion-signal-only is malformed — signal still captured", async () => {
    const raw = "PLAN DESIGN COMPLETE\n";
    await expectEquivalent(raw, {
      kind: "plan",
      startToken: PLAN_START,
      endToken: PLAN_END,
      minLength: 200,
      completionSignal: "PLAN DESIGN COMPLETE",
    });
  });

  // ------------------------------------------------------------------
  // 15. empty — delimiters present but content too short
  // ------------------------------------------------------------------
  test("15 too-short content between delimiters is empty — deep-equal", async () => {
    const raw = `${PLAN_START}\nhi\n${PLAN_END}\n`;
    await expectEquivalent(raw, {
      kind: "plan",
      startToken: PLAN_START,
      endToken: PLAN_END,
      minLength: 200,
      completionSignal: null,
    });
  });

  // ------------------------------------------------------------------
  // 16. multi_kind_pairs — review kind picks only REVIEW pair
  // ------------------------------------------------------------------
  test("16 multi-kind pairs: review kind isolates REVIEW delimiters", async () => {
    const raw =
      `${PLAN_START}\n${LONG_BODY}\n${PLAN_END}\n\n` +
      `${REVIEW_START}\n${LONG_BODY}\n${REVIEW_END}\n` +
      "REVIEW COMPLETE | Verdict: PASS | Severe: 0 Medium: 0 Optimization: 1\n";
    await expectEquivalent(raw, {
      kind: "review",
      startToken: REVIEW_START,
      endToken: REVIEW_END,
      minLength: 150,
      completionSignal: "REVIEW COMPLETE",
    });
  });

  // ------------------------------------------------------------------
  // 17. additional_files_read — trailing marker is stripped
  // ------------------------------------------------------------------
  test("17 ADDITIONAL FILES READ marker stripped from content — deep-equal", async () => {
    const raw =
      `${PLAN_START}\n${LONG_BODY}\n${PLAN_END}\n` +
      "PLAN DESIGN COMPLETE\n" +
      "ADDITIONAL FILES READ: a.py, b.py, c.py\n";
    await expectEquivalent(raw, {
      kind: "plan",
      startToken: PLAN_START,
      endToken: PLAN_END,
      minLength: 200,
      completionSignal: "PLAN DESIGN COMPLETE",
    });
  });

  // ------------------------------------------------------------------
  // 18. review_with_verdict_pass
  // ------------------------------------------------------------------
  test("18 review verdict PASS captured — deep-equal", async () => {
    const raw =
      `${REVIEW_START}\n${LONG_BODY}\n${REVIEW_END}\n` +
      "REVIEW COMPLETE | Verdict: PASS | Severe: 0 Medium: 0 Optimization: 1\n";
    await expectEquivalent(raw, {
      kind: "review",
      startToken: REVIEW_START,
      endToken: REVIEW_END,
      minLength: 150,
      completionSignal: "REVIEW COMPLETE",
    });
  });

  // ------------------------------------------------------------------
  // 19. review_with_verdict_fail
  // ------------------------------------------------------------------
  test("19 review verdict FAIL captured — deep-equal", async () => {
    const raw =
      `${REVIEW_START}\n${LONG_BODY}\n${REVIEW_END}\n` +
      "REVIEW COMPLETE | Verdict: FAIL | Severe: 2 Medium: 1 Optimization: 0\n";
    await expectEquivalent(raw, {
      kind: "review",
      startToken: REVIEW_START,
      endToken: REVIEW_END,
      minLength: 150,
      completionSignal: "REVIEW COMPLETE",
    });
  });

  // ------------------------------------------------------------------
  // 20. review_verdict_missing — verdict field is null when absent
  // ------------------------------------------------------------------
  test("20 review verdict absent → null — deep-equal", async () => {
    const raw = `${REVIEW_START}\n${LONG_BODY}\n${REVIEW_END}\nREVIEW COMPLETE\n`;
    await expectEquivalent(raw, {
      kind: "review",
      startToken: REVIEW_START,
      endToken: REVIEW_END,
      minLength: 150,
      completionSignal: "REVIEW COMPLETE",
    });
  });

  // ------------------------------------------------------------------
  // 21. completion_signal — leading whitespace tolerated
  // ------------------------------------------------------------------
  test("21 completion signal with leading whitespace — deep-equal", async () => {
    const raw =
      `${PLAN_START}\n${LONG_BODY}\n${PLAN_END}\n` +
      "    PLAN DESIGN COMPLETE\n";
    await expectEquivalent(raw, {
      kind: "plan",
      startToken: PLAN_START,
      endToken: PLAN_END,
      minLength: 200,
      completionSignal: "PLAN DESIGN COMPLETE",
    });
  });

  // ------------------------------------------------------------------
  // 22. completion_signal — trailing-content line still matches
  // ------------------------------------------------------------------
  test("22 completion signal with trailing content — deep-equal", async () => {
    const raw =
      `${PLAN_START}\n${LONG_BODY}\n${PLAN_END}\n` +
      "REVIEW COMPLETE | Verdict: FAIL | Severe: 1 Medium: 2 Optimization: 3\n";
    await expectEquivalent(raw, {
      kind: "review",
      startToken: REVIEW_START,
      endToken: REVIEW_END,
      minLength: 150,
      completionSignal: "REVIEW COMPLETE",
    });
  });

  // ------------------------------------------------------------------
  // 23. generic mode with explicit start/end tokens
  // ------------------------------------------------------------------
  test("23 generic kind with explicit tokens — deep-equal", async () => {
    const raw = `<BEGIN>\n${LONG_BODY}\n<END>\n`;
    await expectEquivalent(raw, {
      kind: "generic",
      startToken: "<BEGIN>",
      endToken: "<END>",
      minLength: 200,
      completionSignal: null,
    });
  });

  // ------------------------------------------------------------------
  // 24. min-length boundary — content slightly below triggers empty
  // ------------------------------------------------------------------
  test("24 min-length boundary below threshold → empty — deep-equal", async () => {
    const shortBody =
      "Short plan body that is only one paragraph and well under min.\n";
    const raw = `${PLAN_START}\n${shortBody}\n${PLAN_END}\n`;
    await expectEquivalent(raw, {
      kind: "plan",
      startToken: PLAN_START,
      endToken: PLAN_END,
      minLength: 200,
      completionSignal: null,
    });
  });
});

describe("parseDelimitedOutput convenience wrapper", () => {
  // The wrapper resolves tokens from `kind` and applies the default min
  // length. Verify it produces the same result as the Python CLI invoked
  // with the same kind (no explicit tokens).

  test("wrapper with kind=plan matches Python CLI with --kind plan", async () => {
    const raw = `${PLAN_START}\n${LONG_BODY}\n${PLAN_END}\nPLAN DESIGN COMPLETE\n`;
    const tsResult = parseDelimitedOutput(raw, {
      kind: "plan",
      completionSignal: "PLAN DESIGN COMPLETE",
    });
    const tmp = await makeTempDir("ghs-eq-wrap-");
    try {
      const r = await runPython(
        "parse_delimited_output.py",
        [
          "--kind", "plan",
          "--input-string", raw,
          "--completion-signal", "PLAN DESIGN COMPLETE",
        ],
        tmp,
        true,
      );
      const pyResult = JSON.parse(r.stdout);
      expect(tsResult as unknown).toEqual(pyResult);
    } finally {
      await cleanupTemp(tmp);
    }
  });

  test("wrapper throws for generic kind without explicit tokens", () => {
    expect(() => parseDelimitedOutput("hello", { kind: "generic" })).toThrow(
      /startToken and endToken are required/,
    );
  });

  test("wrapper throws for unknown kind", () => {
    expect(() => parseDelimitedOutput("hello", { kind: "bogus" })).toThrow(
      /unknown kind value/,
    );
  });
});
