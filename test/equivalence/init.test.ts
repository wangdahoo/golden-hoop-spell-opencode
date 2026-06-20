// Equivalence test for init-project.ts vs init_project.py.
//
// Strategy: run BOTH into a fresh temp dir with identical args, then assert
// byte-identical output for the three artifacts written:
//   - .ghs/features.json
//   - .ghs/progress.md
//   - .gitignore
//
// The TS port is invoked as a library function (no CLI layer); the Python
// source is invoked as a subprocess. Both write to their own temp dir to
// avoid any cross-contamination.
//
// Known equivalence concern: Python's `json.dump(obj, f, indent=2)` default
// uses `ensure_ascii=True`. Our fixture template + the substituted values are
// pure ASCII so the byte stream matches JSON.stringify(obj, null, 2).

import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { initProject } from "../../src/lib/scripts/init-project";
import {
  runPython,
  makeTempDir,
  cleanupTemp,
  TS_PLUGIN_ROOT,
} from "./_helpers";

describe("init equivalence", () => {
  let tsDir: string;
  let pyDir: string;

  beforeEach(async () => {
    tsDir = await makeTempDir("ghs-eq-init-ts-");
    pyDir = await makeTempDir("ghs-eq-init-py-");
  });

  afterEach(async () => {
    await cleanupTemp(tsDir);
    await cleanupTemp(pyDir);
  });

  test("init creates byte-identical features.json + progress.md + .gitignore", async () => {
    const projectName = "EquivalenceFixture";
    const description = "Equivalence test project";

    // --- TS port ---
    const tsResult = await initProject({
      projectName,
      description,
      projectDir: tsDir,
      pluginRootPath: TS_PLUGIN_ROOT,
    });
    expect(existsSync(tsResult.featuresFile)).toBe(true);

    // --- Python oracle ---
    const pyResult = await runPython("init_project.py", [
      projectName,
      "--description",
      description,
      "--project-dir",
      pyDir,
    ], pyDir);
    expect(pyResult.exitCode).toBe(0);

    // Compare features.json
    const tsFeatures = await readFile(
      join(tsDir, ".ghs", "features.json"),
      "utf8",
    );
    const pyFeatures = await readFile(
      join(pyDir, ".ghs", "features.json"),
      "utf8",
    );
    expect(tsFeatures).toBe(pyFeatures);

    // Compare progress.md (template copy — must be identical)
    const tsProgress = await readFile(
      join(tsDir, ".ghs", "progress.md"),
      "utf8",
    );
    const pyProgress = await readFile(
      join(pyDir, ".ghs", "progress.md"),
      "utf8",
    );
    expect(tsProgress).toBe(pyProgress);

    // Compare .gitignore
    const tsGitignore = await readFile(join(tsDir, ".gitignore"), "utf8");
    const pyGitignore = await readFile(join(pyDir, ".gitignore"), "utf8");
    expect(tsGitignore).toBe(pyGitignore);
  });

  test("init without --description uses default description in both impls", async () => {
    const projectName = "MinimalProject";

    const tsResult = await initProject({
      projectName,
      projectDir: tsDir,
      pluginRootPath: TS_PLUGIN_ROOT,
    });
    expect(existsSync(tsResult.featuresFile)).toBe(true);

    const pyResult = await runPython("init_project.py", [
      projectName,
      "--project-dir",
      pyDir,
    ], pyDir);
    expect(pyResult.exitCode).toBe(0);

    const tsFeatures = await readFile(
      join(tsDir, ".ghs", "features.json"),
      "utf8",
    );
    const pyFeatures = await readFile(
      join(pyDir, ".ghs", "features.json"),
      "utf8",
    );
    expect(tsFeatures).toBe(pyFeatures);
  });

  test("init refuses to overwrite existing files without --force in both impls", async () => {
    // Seed both dirs with an existing features.json
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(join(tsDir, ".ghs"), { recursive: true });
    await mkdir(join(pyDir, ".ghs"), { recursive: true });
    await writeFile(
      join(tsDir, ".ghs", "features.json"),
      '{"existing": true}',
    );
    await writeFile(
      join(pyDir, ".ghs", "features.json"),
      '{"existing": true}',
    );

    // TS port: should throw InitFilesExistError
    let tsError: unknown;
    try {
      await initProject({
        projectName: "ShouldFail",
        projectDir: tsDir,
        pluginRootPath: TS_PLUGIN_ROOT,
      });
    } catch (e) {
      tsError = e;
    }
    expect(tsError).toBeInstanceOf(Error);
    expect(String((tsError as Error).message)).toContain(
      "already exist",
    );

    // Python oracle: should exit 1 and print the same error text
    const pyResult = await runPython("init_project.py", [
      "ShouldFail",
      "--project-dir",
      pyDir,
    ], pyDir, true);
    expect(pyResult.exitCode).toBe(1);
    expect(pyResult.stdout).toContain("already exist");
    expect(pyResult.stdout).toContain("Use --force to overwrite");
  });
});
