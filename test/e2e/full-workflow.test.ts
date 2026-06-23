// End-to-end test: full ghs plugin workflow (init → … → archive).
//
// Feature s5-feat-005 acceptance criteria:
//   - test/e2e/full-workflow.test.ts exists and drives the complete workflow
//     end-to-end in a temp project, chaining ALL plugin tools together:
//
//       ghs-init → ghs-config → ghs-plan-start →
//       ghs-plan-review(snapshot) → ghs-plan-review(plan) →
//       ghs-plan-review(review, PASS) → ghs-plan-finalize →
//       ghs-sprint → ghs-code → ghs-status → ghs-archive
//
//   - asserts each step's artefacts: .ghs/features.json + .ghs/progress.md
//     created by init; .ghs/plans/ plan + status.json flowing
//     designing → reviewing → pending_approval → approved; .ghs/ghs.json +
//     .opencode/agents/*.md synced by config; after archive the sprint moves
//     into .ghs/archived/.
//   - model-switch smoke: edit .ghs/ghs.json models.context → ghs-config →
//     assert ghs-context-explorer.md frontmatter `model:` updated.
//   - temp-dir isolation via _helpers.ts; no real subagent / no real OpenCode.
//
// Distinct from the per-tool integration tests (plan-dispatch / code-dispatch /
// config-sync / multi-model-orchestration / codegraph-paths): those exercise
// individual tools in isolation against hand-seeded fixtures. This test
// chains the real ghs-* tools into the full lifecycle in one temp project,
// exercising the wiring between them (init creates the files config reads;
// plan-finalize's output id is consumed by sprint; sprint's empty skeleton is
// populated by the writer code dispatch reads; archive consumes the sprint
// status the loop flips to completed).
//
// CANNED delimited blobs stand in for the Task-tool subagent outputs that
// the main AI would otherwise feed in (same machinery as plan-dispatch.test.ts).
//
// codegraph coverage: the full loop here runs against a temp dir WITHOUT a
// `.codegraph/` folder, so it exercises the codegraph-UNAVAILABLE (grep
// fallback) path end-to-end. The codegraph-AVAILABLE path is covered by
// test/integration/codegraph-paths.test.ts (see comment at ghs-plan-start
// below); this test does not duplicate that.

import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile, rm, readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { initTool } from "../../src/tools/init";
import { configTool } from "../../src/tools/config";
import { planStartTool } from "../../src/tools/plan-start";
import { planReviewTool, findActivePlanStatus } from "../../src/tools/plan-review";
import { planFinalizeTool } from "../../src/tools/plan-finalize";
import { sprintTool } from "../../src/tools/sprint";
import { codeTool } from "../../src/tools/code";
import { statusTool } from "../../src/tools/status";
import { archiveTool } from "../../src/tools/archive";
import { plansDir } from "../../src/lib/state";
import { updateFeatureStatus } from "../../src/lib/scripts/update-feature-status";
import {
  makeTempDir,
  mockToolContext,
  longBody,
  snapshotBlob,
  planBlob,
  reviewBlob,
} from "../integration/_helpers";

/**
 * Default model IDs copied verbatim from `shared/ghs.default.json`. ghs-init
 * seeds these into `.ghs/ghs.json`; ghs-config renders them into the agent
 * markdown frontmatter.
 */
const DEFAULT_MODELS = {
  context: "zhipuai-coding-plan/glm-4.5-air",
  designer: "zhipuai-coding-plan/glm-5.1",
  reviewer: "zhipuai-coding-plan/glm-5.1",
} as const;

/** The three agent names ghs-config renders. */
const AGENT_NAMES = [
  "ghs-context-explorer",
  "ghs-plan-designer",
  "ghs-plan-reviewer",
] as const;

