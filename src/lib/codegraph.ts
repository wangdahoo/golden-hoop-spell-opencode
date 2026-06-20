// Runtime probe for the codegraph MCP integration.
//
// codegraph (R1) is an *optional* knowledge-graph backend. The host project
// opts in by running the codegraph MCP server, which materialises a
// `.codegraph/` directory at the project root. The plan dispatcher's
// `ghs-plan-start` tool calls `detectCodegraph()` to decide which Context
// Subagent prompt to use:
//
//   - `.codegraph/` present → `context-codegraph` prompt (graph-aware).
//   - `.codegraph/` absent  → `context-grep` prompt (grep fallback).
//
// This function is intentionally a *pure* probe: it inspects the filesystem
// and returns a boolean. It does NOT start the MCP server — that is declared
// statically in `opencode.json` (`mcp.codegraph`) and loaded by the OpenCode
// core once at startup (plan §3.4 D3, §3.5). Running-time availability is a
// separate concern (the dispatcher additionally asks the main AI to issue a
// `codegraph_status` call); here we only answer "was codegraph ever
// initialised for this project?".
//
// Style follows s1-feat-008's `resolve-project-dir.ts` / `paths.ts`: no
// `process.exit`, no `console.log`, defensive on bad input.

import { statSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Probe whether the codegraph backend is available for a project.
 *
 * Returns `true` iff `<projectDir>/.codegraph/` exists and is a directory.
 *
 * Defensive contract (AC #3): any failure mode returns `false` rather than
 * throwing:
 *   - empty / whitespace-only `projectDir`
 *   - non-string input (coerced via the string guard)
 *   - path that does not exist
 *   - path that exists but is a file (not a directory)
 *   - any underlying `statSync` error (permissions, broken symlink, EIO, …)
 *
 * The probe specifically checks for a *directory* — a stray `.codegraph`
 * file does not count as "codegraph initialised".
 *
 * @param projectDir - absolute or relative path to the host project root.
 * @returns `true` when the codegraph directory is present, `false` otherwise.
 */
export function detectCodegraph(projectDir: string): boolean {
  // Guard against empty / non-string input. A missing or blank projectDir
  // means we have nothing meaningful to probe — report "not available" and
  // let the dispatcher fall back to the grep path rather than crash.
  if (typeof projectDir !== "string" || projectDir.trim().length === 0) {
    return false;
  }

  // `resolve` normalises relative paths against process.cwd() and collapses
  // `.`/`..` segments. We resolve defensively inside try/catch because
  // `resolve` itself is pure but the subsequent `statSync` touches the FS.
  try {
    const codegraphPath = resolve(projectDir, ".codegraph");
    const stats = statSync(codegraphPath);
    return stats.isDirectory();
  } catch {
    // Any stat failure — ENOENT (missing), ENOTDIR (a parent is a file),
    // EACCES (permissions), or a dangling symlink — means codegraph is not
    // usable. Suppress and report `false` per the defensive contract.
    return false;
  }
}
