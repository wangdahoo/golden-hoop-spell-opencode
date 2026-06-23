// Tool-level tests for `src/tools/append-feature.ts` (Feature s1-feat-005).
//
// Exercises the thin-shell tool end-to-end through disk IO: seed a temp
// features.json → call execute → read back and assert. Covers the four AC
// scenarios the feature gates on:
//   1. Normal append → feature written to disk with status "pending"
//   2. Illegal category enum → rejected (same-source Zod enum)
//   3. features.json missing → error text string containing ❌
//   4. Sprint not found → throws
//
// Temp-dir + mock-ToolContext policy matches test/tools/update-feature-status.test.ts.
// The pure-function cascade is covered exhaustively in test/append-feature.test.ts.

import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZodError } from "zod";

import { appendFeatureTool } from "../../src/tools/append-feature";

/** Minimal features.json fixture shape. */
interface FixtureFeature {
  id: string;
  category: string;
  priority: string;
  title: string;
  description: string;
  acceptance_criteria: string[];
  status: string;
  dependencies?: string[];
  estimated_complexity: string;
  files_affected?: string[];
  technical_notes?: string;
}
interface FixtureSprint {
  id: string;
  status: string;
  features: FixtureFeature[];
}
interface FixtureData {
  project: { name: string };
  sprints: FixtureSprint[];
  metadata: Record<string, unknown>;
}

async function seedFeatures(projectDir: string, data: FixtureData): Promise<void> {
  await mkdir(join(projectDir, ".ghs"), { recursive: true });
  await writeFile(join(projectDir, ".ghs", "features.json"), JSON.stringify(data));
}

/** Read + parse the features.json written under `projectDir`. */
async function readFeatures(projectDir: string): Promise<FixtureData> {
  const raw = await readFile(join(projectDir, ".ghs", "features.json"), "utf8");
  return JSON.parse(raw) as FixtureData;
}

/** A minimal featuresData with one empty sprint (s1). */
function emptySprint(): FixtureData {
  return {
    project: { name: "test-project" },
    sprints: [{ id: "s1", status: "planning", features: [] }],
    metadata: {},
  };
}

/**
 * Minimal mock ToolContext. The tool resolves the project dir from
 * `worktree`/`directory`; both point at the temp dir.
 */
function mockCtx(projectDir: string): Parameters<typeof appendFeatureTool.execute>[1] {
  return {
    sessionID: "append-feature-test",
    messageID: "msg",
    agent: "agent",
    directory: projectDir,
    worktree: projectDir,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  } as Parameters<typeof appendFeatureTool.execute>[1];
}

/** A valid execute-args payload with proper literal types. */
function validArgs(
  projectDir: string,
): Parameters<typeof appendFeatureTool.execute>[0] {
  return {
    sprint_id: "s1",
    feature_id: "s1-feat-001",
    category: "core",
    priority: "high",
    title: "测试 feature",
    description: "这是一个测试 feature",
    acceptance_criteria: ["Given x, when y, then z"],
    estimated_complexity: "small",
    project_dir: projectDir,
  };
}

describe("ghs-append-feature tool (s1-feat-005)", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = realpathSync(await mkdtemp(join(tmpdir(), "ghs-af-")));
  });
  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  // AC #1: Normal append → feature written to disk ---------------------------
  test("AC#1 appends a feature (status: pending) and writes to disk", async () => {
    await seedFeatures(projectDir, emptySprint());

    const out = await appendFeatureTool.execute(validArgs(projectDir), mockCtx(projectDir));

    expect(out).toContain("✅");
    expect(out).toContain("status: pending");
    const written = await readFeatures(projectDir);
    const feat = written.sprints[0].features[0];
    expect(feat.id).toBe("s1-feat-001");
    expect(feat.status).toBe("pending");
    expect(feat.category).toBe("core");
  });

  // AC #2: Illegal category enum → rejected ----------------------------------
  test("AC#2 rejects an illegal category value (e.g. 'foo')", async () => {
    await seedFeatures(projectDir, emptySprint());

    // Direct execute bypasses the tool-arg schema (runtime's job); the
    // pure function's same-source Zod enum rejects 'foo' instead.
    const args = validArgs(projectDir);
    (args as Record<string, unknown>).category = "foo";
    await expect(
      appendFeatureTool.execute(args as never, mockCtx(projectDir)),
    ).rejects.toThrow(ZodError);

    // Disk unchanged.
    const written = await readFeatures(projectDir);
    expect(written.sprints[0].features).toHaveLength(0);
  });

  // AC #3: features.json missing → error text string -------------------------
  test("AC#3 returns an error text string (with ❌) when features.json is absent", async () => {
    const out = await appendFeatureTool.execute(validArgs(projectDir), mockCtx(projectDir));

    expect(out).toContain("❌");
    expect(out).toContain("features.json not found");
  });

  // AC #4: Sprint not found → throws -----------------------------------------
  test("AC#4 throws when the target sprint does not exist", async () => {
    await seedFeatures(projectDir, emptySprint());

    const args = validArgs(projectDir);
    args.sprint_id = "s99";
    await expect(
      appendFeatureTool.execute(args, mockCtx(projectDir)),
    ).rejects.toThrow(/not found/);
  });

  // Extra: optional fields (dependencies/files_affected) default to [] -------
  test("optional fields default to empty arrays when omitted", async () => {
    await seedFeatures(projectDir, emptySprint());

    await appendFeatureTool.execute(validArgs(projectDir), mockCtx(projectDir));

    const written = await readFeatures(projectDir);
    const feat = written.sprints[0].features[0];
    expect(feat.dependencies).toEqual([]);
    expect(feat.files_affected).toEqual([]);
  });
});
