// Integration test: ghs-code tool dispatch guidance.
//
// Feature s4-feat-005 acceptance criterion #3: `test/integration/code-dispatch.test.ts`
// exists and covers the 3 ghs-code dispatch scenarios — single pinned feature,
// parallel batch plan, and the no-ready-feature short-circuit — against a temp
// project dir with a hand-seeded fixture `.ghs/features.json`.
//
// The ghs-code tool (s4-feat-004) is a *thin wrapper*: it reads features.json,
// finds the current sprint's ready features (status pending AND deps
// completed), and returns LLM-facing dispatch guidance embedding the rendered
// FEATURE_IMPL_PROMPT (s4-feat-003) so the main AI can hand it to the Task tool
// to spawn an isolated coding subagent. This test plays the role of the main
// AI: we invoke `codeTool.execute(...)` against a temp dir and assert the
// returned text carries the feature id, the rendered dispatch prompt (no
// `<feature_id>` placeholder leak), and the right per-mode framing.
//
// Style follows s3-feat-010's `plan-dispatch.test.ts` + reuses `_helpers.ts`
// (`makeTempDir` / `mockToolContext`). Temp-dir isolation: the project's own
// `.ghs/` is never touched.

import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { codeTool } from "../../src/tools/code";
import { makeTempDir, mockToolContext } from "./_helpers";

/**
 * Minimal features.json fixture shape (matches the real `.ghs/features.json`
 * the code tool reads — `project` / `sprints[]` / `metadata`, each sprint with
 * `id` / `status` / `features[]`, each feature with `id` / `status` /
 * `dependencies` / `files_affected` etc.). The helpers below build per-scenario
 * fixtures with only the fields the ready/batch logic inspects.
 */
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

/** Write a fixture features.json into `<projectDir>/.ghs/`. */
async function seedFeatures(projectDir: string, data: FixtureData): Promise<void> {
  await mkdir(join(projectDir, ".ghs"), { recursive: true });
  await writeFile(
    join(projectDir, ".ghs", "features.json"),
    JSON.stringify(data),
  );
}

/**
 * Assert every `parse-completion-signal` / `update-feature-status` occurrence
 * in `result` carries the `ghs-` prefix (s1-feat-003 AC: no bare prose
 * references). Counts the stem and the prefixed form — they must be equal.
 */
function expectNoBareToolStems(result: string): void {
  const pcs = (result.match(/parse-completion-signal/g) || []).length;
  const ghsPcs = (result.match(/ghs-parse-completion-signal/g) || []).length;
  expect(pcs).toBe(ghsPcs);
  const ufs = (result.match(/update-feature-status/g) || []).length;
  const ghsUfs = (result.match(/ghs-update-feature-status/g) || []).length;
  expect(ufs).toBe(ghsUfs);
}

