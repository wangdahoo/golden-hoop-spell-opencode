// `ghs-status` tool — show the current project's status.
//
// Thin wrapper around `status()` from `src/lib/scripts/status.ts`. Resolves
// the project dir (explicit arg wins; otherwise `resolveProjectDir(ctx)`),
// invokes the formatter, and returns the formatted text for the AI to read.
//
// The returned string is byte-identical to what the Python `status.py`
// script would have printed to stdout (verified by the equivalence tests
// in `test/equivalence/status.test.ts`).

import { tool } from "@opencode-ai/plugin";
import type { ToolContext } from "@opencode-ai/plugin/tool";
import { resolve } from "node:path";

import { status } from "../lib/scripts/status.ts";
import { resolveProjectDir } from "../lib/project.ts";

/**
 * The `ghs-status` tool definition. Registered under the `ghs-status` key.
 */
export const statusTool = tool({
  description:
    "Show the current ghs project status: project name/description, per-sprint " +
    "feature counts (completed/in_progress/pending/blocked), the in-progress feature, " +
    "the next ready feature, and recent progress.md session entries. " +
    "Read-only — does not modify any files.",
  args: {
    project_dir: tool.schema
      .string()
      .optional()
      .describe(
        "Absolute path of the project root. Defaults to the opencode session's worktree/directory.",
      ),
  },
  async execute(
    args: { project_dir?: string },
    ctx: ToolContext,
  ): Promise<string> {
    const projectDir = args.project_dir
      ? resolve(args.project_dir)
      : resolveProjectDir(ctx);

    const result = await status({ projectDir });
    // `status()` returns `{ text, exitCode }`. exitCode is 1 when
    // features.json is missing — the text already carries the "not found"
    // message, so we just return it verbatim. (We don't surface exitCode as
    // a tool error because the message is more useful to the AI than an
    // opaque failure.)
    return result.text;
  },
});