describe("e2e: full ghs plugin workflow (init → … → archive) (s5-feat-005)", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await makeTempDir("ghs-e2e-full-");
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  test("drives the complete workflow through every ghs-* tool", async () => {
    // ========================================================================
    // (1) ghs-init — bootstrap .ghs/features.json + .ghs/progress.md +
    //     .ghs/ghs.json (with default models) + .opencode/agents/*.md.
    // ========================================================================
    const initResult = await initTool.execute(
      {
        project_name: "e2e-demo",
        description: "End-to-end workflow demonstration project",
        project_dir: projectDir,
      },
      mockToolContext(projectDir),
    );
    expect(initResult).toContain("=== ghs-init complete ===");

    // AC: .ghs/features.json + .ghs/progress.md created by init.
    const featuresPath = join(projectDir, ".ghs", "features.json");
    const progressPath = join(projectDir, ".ghs", "progress.md");
    const ghsJsonPath = join(projectDir, ".ghs", "ghs.json");
    expect(existsSync(featuresPath)).toBe(true);
    expect(existsSync(progressPath)).toBe(true);
    // ghs-init seeds ghs.json from the plugin default (so ghs-config has a
    // source of truth to read).
    expect(existsSync(ghsJsonPath)).toBe(true);
    // progress.md carries the shared template's heading.
    expect(await Bun.file(progressPath).text()).toContain("Project Progress Log");

    // ========================================================================
    // (2) ghs-config — render the 3 agent markdowns from .ghs/ghs.json.
    //     (init already calls syncAgents internally, but the user-facing R3
    //     entry point is ghs-config. Re-invoking it here mirrors the real
    //     workflow AND materialises the artefacts the rest of the loop reads.)
    // ========================================================================
    const configResult = await configTool.execute(
      { project_dir: projectDir },
      mockToolContext(projectDir),
    );
    expect(configResult).toContain("Agent markdown files synced");

    // AC: .ghs/ghs.json + .opencode/agents/ghs-*.md synced by config.
    for (const name of AGENT_NAMES) {
      const agentFile = join(projectDir, ".opencode", "agents", `${name}.md`);
      expect(existsSync(agentFile)).toBe(true);
    }
    // Each agent markdown carries its default model ID in the frontmatter.
    const ctxBody0 = await Bun.file(
      join(projectDir, ".opencode", "agents", "ghs-context-explorer.md"),
    ).text();
    expect(ctxBody0).toContain(`model: ${DEFAULT_MODELS.context}`);

    // ========================================================================
    // (3) ghs-plan-start — write initial status.json + dispatch directive.
    //     The temp dir has NO `.codegraph/`, so this exercises the grep
    //     fallback path. (The codegraph-available path is covered by
    //     test/integration/codegraph-paths.test.ts — that suite drives both
    //     branches of detectCodegraph against materialised `.codegraph/`; we
    //     do not duplicate it here.)
    // ========================================================================
    const startResult = await planStartTool.execute(
      { project_dir: projectDir },
      mockToolContext(projectDir),
    );
    expect(startResult).toContain("=== ghs-plan-start complete ===");
    expect(startResult).toContain("grep fallback"); // codegraph unavailable

    let status = await findActivePlanStatus(projectDir);
    expect(status).not.toBeNull();
    expect(status!.round).toBe(1);
    expect(status!.status).toBe("designing"); // AC: status flow starts at designing
    expect(status!.codegraph_available).toBe(false);

    // ========================================================================
    // (4) [mock Task: ghs-context-explorer] → ghs-plan-review(snapshot).
    // ========================================================================
    const snapshot = snapshotBlob(longBody("Architecture snapshot for e2e"));
    const snapshotReview = await planReviewTool.execute(
      { snapshot, project_dir: projectDir },
      mockToolContext(projectDir),
    );
    expect(snapshotReview).toContain("plan-designer");
    status = await findActivePlanStatus(projectDir);
    expect(status!.status).toBe("designing");

    // ========================================================================
    // (5) [mock Task: ghs-plan-designer] → ghs-plan-review(plan).
    // ========================================================================
    const plan = planBlob(longBody("# E2E Plan Title\n\n## Goal\n\nShip the demo."));
    const planReview = await planReviewTool.execute(
      { plan, project_dir: projectDir },
      mockToolContext(projectDir),
    );
    expect(planReview).toContain("plan-reviewer");
    status = await findActivePlanStatus(projectDir);
    // AC: status flows designing → reviewing.
    expect(status!.status).toBe("reviewing");

    // ========================================================================
    // (6) [mock Task: ghs-plan-reviewer, verdict=PASS] → ghs-plan-review(review).
    // ========================================================================
    const review = reviewBlob(longBody("Plan looks solid, shipping it"), "PASS");
    const reviewReview = await planReviewTool.execute(
      { review, project_dir: projectDir },
      mockToolContext(projectDir),
    );
    expect(reviewReview).toContain("Review PASS");
    expect(reviewReview).toContain("ghs-plan-finalize");
    status = await findActivePlanStatus(projectDir);
    // AC: status flows reviewing → pending_approval.
    expect(status!.status).toBe("pending_approval");

    // ========================================================================
    // (7) ghs-plan-finalize — write final plan markdown + flip status to approved.
    // ========================================================================
    // The content must clear the Phase 3 truncation length floor (1000 chars)
    // so the finalize guard admits it rather than rejecting it as a fragment.
    const finalPlan =
      "# E2E Finalised Plan\n\n## Goal\n\nShip the demo end-to-end.\n\n## Detail\n\n" +
      "This section pads the plan content past the finalize truncation length floor. ".repeat(15);
    const finalizeResult = await planFinalizeTool.execute(
      {
        plan_content: finalPlan,
        project_dir: projectDir,
        plan_id: status!.plan_id,
      },
      mockToolContext(projectDir),
    );
    expect(finalizeResult).toContain("=== ghs-plan-finalize complete ===");
    expect(finalizeResult).toContain("ghs-sprint");

    // AC: .ghs/plans/ plan + status.json flow through to approved. After
    // finalize the status is terminal, so findActivePlanStatus (which filters
    // terminal states) returns null — read the status file directly.
    const { readPlanStatus } = await import("../../src/lib/state");
    let resolved: { status: string } | null = null;
    let finalPlanId = "";
    for (const name of await readdir(plansDir(projectDir))) {
      if (!name.endsWith("-status.json")) continue;
      const pid = name.slice(0, -"-status.json".length);
      resolved = await readPlanStatus(projectDir, pid);
      if (resolved) {
        finalPlanId = pid;
        break;
      }
    }
    expect(resolved).not.toBeNull();
    expect(resolved!.status).toBe("approved"); // AC: ...→ approved

    // A finalised plan markdown exists with the YYYY-MM-DD-<slug>.md naming.
    const planMdName = (await readdir(plansDir(projectDir))).find(
      (n) =>
        n.endsWith(".md") &&
        !n.endsWith("-context.md") &&
        !n.endsWith("-review.md"),
    );
    expect(planMdName).toBeDefined();
    expect(planMdName!).toMatch(/^\d{4}-\d{2}-\d{2}-.+\.md$/);
    expect(await Bun.file(join(plansDir(projectDir), planMdName!)).text()).toContain(
      "# E2E Finalised Plan",
    );

    // ========================================================================
    // (8) ghs-sprint — append a new sprint skeleton to features.json.
    //     (The sprint starts empty; the real AI then decomposes the goal into
    //      features via update-feature-status. We do that write inline below
    //      so ghs-code has a ready feature to dispatch.)
    // ========================================================================
    const sprintResult = await sprintTool.execute(
      {
        sprint_name: "E2E Demo Sprint",
        goal: "Implement the demo feature end-to-end",
        project_dir: projectDir,
      },
      mockToolContext(projectDir),
    );
    expect(sprintResult).toContain("=== ghs-sprint complete ===");
    expect(sprintResult).toContain("E2E Demo Sprint");

    // The sprint skeleton is now on disk. Read features.json to find the new
    // sprint id (auto-generated as s1 by nextSprintId since this is the first
    // sprint — init creates features.json with an empty sprints[] array).
    const featuresAfterSprint = JSON.parse(
      await readFile(featuresPath, "utf8"),
    ) as { sprints: Array<{ id: string; status: string; features: unknown[] }> };
    expect(featuresAfterSprint.sprints.length).toBe(1);
    const newSprint = featuresAfterSprint.sprints[0];
    expect(newSprint.status).toBe("planning");
    const sprintId = newSprint.id;
    expect(sprintId).toMatch(/^s\d+$/);

    // Populate the sprint with a feature (mirrors what the real AI does via
    // update-feature-status after decomposing the goal), then flip the sprint
    // to in_progress so getReadyFeatures considers it the current sprint.
    const featureId = `${sprintId}-feat-001`;
    let featuresData = JSON.parse(await readFile(featuresPath, "utf8")) as Record<
      string,
      unknown
    >;
    // Inject the feature record into the sprint's features[] directly (the
    // real flow: AI appends each decomposed feature with status pending).
    const sprints = featuresData.sprints as Array<Record<string, unknown>>;
    const targetSprint = sprints.find((s) => s.id === sprintId)!;
    targetSprint.features = [
      {
        id: featureId,
        title: "Demo feature for e2e dispatch",
        status: "pending",
        dependencies: [],
        files_affected: ["src/demo.ts"],
        acceptance_criteria: ["AC1", "AC2"],
      },
    ];
    targetSprint.status = "in_progress";
    await writeFile(featuresPath, JSON.stringify(featuresData, null, 2) + "\n");

    // ========================================================================
    // (9) ghs-code — read features.json, find the ready feature, return
    //     dispatch guidance embedding FEATURE_IMPL_PROMPT.
    // ========================================================================
    const codeResult = await codeTool.execute(
      { project_dir: projectDir },
      mockToolContext(projectDir),
    );
    expect(codeResult).toContain(featureId);
    expect(codeResult).toContain("FEATURE COMPLETE"); // rendered dispatch prompt
    expect(codeResult).not.toContain("<feature_id>"); // placeholders substituted
    expect(codeResult).toContain(projectDir);

    // Simulate the subagent completing the feature: the main AI would parse
    // the completion signal then call update-feature-status. We call the
    // writer directly (it's a pure function the AI uses via the writer layer).
    featuresData = JSON.parse(await readFile(featuresPath, "utf8")) as Record<
      string,
      unknown
    >;
    const featuresAfterCode = updateFeatureStatus(featuresData, {
      feature_id: featureId,
      status: "completed",
    });
    await writeFile(featuresPath, JSON.stringify(featuresAfterCode, null, 2) + "\n");

    // ========================================================================
    // (9b) Model-switch smoke (R3): edit .ghs/ghs.json models.context →
    //      ghs-config → assert ghs-context-explorer.md frontmatter `model:`
    //      updated. This is the ONE model-switch assertion this e2e test
    //      makes; fine-grained multi-model coverage is owned by
    //      test/integration/multi-model-orchestration.test.ts (s5-feat-003).
    // ========================================================================
    const switchedContextModel = "e2e/custom-context-model";
    const ghsJson = JSON.parse(await readFile(ghsJsonPath, "utf8")) as {
      models: Record<string, string>;
    };
    ghsJson.models.context = switchedContextModel;
    await writeFile(ghsJsonPath, JSON.stringify(ghsJson, null, 2));

    await configTool.execute(
      { project_dir: projectDir },
      mockToolContext(projectDir),
    );
    const ctxBodyAfter = await Bun.file(
      join(projectDir, ".opencode", "agents", "ghs-context-explorer.md"),
    ).text();
    expect(ctxBodyAfter).toContain(`model: ${switchedContextModel}`);
    // The other two agents are untouched by the context edit.
    const designerBody = await Bun.file(
      join(projectDir, ".opencode", "agents", "ghs-plan-designer.md"),
    ).text();
    expect(designerBody).toContain(`model: ${DEFAULT_MODELS.designer}`);

    // ========================================================================
    // (10) ghs-status — read-only summary of the project state.
    // ========================================================================
    const statusResult = await statusTool.execute(
      { project_dir: projectDir },
      mockToolContext(projectDir),
    );
    // status() surfaces the project name + the in-progress sprint summary.
    expect(statusResult).toContain("e2e-demo");
    expect(statusResult).toContain(sprintId);

    // ========================================================================
    // (11) ghs-archive — flip sprint status to completed, then archive.
    //      ghs-archive only archives sprints with status 'completed', so we
    //      mark the sprint completed first (the real workflow does this when
    //      all features are done). The archive then moves the sprint into
    //      .ghs/archived/.
    // ========================================================================
    featuresData = JSON.parse(await readFile(featuresPath, "utf8")) as Record<
      string,
      unknown
    >;
    const sprintsBeforeArchive = featuresData.sprints as Array<
      Record<string, unknown>
    >;
    const sprintToComplete = sprintsBeforeArchive.find((s) => s.id === sprintId)!;
    sprintToComplete.status = "completed";
    await writeFile(featuresPath, JSON.stringify(featuresData, null, 2) + "\n");

    const archivedPath = join(projectDir, ".ghs", "archived");
    expect(existsSync(archivedPath)).toBe(false); // not yet archived

    const archiveResult = await archiveTool.execute(
      { project_dir: projectDir },
      mockToolContext(projectDir),
    );
    expect(archiveResult).toContain("Archived") // per-sprint archive report line

    // AC: after archive the sprint moves into .ghs/archived/.
    expect(existsSync(archivedPath)).toBe(true);
    const archivedEntries = await readdir(archivedPath);
    expect(archivedEntries.length).toBeGreaterThanOrEqual(1);
    // The archive folder is named `<sprintId>_<sprintName>_<timestamp>`.
    const archivedFolder = archivedEntries.find((n) => n.startsWith(`${sprintId}_`));
    expect(archivedFolder).toBeDefined();

    // The archived sprint is removed from the active features.json sprints[].
    const featuresAfterArchive = JSON.parse(
      await readFile(featuresPath, "utf8"),
    ) as { sprints: unknown[] };
    expect(featuresAfterArchive.sprints.length).toBe(0);

    // The plan artefacts written during the loop survive archiving (they are
    // under .ghs/plans/, not part of the sprint record that gets archived).
    expect(existsSync(join(plansDir(projectDir), planMdName!))).toBe(true);

    // Sanity: the finalised plan id we captured above is still resolvable
    // (the status.json is on disk even though the sprint is archived).
    const finalStatus = await readPlanStatus(projectDir, finalPlanId);
    expect(finalStatus).not.toBeNull();
    expect(finalStatus!.status).toBe("approved");
  });
});
