// `ghs-init` tool — initialise the `.ghs/` tracking files for a host project.
//
// This is the entry point a user (or the AI on the user's behalf) calls to
// bootstrap ghs in a project. It:
//   1. Resolves the target project dir (explicit `project_dir` arg wins;
//      otherwise `resolveProjectDir(ctx)` reads the opencode session's
//      worktree/directory).
//   2. Calls `initProject` to create `.ghs/features.json` + `.ghs/progress.md`
//      from the shared templates + update `.gitignore`.
//   3. Calls `validateFeaturesJson` on the freshly-created features.json so
//      the AI sees a confirmation (or, in the unlikely case the shared
//      template is corrupt, an error) inline.
//   4. Copies `shared/ghs.default.json` to `<projectDir>/.ghs/ghs.json` when
//      the user doesn't already have one — so they have a starting point to
//      customise model IDs (R3).
//   5. Calls `syncAgents` to render the 3 agent markdown files into
//      `<projectDir>/.opencode/agents/`. This is a direct function import,
//      NOT a tool invocation (per plan §3.4 D2).
//
// All file I/O is pure — no LLM calls. The returned string is what the AI
// sees as the tool result.

import { tool } from "@opencode-ai/plugin";
import type { ToolContext } from "@opencode-ai/plugin/tool";
import { join, resolve } from "node:path";
import { copyFile, mkdir } from "node:fs/promises";

import {
  initProject,
  InitFilesExistError,
} from "../lib/scripts/init-project.ts";
import {
  validateFeaturesJson,
  formatValidationReport,
} from "../lib/scripts/validate-structure.ts";
import { syncAgents } from "../lib/config.ts";
import { pluginRoot } from "../lib/paths.ts";
import { resolveProjectDir } from "../lib/project.ts";

/**
 * Copy the plugin's `shared/ghs.default.json` to `<projectDir>/.ghs/ghs.json`
 * when the user doesn't already have one. Returns true when a copy happened,
 * false when the destination already existed.
 */
async function seedGhsJsonIfMissing(
  projectDir: string,
  pluginRootDir: string,
): Promise<boolean> {
  const dest = join(resolve(projectDir), ".ghs", "ghs.json");
  const destFile = Bun.file(dest);
  if (await destFile.exists()) {
    return false;
  }
  const src = join(pluginRootDir, "shared", "ghs.default.json");
  // Ensure `.ghs/` exists (initProject already created it, but be defensive
  // — this function is also callable on a project where only .opencode/
  // exists).
  await mkdir(join(resolve(projectDir), ".ghs"), { recursive: true });
  await copyFile(src, dest);
  return true;
}

/**
 * The `ghs-init` tool definition. Registered by the plugin entry point under
 * the `ghs-init` key (hyphenated, per spike 001 / D1).
 */
export const initTool = tool({
  description:
    "Initialise the Golden Hoop Spell (ghs) tracking files for the current project. " +
    "Creates `.ghs/features.json`, `.ghs/progress.md`, `.ghs/ghs.json` (with default model IDs), " +
    "and the 3 subagent markdown files under `.opencode/agents/ghs-*.md`. " +
    "Also appends `.ghs` to `.gitignore`. " +
    "Re-run with `force: true` to overwrite existing `.ghs/features.json` and `.ghs/progress.md`.",
  args: {
    project_name: tool.schema
      .string()
      .describe("Human-readable project name (written into features.json#project.name)."),
    description: tool.schema
      .string()
      .optional()
      .describe(
        "Optional project description. Defaults to '<project_name> project' when omitted.",
      ),
    project_dir: tool.schema
      .string()
      .optional()
      .describe(
        "Absolute path of the project root to initialise. Defaults to the opencode session's worktree/directory.",
      ),
    force: tool.schema
      .boolean()
      .optional()
      .describe(
        "When true, overwrite existing `.ghs/features.json` and `.ghs/progress.md`. Default false.",
      ),
  },
  async execute(
    args: {
      project_name: string;
      description?: string;
      project_dir?: string;
      force?: boolean;
    },
    ctx: ToolContext,
  ): Promise<string> {
    const projectDir = args.project_dir
      ? resolve(args.project_dir)
      : resolveProjectDir(ctx);
    const root = pluginRoot();

    // Step 1: create .ghs/features.json + .ghs/progress.md + .gitignore.
    let initResult;
    try {
      initResult = await initProject({
        projectName: args.project_name,
        description: args.description,
        projectDir,
        force: args.force === true,
        pluginRootPath: root,
      });
    } catch (err) {
      if (err instanceof InitFilesExistError) {
        return [
          "❌ ghs-init refused to overwrite existing files:",
          "",
          err.message,
          "",
          "Re-run with `force: true` to overwrite.",
        ].join("\n");
      }
      throw err;
    }

    // Step 2: validate the freshly-created features.json. In the happy path
    // this always passes (we just wrote it from the shared template); running
    // it here surfaces a useful confirmation to the AI and guards against a
    // corrupt shared template.
    const validation = await validateFeaturesJson(initResult.featuresFile);
    const validationReport = formatValidationReport(validation);

    // Step 3: seed .ghs/ghs.json from the plugin default if the user hasn't
    // placed one yet. Returns whether a copy happened.
    const seededGhsJson = await seedGhsJsonIfMissing(projectDir, root);

    // Step 4: render the 3 subagent markdowns into .opencode/agents/.
    const sync = await syncAgents(projectDir, root);

    // Format the result string the AI sees. Keep it human-readable and
    // include the validation outcome + the restart hint (syncAgents writes
    // files but opencode only picks them up on next process start — spike 004).
    const lines: string[] = [];
    lines.push("=== ghs-init complete ===");
    lines.push("");
    lines.push(`Project directory: ${initResult.outputDir}`);
    lines.push(`Project name:      ${initResult.projectName}`);
    lines.push(`Description:       ${initResult.projectDescription}`);
    lines.push("");
    lines.push("Files created:");
    lines.push(`  - ${initResult.featuresFile}`);
    lines.push(`  - ${initResult.progressFile}`);
    if (initResult.gitignoreUpdated) {
      lines.push(`  - ${initResult.gitignoreFile} (appended \`.ghs\`)`);
    } else {
      lines.push(
        `  - ${initResult.gitignoreFile} (already contained \`.ghs\`)`,
      );
    }
    if (seededGhsJson) {
      lines.push(`  - ${join(projectDir, ".ghs", "ghs.json")} (copied from plugin default)`);
    }
    for (const agentPath of sync.written) {
      lines.push(`  - ${agentPath}`);
    }
    lines.push("");
    lines.push("Resolved model IDs:");
    lines.push(`  context:  ${sync.models.context}${sync.defaults_used ? "  (default)" : ""}`);
    lines.push(`  designer: ${sync.models.designer}${sync.defaults_used ? "  (default)" : ""}`);
    lines.push(`  reviewer: ${sync.models.reviewer}${sync.defaults_used ? "  (default)" : ""}`);
    if (sync.defaults_used) {
      lines.push("");
      lines.push(
        "ℹ️  Model IDs came from the plugin default. Edit `.ghs/ghs.json` to customise, then call `ghs-config`.",
      );
    }
    lines.push("");
    lines.push("Restart your OpenCode session for the new agent definitions to take effect.");
    lines.push("");
    lines.push("--- features.json validation ---");
    lines.push(validationReport);

    return lines.join("\n");
  },
});
