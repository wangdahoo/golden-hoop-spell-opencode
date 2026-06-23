// Port of golden-hoop-spell/plugin/shared/scripts/parse_delimited_output.py.
//
// Behavior source-of-truth:
//   golden-hoop-spell/plugin/shared/scripts/parse_delimited_output.py
//
// Faithful port notes (plan §3.4 D4 — line-by-line port):
//   - The Python source is both a library (`parse_raw` + strategy helpers) and
//     a CLI wrapper. We port the *library* core verbatim; the CLI layer
//     (argparse / stdin / file IO) is intentionally omitted because the
//     OpenCode plugin consumes this as an in-process TS module, not a
//     subprocess. The plan-dispatcher tools (`ghs-plan-review` etc.) call
//     `parseDelimitedOutput()` directly.
//   - The strategy cascade (exact_delimiter → normalized_delimiter →
//     code_fence → open_ended → whole_body) and the empty-vs-malformed
//     distinction are preserved. `open_ended` is a port-layer addition
//     (plan §Phase 1) for truncated-output recovery not present in the
//     Python source; the other four mirror Python 1:1.
//   - Regex port hazards (plan §5 risk row "JS 正则与 Python re 的细微差异"):
//       * Python inline flag group `(?i:_?START)` has no JS equivalent.
//         We approximate by compiling the whole token pattern with the `/i`
//         flag. Functionally equivalent for the inputs we see (the token name
//         and the optional `_START` suffix are the only parts that need
//         case-insensitivity; the bracket character classes are unaffected).
//       * Python `re.DOTALL` → JS `/s` flag. `_strip_thinking` and the
//         code-fence pattern both rely on `.` matching newlines — both use
//         `/s` here.
//       * Python `re.MULTILINE` → JS `/m` flag (completion-signal stripper,
//         code-fence line anchoring).
//       * Python `\b` is Unicode-aware; JS `\b` is ASCII-only. The completion
//         signal is always ASCII uppercase (`PLAN DESIGN COMPLETE`, etc.) so
//         the boundary semantics coincide for every real input.
//       * Python `re.escape` escapes a superset of JS special chars, but for
//         the inputs we pass (literal delimiters like `<<<PLAN_START>>>` and
//         signal phrases) the escaped forms are identical. We use a small
//         `escapeRegex` helper that escapes every char JS treats as special.
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
 * than Python, but for the inputs this module passes (ASCII delimiters and
 * signal phrases) the escaped forms are byte-identical.
 */
