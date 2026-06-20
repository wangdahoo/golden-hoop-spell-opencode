// `ghs-sprint` tool — create a new sprint skeleton in features.json.
//
// This is the Sprint 2 (s2-feat-003) productisation of the source plugin's
// purely-instruction-driven `ghs-sprint` skill. Instead of the AI editing
// features.json by hand, this tool:
//   1. Resolves the project dir (explicit `project_dir` arg wins; otherwise
//      `resolveProjectDir(ctx)` reads the opencode session's worktree/dir).
//   2. Reads features.json.
//   3. If any sprint has `status === "completed"`, auto-archives it first
//      (via `archiveSprints({ projectDir, dryRun: false })`). This mirrors
//      the source plugin's "archive finished sprints before creating a new
//      one" convention and keeps features.json focused on the active sprint.
//   4. Auto-generates the next sprint id (`s{N+1}`) by scanning BOTH the
//      current `sprints[]` array AND the `.ghs/archived/` folders, so an id
//      is never reused after archiving.
//   5. Calls `appendSprint` (s2-feat-001) to build the new featuresData — a
//      pure function; this tool owns the disk write.
//   6. Writes the updated featuresData back to disk.
//   7. Returns the `SPRINT_PLANNING_PROMPT` (s2-feat-002) plus a short
//      summary, so the AI immediately knows how to decompose the sprint
//      goal into atomic features and append them via `update-feature-status`.
//
// The tool is a thin wrapper composing three existing modules:
//   - archive-sprint.ts  (s1-feat-008 port)
//   - append-sprint.ts   (s2-feat-001 writer)
//   - sprint-planning.ts (s2-feat-002 prompt)

