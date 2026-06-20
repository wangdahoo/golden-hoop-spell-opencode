// Unit tests for src/lib/project.ts resolveProjectDir(ctx) (Feature s5-feat-002).
//
// resolveProjectDir(ctx) resolves the active project directory from an OpenCode
// tool context:
//   - returns ctx.worktree when non-empty (stable across agent working dirs)
//   - falls back to ctx.directory when ctx.worktree is empty
//
// NOTE: this tests the ctx *helper* in src/lib/project.ts, not the
// walk-up-directory script port in src/lib/scripts/resolve-project-dir.ts
// (that one is covered by test/equivalence/resolve.test.ts). The two are
// distinct — plan §6 explicitly calls out this helper test as a separate gap.
//
// Style follows test/parallel-utils.test.ts (s4-feat-002): bun:test
// describe/test/expect, hand-rolled stub objects, no real `.ghs/` dependency.
// The mock ctx uses the small `{ worktree, directory }` stub with `as never`
// cast, matching the mockToolContext convention in test/integration/_helpers.ts.

import { expect, test, describe } from "bun:test";
import type { ToolContext } from "@opencode-ai/plugin/tool";

import { resolveProjectDir } from "../src/lib/project";

/**
 * Build a minimal mock ToolContext with just the two fields resolveProjectDir
 * reads (`worktree` + `directory`). The `as never` cast matches the
 * mockToolContext convention in test/integration/_helpers.ts.
 */
function mockCtx(worktree: string, directory: string): ToolContext {
  return { worktree, directory } as never;
}

// =============================================================================
// resolveProjectDir — worktree-preference
// =============================================================================

describe("resolveProjectDir - worktree preferred (s5-feat-002)", () => {
  test("(a) worktree non-empty -> returns worktree even when directory differs", () => {
    const ctx = mockCtx("/proj/worktree", "/proj/worktree/src/sub");
    expect(resolveProjectDir(ctx)).toBe("/proj/worktree");
  });

  test("(b) worktree non-empty -> returns worktree when directory equals worktree", () => {
    const ctx = mockCtx("/proj", "/proj");
    expect(resolveProjectDir(ctx)).toBe("/proj");
  });

  test("(c) worktree preferred regardless of how deep the directory is", () => {
    // The agent may be operating in a nested subdir; writes must still land
    // at the stable worktree root.
    const ctx = mockCtx(
      "/proj/root",
      "/proj/root/packages/foo/src/deep/nested",
    );
    expect(resolveProjectDir(ctx)).toBe("/proj/root");
  });
});

// =============================================================================
// resolveProjectDir — directory fallback
// =============================================================================

describe("resolveProjectDir - directory fallback (s5-feat-002)", () => {
  test("(d) worktree empty string -> falls back to directory", () => {
    const ctx = mockCtx("", "/proj/session/dir");
    expect(resolveProjectDir(ctx)).toBe("/proj/session/dir");
  });

  test("(e) both empty -> returns empty string (no crash)", () => {
    // The helper is a pure || expression; with both empty it yields "". This
    // documents the behaviour so downstream callers know to guard the result.
    const ctx = mockCtx("", "");
    expect(resolveProjectDir(ctx)).toBe("");
  });

  test("(f) directory is respected when worktree is absent", () => {
    const ctx = mockCtx("", "/some/other/path");
    expect(resolveProjectDir(ctx)).toBe("/some/other/path");
  });
});

// =============================================================================
// resolveProjectDir — does not read other ctx fields
// =============================================================================

describe("resolveProjectDir - field isolation (s5-feat-002)", () => {
  test("(g) only worktree + directory are read; other fields can be absent", () => {
    // A stub with just the two fields must work — proves the helper doesn't
    // touch sessionID/agent/abort/etc.
    const minimal = { worktree: "/wt", directory: "/dir" } as never;
    expect(resolveProjectDir(minimal)).toBe("/wt");
  });
});

// =============================================================================
// src/lib/scripts/ coverage audit (acceptance_criteria #3)
// =============================================================================
//
// All 11 scripts under src/lib/scripts/ have smoke / unit test coverage. No
// genuine gap. Detail:
//
//   append-progress-session.ts    -> test/writer.test.ts (appendProgressSession suite)
//   append-sprint.ts              -> test/writer.test.ts (appendSprint suite)
//   archive-sprint.ts             -> test/equivalence/archive.test.ts
//   init-project.ts               -> test/equivalence/init.test.ts
//   parallel-utils.ts             -> test/parallel-utils.test.ts
//   parse-completion-signal.ts    -> test/equivalence/parse-completion-signal.test.ts
//                                    + test/parse.test.ts
//   parse-delimited-output.ts     -> test/equivalence/parse-delimited-output.test.ts
//                                    + test/parse.test.ts
//   resolve-project-dir.ts        -> test/equivalence/resolve.test.ts
//                                    (NOTE: this is the walk-up script port,
//                                     distinct from the ctx helper above)
//   status.ts                     -> test/equivalence/status.test.ts
//   update-feature-status.ts      -> test/writer.test.ts (updateFeatureStatus suite)
//   validate-structure.ts         -> test/equivalence/validate.test.ts
