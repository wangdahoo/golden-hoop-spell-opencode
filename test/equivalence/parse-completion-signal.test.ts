// Equivalence test for parse-completion-signal.ts vs parse_completion_signal.py.
//
// Implements Feature s4-feat-001. Strategy mirrors the other equivalence
// suites (parse-delimited-output / init / resolve / status / archive /
// validate): the TS port is invoked as a library function
// (`parseCompletionSignal`), the Python source is invoked as a subprocess
// (its CLI wraps the same `parse_signal` library function and emits the
// result as JSON), and the parsed JSON objects are compared with
// `toEqual` for structural deep-equality.
//
// The Python fixture
//   /Users/tom/github/golden-hoop-spell/plugin/shared/scripts/test_parse_completion_signal.py
// enumerates 18 cases in `ParseSignalUnitTests` (the 3-strategy cascade:
// exact / case-insensitive / natural-language, plus negatives and
// multi-feature coexistence) + CLI exit-code cases. This suite ports every
// `parse_signal`-based case (the library-function cases). The CLI
// input-source / exit-code cases are CLI-layer concerns not part of the TS
// port's contract (which is a pure library — no argparse / stdin / file IO);
// they're covered indirectly by the fact that the same `parse_signal`
// function powers both layers, and every library case here asserts
// byte-for-byte equality with the oracle.
//
// Each case runs BOTH the TS port and the Python oracle on the same raw text
// + feature_id + min_length and asserts the two result objects are deep-equal.
// This catches subtle regex/length/strategy divergence (e.g. the Python `$`
// vs JS `$` trailing-newline semantics documented in the port).
//
// Coverage (per the feature's acceptance criteria):
//   - exact_signal: completed / blocked-with-reason / blocked-without-reason
//   - case_insensitive: lowercase / mixed-case blocked
//   - natural_language: English completed/blocked, Chinese completed/blocked
//   - negatives: extra 'D' (COMPLETED), extra 'S' (COMPLETES), wrong
//     feature_id, forgot-to-emit
//   - min-length gate (short input → unknown)
//   - multi-feature coexistence (calling id1 sees only id1; id2 sees id2)
//   - markdown-bold + thinking-tag signal wrapping

import { expect, test, describe } from "bun:test";

import { parseCompletionSignal } from "../../src/lib/scripts/parse-completion-signal";
import {
  runPython,
  makeTempDir,
  cleanupTemp,
} from "./_helpers";

const FEATURE_ID = "s3-feat-001";
const OTHER_ID = "s3-feat-002";

/** Options passed to both the TS port and the Python CLI. */
interface CaseOpts {
  featureId: string;
  minLength: number;
}

/**
 * Run the Python oracle's `parse_signal` via its CLI wrapper and return the
 * parsed result object. The CLI emits `json.dumps(result, ensure_ascii=False,
 * indent=2)` on stdout and exits 0 on completed/blocked, 1 on unknown.
 *
 * `allowNonZero` is set so unknown cases (exit 1) still yield their JSON.
 */
async function pyParseSignal(
  rawText: string,
  opts: CaseOpts,
): Promise<Record<string, unknown>> {
  const tmp = await makeTempDir("ghs-eq-signal-");
  try {
    const r = await runPython(
      "parse_completion_signal.py",
      [
        "--feature-id", opts.featureId,
        "--input-string", rawText,
        "--min-length", String(opts.minLength),
      ],
      tmp,
      true,
    );
    // The CLI exits 0 (completed/blocked) or 1 (unknown); both emit JSON.
    expect(r.exitCode === 0 || r.exitCode === 1).toBe(true);
    const parsed = JSON.parse(r.stdout);
    return parsed as Record<string, unknown>;
  } finally {
    await cleanupTemp(tmp);
  }
}

/**
 * Run BOTH the TS port and the Python oracle on the same input and assert
 * deep equality of the full result object (status, feature_id, reason,
 * strategy, raw_signal_line, warnings, meta).
 */
async function expectEquivalent(
  rawText: string,
  opts: CaseOpts,
): Promise<void> {
  const tsResult = parseCompletionSignal(rawText, {
    feature_id: opts.featureId,
    min_length: opts.minLength,
  });
  const pyResult = await pyParseSignal(rawText, opts);
  // Compare as `unknown` so `toEqual` performs a structural deep-equal without
  // requiring the Python-derived `Record<string, unknown>` to satisfy the
  // TS port's `SignalResult` nominal shape.
  expect(tsResult as unknown).toEqual(pyResult);
}

