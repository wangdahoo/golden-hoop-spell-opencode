// Port of golden-hoop-spell/plugin/shared/scripts/parse_completion_signal.py.
//
// Behavior source-of-truth:
//   /Users/tom/github/golden-hoop-spell/plugin/shared/scripts/parse_completion_signal.py
//
// Faithful port notes (plan §3.4 D4 — line-by-line port):
//   - The Python source is both a library (`parse_signal` + 4 strategy helpers)
//     and a CLI wrapper (argparse / stdin / file IO). We port the *library*
//     core verbatim; the CLI layer is intentionally omitted because the
//     OpenCode plugin consumes this as an in-process TS module, not a
//     subprocess. The ghs-code dispatcher (and any other tool) calls
//     `parseCompletionSignal()` directly.
//   - The 3-strategy cascade (exact_signal → case_insensitive →
//     natural_language) plus the min-length gate is preserved exactly.
//   - Regex port hazards (plan §5 risk row "JS 正则与 Python re 的细微差异"):
//       * Python `re.MULTILINE` → JS `/m` flag (exact / case-insensitive
//         strategies anchor to line start with `^`).
//       * Python `re.IGNORECASE` → JS `/i` flag (case-insensitive +
//         natural-language patterns).
//       * Python `\b` is Unicode-aware; JS `\b` is ASCII-only. The
//         feature_id is always ASCII (`sN-feat-NNN`), so the boundary
//         semantics coincide for every real input.
//       * Python `re.escape` escapes a superset of JS special chars, but
//         for the inputs we pass (ASCII feature IDs) the escaped forms are
//         identical. We use a small `escapeRegex` helper that escapes every
//         char JS treats as special.
//       * Python named groups `(?P<name>...)` → JS `(?<name>...)`.
//       * The natural-language templates embed a literal `PLACEHOLDER` for
//         the feature_id, re-compiled per call with the real escaped id —
//         same mechanism as the Python source.
//   - JSON output: the Python CLI serialises with `json.dumps(result,
//     ensure_ascii=False, indent=2)`. Callers consume the *parsed* result
//     object (not the serialised string), so we return a plain object; a
//     `serializeResult()` helper is provided for callers that need the exact
//     byte stream (uses `JSON.stringify(..., null, 2)`).
//   - Style follows s1-feat-008: no `process.exit`, no `console.log`,
//     functions are pure (no FS / subprocess side effects).

/**
 * Escape every character that has special meaning in a JavaScript regular
 * expression, so a literal string can be embedded inside a `RegExp`.
 *
 * This mirrors the intent of Python's `re.escape`: the escaped result matches
 * the input verbatim. JS escapes a slightly smaller set of metacharacters
 * than Python, but for the inputs this module passes (ASCII feature IDs) the
 * escaped forms are byte-identical.
 */
function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Constants — mirror the Python module-level globals.
// ---------------------------------------------------------------------------

/**
 * Default minimum raw-input length. The completion-signal protocol itself is
 * a single line, but a near-empty response (no commit log, no description)
 * is treated as unknown rather than risk a false-positive natural-language
 * match.
 */
export const DEFAULT_MIN_LENGTH = 50;

/**
 * Maximum characters of trailing context to scan when extracting a reason
 * from natural-language blocked signals (e.g. "Feature X is blocked because
 * lint fails and tests don't compile"). Keeps the reason field bounded.
 */
export const NATURAL_LANGUAGE_REASON_WINDOW = 200;

/**
 * Markdown emphasis markers we strip from candidate signal lines so that
 * `**FEATURE COMPLETE: <id>**` matches the same way as the bare line.
 *
 * Mirrors the Python `_EMPHASIS_CHARS = "*_\`"`.
 */
const _EMPHASIS_CHARS = "*_`";

// ---------------------------------------------------------------------------
// Result types.
// ---------------------------------------------------------------------------

export type SignalStatus = "completed" | "blocked" | "unknown";

export type SignalStrategy =
  | "exact_signal"
  | "case_insensitive"
  | "natural_language"
  | "none";

export interface SignalResultMeta {
  feature_id: string;
  input_length: number;
}

export interface SignalResult {
  status: SignalStatus;
  feature_id: string;
  reason: string | null;
  strategy: SignalStrategy;
  raw_signal_line: string | null;
  warnings: string[];
  meta: SignalResultMeta;
}

