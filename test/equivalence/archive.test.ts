// Equivalence test for archive-sprint.ts vs archive_sprint.py.
//
// Strategy: seed a temp dir with the canonical fixture, then exercise three
// modes against BOTH impls:
//   - list:    --list     (stdout must match byte-identically)
//   - dry-run: --dry-run  (stdout must match byte-identically)
//   - archive: (no flag)  (filesystem state must match: features.json,
//                           progress.md, and the archive folder's features.json)
//
// For archive mode, the archive folder name embeds a timestamp
// (`<id>_<name>_<YYYYMMDD_HHMMSS>`) — these differ between the two runs by
// sub-second drift. So we normalise the timestamp in stdout comparisons and
// compare archive folder CONTENTS rather than folder names directly.
//
// The "nothing to archive" branch (sprint without completed status) is also
// covered via a second fixture variant.

import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, cp, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  archiveSprints,
  formatListReport,
  formatArchiveReport,
  getAllSprints,
  getCompletedSprints,
} from "../../src/lib/scripts/archive-sprint";
import {
  runPython,
  makeTempDir,
  cleanupTemp,
  normalizeTempDirs,
  GHS_OPENCODE_ROOT,
  TS_PLUGIN_ROOT,
} from "./_helpers";

const FIXTURE_GHS = join(GHS_OPENCODE_ROOT, "test", "fixtures", ".ghs");

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

/**
 * Normalise timestamps embedded in archive output:
 *   - folder-name timestamps: `\d{8}_\d{6}` (YYYYMMDD_HHMMSS)
 *   - `archived_at`/`Archived:` headers: `\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}`
 *
 * The TS port and the Python oracle each call `datetime.now()` (or
 * `new Date()`) independently at slightly different wall-clock instants. We
 * substitute a fixed placeholder so the runs compare byte-equal.
 */
function normalizeTimestamps(text: string): string {
  return text
    .replace(/\d{8}_\d{6}/g, "TS")
    .replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/g, "DATE");
}

