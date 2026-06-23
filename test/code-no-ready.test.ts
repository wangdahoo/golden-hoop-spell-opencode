// Snapshot test for the `ready.length === 0` short-circuit branch
// (Feature s1-feat-003 / plan §3.4, Medium #3 / Opt #4).
//
// The loop instruction in NEXT_ACTION_CODE and the three dispatch functions
// references the exact terminal banner `'=== ghs-code: no ready features ==='`.
// This test pins that banner's exact first line so a future refactor cannot
// silently change it (which would break the main AI's loop-termination
// detection without any test catching it).
//
// Two scenarios:
//   - 情况 A (skipped 为空): every feature completed → sprint done.
//   - 情况 B (skipped 非空): features exist but none ready (unmet deps).
//
// Style follows test/integration/code-dispatch.test.ts (temp-dir + seed +
// mockToolContext).

import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { codeTool } from "../src/tools/code";
import { makeTempDir, mockToolContext } from "./integration/_helpers";

interface FixtureFeature {
  id: string;
  title: string;
  status: string;
  dependencies?: string[];
  files_affected?: string[];
  acceptance_criteria?: string[];
}
interface FixtureSprint {
  id: string;
  status: string;
  features: FixtureFeature[];
}
interface FixtureData {
  project: string;
  sprints: FixtureSprint[];
  metadata: Record<string, unknown>;
}

async function seedFeatures(projectDir: string, data: FixtureData): Promise<void> {
  await mkdir(join(projectDir, ".ghs"), { recursive: true });
  await writeFile(
    join(projectDir, ".ghs", "features.json"),
    JSON.stringify(data),
  );
}

const NO_READY_BANNER = "=== ghs-code: no ready features ===";

describe("code no-ready-features banner snapshot (s1-feat-003)", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await makeTempDir("ghs-code-no-ready-");
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  test("情况 A: all features completed (ready empty, skipped empty) → banner is first line", async () => {
    await seedFeatures(projectDir, {
      project: "test-project",
      sprints: [
        {
          id: "s-nr",
          status: "in_progress",
          features: [
            {
              id: "s-nr-feat-done-a",
              title: "Completed feature A",
              status: "completed",
              dependencies: [],
              files_affected: ["src/a.ts"],
              acceptance_criteria: ["AC1"],
            },
            {
              id: "s-nr-feat-done-b",
              title: "Completed feature B",
              status: "completed",
              dependencies: [],
              files_affected: ["src/b.ts"],
              acceptance_criteria: ["AC1"],
            },
          ],
        },
      ],
      metadata: { version: "1.0.0" },
    });

    const result = await codeTool.execute(
      { project_dir: projectDir },
      mockToolContext(projectDir),
    );

    const firstLine = result.split("\n")[0];
    expect(firstLine).toBe(NO_READY_BANNER);
    // The no-ready branch is NOT stage-tracked (getStageSignature returns null
    // when there are no ready features), so no workflow chrome is prepended.
    expect(result).not.toContain("--- ghs stage:");
  });

  test("情况 B: features exist but none ready (unmet deps, skipped non-empty) → banner is first line", async () => {
    await seedFeatures(projectDir, {
      project: "test-project",
      sprints: [
        {
          id: "s-nr",
          status: "in_progress",
          features: [
            {
              id: "s-nr-feat-blocked",
              title: "Blocked feature (dep not completed)",
              status: "pending",
              dependencies: ["s-nr-feat-missing"],
              files_affected: ["src/c.ts"],
              acceptance_criteria: ["AC1"],
            },
          ],
        },
      ],
      metadata: { version: "1.0.0" },
    });

    const result = await codeTool.execute(
      { project_dir: projectDir },
      mockToolContext(projectDir),
    );

    const firstLine = result.split("\n")[0];
    expect(firstLine).toBe(NO_READY_BANNER);
    // skipped 非空 → the branch surfaces a count hint.
    expect(result).toContain("无一 ready");
    expect(result).toContain("ghs-status");
    expect(result).not.toContain("--- ghs stage:");
  });
});
