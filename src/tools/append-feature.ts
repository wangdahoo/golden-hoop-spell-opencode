// `ghs-append-feature` tool — thin shell over the pure function `appendFeature`
// (src/lib/scripts/append-feature.ts).
//
// IO model mirrors sprintTool → appendSprint / updateFeatureStatusTool: read
// features.json → call the pure writer (no IO) → write the result back to
// disk. The pure function validates the spec (format, enum, uniqueness) and
// locates the target sprint.
//
// category / priority / estimated_complexity use tool.schema.enum([...]),
// same-source imported from the pure-function module — schema layer and
// pure-function layer share one enum definition (Medium #1 + Opt #3). status
// is hard-coded to "pending" by the pure function (not accepted as an arg).

import { tool } from "@opencode-ai/plugin";
import type { ToolContext } from "@opencode-ai/plugin/tool";
import { join, resolve } from "node:path";

import {
  appendFeature,
  VALID_CATEGORIES,
  VALID_PRIORITIES,
  VALID_COMPLEXITIES,
} from "../lib/scripts/append-feature.ts";
import { resolveProjectDir } from "../lib/project.ts";

export const appendFeatureTool = tool({
  description:
    "Append a single feature (status: pending) to a sprint in features.json " +
    "(reads → appends → writes back to disk). Call this repeatedly during " +
    "sprint planning to decompose the sprint goal into atomic features. " +
    "The feature id format must be s{N}-feat-{NNN} matching the sprint.",
  args: {
    sprint_id: tool.schema
      .string()
      .describe("Target sprint id (e.g. s5). Must match ^s\\d{1,4}$."),
    feature_id: tool.schema
      .string()
      .describe(
        "Feature id (e.g. s5-feat-001). Must match ^s\\d{1,4}-feat-\\d{3}$.",
      ),
    category: tool.schema
      .enum(VALID_CATEGORIES)
      .describe("Feature category. One of: core | ui | api | auth | data | infra."),
    priority: tool.schema
      .enum(VALID_PRIORITIES)
      .describe("Feature priority. One of: high | medium | low."),
    title: tool.schema.string().min(1).describe("Feature title (中文)."),
    description: tool.schema
      .string()
      .min(1)
      .describe(
        "Feature description (中文, the single source of truth for the subagent).",
      ),
    acceptance_criteria: tool.schema
      .array(tool.schema.string())
      .min(1)
      .describe("Acceptance criteria (Given/When/Then format, at least 1)."),
    technical_notes: tool.schema
      .string()
      .optional()
      .describe("Implementation guidance / pointers (中文)."),
    dependencies: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("Feature ids this depends on (must be completed first)."),
    estimated_complexity: tool.schema
      .enum(VALID_COMPLEXITIES)
      .describe("Complexity estimate. One of: small (<2h) | medium (2-4h) | large (4h+)."),
    files_affected: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("Files this feature will touch (for parallel batch conflict detection)."),
    project_dir: tool.schema
      .string()
      .optional()
      .describe(
        "Absolute path of the project root. Defaults to the opencode session's worktree/directory.",
      ),
  },
  async execute(
    args: {
      sprint_id: string;
      feature_id: string;
      category: "core" | "ui" | "api" | "auth" | "data" | "infra";
      priority: "high" | "medium" | "low";
      title: string;
      description: string;
      acceptance_criteria: string[];
      technical_notes?: string;
      dependencies?: string[];
      estimated_complexity: "small" | "medium" | "large";
      files_affected?: string[];
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
    // uniqueness) — same-source double validation. On invalid input it throws
    // ZodError; let it propagate (same pattern as sprintTool → appendSprint).
    const updated = appendFeature(featuresData, {
      sprint_id: args.sprint_id,
      feature: {
        id: args.feature_id,
        category: args.category,
        priority: args.priority,
        title: args.title,
        description: args.description,
        acceptance_criteria: args.acceptance_criteria,
        ...(args.technical_notes !== undefined
          ? { technical_notes: args.technical_notes }
          : {}),
        dependencies: args.dependencies ?? [],
        estimated_complexity: args.estimated_complexity,
        files_affected: args.files_affected ?? [],
      },
    });

    await Bun.write(featuresPath, JSON.stringify(updated, null, 2) + "\n");

    return [
      `✅ Feature ${args.feature_id} appended to sprint ${args.sprint_id} (status: pending).`,
      "",
      `Written to ${featuresPath}`,
    ].join("\n");
  },
});
