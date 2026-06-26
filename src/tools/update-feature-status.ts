// `ghs-update-feature-status` tool — thin shell over the pure function
// `updateFeatureStatus` (src/lib/scripts/update-feature-status.ts).
//
// IO model mirrors sprintTool → appendSprint: read features.json → call the
// pure writer (no IO) → write the result back to disk. The pure function
// validates the spec (format, enum, blocked_reason refinement) and locates
// the feature across all sprints.
//
// status uses tool.schema.enum(VALID_FEATURE_STATUSES), same-source imported
// from the pure-function module — schema layer and pure-function layer share
// one enum definition (Medium #1 + Opt #3). The writer validates the status
// enum value and feature existence, NOT the direction of state transitions
// (Medium #2: description carries no "Valid transitions" claim).

import { tool } from "@opencode-ai/plugin";
import type { ToolContext } from "@opencode-ai/plugin/tool";
import { join, resolve } from "node:path";

import {
  updateFeatureStatus,
  VALID_FEATURE_STATUSES,
} from "../lib/scripts/update-feature-status.ts";
import { resolveProjectDir } from "../lib/project.ts";

export const updateFeatureStatusTool = tool({
  description:
    "Update a single feature's status in features.json (reads → updates → " +
    "writes back to disk). Call this after ghs-parse-completion-signal returns " +
    "status 'completed' or 'blocked', to record the outcome. Sets the feature " +
    "status; the caller is responsible for transition legality — the underlying " +
    "writer validates the status enum value and feature existence, NOT the " +
    "direction of state transitions.",
  args: {
    feature_id: tool.schema
      .string()
      .describe(
        "Feature id to update (e.g. s5-feat-003). Must match ^s\\d{1,4}-feat-\\d{3}$.",
      ),
    status: tool.schema
      .enum(VALID_FEATURE_STATUSES)
      .describe(
        "New status. One of: pending | in_progress | completed | blocked. " +
        "No transition-direction guard — caller ensures legality.",
      ),
    blocked_reason: tool.schema
      .string()
      .optional()
      .describe("Required when status is 'blocked'."),
    project_dir: tool.schema
      .string()
      .optional()
      .describe(
        "Absolute path of the project root. Defaults to the opencode session's worktree/directory.",
      ),
  },
  async execute(
    args: {
      feature_id: string;
      status: "pending" | "in_progress" | "completed" | "blocked";
      blocked_reason?: string;
      project_dir?: string;
    },
    ctx: ToolContext,
  ): Promise<string> {
    const projectDir = args.project_dir
      ? resolve(args.project_dir)
      : resolveProjectDir(ctx);

    const featuresPath = join(projectDir, ".ghs", "features.json");
    const featuresFile = Bun.file(featuresPath);
    if (!(await featuresFile.exists())) {
      return [
        `❌ features.json not found at ${featuresPath}.`,
        "",
        "Run `ghs-init` first to bootstrap the .ghs/ tracking files.",
      ].join("\n");
    }

    const featuresData = JSON.parse(await featuresFile.text());

    // The pure function's Zod schema re-validates the spec (format, enum,
    // blocked_reason refinement) — same-source double validation. On invalid
    // input it throws ZodError; let it propagate (same pattern as
    // sprintTool → appendSprint).
    const updated = updateFeatureStatus(featuresData, {
      feature_id: args.feature_id,
      status: args.status,
      ...(args.blocked_reason !== undefined
        ? { blocked_reason: args.blocked_reason }
        : {}),
    });

    await Bun.write(featuresPath, JSON.stringify(updated, null, 2) + "\n");

    // Detect sprint-completion promotion: the pure writer flips the owning
    // sprint's status to "completed" when its last feature completes. Compare
    // that sprint's status before/after so the AI is told the sprint is now
    // ready to archive (it otherwise has no signal — ghs-code just reports
    // "no ready features" without persisting anything).
    const before = findOwningSprint(featuresData, args.feature_id);
    const after = findOwningSprint(updated, args.feature_id);
    const promoted =
      before !== null &&
      after !== null &&
      before.status !== "completed" &&
      after.status === "completed";

    const lines = [
      `✅ Feature ${args.feature_id} status updated → ${args.status}.`,
      "",
      `Written to ${featuresPath}`,
    ];
    if (promoted) {
      lines.push("");
      lines.push(
        `Sprint ${after!.id} 的所有 feature 已完成，sprint 状态已置为 completed —— 可用 \`ghs-archive\` 归档该 sprint。`,
      );
    }
    return lines.join("\n");
  },
});

/**
 * Locate the sprint that owns `featureId` and return its id + status.
 *
 * Used by {@link updateFeatureStatusTool.execute} to detect whether the pure
 * writer just promoted the owning sprint to `completed`. Returns `null` when
 * the feature is not found (which would already have thrown inside the pure
 * writer, so this is purely defensive).
 */
function findOwningSprint(
  data: Record<string, unknown>,
  featureId: string,
): { id: string; status: string } | null {
  const sprints = Array.isArray(data.sprints)
    ? (data.sprints as Record<string, unknown>[])
    : [];
  for (const sprint of sprints) {
    const feats = Array.isArray(sprint.features)
      ? (sprint.features as Record<string, unknown>[])
      : [];
    if (feats.some((f) => f.id === featureId)) {
      return {
        id: String(sprint.id ?? ""),
        status: String(sprint.status ?? ""),
      };
    }
  }
  return null;
}