describe("parse-completion-signal equivalence", () => {
  // ------------------------------------------------------------------
  // 1. exact_signal — completed
  // ------------------------------------------------------------------
  test("01 exact_signal completed — deep-equal to Python", async () => {
    const raw =
      "I implemented the helper and ran all tests.\n" +
      `FEATURE COMPLETE: ${FEATURE_ID}\n`;
    await expectEquivalent(raw, {
      featureId: FEATURE_ID,
      minLength: 50,
    });
  });

  // ------------------------------------------------------------------
  // 2. exact_signal — blocked with reason
  // ------------------------------------------------------------------
  test("02 exact_signal blocked with reason — deep-equal to Python", async () => {
    const raw =
      "I tried but the linter fails on the new file.\n" +
      `FEATURE BLOCKED: ${FEATURE_ID} - lint errors in foo.py\n`;
    await expectEquivalent(raw, {
      featureId: FEATURE_ID,
      minLength: 50,
    });
  });

  // ------------------------------------------------------------------
  // 3. exact_signal — blocked without reason (warning emitted)
  // ------------------------------------------------------------------
  test("03 exact_signal blocked without reason — deep-equal to Python", async () => {
    const raw =
      "I cannot complete this.\n" +
      `FEATURE BLOCKED: ${FEATURE_ID}\n`;
    await expectEquivalent(raw, {
      featureId: FEATURE_ID,
      minLength: 50,
    });
  });

  // ------------------------------------------------------------------
  // 4. case_insensitive — lowercase
  // ------------------------------------------------------------------
  test("04 case_insensitive lowercase completed — deep-equal to Python", async () => {
    const raw =
      "Done with the implementation.\n" +
      `feature complete: ${FEATURE_ID}\n`;
    await expectEquivalent(raw, {
      featureId: FEATURE_ID,
      minLength: 50,
    });
  });

  // ------------------------------------------------------------------
  // 5. case_insensitive — mixed-case blocked
  // ------------------------------------------------------------------
  test("05 case_insensitive mixed-case blocked — deep-equal to Python", async () => {
    const raw =
      "Hit a wall.\n" +
      `Feature Blocked: ${FEATURE_ID} - dependency missing\n`;
    await expectEquivalent(raw, {
      featureId: FEATURE_ID,
      minLength: 50,
    });
  });

  // ------------------------------------------------------------------
  // 6. Negative: extra 'D' (COMPLETED) — must be unknown
  // ------------------------------------------------------------------
  test("06 extra 'D' COMPLETED is unknown — deep-equal to Python", async () => {
    const raw =
      "Some context for the response.\n" +
      `FEATURE COMPLETED: ${FEATURE_ID}\n`;
    await expectEquivalent(raw, {
      featureId: FEATURE_ID,
      minLength: 50,
    });
  });

  // ------------------------------------------------------------------
  // 7. Negative: extra 'S' (COMPLETES) — short input, below min-length
  // ------------------------------------------------------------------
  test("07 extra 'S' COMPLETES is unknown — deep-equal to Python", async () => {
    const raw =
      "Some context.\n" +
      `FEATURE COMPLETES: ${FEATURE_ID}\n`;
    await expectEquivalent(raw, {
      featureId: FEATURE_ID,
      minLength: 50,
    });
  });

  // ------------------------------------------------------------------
  // 8. Chinese completion — natural_language
  // ------------------------------------------------------------------
  test("08 Chinese completed (natural_language) — deep-equal to Python", async () => {
    const raw =
      "我已经完成了实现并通过测试。\n" +
      `特性完成: ${FEATURE_ID}\n`;
    // Chinese chars: low min-length so the strategy logic is what's tested,
    // not the threshold (matches the Python fixture's min_length=10).
    await expectEquivalent(raw, {
      featureId: FEATURE_ID,
      minLength: 10,
    });
  });

  // ------------------------------------------------------------------
  // 9. Chinese blocked with reason — natural_language
  //     (exercises the Python `$` vs JS `$` trailing-newline divergence
  //     documented in the port — pattern #6 uses no MULTILINE flag)
  // ------------------------------------------------------------------
  test("09 Chinese blocked with reason (natural_language) — deep-equal to Python", async () => {
    const raw =
      "无法继续。\n" +
      `功能阻塞: ${FEATURE_ID} 依赖缺失无法编译\n`;
    await expectEquivalent(raw, {
      featureId: FEATURE_ID,
      minLength: 10,
    });
  });

  // ------------------------------------------------------------------
  // 10. Natural-language English — completed
  // ------------------------------------------------------------------
  test("10 natural_language English completed — deep-equal to Python", async () => {
    const raw =
      "All acceptance criteria are verified. " +
      `I have completed feature ${FEATURE_ID} successfully.\n`;
    await expectEquivalent(raw, {
      featureId: FEATURE_ID,
      minLength: 50,
    });
  });

  // ------------------------------------------------------------------
  // 11. Natural-language English — blocked with reason
  // ------------------------------------------------------------------
  test("11 natural_language English blocked — deep-equal to Python", async () => {
    const raw =
      "I cannot make progress. " +
      `Feature ${FEATURE_ID} is blocked because lint errors remain.\n`;
    await expectEquivalent(raw, {
      featureId: FEATURE_ID,
      minLength: 50,
    });
  });

  // ------------------------------------------------------------------
  // 12. Signal inside <thinking> tag — still recognized via natural_language
  // ------------------------------------------------------------------
  test("12 signal in <thinking> tag — deep-equal to Python", async () => {
    const raw =
      `<thinking>I'm done. FEATURE COMPLETE: ${FEATURE_ID}</thinking>\n` +
      "Let me write up the summary.\n";
    await expectEquivalent(raw, {
      featureId: FEATURE_ID,
      minLength: 50,
    });
  });

  // ------------------------------------------------------------------
  // 13. Signal wrapped in markdown bold — exact_signal after emphasis strip
  // ------------------------------------------------------------------
  test("13 signal in markdown bold — deep-equal to Python", async () => {
    const raw =
      "Implementation finished.\n" +
      `**FEATURE COMPLETE: ${FEATURE_ID}**\n`;
    await expectEquivalent(raw, {
      featureId: FEATURE_ID,
      minLength: 50,
    });
  });

  // ------------------------------------------------------------------
  // 14. Forgot to emit signal (just commit log) — unknown
  // ------------------------------------------------------------------
  test("14 no signal forgot — deep-equal to Python", async () => {
    const raw =
      "I committed the implementation. The diff includes the new file " +
      "and the tests. All 32 unit tests pass.\n";
    await expectEquivalent(raw, {
      featureId: FEATURE_ID,
      minLength: 50,
    });
  });

  // ------------------------------------------------------------------
  // 15. Empty/short input — below min-length → unknown
  // ------------------------------------------------------------------
  test("15 empty input below min-length — deep-equal to Python", async () => {
    const raw = "short"; // 5 chars < default 50
    await expectEquivalent(raw, {
      featureId: FEATURE_ID,
      minLength: 50,
    });
  });

  // ------------------------------------------------------------------
  // 16. Wrong feature_id — must not match
  // ------------------------------------------------------------------
  test("16 wrong feature_id is unknown — deep-equal to Python", async () => {
    const raw = `FEATURE COMPLETE: ${OTHER_ID}\n` + "x".repeat(100);
    await expectEquivalent(raw, {
      featureId: FEATURE_ID,
      minLength: 50,
    });
  });

  // ------------------------------------------------------------------
  // 17. Multi-feature coexistence — calling id1 sees only id1
  // ------------------------------------------------------------------
  test("17 multi-feature calling first id — deep-equal to Python", async () => {
    const raw =
      `FEATURE COMPLETE: ${FEATURE_ID}\n` +
      `FEATURE BLOCKED: ${OTHER_ID} - some reason\n`;
    await expectEquivalent(raw, {
      featureId: FEATURE_ID,
      minLength: 50,
    });
  });

  // ------------------------------------------------------------------
  // 18. Multi-feature coexistence — calling id2 sees only id2
  // ------------------------------------------------------------------
  test("18 multi-feature calling second id — deep-equal to Python", async () => {
    const raw =
      `FEATURE COMPLETE: ${FEATURE_ID}\n` +
      `FEATURE BLOCKED: ${OTHER_ID} - some reason\n`;
    await expectEquivalent(raw, {
      featureId: OTHER_ID,
      minLength: 50,
    });
  });
});