import { tool } from "@opencode-ai/plugin";
import type { ToolContext } from "@opencode-ai/plugin/tool";
import { readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { archiveSprints, formatLocalDate } from "../lib/scripts/archive-sprint.ts";
import { appendSprint } from "../lib/scripts/append-sprint.ts";
import { SPRINT_PLANNING_PROMPT } from "../prompts/sprint-planning.ts";
import { resolveProjectDir } from "../lib/project.ts";

/**
 * Scan a parsed features.json for the largest sprint numeric id.
 * Returns 0 when there are no sprints.
 */
function maxSprintNumber(sprints: unknown): number {
  if (!Array.isArray(sprints)) return 0;
  let max = 0;
  for (const s of sprints as Array<Record<string, unknown>>) {
    const id = typeof s.id === "string" ? s.id : "";
    const m = /^s(\d{1,4})$/.exec(id);
    if (m) {
      const n = Number.parseInt(m[1], 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return max;
}

/**
 * Scan `.ghs/archived/` folder names for sprint ids.
 *
 * Archived folders are named `<sprintId>_<sprintName>_<timestamp>` (see
 * archive-sprint.ts `archiveSprintFiles`). We parse the leading `s<N>_`
 * prefix to recover the sprint number, so that creating a fresh sprint
 * after an archive never reuses a retired id (the source plugin's
 * uniqueness guarantee is over the lifetime of the project, not just the
 * active sprints array).
 */
function maxArchivedSprintNumber(projectDir: string): number {
  const archivedPath = join(resolve(projectDir), ".ghs", "archived");
  if (!existsSync(archivedPath)) return 0;
  let max = 0;
  let entries: string[];
  try {
    entries = readdirSync(archivedPath);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const m = /^s(\d{1,4})_/.exec(name);
    if (m) {
      const n = Number.parseInt(m[1], 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return max;
}

/**
 * Compute the next sprint id for `projectDir` given the current
 * `featuresData`. Considers both active sprints and archived folders.
 */
export function nextSprintId(
  projectDir: string,
  featuresData: Record<string, unknown>,
): string {
  const fromActive = maxSprintNumber(featuresData.sprints);
  const fromArchived = maxArchivedSprintNumber(projectDir);
  const next = Math.max(fromActive, fromArchived) + 1;
  return `s${next}`;
}

/**
 * The `ghs-sprint` tool definition. Registered by the plugin entry point
 * under the `ghs-sprint` key (hyphenated, per spike 001 / D1).
 */
export const sprintTool = tool({
  description:
    "Create a new sprint skeleton in features.json. Auto-archives any already-completed sprints first, " +
    "auto-generates the next sprint id (s{N+1}, scanning active + archived sprints so ids never collide), " +
    "appends an empty sprint with status 'planning', writes it back to disk, and returns the sprint-planning " +
    "prompt so the AI can decompose the goal into atomic features (which it then appends via update-feature-status).",
  args: {
    sprint_name: tool.schema
      .string()
      .min(1)
      .describe("Human-readable sprint name (written into features.json#sprints[].name)."),
    goal: tool.schema
      .string()
      .min(1)
      .describe(
        "The sprint goal — what 'done' looks like for this sprint. Written into features.json#sprints[].goal.",
      ),
    project_dir: tool.schema
      .string()
      .optional()
      .describe(
        "Absolute path of the project root. Defaults to the opencode session's worktree/directory.",
      ),
  },
  async execute(
    args: {
      sprint_name: string;
      goal: string;
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

    // (c) Auto-archive completed sprints before creating a new one. If
    // archiveSprints throws (e.g. corrupt features.json), surface the error
    // rather than proceeding — appending on top of a corrupt file would
    // mask the real problem.
    let archivedSummary = "";
    let archivedCount = 0;
    const archived = await archiveSprints({ projectDir });
    if (archived.length > 0) {
      archivedCount = archived.length;
      archivedSummary =
        archived
          .map(
            (info) =>
              `  - ${info.sprint_name} (${info.sprint_id}) → ${info.archive_path ?? "(no path)"}`,
          )
          .join("\n") + "\n\n";
    }

    // Re-read features.json AFTER archiving — archiveSprints mutates the
    // file on disk (removes the archived sprint, updates metadata). Reading
    // the fresh content keeps the in-memory copy in sync.
    const text = await (Bun.file(featuresPath)).text();
    const featuresData = JSON.parse(text) as Record<string, unknown>;

    // (d) Auto-generate the next sprint id and append the skeleton.
    const newSprintId = nextSprintId(projectDir, featuresData);
    const updated = appendSprint(featuresData, {
      id: newSprintId,
      name: args.sprint_name,
      goal: args.goal,
      created_at: formatLocalDate(),
    });

    // (e) Write back to disk. 2-space indent matches every other features.json
    // writer in the project (init-project.ts / archive-sprint.ts).
    await Bun.write(featuresPath, JSON.stringify(updated, null, 2) + "\n");

    // (f) Compose the result. Lead with the short summary, then the planning
    // prompt so the AI can immediately start decomposing the goal.
    const lines: string[] = [];
    lines.push("=== ghs-sprint complete ===");
    lines.push("");
    lines.push(`Project directory: ${projectDir}`);
    lines.push(`New sprint:        ${args.sprint_name} (${newSprintId})`);
    lines.push(`Created at:        ${formatLocalDate()}`);
    if (archivedCount > 0) {
      lines.push("");
      lines.push(
        `Auto-archived ${archivedCount} completed sprint(s) before creating ${newSprintId}:`,
      );
      lines.push(archivedSummary.trimEnd());
    }
    lines.push("");
    lines.push(`Sprint skeleton written to ${featuresPath} (status: planning, features: []).`);
    lines.push("");
    lines.push("Next: decompose the sprint goal into atomic features and append each via");
    lines.push("`update-feature-status` (initial status: pending). Then flip the sprint status");
    lines.push("to in_progress once you start coding.");
    lines.push("");
    lines.push("--- sprint-planning prompt ---");
    lines.push(SPRINT_PLANNING_PROMPT);
    return lines.join("\n");
  },
});
