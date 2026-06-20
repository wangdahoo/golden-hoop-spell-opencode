// Integration test: R2 plan dispatcher end-to-end loop.
//
// Feature s3-feat-010 acceptance criterion #1: `test/integration/plan-dispatch.test.ts`
// exists and covers the R2 dispatcher flow — mock Task-tool dispatch of the 3
// subagents + model ID parsing + plan artefact schema.
//
// The 3-role plan dispatcher (plan §3.5 / §3.7) drives the main chat AI
// through this loop:
//
//     ghs-plan-start
//       → [Task: ghs-context-haiku] → ghs-plan-review(snapshot)
//       → [Task: ghs-plan-designer] → ghs-plan-review(plan)
//       → [Task: ghs-plan-reviewer] → ghs-plan-review(review, verdict=PASS)
//       → ghs-plan-finalize
//
// OpenCode's Task tool is what the main AI uses to spawn each subagent; the
// plugin itself never invokes the Task tool (it only returns dispatch
// directives the AI then acts on). So in this integration test we play the
// role of the orchestrating AI: we invoke each ghs-* tool in sequence and
// substitute canned delimited-output blobs for what the subagents would have
// returned. The assertions verify:
//
//   1. Each review step's dispatch directive names the NEXT subagent the AI
//      is supposed to spawn (context-haiku → plan-designer → plan-reviewer),
//      proving the 3-agent fan-out is wired correctly (R2 core).
//   2. The model IDs in `.ghs/ghs.json` flow through to the rendered
//      `.opencode/agents/ghs-*.md` (R3 — the model each Task-tool dispatch
//      will use is read from the agent markdown, which ghs-config renders
//      from ghs.json). We invoke ghs-config once at the start to materialise
//      the agent markdown, then assert each file carries the configured model.
//   3. The finalised plan artefact in `.ghs/plans/` has the expected schema
//      (YYYY-MM-DD-<slug>.md naming, valid status.json with status=approved).
//
// Temp-dir isolation: the whole loop runs against a fresh temp dir; the
// project's own `.ghs/` and `.opencode/` are never touched.

import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { planStartTool } from "../../src/tools/plan-start";
import { planReviewTool, findActivePlanStatus } from "../../src/tools/plan-review";
import { planFinalizeTool } from "../../src/tools/plan-finalize";
import { configTool } from "../../src/tools/config";
import { plansDir } from "../../src/lib/state";
import {
  makeTempDir,
  mockToolContext,
  longBody,
  snapshotBlob,
  planBlob,
  reviewBlob,
} from "./_helpers";

/**
 * The default model IDs copied verbatim from `shared/ghs.default.json`.
 * ghs-config (invoked below) renders these into `.opencode/agents/ghs-*.md`,
 * which is what the Task tool reads when spawning each subagent.
 */
const DEFAULT_MODELS = {
  context: "zai-coding-plan/glm-4.5-air",
  designer: "zhipuai-coding-plan/glm-4.6",
  reviewer: "zhipuai-coding-plan/glm-4.6",
} as const;

/** The three agent names the dispatcher fans out to (R2). */
const AGENT_NAMES = [
  "ghs-context-haiku",
  "ghs-plan-designer",
  "ghs-plan-reviewer",
] as const;

