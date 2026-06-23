// Tool-level tests for `src/tools/update-feature-status.ts` (Feature s1-feat-002).
//
// Exercises the thin-shell tool end-to-end through disk IO: seed a temp
// features.json → call execute → read back and assert. Covers the six AC
// scenarios the feature gates on:
//   1. Normal: pending → completed (status written to disk)
//   2. Illegal status enum → rejected (same-source Zod enum)
//   3. features.json missing → error text string containing ❌
//   4. feature_id not found → throws
//   5. status 'blocked' without blocked_reason → ZodError (.refine())
//   6. Regression: completed → pending is NOT blocked (no transition guard)
//
// Temp-dir + mock-ToolContext policy matches test/code.test.ts and
// test/tools/parse-completion-signal.test.ts. The pure-function cascade is
// covered exhaustively in test/writer.test.ts; here we assert the tool layer
// (read → pure function → write-back) behaves correctly.
//
// Note on schema layer: `tool()`'s arg-schema validation runs in the OpenCode
// runtime before execute, NOT inside execute itself. So a direct `.execute()`
// call with an illegal status reaches the pure function, which re-validates
// via the same-source Zod enum (update-feature-status.ts:57) and throws
// ZodError. At runtime the tool-arg schema rejects even earlier; both layers
// share VALID_FEATURE_STATUSES, so the rejection outcome is identical.

import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZodError } from "zod";

import { updateFeatureStatusTool } from "../../src/tools/update-feature-status";

/** Minimal features.json fixture shape. */
interface FixtureFeature {
  id: string;
  title: string;
  status: string;
  blocked_reason?: string;
  dependencies?: string[];
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
  await writeFile(
    join(projectDir, ".ghs", "features.json"),
    JSON.stringify(data),
  );
}

/** Read + parse the features.json written under `projectDir`. */
async function readFeatures(projectDir: string): Promise<FixtureData> {
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(join(projectDir, ".ghs", "features.json"), "utf8");
  return JSON.parse(raw) as FixtureData;
}

/** Locate a feature by id across all sprints. Throws if missing. */
function findFeature(data: FixtureData, featureId: string): FixtureFeature {
  for (const sprint of data.sprints) {
    for (const f of sprint.features) {
      if (f.id === featureId) return f;
    }
  }
  throw new Error(`test helper: feature ${featureId} missing from data`);
}

/**
 * Minimal mock ToolContext. The tool resolves the project dir from
 * `worktree`/`directory`; both point at the temp dir.
 */
function mockCtx(projectDir: string): Parameters<typeof updateFeatureStatusTool.execute>[1] {
  return {
    sessionID: "update-feature-status-test",
    messageID: "msg",
    agent: "agent",
    directory: projectDir,
    worktree: projectDir,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  } as Parameters<typeof updateFeatureStatusTool.execute>[1];
}