// ---------------------------------------------------------------------------
// Direct TS-only assertions mirroring the Python fixture's specific claims.
//
// These complement the oracle-comparison tests above with the fixture's
// explicit assertions (status equality, warning substring checks, strategy
// names) so a future refactor that accidentally weakens the TS port fails
// loudly even before the Python oracle is consulted.
// ---------------------------------------------------------------------------

describe("parse-completion-signal direct assertions (Python fixture parity)", () => {
  const call = (
    raw: string,
    featureId: string = FEATURE_ID,
    minLength: number = 50,
  ) => parseCompletionSignal(raw, { feature_id: featureId, min_length: minLength });

  test("exact completed — status/strategy/raw_signal_line", () => {
    const result = call(
      "I implemented the helper and ran all tests.\n" +
        `FEATURE COMPLETE: ${FEATURE_ID}\n`,
    );
    expect(result.status).toBe("completed");
    expect(result.strategy).toBe("exact_signal");
    expect(result.reason).toBeNull();
    expect(result.feature_id).toBe(FEATURE_ID);
    expect(result.raw_signal_line).toContain("FEATURE COMPLETE");
  });

  test("exact blocked with reason — reason extracted", () => {
    const result = call(
      "I tried but the linter fails on the new file.\n" +
        `FEATURE BLOCKED: ${FEATURE_ID} - lint errors in foo.py\n`,
    );
    expect(result.status).toBe("blocked");
    expect(result.strategy).toBe("exact_signal");
    expect(result.reason).toBe("lint errors in foo.py");
    expect(result.raw_signal_line).toContain("FEATURE BLOCKED");
  });

  test("exact blocked without reason — 'no reason' warning", () => {
    const result = call(
      "I cannot complete this.\n" + `FEATURE BLOCKED: ${FEATURE_ID}\n`,
    );
    expect(result.status).toBe("blocked");
    expect(result.reason).toBeNull();
    expect(result.warnings.some((w) => w.includes("no reason"))).toBe(true);
  });

  test("case_insensitive — 'case-insensitive' warning", () => {
    const result = call(
      "Done with the implementation.\n" +
        `feature complete: ${FEATURE_ID}\n`,
    );
    expect(result.status).toBe("completed");
    expect(result.strategy).toBe("case_insensitive");
    expect(result.warnings.some((w) => w.includes("case-insensitive"))).toBe(
      true,
    );
  });

  test("natural_language Chinese completed — 'natural language' warning", () => {
    const result = call(
      "我已经完成了实现并通过测试。\n" + `特性完成: ${FEATURE_ID}\n`,
      FEATURE_ID,
      10,
    );
    expect(result.status).toBe("completed");
    expect(result.strategy).toBe("natural_language");
    expect(result.warnings.some((w) => w.includes("natural language"))).toBe(
      true,
    );
  });

  test("natural_language Chinese blocked — reason contains dependency", () => {
    const result = call(
      "无法继续。\n" + `功能阻塞: ${FEATURE_ID} 依赖缺失无法编译\n`,
      FEATURE_ID,
      10,
    );
    expect(result.status).toBe("blocked");
    expect(result.strategy).toBe("natural_language");
    expect(result.reason).not.toBeNull();
    expect(result.reason).toContain("依赖");
  });

  test("unknown result records warnings", () => {
    const result = call(
      "I committed the implementation. The diff includes the new file " +
        "and the tests. All 32 unit tests pass.\n",
    );
    expect(result.status).toBe("unknown");
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  test("min-length gate — 'min-length' warning + strategy none", () => {
    const result = call("short", FEATURE_ID, 50);
    expect(result.status).toBe("unknown");
    expect(result.strategy).toBe("none");
    expect(result.warnings.some((w) => w.includes("min-length"))).toBe(true);
  });

  test("meta.input_length matches rawText length", () => {
    const raw = "I implemented the helper.\n" +
      `FEATURE COMPLETE: ${FEATURE_ID}\n`;
    const result = call(raw);
    expect(result.meta.input_length).toBe(raw.length);
    expect(result.meta.feature_id).toBe(FEATURE_ID);
  });
});