describe("integration: ghs-code tool dispatch guidance (s4-feat-005)", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await makeTempDir("ghs-int-code-");
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  test("single feature: pinned feature_id returns dispatch guidance with rendered FEATURE_IMPL_PROMPT", async () => {
    // One in_progress sprint with a single ready feature (pending, no deps).
    await seedFeatures(projectDir, {
      project: "test-project",
      sprints: [
        {
          id: "s-int",
          status: "in_progress",
          features: [
            {
              id: "s-int-feat-001",
              title: "Ready feature for single dispatch",
              status: "pending",
              dependencies: [],
              files_affected: ["src/a.ts"],
              acceptance_criteria: ["AC1", "AC2"],
            },
          ],
        },
      ],
      metadata: { version: "1.0.0" },
    });

    const result = await codeTool.execute(
      { feature_id: "s-int-feat-001", project_dir: projectDir },
      mockToolContext(projectDir),
    );

    // (a) The selected feature's id is surfaced in the dispatch text.
    expect(result).toContain("s-int-feat-001");
    // (b) The FEATURE_IMPL_PROMPT body is embedded. A characteristic phrase
    //     from the rendered prompt (the hard completion-signal protocol).
    expect(result).toContain("FEATURE COMPLETE");
    // (c) Placeholders were substituted: no literal `<feature_id>` or
    //     `<PROJECT_DIR>` leak — the main AI can hand the text to Task verbatim.
    expect(result).not.toContain("<feature_id>");
    expect(result).not.toContain("<PROJECT_DIR>");
    // (d) The rendered prompt references the temp project dir (substitution
    //     actually happened, not just absence of the placeholder token).
    expect(result).toContain(projectDir);
    // (e) s1-feat-003: dispatch prose references real tool names + the
    //     re-call loop + the terminal banner.
    expect(result).toContain("ghs-parse-completion-signal");
    expect(result).toContain("ghs-update-feature-status");
    expect(result).toContain("=== ghs-code: no ready features ===");
    expectNoBareToolStems(result);
  });

  test("parallel mode: lists ready features and presents a batch dispatch plan", async () => {
    // Two ready features touching disjoint files → one conflict-free batch.
    await seedFeatures(projectDir, {
      project: "test-project",
      sprints: [
        {
          id: "s-int",
          status: "in_progress",
          features: [
            {
              id: "s-int-feat-010",
              title: "Parallel feature A",
              status: "pending",
              dependencies: [],
              files_affected: ["src/a.ts"],
              acceptance_criteria: ["AC1"],
            },
            {
              id: "s-int-feat-011",
              title: "Parallel feature B",
              status: "pending",
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
      { parallel: true, project_dir: projectDir },
      mockToolContext(projectDir),
    );

    // Both ready features are listed (nothing silently dropped).
    expect(result).toContain("s-int-feat-010");
    expect(result).toContain("s-int-feat-011");
    // Parallel-specific batch framing (dispatch plan, not a single pin).
    expect(result).toContain("parallel dispatch plan");
    expect(result).toContain("Batch");
    // s1-feat-003: dispatch prose references real tool names + the re-call
    // loop + the terminal banner; no bare (ghs--less) tool stems.
    expect(result).toContain("ghs-parse-completion-signal");
    expect(result).toContain("ghs-update-feature-status");
    expect(result).toContain("=== ghs-code: no ready features ===");
    expectNoBareToolStems(result);

    // s1-feat-004: shared template rendered ONCE (not N times — token bloat
    // reduction). The "--- feature-impl dispatch prompt" header appears
    // exactly 1 time regardless of how many features are in the batches.
    const promptHeaderCount =
      (result.match(/--- feature-impl dispatch prompt/g) || []).length;
    expect(promptHeaderCount).toBe(1);
    // The shared template contains the literal <feature_id> placeholder
    // (NOT pre-substituted) — the main AI must replace it per dispatch.
    expect(result).toContain("<feature_id>");
    // Explicit "replace ALL <feature_id>" directive (Medium #4) —
    // enumerate every occurrence so the AI doesn't miss one.
    expect(result).toContain("所有");
    expect(result).toContain("共 5 处");
    expect(result).toContain("FEATURE COMPLETE: <feature_id>");
  });

  test("single feature (default path): returns dispatch guidance with real tool names + loop", async () => {
    // Default dispatch (no feature_id, no parallel) → dispatchSingleFeature.
    await seedFeatures(projectDir, {
      project: "test-project",
      sprints: [
        {
          id: "s-int",
          status: "in_progress",
          features: [
            {
              id: "s-int-feat-020",
              title: "Default-path ready feature",
              status: "pending",
              dependencies: [],
              files_affected: ["src/d.ts"],
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

    // The selected feature is surfaced.
    expect(result).toContain("s-int-feat-020");
    // s1-feat-003: dispatch prose references real tool names + the re-call
    // loop + the terminal banner; no bare tool stems.
    expect(result).toContain("ghs-parse-completion-signal");
    expect(result).toContain("ghs-update-feature-status");
    expect(result).toContain("=== ghs-code: no ready features ===");
    expectNoBareToolStems(result);
  });

  test("no ready feature: returns the no-ready-features message", async () => {
    // A sprint where every feature is already completed — no pending work.
    await seedFeatures(projectDir, {
      project: "test-project",
      sprints: [
        {
          id: "s-int",
          status: "in_progress",
          features: [
            {
              id: "s-int-feat-done",
              title: "Already completed feature",
              status: "completed",
              dependencies: [],
              files_affected: ["src/done.ts"],
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

    // The no-ready short-circuit framing (AC #3 "no pending features").
    expect(result).toContain("no ready features");
    expect(result).toContain("pending");
  });
});