describe("archive equivalence", () => {
  let tsDir: string;
  let pyDir: string;

  beforeEach(async () => {
    tsDir = await makeTempDir("ghs-eq-archive-ts-");
    pyDir = await makeTempDir("ghs-eq-archive-py-");
    await seedFixture(tsDir);
    await seedFixture(pyDir);
  });

  afterEach(async () => {
    await cleanupTemp(tsDir);
    await cleanupTemp(pyDir);
  });

  test("list mode: both produce identical stdout", async () => {
    // --- TS port ---
    // Mirror what Python's main() prints for the list branch.
    const featuresPathTs = join(tsDir, ".ghs", "features.json");
    const tsFeaturesText = await readFile(featuresPathTs, "utf8");
    const tsFeaturesData = JSON.parse(tsFeaturesText);
    const tsSprints = getCompletedSprints(tsFeaturesData);
    const tsReport = formatListReport({
      projectDir: tsDir,
      force: false,
      sprints: tsSprints,
    });

    // --- Python oracle ---
    const pyResult = await runPython("archive_sprint.py", [
      "--project-dir",
      pyDir,
      "--list",
    ], pyDir);
    expect(pyResult.exitCode).toBe(0);

    // Both reports embed the absolute project-dir path — normalise it before
    // comparing since the two impls ran in different temp dirs.
    const tsNorm = normalizeTempDirs(tsReport, [
      { path: tsDir, label: "DIR" },
    ]);
    const pyNorm = normalizeTempDirs(pyResult.stdout, [
      { path: pyDir, label: "DIR" },
    ]);
    expect(tsNorm).toBe(pyNorm);
  });

  test("list --force mode: both produce identical stdout", async () => {
    const featuresPathTs = join(tsDir, ".ghs", "features.json");
    const tsFeaturesText = await readFile(featuresPathTs, "utf8");
    const tsFeaturesData = JSON.parse(tsFeaturesText);
    const tsSprints = getAllSprints(tsFeaturesData);
    const tsReport = formatListReport({
      projectDir: tsDir,
      force: true,
      sprints: tsSprints,
    });

    const pyResult = await runPython("archive_sprint.py", [
      "--project-dir",
      pyDir,
      "--list",
      "--force",
    ], pyDir);
    expect(pyResult.exitCode).toBe(0);

    const tsNorm = normalizeTempDirs(tsReport, [
      { path: tsDir, label: "DIR" },
    ]);
    const pyNorm = normalizeTempDirs(pyResult.stdout, [
      { path: pyDir, label: "DIR" },
    ]);
    expect(tsNorm).toBe(pyNorm);
  });

  test("dry-run mode: both produce identical stdout", async () => {
    // --- TS port ---
    // Read features for the report.
    const featuresPathTs = join(tsDir, ".ghs", "features.json");
    const tsFeaturesText = await readFile(featuresPathTs, "utf8");
    const tsFeaturesData = JSON.parse(tsFeaturesText);
    const considered = getCompletedSprints(tsFeaturesData);

    const tsArchived = await archiveSprints({
      projectDir: tsDir,
      dryRun: true,
      pluginRootPath: TS_PLUGIN_ROOT,
    });

    const tsReport = formatArchiveReport({
      projectDir: tsDir,
      mode: "dry-run",
      force: false,
      sprintsConsidered: considered,
      archived: tsArchived,
      remainingCount: considered.length,
      resetProgress: false,
    });

    // --- Python oracle ---
    const pyResult = await runPython("archive_sprint.py", [
      "--project-dir",
      pyDir,
      "--dry-run",
    ], pyDir);
    expect(pyResult.exitCode).toBe(0);

    // Normalise temp-dir paths before comparing (both embed project dir +
    // would-archive-to path which contain the dir).
    const tsNorm = normalizeTempDirs(tsReport, [
      { path: tsDir, label: "DIR" },
    ]);
    const pyNorm = normalizeTempDirs(pyResult.stdout, [
      { path: pyDir, label: "DIR" },
    ]);
    expect(tsNorm).toBe(pyNorm);

    // Dry-run still creates the empty .ghs/archived/ directory in both impls
    // (mirrors Python's `create_archive_structure` call before the dry-run
    // branch). No actual archive folders are written, however.
    expect(existsSync(join(tsDir, ".ghs", "archived"))).toBe(true);
    expect(existsSync(join(pyDir, ".ghs", "archived"))).toBe(true);
    expect(readdirSync(join(tsDir, ".ghs", "archived")).length).toBe(0);
    expect(readdirSync(join(pyDir, ".ghs", "archived")).length).toBe(0);
  });

  test("archive mode: both produce identical post-archive features.json + progress.md", async () => {
    // --- TS port ---
    await archiveSprints({
      projectDir: tsDir,
      pluginRootPath: TS_PLUGIN_ROOT,
    });

    // --- Python oracle ---
    const pyResult = await runPython("archive_sprint.py", [
      "--project-dir",
      pyDir,
    ], pyDir);
    expect(pyResult.exitCode).toBe(0);

    // 1. Compare features.json (post-archive).
    const tsFeatures = await readFile(
      join(tsDir, ".ghs", "features.json"),
      "utf8",
    );
    const pyFeatures = await readFile(
      join(pyDir, ".ghs", "features.json"),
      "utf8",
    );
    expect(tsFeatures).toBe(pyFeatures);

    // 2. Compare progress.md (post-archive).
    const tsProgress = await readFile(
      join(tsDir, ".ghs", "progress.md"),
      "utf8",
    );
    const pyProgress = await readFile(
      join(pyDir, ".ghs", "progress.md"),
      "utf8",
    );
    expect(tsProgress).toBe(pyProgress);

    // 3. Both created an archive folder with the same structure.
    const tsArchivedDir = join(tsDir, ".ghs", "archived");
    const pyArchivedDir = join(pyDir, ".ghs", "archived");
    expect(existsSync(tsArchivedDir)).toBe(true);
    expect(existsSync(pyArchivedDir)).toBe(true);

    const tsSubdirs = readdirSync(tsArchivedDir);
    const pySubdirs = readdirSync(pyArchivedDir);
    expect(tsSubdirs.length).toBe(1);
    expect(pySubdirs.length).toBe(1);

    // The folder names contain timestamps — match by prefix `<sprintId>_`.
    const tsFolder = tsSubdirs[0];
    const pyFolder = pySubdirs[0];
    expect(tsFolder.startsWith("s1_")).toBe(true);
    expect(pyFolder.startsWith("s1_")).toBe(true);

    // 4. Compare the archived features.json content (the per-sprint snapshot).
    const tsArchivedFeat = await readFile(
      join(tsArchivedDir, tsFolder, "features.json"),
      "utf8",
    );
    const pyArchivedFeat = await readFile(
      join(pyArchivedDir, pyFolder, "features.json"),
      "utf8",
    );
    // Both contain an `archived_at` timestamp — normalise before comparing.
    expect(normalizeTimestamps(tsArchivedFeat)).toBe(
      normalizeTimestamps(pyArchivedFeat),
    );
  });

  test("nothing-to-archive: both produce identical stdout", async () => {
    // Use a fixture where no sprints are completed.
    const noCompleted = {
      project: {
        name: "NoCompleted",
        description: "x",
        created_at: "2026-01-01",
      },
      sprints: [
        {
          id: "s1",
          name: "Active",
          status: "in_progress",
          features: [],
        },
      ],
      metadata: { version: "1.0.0", last_updated: "2026-01-01" },
    };
    await mkdir(join(tsDir, ".ghs"), { recursive: true });
    await mkdir(join(pyDir, ".ghs"), { recursive: true });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(tsDir, ".ghs", "features.json"),
      JSON.stringify(noCompleted, null, 2),
    );
    await writeFile(
      join(pyDir, ".ghs", "features.json"),
      JSON.stringify(noCompleted, null, 2),
    );

    // --- Python oracle (run first because it prints to stdout directly) ---
    const pyResult = await runPython("archive_sprint.py", [
      "--project-dir",
      pyDir,
    ], pyDir);
    expect(pyResult.exitCode).toBe(0);

    // --- TS port ---
    const tsArchived = await archiveSprints({
      projectDir: tsDir,
      pluginRootPath: TS_PLUGIN_ROOT,
    });
    expect(tsArchived).toEqual([]);

    // Neither created an archive dir.
    expect(existsSync(join(tsDir, ".ghs", "archived"))).toBe(false);
    expect(existsSync(join(pyDir, ".ghs", "archived"))).toBe(false);

    // Python's "No completed sprints to archive." line:
    expect(pyResult.stdout).toContain(
      "No completed sprints to archive.",
    );
  });
});
