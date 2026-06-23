// `ghs-config` tool — render agent markdown templates from the user's
// `.ghs/ghs.json` config (with field-level fallback to plugin defaults) and
// write them to `<projectDir>/.opencode/agents/ghs-*.md`.
//
// This is the R3 (Round 6) user-facing entry point: users edit
// `.ghs/ghs.json`, invoke `ghs-config`, then restart OpenCode to pick up the
// new agent definitions. The substitution-then-restart mechanism was
// validated by Phase 0 spike 004.
//
// The tool is a thin wrapper around `syncAgents` / `renderAgentTemplate` /
// `loadGhsConfig` from `src/lib/config.ts`. Responsibilities unique to the
// tool layer:
//   - Resolve `project_dir` from the tool context when not supplied.
//   - Refuse to run before `ghs-init` (i.e. when `.ghs/` is absent).
//   - Support `dry_run: true` to preview without writing.
//   - Catch Zod parse errors on a malformed `.ghs/ghs.json` and return the
//     error text instead of writing files (acceptance criterion #5).
//   - Emit the "Restart your OpenCode session" hint on every successful run,
//     because OpenCode loads agent markdown only at process startup (no
//     hot-reload — see spike 004 + spike 002).

import { tool } from "@opencode-ai/plugin";
import { resolve } from "node:path";
import {
  loadGhsConfig,
  renderAgentTemplate,
  syncAgents,
  fileExists,
} from "../lib/config.js";
import { pluginRoot } from "../lib/paths.js";
import { resolveProjectDir } from "../lib/project.js";

// Authoritative agent names — must match `AGENT_NAMES` in src/lib/config.ts.
// Kept in sync so the dry-run preview enumerates the exact same files that a
// real sync would write.
const AGENTS = ["ghs-context-explorer", "ghs-plan-designer", "ghs-plan-reviewer"] as const;

/**
 * Build the structured success message returned by a real (non-dry-run)
 * sync. Lists the written file paths, the resolved model IDs, whether any
 * defaults leaked through, and the mandatory restart hint.
 */
function formatSyncResult(result: {
  written: string[];
  models: { context: string; designer: string; reviewer: string };
  defaults_used: boolean;
}): string {
  const lines: string[] = [];
  lines.push("Agent markdown files synced:");
  for (const path of result.written) {
    lines.push(`  - ${path}`);
  }
  lines.push("");
  lines.push("Resolved model IDs:");
  lines.push(`  - context:  ${result.models.context}`);
  lines.push(`  - designer: ${result.models.designer}`);
  lines.push(`  - reviewer: ${result.models.reviewer}`);
  lines.push("");
  lines.push(`Defaults used: ${result.defaults_used ? "yes" : "no"}`);
  if (result.defaults_used) {
    lines.push(
      "Some model IDs fell back to plugin defaults. To customize, edit `.ghs/ghs.json` and re-run ghs-config.",
    );
  }
  lines.push("");
  // Critical: OpenCode loads agent markdown only at process startup. Spike
  // 004 confirmed writes don't hot-reload — users MUST restart for changes
  // to take effect.
  lines.push("Restart your OpenCode session for the new agent definitions to take effect.");
  return lines.join("\n");
}

/**
 * Build the dry-run preview message. Renders every template (so malformed
 * templates still surface as errors) but writes nothing.
 */
async function formatDryRun(
  projectDir: string,
  root: string,
): Promise<string> {
  const { config, defaults_used } = await loadGhsConfig(projectDir, root);
  const lines: string[] = [];
  lines.push("Dry run — no files will be written.");
  lines.push("");
  lines.push("Resolved model IDs:");
  lines.push(`  - context:  ${config.models.context}`);
  lines.push(`  - designer: ${config.models.designer}`);
  lines.push(`  - reviewer: ${config.models.reviewer}`);
  lines.push(`Defaults used: ${defaults_used ? "yes" : "no"}`);
  lines.push("");
  lines.push("Files that would be written:");
  for (const name of AGENTS) {
    const rendered = await renderAgentTemplate(name, config, root);
    const outPath = resolve(projectDir, ".opencode", "agents", `${name}.md`);
    lines.push(`--- ${outPath} ---`);
    lines.push(rendered);
    lines.push("");
  }
  // Even in dry-run we surface the restart hint, because a subsequent real
  // invocation will still require a restart.
  lines.push("Restart your OpenCode session for the new agent definitions to take effect.");
  return lines.join("\n");
}

/**
 * The `ghs-config` tool definition. Registered under the hyphenated key
 * `ghs-config` (Phase 0 spike 001 confirmed hyphenated keys load and
 * round-trip correctly).
 */
export const configTool = tool({
  description:
    "Regenerate the ghs-* subagent markdown files (.opencode/agents/ghs-{context-explorer,plan-designer,plan-reviewer}.md) " +
    "from the user's .ghs/ghs.json config with field-level fallback to plugin defaults. " +
    "Use this after editing .ghs/ghs.json to change the model IDs used by the plan dispatcher's three roles. " +
    "OpenCode loads agents only at startup, so you must restart your session after running this. " +
    "Requires .ghs/ to exist (run ghs-init first).",
  args: {
    project_dir: tool.schema
      .string()
      .optional()
      .describe(
        "Project directory containing .ghs/. Defaults to the current session's worktree/directory.",
      ),
    dry_run: tool.schema
      .boolean()
      .optional()
      .describe(
        "If true, render templates and return a preview WITHOUT writing any files.",
      ),
  },
  async execute(args, ctx) {
    const projectDir = args.project_dir ?? resolveProjectDir(ctx);
    const root = pluginRoot();

    // Gate 1: refuse to run before `ghs-init`. We check for `.ghs/ghs.json`
    // (the file ghs-init actually creates) rather than the `.ghs/` directory,
    // because `Bun.file().exists()` returns false for directories — checking
    // the directory would always fail.
    const ghsJsonExists = await fileExists(resolve(projectDir, ".ghs", "ghs.json"));
    if (!ghsJsonExists) {
      return "Run ghs-init first.";
    }

    if (args.dry_run) {
      // Dry-run path: render + preview, no writes. Malformed ghs.json
      // surfaces a Zod error here (loadGhsConfig throws) and the catch
      // below formats it without writing.
      try {
        return await formatDryRun(projectDir, root);
      } catch (err) {
        return formatConfigError(err);
      }
    }

    // Real path: load + render + write. We split the load step out so we
    // can catch Zod parse errors on a malformed .ghs/ghs.json and return
    // the error text WITHOUT having already written any partial files
    // (acceptance criterion #5: "returns the Zod parse error and does NOT
    // write any files"). syncAgents internally calls loadGhsConfig again
    // — a redundant parse, but cheap, and keeps the tool layer's
    // error-gate logic explicit.
    try {
      await loadGhsConfig(projectDir, root);
    } catch (err) {
      return formatConfigError(err);
    }

    const result = await syncAgents(projectDir, root);
    return formatSyncResult(result);
  },
});

/**
 * Format a config-load / template-render error as a readable string. Zod
 * errors get their `.message` (a JSON string listing every issue); other
 * errors get their `.message` verbatim. Used in both dry-run and real
 * paths so malformed configs never silently succeed.
 */
function formatConfigError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `Failed to load ghs config: ${msg}\n\nNo files were written. Fix the error above and re-run ghs-config.`;
}