describe("integration: plan dispatcher end-to-end (R2)", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await makeTempDir("ghs-int-dispatch-");
    // Seed a minimal `.ghs/ghs.json` so ghs-config has something to read.
    // In production ghs-init creates this; here we skip ghs-init to keep the
    // test focused on the dispatcher + config-sync, and seed the file by hand.
    await mkdir(join(projectDir, ".ghs"), { recursive: true });
    await writeFile(
      join(projectDir, ".ghs", "ghs.json"),
      JSON.stringify({ models: DEFAULT_MODELS }),
    );
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  test("full dispatcher loop fans out to all 3 subagents and finalises a plan", async () => {
    // (0) ghs-config renders the 3 agent markdown files from ghs.json. The
    // Task tool reads these at spawn time to pick each subagent's model.
    const configResult = await configTool.execute(
      { project_dir: projectDir },
      mockToolContext(projectDir),
    );
    expect(configResult).toContain("Agent markdown files synced");

    // R3 assertion: each rendered agent markdown carries the model ID from
    // ghs.json. These are the models the Task tool would dispatch each
    // subagent with.
    for (const name of AGENT_NAMES) {
      const agentPath = join(projectDir, ".opencode", "agents", `${name}.md`);
      expect(existsSync(agentPath)).toBe(true);
      const body = await Bun.file(agentPath).text();
      const expectedModel =
        name === "ghs-context-haiku"
          ? DEFAULT_MODELS.context
          : name === "ghs-plan-designer"
            ? DEFAULT_MODELS.designer
            : DEFAULT_MODELS.reviewer;
      expect(body).toContain(`model: ${expectedModel}`);
    }

    // (1) ghs-plan-start — writes initial status.json + dispatch directive
    // for the FIRST subagent (ghs-context-haiku).
    const startResult = await planStartTool.execute(
      { project_dir: projectDir },
      mockToolContext(projectDir),
    );
    // The directive tells the AI to spawn ghs-context-haiku via Task tool.
    expect(startResult).toContain("ghs-context-haiku");
    expect(startResult).toContain("Task tool");
    // Initial status persisted.
    let status = await findActivePlanStatus(projectDir);
    expect(status).not.toBeNull();
    expect(status!.round).toBe(1);
    expect(status!.status).toBe("designing");

    // (2) [mock Task: ghs-context-haiku] → ghs-plan-review(snapshot).
    // We stand in for the context-haiku subagent by feeding a canned
    // delimited snapshot blob.
    const snapshot = snapshotBlob(longBody("Architecture snapshot"));
    const snapshotReview = await planReviewTool.execute(
      { snapshot, project_dir: projectDir },
      mockToolContext(projectDir),
    );
    // Snapshot mode dispatches the SECOND subagent (ghs-plan-designer).
    expect(snapshotReview).toContain("plan-designer");
    expect(snapshotReview).toContain("Task tool");
    // Context artefact persisted to .ghs/plans/.
    status = await findActivePlanStatus(projectDir);
    expect(existsSync(join(plansDir(projectDir), status!.context_file))).toBe(true);

    // (3) [mock Task: ghs-plan-designer] → ghs-plan-review(plan).
    const plan = planBlob(longBody("# Plan Title\n\n## Goal\n\nBuild it."));
    const planReview = await planReviewTool.execute(
      { plan, project_dir: projectDir },
      mockToolContext(projectDir),
    );
    // Plan mode dispatches the THIRD subagent (ghs-plan-reviewer).
    expect(planReview).toContain("plan-reviewer");
    expect(planReview).toContain("Task tool");
    // Plan artefact persisted + status advanced to reviewing.
    status = await findActivePlanStatus(projectDir);
    expect(existsSync(join(plansDir(projectDir), status!.plan_file))).toBe(true);
    expect(status!.status).toBe("reviewing");

    // (4) [mock Task: ghs-plan-reviewer, verdict=PASS] → ghs-plan-review(review).
    const review = reviewBlob(longBody("Review looks good"), "PASS");
    const reviewReview = await planReviewTool.execute(
      { review, project_dir: projectDir },
      mockToolContext(projectDir),
    );
    // PASS verdict advances to ghs-plan-finalize.
    expect(reviewReview).toContain("Review PASS");
    expect(reviewReview).toContain("ghs-plan-finalize");
    status = await findActivePlanStatus(projectDir);
    expect(status!.status).toBe("pending_approval");
    // Review artefact persisted.
    expect(status!.review_file).toBeDefined();
    expect(existsSync(join(plansDir(projectDir), status!.review_file!))).toBe(true);

    // (5) ghs-plan-finalize — writes the final plan markdown + flips status.
    const finalPlan = "# Finalised Plan\n\n## Goal\n\nShip the feature.\n";
    const finalizeResult = await planFinalizeTool.execute(
      {
        plan_content: finalPlan,
        project_dir: projectDir,
        plan_id: status!.plan_id,
      },
      mockToolContext(projectDir),
    );
    expect(finalizeResult).toContain("ghs-sprint");

    // Final plan artefact: schema check.
    // (a) file exists under .ghs/plans/ with YYYY-MM-DD-<slug>.md naming.
    const plansListing: string[] = [];
    for (const name of await readdir(plansDir(projectDir))) {
      if (name.endsWith(".md")) plansListing.push(name);
    }
    expect(plansListing.length).toBeGreaterThanOrEqual(1);
    const planMdName = plansListing.find((n) => !n.endsWith("-context.md") && !n.endsWith("-review.md"));
    expect(planMdName).toBeDefined();
    // YYYY-MM-DD-<slug>.md naming convention (plan_ref §3.5).
    expect(planMdName!).toMatch(/^\d{4}-\d{2}-\d{2}-.+\.md$/);
    const planMdBody = await Bun.file(join(plansDir(projectDir), planMdName!)).text();
    expect(planMdBody).toContain("# Finalised Plan");

    // (b) status.json final state: approved. After finalize the status is
    // terminal so findActivePlanStatus (which filters terminal states) may
    // return null — read the status file directly. There is exactly one
    // `-status.json` per plan loop, so we locate it by listing the dir.
    const { readPlanStatus } = await import("../../src/lib/state");
    let resolved: { status: string } | null = null;
    for (const name of await readdir(plansDir(projectDir))) {
      if (!name.endsWith("-status.json")) continue;
      const pid = name.slice(0, -"-status.json".length);
      resolved = await readPlanStatus(projectDir, pid);
      if (resolved) break;
    }
    expect(resolved).not.toBeNull();
    expect(resolved!.status).toBe("approved");
  });

  test("review FAIL verdict triggers a revise round (re-dispatch designer) rather than advancing", async () => {
    // Bootstrap a fresh plan loop up to the review step, same as above but
    // abbreviated — we only care about the FAIL branch here.
    await planStartTool.execute(
      { project_dir: projectDir },
      mockToolContext(projectDir),
    );

    // snapshot → designer dispatch
    await planReviewTool.execute(
      { snapshot: snapshotBlob(longBody("snap")), project_dir: projectDir },
      mockToolContext(projectDir),
    );
    // plan → reviewer dispatch
    await planReviewTool.execute(
      { plan: planBlob(longBody("# Draft plan")), project_dir: projectDir },
      mockToolContext(projectDir),
    );

    // review FAIL → revise round (round 1 → 2), re-dispatch designer.
    const failReview = await planReviewTool.execute(
      { review: reviewBlob(longBody("Severe issue found"), "FAIL"), project_dir: projectDir },
      mockToolContext(projectDir),
    );
    expect(failReview).toContain("Review FAIL");
    expect(failReview).toContain("ghs-plan-designer");
    // Round counter advanced.
    const status = await findActivePlanStatus(projectDir);
    expect(status).not.toBeNull();
    expect(status!.round).toBe(2);
    expect(status!.status).toBe("revising");
  });

  test("model IDs from ghs.json are respected when customised (R3 model fan-out)", async () => {
    // Overwrite ghs.json with custom model IDs and re-sync.
    const customModels = {
      context: "custom/context-model",
      designer: "custom/designer-model",
      reviewer: "custom/reviewer-model",
    };
    await writeFile(
      join(projectDir, ".ghs", "ghs.json"),
      JSON.stringify({ models: customModels }),
    );

    await configTool.execute(
      { project_dir: projectDir },
      mockToolContext(projectDir),
    );

    // Each agent markdown now references the custom model — proving the
    // dispatcher's per-role model selection is driven by user config (R2 + R3).
    const ctxBody = await Bun.file(
      join(projectDir, ".opencode", "agents", "ghs-context-haiku.md"),
    ).text();
    expect(ctxBody).toContain("model: custom/context-model");

    const designerBody = await Bun.file(
      join(projectDir, ".opencode", "agents", "ghs-plan-designer.md"),
    ).text();
    expect(designerBody).toContain("model: custom/designer-model");

    const reviewerBody = await Bun.file(
      join(projectDir, ".opencode", "agents", "ghs-plan-reviewer.md"),
    ).text();
    expect(reviewerBody).toContain("model: custom/reviewer-model");
  });
});