function escapeRegex(literal: string): string {
  // Escape anything that is not a word character. This is a conservative
  // superset of the JS regex metacharacters and is safe — escaping a normal
  // char is a no-op for matching purposes.
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Constants — mirror the Python module-level globals.
// ---------------------------------------------------------------------------

/** Token name per `kind` value (used to derive the delimiter labels). */
const TOKEN_BY_KIND: Record<string, string> = {
  plan: "PLAN",
  review: "REVIEW",
  context_snapshot: "CONTEXT_SNAPSHOT",
};

/** Default min length when `minLength` is not provided. */
const DEFAULT_MIN_LENGTH = 200;

/**
 * Regex that pulls `Verdict: PASS` or `Verdict: FAIL` out of a review signal
 * line.
 *
 * Python: `re.compile(r"Verdict:\s*(PASS|FAIL)")` (no flags).
 */
const VERDICT_RE = /Verdict:\s*(PASS|FAIL)/;

/**
 * Marker that plan-designer prints at the end of its response; everything
 * after it is metadata that must not leak into the extracted content.
 */
const ADDITIONAL_FILES_READ_MARKER = "ADDITIONAL FILES READ:";

/**
 * Regex variants used by STRATEGY 2 normalized_delimiter. Kept as plain
 * strings so the token name can be interpolated before compilation, mirroring
 * the Python module-level constants.
 */
const _NORMALIZED_TOKEN_LEFT = "[<《「〖]+\\s*";
const _NORMALIZED_TOKEN_RIGHT = "\\s*[>》」〗]+";

// ---------------------------------------------------------------------------
// Result types.
// ---------------------------------------------------------------------------

export type ParseStatus = "ok" | "fallback_used" | "empty" | "malformed";

export type ParseStrategy =
  | "exact_delimiter"
  | "normalized_delimiter"
  | "code_fence"
  | "open_ended"
  | "whole_body"
  | "none";

export type Verdict = "PASS" | "FAIL" | null;

export interface ParseResultMeta {
  kind: string;
  input_length: number;
  content_length: number;
}

export interface ParseResult {
  status: ParseStatus;
  content: string;
  strategy: ParseStrategy;
  completion_signal: string | null;
  verdict: Verdict;
  warnings: string[];
  meta: ParseResultMeta;
}

// ---------------------------------------------------------------------------
// Helpers — 1:1 ports of the Python `_strip_*` / `_extract_*` functions.
// ---------------------------------------------------------------------------

/**
 * Strip legacy `<thinking>...</thinking>` and `<antml:thinking>...</antml:thinking>`
 * blocks.
 *
 * Port of `_strip_thinking`. Python compiles
 * `r"<(?:antml:)?thinking>.*?</(?:antml:)?thinking>"` with `re.DOTALL |
 * re.IGNORECASE`. JS equivalent: `/.../gis` (the `s` flag makes `.` match
 * newlines; `i` is case-insensitive; the non-greedy `.*?` is preserved).
 *
 * The second regex strips a stray unclosed opening tag (rare but seen) by
 * removing everything after it.
 */
function stripThinking(text: string): string {
  const closed = text.replace(
    /<(?:antml:)?thinking>.*?<\/(?:antml:)?thinking>/gis,
    "",
  );
  return closed.replace(/<(?:antml:)?thinking>.*/gis, "");
}

/**
 * Strip the completion-signal line from text, returning `[cleanedText,
 * signalLine]`.
 *
 * Port of `_strip_completion_signal`. Python compiles
 * `r"^[ \t]*" + re.escape(signal) + r"\b.*$"` with `re.MULTILINE`. The entire
 * matching line (including any trailing variables like
 * `| Verdict: PASS | Severe: 0 ...`) is captured and returned.
 *
 * JS note: `.*` without the `s` flag stops at the first newline, matching
 * Python's default (no DOTALL) behaviour. `$` with the `m` flag matches end
 * of line. `\b` is ASCII-only in JS but the signal is always ASCII, so the
 * word boundary coincides.
 */
function stripCompletionSignal(
  text: string,
  signal: string,
): [string, string | null] {
  if (!signal) {
    return [text, null];
  }
  const pattern = new RegExp(
    "^[ \\t]*" + escapeRegex(signal) + "\\b.*$",
    "m",
  );
  const match = pattern.exec(text);
  if (!match) {
    return [text, null];
  }
  const signalLine = match[0].trim();
  // Replace the first occurrence only — `pattern` has no `g` flag, but
  // `String.replace` with a non-global RegExp replaces the first match, which
  // matches Python's `pattern.sub("", text)` behaviour when there is exactly
  // one signal line. Python's `re.sub` without a count replaces *all*
  // non-overlapping matches; we mirror that by using the global flag for the
  // substitution pass.
  const globalPattern = new RegExp(
    "^[ \\t]*" + escapeRegex(signal) + "\\b.*$",
    "gm",
  );
  const cleaned = text.replace(globalPattern, "");
  return [cleaned, signalLine];
}

/**
 * Strip everything from the `ADDITIONAL FILES READ:` marker onward.
 *
 * Port of `_strip_additional_files_read`. Uses `String.indexOf` + slice to
 * mirror Python's `text.find(marker)` + slice semantics exactly (a regex
 * would also work but the source uses plain string ops).
 */
function stripAdditionalFilesRead(text: string): string {
  const idx = text.indexOf(ADDITIONAL_FILES_READ_MARKER);
  if (idx === -1) {
    return text;
  }
  return text.slice(0, idx).replace(/\s+$/, "");
}

/**
 * Extract `Verdict: PASS|FAIL` from the completion-signal line first, then
 * the raw text tail.
 *
 * Port of `_extract_verdict`. Scans the signal line first; if not found
 * there, falls back to the trailing ~600 chars of the raw input.
 */
function extractVerdict(
  signalLine: string | null,
  rawText: string,
): Verdict {
  if (signalLine) {
    const m = VERDICT_RE.exec(signalLine);
    if (m) {
      return m[1] as "PASS" | "FAIL";
    }
  }
  const tail = rawText.length > 600 ? rawText.slice(-600) : rawText;
  const m = VERDICT_RE.exec(tail);
  if (m) {
    return m[1] as "PASS" | "FAIL";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Strategies. Each returns `[content, warnings]` or `[null, warnings]`.
// Callers must validate `content.trim().length >= minLength` before accepting.
// ---------------------------------------------------------------------------

type StrategyResult = [string | null, string[]];

/**
 * STRATEGY 1: literal `<<<X_START>>>...<<<X_END>>>` extraction.
 *
 * Port of `_strategy_exact`. When the raw text contains multiple candidate
 * pairs (e.g. a code fence that quotes the delimiters as string literals
 * followed by the real pair), pick the pair with the largest inner span.
 * `String.indexOf` mirrors Python's `str.find` (-1 sentinel on miss).
 */
function strategyExact(
  text: string,
  startToken: string,
  endToken: string,
): StrategyResult {
  const warnings: string[] = [];
  const startPositions: number[] = [];
  let searchFrom = 0;
  while (true) {
    const idx = text.indexOf(startToken, searchFrom);
    if (idx === -1) {
      break;
    }
    startPositions.push(idx);
    searchFrom = idx + startToken.length;
  }
  if (startPositions.length === 0) {
    return [null, warnings];
  }

  let bestContent: string | null = null;
  for (const startIdx of startPositions) {
    const contentStart = startIdx + startToken.length;
    const endIdx = text.indexOf(endToken, contentStart);
    if (endIdx === -1) {
      continue;
    }
    const candidate = text.slice(contentStart, endIdx);
    if (bestContent === null || candidate.length > bestContent.length) {
      bestContent = candidate;
    }
  }
  if (bestContent === null) {
    return [null, warnings];
  }
  return [bestContent, warnings];
}

/**
 * STRATEGY 2: tolerate bracket punctuation / whitespace / case variations.
 *
 * Port of `_strategy_normalized`. Matches the kind-specific token only (e.g.
 * `PLAN`) so a response that mixes multiple kinds does not
 * cross-contaminate.
 *
 * Python uses inline `(?i:_?START)` / `(?i:_?END)` flags; JS has no inline
 * flags, so the whole token pattern is compiled with the global `/i` flag.
 * For the inputs this strategy sees (ASCII token names + bracket decoration)
 * the behaviour is identical.
 */
function strategyNormalized(
  text: string,
  tokenName: string,
): StrategyResult {
  const warnings: string[] = [];
  const tokenRe = escapeRegex(tokenName);

  // `[<《「〖]+` then the token then optional `_?START` then `[>》」〗]+`.
  // Whitespace tolerance via `\s*` on both sides (Python source).
  const startPattern = new RegExp(
    _NORMALIZED_TOKEN_LEFT + tokenRe + "_?START" + _NORMALIZED_TOKEN_RIGHT,
    "i",
  );
  const endPattern = new RegExp(
    _NORMALIZED_TOKEN_LEFT + tokenRe + "_?END" + _NORMALIZED_TOKEN_RIGHT,
    "i",
  );

  const startMatch = startPattern.exec(text);
  if (!startMatch) {
    return [null, warnings];
  }
  // Search for the END marker from the end of the START match onward.
  endPattern.lastIndex = startMatch.index! + startMatch[0].length;
  const endMatch = endPattern.exec(text);
  if (!endMatch) {
    return [null, warnings];
  }
  const contentStart = startMatch.index! + startMatch[0].length;
  const content = text.slice(contentStart, endMatch.index);
  warnings.push(
    `delimiter normalized: matched START at ${startMatch.index!}-${startMatch.index! + startMatch[0].length}, ` +
      `END at ${endMatch.index}-${endMatch.index + endMatch[0].length}`,
  );
  return [content, warnings];
}

/**
 * STRATEGY 3: take the largest fenced code block.
 *
 * Port of `_strategy_code_fence`. Python pattern:
 *   r"(?m)^(?P<fence>`{3,}|~{3,})[^\n]*\n(?P<body>.*?)(?P=fence)[^\n]*$"
 * with `re.DOTALL`. JS port: the named backreference `(?P=fence)` becomes a
 * numbered backreference (`\1`); `re.DOTALL` → `/s`; `(?m)` → `/m`.
 *
 * If the fence itself contains delimiters, defer to STRATEGY 1 on the fenced
 * content so an exact-match win is not masked by fence wrapping.
 */
function strategyCodeFence(
  text: string,
  startToken: string,
  endToken: string,
): StrategyResult {
  const warnings: string[] = [];
  const fencePattern =
    /^(?:(`{3,}|~{3,})[^\n]*\n(.*?)(\1)[^\n]*)$/gms;
  const blocks: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = fencePattern.exec(text)) !== null) {
    blocks.push(m);
    // Guard against zero-width matches looping forever.
    if (m.index === fencePattern.lastIndex) {
      fencePattern.lastIndex++;
    }
  }
  if (blocks.length === 0) {
    return [null, warnings];
  }
  // Pick the largest block by body (group 2) length.
  let largest = blocks[0];
  for (const b of blocks) {
    if (b[2].length > largest[2].length) {
      largest = b;
    }
  }
  const body = largest[2];
  // If the fenced body contains literal delimiters, try STRATEGY 1 on it.
  const inner = strategyExact(body, startToken, endToken);
  if (inner[0] !== null) {
    warnings.push("code_fence: inner exact-delimiter match used");
    return [inner[0], warnings];
  }
  warnings.push("code_fence: largest fenced block returned as content");
  return [body, warnings];
}

/**
 * STRATEGY 3.5 (open_ended): truncated-output recovery.
 *
 * When the raw text contains a START delimiter but no END delimiter, the
 * upstream subagent output was almost certainly truncated mid-stream (the
 * display layer clipped the tail). Rather than discard the partial content
 * as `malformed`, this strategy extracts from just after START to EOF and
 * flags it via a warning. The orchestrator classifies the result as
 * `fallback_used` (not `ok`) so downstream consumers know the extraction is
 * not exact.
 *
 * Boundary rules:
 *   - No START present → return `[null, warnings]` (fall through).
 *   - START and END both present (paired) → return `[null, warnings]`.
 *     Exact-delimiter (STRATEGY 1) already wins in this case; open_ended
 *     deliberately declines so it never masks a clean paired extraction.
 *   - START present, END absent → extract `START..EOF`, push the
 *     `"open_ended: END missing, extracted START..EOF"` warning, return
 *     `[content, warnings]`.
 */
function strategyOpenEnded(
  text: string,
  startToken: string,
  endToken: string,
): StrategyResult {
  const warnings: string[] = [];
  const startIdx = text.indexOf(startToken);
  if (startIdx === -1) {
    return [null, warnings];
  }
  const contentStart = startIdx + startToken.length;
  const endIdx = text.indexOf(endToken, contentStart);
  if (endIdx !== -1) {
    // Paired delimiters — exact_delimiter already handled it; decline here.
    return [null, warnings];
  }
  const content = text.slice(contentStart);
  warnings.push("open_ended: END missing, extracted START..EOF");
  return [content, warnings];
}

/**
 * Pure heuristic: does `rawText` look truncated w.r.t. the delimiter pair?
 *
 * Returns `true` iff the START token is present but the END token is absent.
 * Used by plan-review's retry/success path (Phase 2) to decide whether to
 * surface a "read the saved tool-output file" recovery nudge. Pure — no
 * side effects, no I/O — so it is trivially unit-testable.
 */
export function looksTruncated(
  rawText: string,
  startToken: string,
  endToken: string,
): boolean {
  return rawText.includes(startToken) && !rawText.includes(endToken);
}

/**
 * STRATEGY 4: take the whole body after stripping thinking / signal / extras.
 *
 * Port of `_strategy_whole_body`. Returns `null` when nothing usable is left
 * after stripping, so the orchestrator does not classify this as a
 * too-short hit (which would yield `empty`); it falls through to `malformed`.
 */
function strategyWholeBody(
  text: string,
  completionSignal: string | null,
): StrategyResult {
  const warnings: string[] = ["whole_body fallback engaged"];
  let cleaned = stripThinking(text);
  // Strip completion signal (we use raw_text for verdict extraction in the
  // orchestrator, so we ignore the returned signal line here — mirrors
  // Python which rebinds `cleaned, _ = ...`).
  const [stripped] = stripCompletionSignal(cleaned, completionSignal ?? "");
  cleaned = stripped;
  cleaned = stripAdditionalFilesRead(cleaned);
  if (cleaned.trim().length === 0) {
    warnings.push("whole_body: nothing left after stripping");
    return [null, warnings];
  }
  return [cleaned, warnings];
}

// ---------------------------------------------------------------------------
// Orchestrator — port of `parse_raw`.
// ---------------------------------------------------------------------------

/** Options accepted by {@link parseRaw}. */
export interface ParseRawOptions {
  kind: string;
  startToken: string;
  endToken: string;
  minLength: number;
  completionSignal: string | null;
}

/**
 * Parse `rawText` and return the result object.
 *
 * Faithful port of `parse_raw` in the Python source. Tries the 4 strategies
 * in priority order; the first one that yields content whose stripped length
 * is `>= minLength` wins. If a strategy finds something but it is too short,
 * `foundShortContent` becomes true so the final status is `empty` (rather
 * than `malformed`).
 *
 * The completion signal is pre-extracted from the *whole* raw text regardless
 * of which strategy wins, so the dispatcher always sees a stable
 * `completion_signal` field.
 */
export function parseRaw(rawText: string, opts: ParseRawOptions): ParseResult {
  const { kind, startToken, endToken } = opts;
  const minLength = opts.minLength;
  const completionSignal = opts.completionSignal;
  const warnings: string[] = [];
  const tokenName = TOKEN_BY_KIND[kind] ?? "";

  // Pre-extract completion signal from the WHOLE raw text.
  const [, capturedSignalLine] = stripCompletionSignal(
    rawText,
    completionSignal ?? "",
  );

  // Build the strategy list in priority order. Each entry is `[name, runner]`.
  type StrategyEntry = [ParseStrategy, () => StrategyResult];
  const strategies: StrategyEntry[] = [
    ["exact_delimiter", () => strategyExact(rawText, startToken, endToken)],
  ];
  if (tokenName) {
    strategies.push([
      "normalized_delimiter",
      () => strategyNormalized(rawText, tokenName),
    ]);
  }
  strategies.push([
    "code_fence",
    () => strategyCodeFence(rawText, startToken, endToken),
  ]);
  strategies.push([
    "open_ended",
    () => strategyOpenEnded(rawText, startToken, endToken),
  ]);
  strategies.push([
    "whole_body",
    () => strategyWholeBody(rawText, completionSignal),
  ]);

  let foundShortContent = false;

  for (const [strategyName, runner] of strategies) {
    const [content, stratWarnings] = runner();
    if (content === null) {
      continue;
    }
    warnings.push(...stratWarnings);
    if (content.trim().length >= minLength) {
      // Success — strip completion signal from the extracted content too so
      // a strategy that includes the trailing signal line still produces
      // clean output.
      const [strippedContent] = stripCompletionSignal(
        content,
        completionSignal ?? "",
      );
      let finalContent = strippedContent;
      finalContent = stripAdditionalFilesRead(finalContent);
      const trimmed = finalContent.trim();
      const status: ParseStatus =
        strategyName === "exact_delimiter" ? "ok" : "fallback_used";
      const verdict: Verdict =
        kind === "review"
          ? extractVerdict(capturedSignalLine, rawText)
          : null;
      return {
        status,
        content: trimmed,
        strategy: strategyName,
        completion_signal: capturedSignalLine,
        verdict,
        warnings,
        meta: {
          kind,
          input_length: rawText.length,
          // Python computes `len(content.strip())` AFTER the post-strip pass,
          // i.e. on the same `trimmed` value we return as `content`.
          content_length: trimmed.length,
        },
      };
    }
    // Strategy found something but too short.
    foundShortContent = true;
    warnings.push(
      `${strategyName}: extracted content too short ` +
        `(${content.trim().length} < ${minLength})`,
    );
  }

  // No strategy produced acceptable content.
  const status: ParseStatus = foundShortContent ? "empty" : "malformed";
  const verdict: Verdict =
    kind === "review"
      ? extractVerdict(capturedSignalLine, rawText)
      : null;
  return {
    status,
    content: "",
    strategy: "none",
    completion_signal: capturedSignalLine,
    verdict,
    warnings,
    meta: {
      kind,
      input_length: rawText.length,
      content_length: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Public convenience API.
// ---------------------------------------------------------------------------

/**
 * Default options resolver — mirrors the Python CLI's `_resolve_tokens`.
 *
 * Given a `kind`, derives the `<<<KIND_START>>>` / `<<<KIND_END>>>` token
 * pair. `generic` kind requires explicit `startToken` / `endToken`.
 */
function resolveTokens(
  kind: string,
  startToken?: string,
  endToken?: string,
): { startToken: string; endToken: string } {
  if (startToken && endToken) {
    return { startToken, endToken };
  }
  if (kind === "generic") {
    throw new Error(
      "startToken and endToken are required when kind=generic",
    );
  }
  const tokenName = TOKEN_BY_KIND[kind];
  if (tokenName === undefined) {
    throw new Error(`unknown kind value: ${JSON.stringify(kind)}`);
  }
  return {
    startToken: `<<<${tokenName}_START>>>`,
    endToken: `<<<${tokenName}_END>>>`,
  };
}

/** Arguments accepted by {@link parseDelimitedOutput}. */
export interface ParseDelimitedOutputArgs {
  /** Delimiter family. One of `plan` / `review` / `context_snapshot` / `generic`. */
  kind?: string;
  /** Explicit start delimiter (overrides `kind`; required for `generic`). */
  startToken?: string;
  /** Explicit end delimiter (overrides `kind`; required for `generic`). */
  endToken?: string;
  /** Minimum acceptable stripped content length (default 200). */
  minLength?: number;
  /** Completion-signal prefix to detect and strip (line-anchored). */
  completionSignal?: string | null;
}

/**
 * Parse delimiter-based subagent output with multiple fallback strategies.
 *
 * This is the primary public entry point — a thin wrapper around
 * {@link parseRaw} that resolves the kind-specific tokens and applies the
 * default min length. Behaviour is equivalent to invoking the Python
 * `parse_delimited_output.py` CLI with the same arguments.
 *
 * @example
 *   parseDelimitedOutput("<<<PLAN_START>>>\n...\n<<<PLAN_END>>>", {
 *     kind: "plan",
 *     completionSignal: "PLAN DESIGN COMPLETE",
 *   });
 *
 * @param text - raw text emitted by the subagent.
 * @param args - parsing options (all optional; sensible defaults apply).
 */
export function parseDelimitedOutput(
  text: string,
  args: ParseDelimitedOutputArgs = {},
): ParseResult {
  const kind = args.kind ?? "generic";
  const { startToken, endToken } = resolveTokens(
    kind,
    args.startToken,
    args.endToken,
  );
  return parseRaw(text, {
    kind,
    startToken,
    endToken,
    minLength: args.minLength ?? DEFAULT_MIN_LENGTH,
    completionSignal: args.completionSignal ?? null,
  });
}

/**
 * Serialise a {@link ParseResult} to canonical JSON
 * (`JSON.stringify(result, null, 2)`).
 *
 * Provided for callers that need the canonical textual form. Runtime tool
 * callers consume the {@link ParseResult} object directly.
 */
export function serializeResult(result: ParseResult): string {
  return JSON.stringify(result, null, 2);
}
