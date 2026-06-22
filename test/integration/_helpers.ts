// Shared helpers for the s3-feat-010 integration test suite.
//
// These tests exercise the plan dispatcher, the codegraph runtime probe, and
// the R3 config-sync flow end-to-end against a temp project dir. To keep each
// test file focused on its own assertions, the common scaffolding — temp dir
// creation, mock ToolContext construction, delimited-output blob fixtures —
// lives here.
//
// Temp-dir policy matches test/config.test.ts: Bun 1.3.11 has no
// `Bun.mkdtemp`, so we lean on Node's `fs.mkdtemp` under `os.tmpdir()` and
// `realpathSync` the result (dodges the macOS `/tmp` → `/private/tmp` symlink
// surprise that would otherwise confuse path assertions).

import { mkdtemp } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Repo root — where `shared/agents/*.md.template` + `shared/ghs.default.json` live. */
export const REPO_ROOT = join(import.meta.dir, "..", "..");

/**
 * Create a fresh temp directory under the OS temp dir. Returns the absolute
 * path with symlinks resolved (matches Python's `Path.resolve()` + Node's
 * `realpathSync` convention).
 */
export async function makeTempDir(prefix = "ghs-int-"): Promise<string> {
  const raw = await mkdtemp(join(tmpdir(), prefix));
  return realpathSync(raw);
}

/**
 * Build a minimal mock ToolContext whose `worktree` / `directory` both point
 * at `projectDir`. Only those two fields are read by `resolveProjectDir` /
 * the ghs-* tools, so the stub is intentionally small. The `as never` cast
 * matches the convention in test/plan-review.test.ts.
 */
export function mockToolContext(projectDir: string): never {
  return {
    sessionID: "integration-test-session",
    messageID: "integration-test-message",
    agent: "integration-test-agent",
    directory: projectDir,
    worktree: projectDir,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  } as never;
}

// -----------------------------------------------------------------------------
// Delimited-output blob fixtures
// -----------------------------------------------------------------------------
//
// The plan dispatcher consumes subagent responses that wrap their structured
// payload in delimiter tokens (s3-feat-003 / s3-feat-005). The bodies here
// are padded past DEFAULT_MIN_LENGTH (200) so the parser classifies them as
// `ok` rather than `empty`. Each blob mirrors the exact delimiter family
// parse.ts expects for that subagent kind.

/** Pad a short body past the parser's DEFAULT_MIN_LENGTH so it clears `ok`. */
export function longBody(prefix: string, minLen = 200): string {
  return prefix + "\n" + "x".repeat(minLen + 40);
}

/** A valid context-snapshot blob (ghs-context-haiku output family). */
export function snapshotBlob(body: string): string {
  return `<<<CONTEXT_SNAPSHOT_START>>>\n${body}\n<<<CONTEXT_SNAPSHOT_END>>>`;
}

/** A valid plan blob (ghs-plan-designer output family). */
export function planBlob(body: string): string {
  return `<<<PLAN_START>>>\n${body}\n<<<PLAN_END>>>`;
}

/** A valid review blob (ghs-plan-reviewer output family) with the given verdict. */
export function reviewBlob(body: string, verdict: "PASS" | "FAIL"): string {
  return (
    `<<<REVIEW_START>>>\n${body}\n<<<REVIEW_END>>>\n` +
    `PLAN REVIEW COMPLETE | Verdict: ${verdict} | Severe: 0 Medium: 0 Optimization: 1`
  );
}