describe("ghs-update-feature-status tool (s1-feat-002)", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = realpathSync(await mkdtemp(join(tmpdir(), "ghs-ufs-")));
  });
  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  // AC #1: Normal: pending → completed (status written to disk) ----------------
  test("AC#1 updates a pending feature to completed and writes to disk", async () => {
    await seedFeatures(projectDir, {
      project: { name: "test-project" },
      sprints: [
        {
          id: "s1",
          status: "in_progress",
          features: [
            { id: "s1-feat-001", title: "A feature", status: "pending" },
          ],
        },
      ],
      metadata: {},
    });

    const out = await updateFeatureStatusTool.execute(
      { feature_id: "s1-feat-001", status: "completed", project_dir: projectDir },
      mockCtx(projectDir),
    );

    expect(out).toContain("✅");
    const written = await readFeatures(projectDir);
    expect(findFeature(written, "s1-feat-001").status).toBe("completed");
  });

  // AC #2: Illegal status enum → rejected -------------------------------------
  test("AC#2 rejects an illegal status value (e.g. 'done')", async () => {
    await seedFeatures(projectDir, {
      project: { name: "test-project" },
      sprints: [
        {
          id: "s1",
          status: "in_progress",
          features: [
            { id: "s1-feat-001", title: "A feature", status: "pending" },
          ],
        },
      ],
      metadata: {},
    });

    // Direct execute bypasses the tool-arg schema (runtime's job); the
    // pure function's same-source Zod enum rejects 'done' instead.
    expect(
      updateFeatureStatusTool.execute(
        {
          feature_id: "s1-feat-001",
          status: "done" as unknown as "completed",
          project_dir: projectDir,
        },
        mockCtx(projectDir),
      ),
    ).rejects.toThrow(ZodError);

    // Disk unchanged.
    const written = await readFeatures(projectDir);
    expect(findFeature(written, "s1-feat-001").status).toBe("pending");
  });

  // AC #3: features.json missing → error text string containing ❌ -------------
  test("AC#3 returns an error text string (with ❌) when features.json is absent", async () => {
    // No seed — features.json does not exist.
    const out = await updateFeatureStatusTool.execute(
      { feature_id: "s1-feat-001", status: "completed", project_dir: projectDir },
      mockCtx(projectDir),
    );

    expect(out).toContain("❌");
    expect(out).toContain("features.json not found");
  });

  // AC #4: feature_id not found → throws --------------------------------------
  test("AC#4 throws when the feature_id is not found in any sprint", async () => {
    await seedFeatures(projectDir, {
      project: { name: "test-project" },
      sprints: [
        {
          id: "s1",
          status: "in_progress",
          features: [
            { id: "s1-feat-001", title: "A feature", status: "pending" },
          ],
        },
      ],
      metadata: {},
    });

    await expect(
      updateFeatureStatusTool.execute(
        { feature_id: "s1-feat-999", status: "completed", project_dir: projectDir },
        mockCtx(projectDir),
      ),
    ).rejects.toThrow(/not found/);
  });

  // AC #5: status 'blocked' without blocked_reason → ZodError (.refine()) -----
  test("AC#5 rejects status 'blocked' without a blocked_reason (refinement)", async () => {
    await seedFeatures(projectDir, {
      project: { name: "test-project" },
      sprints: [
        {
          id: "s1",
          status: "in_progress",
          features: [
            { id: "s1-feat-001", title: "A feature", status: "pending" },
          ],
        },
      ],
      metadata: {},
    });

    await expect(
      updateFeatureStatusTool.execute(
        { feature_id: "s1-feat-001", status: "blocked", project_dir: projectDir },
        mockCtx(projectDir),
      ),
    ).rejects.toThrow(ZodError);
  });

  // AC #5b: status 'blocked' WITH blocked_reason succeeds ----------------------
  test("AC#5b accepts status 'blocked' when a blocked_reason is supplied", async () => {
    await seedFeatures(projectDir, {
      project: { name: "test-project" },
      sprints: [
        {
          id: "s1",
          status: "in_progress",
          features: [
            { id: "s1-feat-001", title: "A feature", status: "pending" },
          ],
        },
      ],
      metadata: {},
    });

    const out = await updateFeatureStatusTool.execute(
      {
        feature_id: "s1-feat-001",
        status: "blocked",
        blocked_reason: "Waiting on upstream API",
        project_dir: projectDir,
      },
      mockCtx(projectDir),
    );

    expect(out).toContain("✅");
    const written = await readFeatures(projectDir);
    const feat = findFeature(written, "s1-feat-001");
    expect(feat.status).toBe("blocked");
    expect(feat.blocked_reason).toBe("Waiting on upstream API");
  });

  // AC #6: Regression — completed → pending NOT blocked (no transition guard) -
  test("AC#6 does NOT block a completed → pending regression (no transition-direction guard)", async () => {
    await seedFeatures(projectDir, {
      project: { name: "test-project" },
      sprints: [
        {
          id: "s1",
          status: "in_progress",
          features: [
            { id: "s1-feat-001", title: "A feature", status: "completed" },
          ],
        },
      ],
      metadata: {},
    });

    const out = await updateFeatureStatusTool.execute(
      { feature_id: "s1-feat-001", status: "pending", project_dir: projectDir },
      mockCtx(projectDir),
    );

    expect(out).toContain("✅");
    const written = await readFeatures(projectDir);
    expect(findFeature(written, "s1-feat-001").status).toBe("pending");
  });
});
