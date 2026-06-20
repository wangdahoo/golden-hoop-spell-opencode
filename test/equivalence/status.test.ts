// Equivalence test for status.ts vs status.py.
//
// Strategy: seed a temp dir with the canonical fixture (.ghs/features.json +
// .ghs/progress.md), then run BOTH status implementations and compare stdout
// byte-for-byte.
//
// The TS port exposes `formatStatus(options)` that returns the same text the
// Python script prints. We assert the strings match exactly.
//
// Edge cases covered:
//   - normal fixture (sprint with features in various states + progress.md)
//   - missing features.json (Python prints error + exits 1)
//   - empty sprints array (early return after "No sprints defined yet")

import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, rm, cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { formatStatus, status } from "../../src/lib/scripts/status";
import {
  runPython,
  makeTempDir,
  cleanupTemp,
  GHS_OPENCODE_ROOT,
} from "./_helpers";

const FIXTURE_GHS = join(GHS_OPENCODE_ROOT, "test", "fixtures", ".ghs");

/** Seed a temp dir with the canonical fixture by copying test/fixtures/.ghs. */
async function seedFixture(destDir: string): Promise<void> {
  await mkdir(join(destDir, ".ghs"), { recursive: true });
  await cp(
    join(FIXTURE_GHS, "features.json"),
    join(destDir, ".ghs", "features.json"),
  );
  await cp(
    join(FIXTURE_GHS, "progress.md"),
    join(destDir, ".ghs", "progress.md"),
  );
}

describe("status equivalence", () => {
  let tsDir: string;
  let pyDir: string;

  beforeEach(async () => {
    tsDir = await makeTempDir("ghs-eq-status-ts-");
    pyDir = await makeTempDir("ghs-eq-status-py-");
    await seedFixture(tsDir);
    await seedFixture(pyDir);
  });

  afterEach(async () => {
    await cleanupTemp(tsDir);
    await cleanupTemp(pyDir);
  });

  test("both produce identical status output for the canonical fixture", async () => {
    const tsText = await formatStatus({ projectDir: tsDir });

    const pyResult = await runPython("status.py", [
      "--project-dir",
      pyDir,
    ], pyDir);
    expect(pyResult.exitCode).toBe(0);

    expect(tsText).toBe(pyResult.stdout);
  });

  test("both report missing features.json with identical text", async () => {
    // Remove features.json from both dirs
    await rm(join(tsDir, ".ghs", "features.json"));
    await rm(join(pyDir, ".ghs", "features.json"));

    const tsResult = await status({ projectDir: tsDir });
    expect(tsResult.exitCode).toBe(1);

    const pyResult = await runPython("status.py", [
      "--project-dir",
      pyDir,
    ], pyDir, true);
    expect(pyResult.exitCode).toBe(1);

    expect(tsResult.text).toBe(pyResult.stdout);
  });

  test("both early-return when no sprints defined", async () => {
    // Overwrite features.json with an empty sprints array.
    const emptyData = {
      project: {
        name: "Empty",
        description: "no sprints",
        created_at: "2026-01-01",
      },
      sprints: [],
      metadata: { version: "1.0.0", last_updated: "2026-01-01" },
    };
    await writeFile(
      join(tsDir, ".ghs", "features.json"),
      JSON.stringify(emptyData, null, 2),
    );
    await writeFile(
      join(pyDir, ".ghs", "features.json"),
      JSON.stringify(emptyData, null, 2),
    );

    const tsText = await formatStatus({ projectDir: tsDir });
    const pyResult = await runPython("status.py", [
      "--project-dir",
      pyDir,
    ], pyDir);
    expect(pyResult.exitCode).toBe(0);

    expect(tsText).toBe(pyResult.stdout);
  });
});

// Suppress unused-import warning.
void existsSync;
void readFile;
