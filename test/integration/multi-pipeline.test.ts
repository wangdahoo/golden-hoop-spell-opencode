// Integration test: multi-pipeline runtime-lock concurrency (Feature s1-feat-005).
//
// Exercises the Phase 3a wiring of the runtime lock (`.ghs/active.lock`) into
// the stage-owner tools `ghs-sprint` and `ghs-code`, per
// docs/ghs/plans/2026-07-02-multi-pipeline-concurrency.md §4 Phase 3:
//   - M2: `takeover: boolean().optional()` schema on both tools.
//   - M3: acquireLock placed AFTER pre-flight checks (so early-return paths
//         never leak a lock); code releases on the terminal "no ready
//         features" banner.
//   - Conflict copy: a cross-session collision returns
//         `renderConflictMessage(...)` and performs NO write.
//
// Two mock ToolContexts with DIFFERENT sessionIDs simulate two terminal
// sessions racing on the same project (M7 helper). Temp dirs are per-test so
// lock state never leaks between scenarios.

import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { sprintTool } from "../../src/tools/sprint";
import { codeTool } from "../../src/tools/code";
import { readLock } from "../../src/lib/runtime-lock";
import { makeTempDir, mockToolContext } from "./_helpers";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
  name?: string;
  status: string;
  goal?: string;
  created_at?: string;
  features: FixtureFeature[];
}
interface FixtureData {
  project: Record<string, unknown>;
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

async function seedRaw(projectDir: string, contents: string): Promise<void> {
  await mkdir(join(projectDir, ".ghs"), { recursive: true });
  await writeFile(join(projectDir, ".ghs", "features.json"), contents);
}

/** Read features.json and return the sprint count (defensive on shape). */
async function sprintCount(projectDir: string): Promise<number> {
  const txt = await Bun.file(join(projectDir, ".ghs", "features.json")).text();
  const data = JSON.parse(txt) as { sprints?: unknown[] };
  return Array.isArray(data.sprints) ? data.sprints.length : 0;
}

const BASE_FEATURES: FixtureData = {
  project: { name: "multi-pipeline-test", description: "concurrency fixture" },
  sprints: [
    {
      id: "s1",
      name: "seed sprint",
      status: "planning",
      goal: "seed",
      created_at: "2026-07-02",
      features: [],
    },
  ],
  metadata: { version: "1.0.0", last_updated: "2026-07-02" },
};

// Two distinct sessionIDs simulate two terminal sessions (M7). buildLabel
// derives `<agent>@<sessionID.slice(-6)>` so the conflict copy is human-
// distinguishable.
const SESSION_A = "session-A-pipeline";
const SESSION_B = "session-B-pipeline";

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe("integration: multi-pipeline runtime lock (s1-feat-005)", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await makeTempDir("ghs-multi-pipeline-");
  });
  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  test("M2: both stage-owner tools expose a `takeover: boolean().optional()` arg", () => {
    // Behaviorally verify the arg schema accepts true/false/undefined and
    // rejects non-booleans — equivalent to z.boolean().optional() without
    // depending on zod internals.
    for (const schema of [sprintTool.args.takeover, codeTool.args.takeover]) {
      expect(schema).toBeDefined();
      expect(schema.safeParse(true).success).toBe(true);
      expect(schema.safeParse(false).success).toBe(true);
      expect(schema.safeParse(undefined).success).toBe(true);
      expect(schema.safeParse("yes").success).toBe(false);
    }
  });

  test("scenario 1 (sprint race): sessionA holds sprint lock → sessionB sprint is rejected, no write", async () => {
    await seedFeatures(projectDir, BASE_FEATURES);

    // sessionA creates a sprint skeleton → acquires the lock and HOLDS it
    // (sprint does not release on success; it spans the subsequent
    // append-feature calls).
    const resA = await sprintTool.execute(
      { sprint_name: "sprint-A", goal: "goal-A", project_dir: projectDir },
      mockToolContext(projectDir, SESSION_A),
    );
    expect(resA).toContain("=== ghs-sprint complete ===");
    expect(await sprintCount(projectDir)).toBe(2);

    // sessionB (different sessionID) attempts sprint → cross-session
    // collision → conflict copy, NO write.
    const resB = await sprintTool.execute(
      { sprint_name: "sprint-B", goal: "goal-B", project_dir: projectDir },
      mockToolContext(projectDir, SESSION_B),
    );
    expect(resB).toContain("另一流水线正持有 ghs 运行期锁");
    expect(resB).toContain("takeover=true");
    expect(resB).toContain("ghs-sprint");
    // sprint count unchanged — sessionB did not write.
    expect(await sprintCount(projectDir)).toBe(2);

    // The lock is still held by sessionA (sprint does not release on success).
    const holder = await readLock(projectDir);
    expect(holder).not.toBeNull();
    expect(holder!.stage).toBe("sprint");
    expect(holder!.session_id).toBe(SESSION_A);
  });

  test("scenario 2 (takeover, M2): sessionB takeover=true acquires; sessionA code then conflicts", async () => {
    await seedFeatures(projectDir, BASE_FEATURES);

    // sessionA acquires the sprint lock first.
    await sprintTool.execute(
      { sprint_name: "sprint-A", goal: "goal-A", project_dir: projectDir },
      mockToolContext(projectDir, SESSION_A),
    );
    expect(await sprintCount(projectDir)).toBe(2);

    // sessionB forcibly takes over (M2 arg) → overwrites the lock, succeeds,
    // and writes its own sprint skeleton.
    const resTake = await sprintTool.execute(
      {
        sprint_name: "sprint-B",
        goal: "goal-B",
        project_dir: projectDir,
        takeover: true,
      },
      mockToolContext(projectDir, SESSION_B),
    );
    expect(resTake).toContain("=== ghs-sprint complete ===");
    expect(await sprintCount(projectDir)).toBe(3);

    // The lock now belongs to sessionB.
    const holderAfterTakeover = await readLock(projectDir);
    expect(holderAfterTakeover!.session_id).toBe(SESSION_B);

    // sessionA (the kicked session) now calls ghs-code → the lock is held by
    // sessionB, so acquireLock refuses → conflict copy. sessionA never reaches
    // getReadyFeatures (M3: lock check precedes it).
    const resCode = await codeTool.execute(
      { project_dir: projectDir },
      mockToolContext(projectDir, SESSION_A),
    );
    expect(resCode).toContain("另一流水线正持有 ghs 运行期锁");
    expect(resCode).toContain("takeover=true");
    expect(resCode).toContain("ghs-code");
  });

  test("scenario 3a (code terminal release): no ready feature → banner + lock released", async () => {
    // An in_progress sprint whose only feature is already completed → no
    // ready feature → the terminal "no ready features" banner path, which
    // MUST releaseLock (code 终态释放).
    await seedFeatures(projectDir, {
      project: BASE_FEATURES.project,
      sprints: [
        {
          id: "s1",
          status: "in_progress",
          features: [
            {
              id: "s1-feat-done",
              title: "done",
              status: "completed",
              dependencies: [],
              files_affected: ["src/a.ts"],
              acceptance_criteria: ["AC1"],
            },
          ],
        },
      ],
      metadata: BASE_FEATURES.metadata,
    });

    const res = await codeTool.execute(
      { project_dir: projectDir },
      mockToolContext(projectDir, SESSION_A),
    );
    expect(res).toContain("=== ghs-code: no ready features ===");
    // Terminal state released the lock — no stranded lock file.
    expect(await readLock(projectDir)).toBeNull();
  });

  test("scenario 3b (M3 no leak): features.json missing → early return acquires no lock", async () => {
    // No seed at all — features.json is absent. code returns the not-found
    // error BEFORE acquireLock (M3 placement), so readLock stays null.
    const res = await codeTool.execute(
      { project_dir: projectDir },
      mockToolContext(projectDir, SESSION_A),
    );
    expect(res).toContain("features.json not found");
    expect(await readLock(projectDir)).toBeNull();
  });

  test("scenario 3c (M3 no leak): JSON parse failure → early return acquires no lock", async () => {
    // features.json exists but is unparseable — code returns the parse error
    // BEFORE acquireLock (M3 placement), so readLock stays null.
    await seedRaw(projectDir, "{ this is not valid json,,,}");

    const res = await codeTool.execute(
      { project_dir: projectDir },
      mockToolContext(projectDir, SESSION_A),
    );
    expect(res).toContain("Failed to parse");
    expect(await readLock(projectDir)).toBeNull();
  });
});
