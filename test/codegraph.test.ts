// Unit tests for `src/lib/codegraph.ts` (`detectCodegraph`).
//
// Implements Feature s3-feat-002. Covers every acceptance criterion:
//   - AC #1: exports `detectCodegraph(projectDir: string): boolean`
//   - AC #2: `.codegraph/` directory present → true; absent → false
//   - AC #3: empty / invalid projectDir → false (defensive, no throw)
//   - AC #4: pure probe — no side effects (verifiable by absence of MCP
//     process spawn; here we assert the return contract only)
//
// Temp-dir policy: uses Node's `fs.promises.mkdtemp` under `os.tmpdir()`
// and `realpathSync` the result (matches test/config.test.ts convention,
// avoids macOS `/tmp` → `/private/tmp` symlink surprises). No test touches
// the real project `.codegraph/` directory.

import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectCodegraph } from "../src/lib/codegraph";

describe("detectCodegraph", () => {
  let tempRoot: string;

  beforeEach(async () => {
    // mkdtemp gives a unique, empty dir per test — full isolation.
    tempRoot = realpathSync(await mkdtemp(join(tmpdir(), "ghs-cg-")));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("returns false when .codegraph/ does not exist", () => {
    // Fresh tempRoot has no .codegraph/ — should report unavailable.
    expect(detectCodegraph(tempRoot)).toBe(false);
  });

  test("returns true when .codegraph/ directory exists", async () => {
    await mkdir(join(tempRoot, ".codegraph"));
    expect(detectCodegraph(tempRoot)).toBe(true);
  });

  test("returns true for a non-empty .codegraph/ directory", async () => {
    // A populated index dir (realistic shape) still counts as available.
    await mkdir(join(tempRoot, ".codegraph"), { recursive: true });
    await writeFile(join(tempRoot, ".codegraph", "graph.db"), "stub");
    expect(detectCodegraph(tempRoot)).toBe(true);
  });

  test("returns false when .codegraph exists but is a file, not a directory", async () => {
    // A stray file named `.codegraph` must NOT count as initialised.
    await writeFile(join(tempRoot, ".codegraph"), "not a dir");
    expect(detectCodegraph(tempRoot)).toBe(false);
  });

  test("returns false for empty string projectDir (defensive, no throw)", () => {
    expect(() => detectCodegraph("")).not.toThrow();
    expect(detectCodegraph("")).toBe(false);
  });

  test("returns false for whitespace-only projectDir (defensive, no throw)", () => {
    expect(() => detectCodegraph("   ")).not.toThrow();
    expect(() => detectCodegraph("\t\n")).not.toThrow();
    expect(detectCodegraph("   ")).toBe(false);
  });

  test("returns false for a non-existent projectDir path (no throw)", () => {
    const ghost = join(tempRoot, "does", "not", "exist");
    expect(() => detectCodegraph(ghost)).not.toThrow();
    expect(detectCodegraph(ghost)).toBe(false);
  });

  test("respects the <projectDir>/.codegraph location when nested", async () => {
    // A nested working dir should NOT trigger detection unless its own
    // .codegraph/ exists — the probe is anchored to projectDir verbatim.
    const nested = join(tempRoot, "subproject");
    await mkdir(nested, { recursive: true });
    // Parent has .codegraph, nested does not.
    await mkdir(join(tempRoot, ".codegraph"));
    expect(detectCodegraph(nested)).toBe(false);
    expect(detectCodegraph(tempRoot)).toBe(true);
  });

  test("accepts a relative projectDir (resolves against cwd)", async () => {
    // detectCodegraph should not require an absolute path. We chdir into
    // the temp root via process.chdir and pass "." — the probe must still
    // find the .codegraph/ dir created there.
    const previousCwd = process.cwd();
    try {
      process.chdir(tempRoot);
      await mkdir(join(tempRoot, ".codegraph"));
      // Pass a relative path; resolve() inside the impl anchors to cwd.
      expect(detectCodegraph(".")).toBe(true);
    } finally {
      process.chdir(previousCwd);
    }
  });
});