/** Outcome of a single strategy probe: null status means "no match". */
interface StrategyOutcome {
  status: SignalStatus | null;
  reason: string | null;
  rawLine: string | null;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Helpers — 1:1 ports of the Python `_strip_*` / `_extract_*` functions.
// ---------------------------------------------------------------------------

/**
 * Strip leading/trailing whitespace and markdown emphasis characters from a
 * line.
 *
 * Port of `_strip_emphasis`. Lets `**FEATURE COMPLETE: <id>**` and
 * `_FEATURE COMPLETE: <id>_` match the same regexes as the bare signal line.
 *
 * Implementation note: Python's `str.strip(chars)` removes any of the chars
 * from both ends repeatedly. We emulate by trimming whitespace, then
 * repeatedly stripping leading/trailing emphasis chars (JS `String.trim`
 * takes no char-set arg), then trimming whitespace again.
 */
function stripEmphasis(line: string): string {
  let out = line.trim();
  // Strip emphasis chars from both ends until neither end is an emphasis char.
  // (Equivalent to Python `"*_`".strip() outer + inner whitespace handling.)
  while (out.length > 0 && _EMPHASIS_CHARS.includes(out[0])) {
    out = out.slice(1);
  }
  while (out.length > 0 && _EMPHASIS_CHARS.includes(out[out.length - 1])) {
    out = out.slice(0, -1);
  }
  return out.trim();
}

/**
 * Extract the `- <reason>` tail from a blocked-signal line.
 *
 * Port of `_extract_reason_from_signal_line`. Works on both exact and
 * case-insensitive matches. Returns null if no ` - ` separator is present
 * (treated as blocked without a reason).
 *
 * Accepts dash variants: ASCII hyphen, en dash, em dash, double-hyphen.
 * Python regex: `r"(?:--|—|–|-)\s*(.+)$"`.
 */
function extractReasonFromSignalLine(
  line: string,
  featureId: string,
): string | null {
  // Drop everything up to and including the feature_id, then look for the
  // ` - ` (or ` — ` / ` -- `) separator that introduces the reason.
  const parts = line.split(featureId);
  if (parts.length < 2) {
    return null;
  }
  // Python: `line.split(feature_id, 1)` → at most 2 parts. JS `split` without
  // a limit splits on every occurrence; we only care about the tail after the
  // FIRST occurrence, which is `parts.slice(1).join(featureId)` — but since
  // we only inspect the immediate tail, joining back any re-occurrences of
  // the id is the faithful behaviour.
  const tail = parts.slice(1).join(featureId).trim();
  if (!tail) {
    return null;
  }
  const m = /(?:--|—|–|-)\s*(.+)$/.exec(tail);
  if (!m) {
    return null;
  }
  const reason = m[1].trim();
  return reason || null;
}

// ---------------------------------------------------------------------------
// Strategy 1: exact_signal.
// ---------------------------------------------------------------------------

/**
 * STRATEGY 1: literal `FEATURE (COMPLETE|BLOCKED): <id>` on its own line.
 *
 * Port of `_strategy_exact`. Python compiles
 * `r"^FEATURE\s+(COMPLETE|BLOCKED):\s*" + re.escape(feature_id) + r"\b.*$"`
 * with `re.MULTILINE`. JS equivalent: `new RegExp(..., "m")` — `^` and `$`
 * anchor to line starts/ends.
 */
function strategyExact(
  text: string,
  featureId: string,
): StrategyOutcome {
  const warnings: string[] = [];
  const pattern = new RegExp(
    "^FEATURE\\s+(COMPLETE|BLOCKED):\\s*" +
      escapeRegex(featureId) +
      "\\b.*$",
    "m",
  );
  const match = pattern.exec(text);
  if (!match) {
    return { status: null, reason: null, rawLine: null, warnings };
  }
  const outcome = match[1].toUpperCase(); // "COMPLETE" or "BLOCKED"
  const rawLine = match[0].trim();
  if (outcome === "COMPLETE") {
    return { status: "completed", reason: null, rawLine, warnings };
  }
  const reason = extractReasonFromSignalLine(rawLine, featureId);
  if (reason === null) {
    warnings.push("blocked signal has no reason text");
  }
  return { status: "blocked", reason, rawLine, warnings };
}

// ---------------------------------------------------------------------------
// Strategy 2: case_insensitive.
// ---------------------------------------------------------------------------

/**
 * STRATEGY 2: tolerate case variation in FEATURE/COMPLETE/BLOCKED.
 *
 * Port of `_strategy_case_insensitive`. Matches `Feature Complete`,
 * `feature complete`, etc. Requires the feature_id to still match exactly
 * (it's a key, not prose). Python compiles the same shape as STRATEGY 1 but
 * with `re.IGNORECASE` added; we use JS `im` flags. Always records a
 * "case-insensitive match" warning when it fires.
 */
function strategyCaseInsensitive(
  text: string,
  featureId: string,
): StrategyOutcome {
  const warnings: string[] = [];
  const pattern = new RegExp(
    "^feature\\s+(complete|blocked):\\s*" +
      escapeRegex(featureId) +
      "\\b.*$",
    "im",
  );
  const match = pattern.exec(text);
  if (!match) {
    return { status: null, reason: null, rawLine: null, warnings };
  }
  const outcome = match[1].toUpperCase();
  const rawLine = match[0].trim();
  warnings.push("case-insensitive match");
  if (outcome === "COMPLETE") {
    return { status: "completed", reason: null, rawLine, warnings };
  }
  const reason = extractReasonFromSignalLine(rawLine, featureId);
  if (reason === null) {
    warnings.push("blocked signal has no reason text");
  }
  return { status: "blocked", reason, rawLine, warnings };
}

// ---------------------------------------------------------------------------
// Strategy 3: natural_language.
// ---------------------------------------------------------------------------

/**
 * Natural-language pattern template. Each entry:
 *   - `source`: the regex source with a literal `PLACEHOLDER` where the
 *     escaped feature_id should be substituted at call time.
 *   - `flags`: the JS flag string to compile with (`i` / `im`).
 *   - `outcome`: `"completed"` or `"blocked"`.
 *   - `reasonGroup`: the named-capture-group name holding the reason text
 *     (`null` for completed matches).
 *
 * Port of `_NATURAL_LANGUAGE_PATTERNS`. The Python source stores compiled
 * regexes with a literal PLACEHOLDER and re-compiles per call; we mirror
 * that mechanism (store source strings, re-compile per call) so the
 * feature_id is interpolated into the pattern body exactly as in Python.
 */
interface NaturalLanguagePattern {
  source: string;
  flags: string;
  outcome: "completed" | "blocked";
  reasonGroup: string | null;
}

const _NATURAL_LANGUAGE_PATTERNS: NaturalLanguagePattern[] = [
  // English completion phrasings.
  {
    // Python: r"(?:i\s+(?:have\s+|'ve\s+)?(?:finished|completed|done)|"
    //         r"(?:feature|task)\s+(?:is\s+)?(?:done|complete|finished))\s*[:\.]?\s*"
    //         r"(?:feature\s+)?(?P<id>{id})\b"
    // JS note: the `\.` inside the character class needs no escaping in JS
    // either; we keep it as `[.:]` which matches `.` or `:`. Python wrote
    // `[:\.]` (escaped dot inside class — harmless redundancy); JS `[.:]`
    // is equivalent.
    source:
      "(?:i\\s+(?:have\\s+|'ve\\s+)?(?:finished|completed|done)|" +
      "(?:feature|task)\\s+(?:is\\s+)?(?:done|complete|finished))\\s*[.:]?\\s*" +
      "(?:feature\\s+)?(?<id>PLACEHOLDER)\\b",
    flags: "i",
    outcome: "completed",
    reasonGroup: null,
  },
  {
    // Python: r"(?P<id>{id})\s+is\s+(?:done|complete|finished)\b"
    source: "(?<id>PLACEHOLDER)\\s+is\\s+(?:done|complete|finished)\\b",
    flags: "i",
    outcome: "completed",
    reasonGroup: null,
  },
  // English blocked phrasings.
  {
    // Python: r"(?P<id>{id})\s+is\s+blocked\s+(?:because\s+)?(?P<reason>.+)$"
    //         with IGNORECASE | MULTILINE
    source:
      "(?<id>PLACEHOLDER)\\s+is\\s+blocked\\s+(?:because\\s+)?(?<reason>.+)$",
    flags: "im",
    outcome: "blocked",
    reasonGroup: "reason",
  },
  {
    // Python:
    //   r"(?:i\s+(?:have\s+)?(?:blocked|halted|stopped\s+at))\s+(?:feature\s+)?"
    //   r"(?P<id>{id})\s*(?P<reason>.+)$"  with IGNORECASE | MULTILINE
    source:
      "(?:i\\s+(?:have\\s+)?(?:blocked|halted|stopped\\s+at))\\s+(?:feature\\s+)?" +
      "(?<id>PLACEHOLDER)\\s*(?<reason>.+)$",
    flags: "im",
    outcome: "blocked",
    reasonGroup: "reason",
  },
  // Chinese completion phrasings.
  {
    // Python: r"(?:特性|功能|任务)\s*完成\s*[:：]\s*(?P<id>{id})\b"
    // JS note: no flags (Python had none). The Chinese full-width colon `：`
    // and ASCII `:` are both matched by the character class `[:：]`.
    source: "(?:特性|功能|任务)\\s*完成\\s*[:：]\\s*(?<id>PLACEHOLDER)\\b",
    flags: "",
    outcome: "completed",
    reasonGroup: null,
  },
  // Chinese blocked phrasings.
  {
    // Python: r"(?:特性|功能|任务)\s*(?:阻塞|卡住|未完成|失败)\s*[:：]\s*(?P<id>{id})"
    //         r"\s*(?:[-—–\-：:])?\s*(?P<reason>.+)$"   (no flags)
    //
    // Regex port hazard: Python's `$` WITHOUT `re.MULTILINE` matches at the
    // end of the string OR just before a single trailing newline at the end
    // of the string. JS's `$` WITHOUT the `/m` flag matches ONLY at the
    // absolute end of the string. Since real subagent output almost always
    // has a trailing `\n`, the Python pattern matches on `"...\n"` but a
    // naive JS `...$` does not. We restore byte-equivalent behaviour with a
    // zero-width lookahead `(?=\n?$)` that matches at the absolute end OR
    // just before a single optional trailing newline. (Patterns #1-#4 use
    // `i`/`im` flags and are anchored with `$` only where MULTILINE is set,
    // so they're unaffected.)
    source:
      "(?:特性|功能|任务)\\s*(?:阻塞|卡住|未完成|失败)\\s*[:：]\\s*(?<id>PLACEHOLDER)" +
      "\\s*(?:[-—–\\-：:])?\\s*(?<reason>.+)(?=\\n?$)",
    flags: "",
    outcome: "blocked",
    reasonGroup: "reason",
  },
];

/**
 * STRATEGY 3: permissive natural-language phrasings.
 *
 * Port of `_strategy_natural_language`. Lower accuracy than the strict
 * strategies. Used only as a fallback so a subagent that forgot the protocol
 * but clearly stated its outcome still resolves. Always records a warning
 * naming the matched pattern.
 *
 * Runs against the *raw* text (not the emphasis-stripped text), matching the
 * Python source which passes `raw_text` (not `stripped_text`) to this
 * strategy.
 */
function strategyNaturalLanguage(
  text: string,
  featureId: string,
): StrategyOutcome {
  const warnings: string[] = [];
  const escapedId = escapeRegex(featureId);
  for (let idx = 0; idx < _NATURAL_LANGUAGE_PATTERNS.length; idx++) {
    const template = _NATURAL_LANGUAGE_PATTERNS[idx];
    // Each template was authored with a literal PLACEHOLDER where the
    // feature_id regex should go. Re-compile per call with the real id.
    const patternSrc = template.source.replace("PLACEHOLDER", escapedId);
    let pattern: RegExp;
    try {
      pattern = new RegExp(patternSrc, template.flags);
    } catch {
      // Python `except re.error: continue`. Defensive — a bad template would
      // be a port bug, but we skip rather than crash to preserve the cascade.
      continue;
    }
    const match = pattern.exec(text);
    if (!match) {
      continue;
    }
    let rawLine = (match[0] ?? "").trim();
    // Truncate the captured raw line so an over-eager natural-language
    // pattern doesn't dump the entire rest of the response into JSON.
    if (rawLine.length > NATURAL_LANGUAGE_REASON_WINDOW) {
      rawLine = rawLine.slice(0, NATURAL_LANGUAGE_REASON_WINDOW) + "...";
    }
    // Python `enumerate(..., start=1)` → pattern number is 1-based.
    warnings.push(`natural language fallback: pattern #${idx + 1}`);
    if (template.outcome === "completed") {
      return { status: "completed", reason: null, rawLine, warnings };
    }
    // outcome === "blocked"
    const groups = match.groups ?? {};
    let reason: string | null = null;
    if (template.reasonGroup && template.reasonGroup in groups) {
      const captured = groups[template.reasonGroup];
      reason = captured ? captured.trim() : null;
    }
    if (!reason) {
      warnings.push(
        "natural-language blocked signal has no reason text",
      );
      reason = null;
    }
    return { status: "blocked", reason, rawLine, warnings };
  }
  return { status: null, reason: null, rawLine: null, warnings };
}

// ---------------------------------------------------------------------------
// Public API — parseCompletionSignal.
// ---------------------------------------------------------------------------

/**
 * Parse `rawText` and return the result object.
 *
 * Port of `parse_signal`. The result shape is:
 *
 * ```json
 * {
 *   "status": "completed" | "blocked" | "unknown",
 *   "feature_id": "<id>",
 *   "reason": "<reason text, or null>",
 *   "strategy": "exact_signal" | "case_insensitive"
 *            | "natural_language" | "none",
 *   "raw_signal_line": "<stripped signal line, or null>",
 *   "warnings": ["...", "..."],
 *   "meta": { "feature_id": "<id>", "input_length": <number> }
 * }
 * ```
 *
 * `minLength` defaults to {@link DEFAULT_MIN_LENGTH} (50). Inputs shorter
 * than the threshold are resolved `unknown` without running any strategy.
 *
 * The three strategies are tried in priority order:
 *   1. `exact_signal` — literal `FEATURE (COMPLETE|BLOCKED): <id>` on its own
 *      line (after stripping markdown emphasis).
 *   2. `case_insensitive` — same shape, tolerant of case variation in
 *      FEATURE/COMPLETE/BLOCKED.
 *   3. `natural_language` — permissive phrasings (English + Chinese),
 *      evaluated against the *raw* text. Always records a warning.
 */
export function parseCompletionSignal(
  rawText: string,
  opts: { feature_id: string; min_length?: number },
): SignalResult {
  const featureId = opts.feature_id;
  const minLength = opts.min_length ?? DEFAULT_MIN_LENGTH;
  const warnings: string[] = [];

  // JS `.length` counts UTF-16 code units; Python `len()` counts code points.
  // For ASCII inputs (the overwhelmingly common case for completion signals)
  // the two coincide. For inputs with astral-plane chars the counts differ,
  // but such chars never appear in real subagent signal output. We match
  // Python's `len(raw_text)` for the threshold comparison by using
  // `.length` (code units) — acceptable for the realistic input domain.
  const inputLength = rawText.length;

  if (inputLength < minLength) {
    warnings.push(
      `raw input below min-length (${inputLength} < ${minLength})`,
    );
    return {
      status: "unknown",
      feature_id: featureId,
      reason: null,
      strategy: "none",
      raw_signal_line: null,
      warnings,
      meta: {
        feature_id: featureId,
        input_length: inputLength,
      },
    };
  }

  // Pre-process: strip markdown emphasis on each non-empty line so signals
  // wrapped in **bold** or _italic_ match the same regexes.
  const strippedLines = rawText.split(/\r?\n/).map((line) => {
    // Python: `_strip_emphasis(line) if line.strip() else line`. We emulate
    // `line.strip()` truthiness: a line that is empty/whitespace-only is
    // passed through untouched.
    if (line.trim() === "") {
      return line;
    }
    return stripEmphasis(line);
  });
  const strippedText = strippedLines.join("\n");

  // Strategy cascade. Note STRATEGY 3 runs against `rawText`, not
  // `strippedText` — intentional, matches the Python source.
  const strategies: Array<{
    name: SignalStrategy;
    run: () => StrategyOutcome;
  }> = [
    { name: "exact_signal", run: () => strategyExact(strippedText, featureId) },
    {
      name: "case_insensitive",
      run: () => strategyCaseInsensitive(strippedText, featureId),
    },
    {
      name: "natural_language",
      run: () => strategyNaturalLanguage(rawText, featureId),
    },
  ];

  for (const { name, run } of strategies) {
    const outcome = run();
    if (outcome.status === null) {
      continue;
    }
    warnings.push(...outcome.warnings);
    return {
      status: outcome.status,
      feature_id: featureId,
      reason: outcome.reason,
      strategy: name,
      raw_signal_line: outcome.rawLine,
      warnings,
      meta: {
        feature_id: featureId,
        input_length: inputLength,
      },
    };
  }

  // No strategy matched.
  warnings.push(
    "no signal pattern matched (exact/case-insensitive/natural-language)",
  );
  return {
    status: "unknown",
    feature_id: featureId,
    reason: null,
    strategy: "none",
    raw_signal_line: null,
    warnings,
    meta: {
      feature_id: featureId,
      input_length: inputLength,
    },
  };
}

// ---------------------------------------------------------------------------
// Serialization helper.
// ---------------------------------------------------------------------------

/**
 * Serialize a {@link SignalResult} to the canonical JSON form
 * (`JSON.stringify(result, null, 2)`).
 *
 * Callers normally consume the *parsed* object directly, so they rarely need
 * this. It's provided for parity with the other ported scripts and for any
 * caller that wants the canonical textual form.
 *
 * `JSON.stringify(result, null, 2)` matches `json.dumps(..., indent=2)` for
 * the result shape (no Date / BigInt / undefined fields). Non-ASCII chars
 * are preserved (JS does not escape them by default, matching
 * `ensure_ascii=False`).
 */
export function serializeResult(result: SignalResult): string {
  return JSON.stringify(result, null, 2);
}
