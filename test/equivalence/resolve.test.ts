// Equivalence test for resolve-project-dir.ts vs resolve_project_dir.py.
//
// Strategy: seed a temp dir with `.ghs/{features.json,progress.md}`, then
// invoke BOTH from a nested subdirectory and assert both return the same
// absolute path string.
//
// Both implementations walk up from the start dir looking for a `.ghs/`
// containing a marker file. The Python source uses Path.resolve() which
// follows symlinks — so we compare resolved (post-symlink) paths.
//
// Negative case: when no .ghs/ exists in any ancestor, both should report
// failure (Python exits 1 + stderr message; TS throws ProjectDirNotFoundError).

import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  resolveProjectDir,
  ProjectDirNotFoundError,
} from "../../src/lib/scripts/resolve-project-dir";
import {
  runPython,
  makeTempDir,
  cleanupTemp,
} from "./_helpers";

describe("resolve equivalence", () => {
  let projDir: string;
  let nestedDir: string;

  beforeEach(async () => {
    projDir = await makeTempDir("ghs-eq-resolve-proj-");
    // Seed .ghs/ with marker files.
    await mkdir(join(projDir, ".ghs"), { recursive: true });
    await writeFile(
      join(projDir, ".ghs", "features.json"),
      '{"project": {}}',
    );
    await writeFile(
      join(projDir, ".ghs", "progress.md"),
      "# progress\n",
    );
    // Create a deeply nested subdir to start the walk from.
    nestedDir = join(projDir, "a", "b", "c");
    await mkdir(nestedDir, { recursive: true });
  });

  afterEach(async () => {
    await cleanupTemp(projDir);
  });

  test("both resolve the same project dir from a nested subdir", async () => {
    // --- TS port ---
    const tsResult = resolveProjectDir(nestedDir);

    // --- Python oracle ---
    const pyResult = await runPython("resolve_project_dir.py", [
      "--start-dir",
      nestedDir,
    ], nestedDir);
    expect(pyResult.exitCode).toBe(0);
    // Python prints the resolved path with a trailing newline.
    const pyPath = pyResult.stdout.trimEnd();

    expect(tsResult).toBe(pyPath);
  });

  test("both resolve the project dir when start dir IS the project dir", async () => {
    const tsResult = resolveProjectDir(projDir);
    const pyResult = await runPython("resolve_project_dir.py", [
      "--start-dir",
      projDir,
    ], projDir);
    expect(pyResult.exitCode).toBe(0);
    expect(tsResult).toBe(pyResult.stdout.trimEnd());
  });

  test("both fail when no .ghs/ exists in any ancestor", async () => {
    const orphanDir = await makeTempDir("ghs-eq-resolve-orphan-");
    try {
      // TS port: throws ProjectDirNotFoundError
      expect(() => resolveProjectDir(orphanDir)).toThrow(
        ProjectDirNotFoundError,
      );

      // Python oracle: exits 1 with stderr message
      const pyResult = await runPython("resolve_project_dir.py", [
        "--start-dir",
        orphanDir,
      ], orphanDir, true);
      expect(pyResult.exitCode).toBe(1);
      expect(pyResult.stderr).toContain("No project directory found");
    } finally {
      await cleanupTemp(orphanDir);
    }
  });

  test("both detect project via .ghs/progress.md only (no features.json)", async () => {
    const proj2 = await makeTempDir("ghs-eq-resolve-progress-only-");
    try {
      await mkdir(join(proj2, ".ghs"), { recursive: true });
      await writeFile(join(proj2, ".ghs", "progress.md"), "# p\n");
      const nested = join(proj2, "sub");
      await mkdir(nested, { recursive: true });

      const tsResult = resolveProjectDir(nested);
      const pyResult = await runPython("resolve_project_dir.py", [
        "--start-dir",
        nested,
      ], nested);
      expect(pyResult.exitCode).toBe(0);
      expect(tsResult).toBe(pyResult.stdout.trimEnd());
    } finally {
      await cleanupTemp(proj2);
    }
  });
});
