// Prose-contract regression test (Feature s1-feat-006, plan §8 / Opt #1).
//
// Programmatic assertion that PROSE_FILES — the files that produce LLM-facing
// prose instructions — contain NO bare (non-prefixed) references to the three
// tool-name stems registered in sprint s1:
//   - parse-completion-signal
//   - update-feature-status
//   - append-feature
//
// Every prose reference must carry the `ghs-` prefix (e.g. `ghs-parse-
// completion-signal`). A bare reference is a "dead" instruction that commands
// the main AI to call a tool by a name that doesn't exist as a registered tool
// key — the root cause this sprint fixes.
//
// Why a programmatic test instead of a grep pipe (Opt #1):
//   - grep produces false positives (matches file names, import paths,
//     comment lines). This test excludes comments and imports precisely.
//   - grep is shell-specific; this test runs cross-platform under `bun test`.
//   - A failing test is self-documenting (reports exact file:line:content),
//     whereas a grep pipeline's empty/non-empty output requires interpretation.
//
// Scope: PROSE_FILES are limited to files that EMIT prose instructions consumed
// by the main AI (code.ts / sprint.ts dispatch text + feature-impl.ts /
// sprint-planning.ts prompt templates). Pure-function files under
// `src/lib/scripts/*.ts` are NOT included — their file names / imports
// legitimately contain the stems without the `ghs-` prefix, and they produce
// no prose instructions.

import { expect, test, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const projectRoot = join(import.meta.dir, "..");

/** Files that emit LLM-facing prose instructions (plan §10 PROSE_FILES). */
const PROSE_FILES = [
  "src/tools/code.ts",
  "src/tools/sprint.ts",
  "src/prompts/feature-impl.ts",
  "src/prompts/sprint-planning.ts",
] as const;

/** Tool-name stems that must always be `ghs-`-prefixed in prose. */
const TOOL_STEMS = [
  "parse-completion-signal",
  "update-feature-status",
  "append-feature",
] as const;

/**
 * Whether a trimmed line is a comment (starts with `//` for line comments or
 * `*` for JSDoc/block-comment continuation lines).
 */
function isCommentLine(trimmed: string): boolean {
  return trimmed.startsWith("//") || trimmed.startsWith("*");
}

/**
 * Whether a line is an import / re-export statement. These legitimately
 * reference module paths (e.g. `from "../lib/scripts/parse-completion-signal.ts"`)
 * that contain the stem without the `ghs-` prefix.
 */
function isImportLine(line: string): boolean {
  return line.includes('from "') || line.includes("import ");
}

/**
 * Whether a line contains a BARE (non-prefixed) reference to `stem`.
 *
 * Strategy: remove every `ghs-<stem>` occurrence from the line, then check
 * whether the bare stem still appears. If it does, at least one occurrence
 * was not properly prefixed → violation.
 *
 * This correctly handles mixed lines (e.g. "call ghs-parse-completion-signal,
 * not bare parse-completion-signal") — the prefixed occurrence is stripped,
 * leaving the bare one to trigger the violation.
 */
function hasBareReference(line: string, stem: string): boolean {
  const stripped = line.split(`ghs-${stem}`).join("");
  return stripped.includes(stem);
}

describe("prose-contract (s1-feat-006)", () => {
  test("PROSE_FILES contain no bare tool-name stem references", () => {
    const violations: string[] = [];

    for (const relPath of PROSE_FILES) {
      const absPath = join(projectRoot, relPath);
      const content = readFileSync(absPath, "utf-8");
      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        if (isCommentLine(trimmed)) continue;
        if (isImportLine(line)) continue;

        for (const stem of TOOL_STEMS) {
          if (hasBareReference(line, stem)) {
            violations.push(
              `${relPath}:${i + 1}: bare '${stem}' in: ${trimmed}`,
            );
          }
        }
      }
    }

    // Empty violations array === all prose references are properly prefixed.
    expect(violations).toEqual([]);
  });
});
