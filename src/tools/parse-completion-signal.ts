// `ghs-parse-completion-signal` tool — thin shell over the pure function
// `parseCompletionSignal` (src/lib/scripts/parse-completion-signal.ts).
//
// Pure-computation tool: no project_dir, no IO. Calls the pure function and
// serialises the result to a canonical JSON string via `serializeResult`.
// Thin-shell pattern mirrors sprintTool → appendSprint (but without the
// read/write disk step).

import { tool } from "@opencode-ai/plugin";
import {
  parseCompletionSignal,
  serializeResult,
} from "../lib/scripts/parse-completion-signal.ts";

export const parseCompletionSignalTool = tool({
  description:
    "Parse a coding subagent's raw output for the completion signal " +
    "(FEATURE COMPLETE: <id> / FEATURE BLOCKED: <id> - <reason>). " +
    "Returns a compact JSON object: { status, feature_id, reason, strategy, " +
    "warnings }. Call this after each coding subagent returns, before calling " +
    "ghs-update-feature-status.",
  args: {
    raw_text: tool.schema
      .string()
      .describe("The subagent's raw output text to parse."),
    feature_id: tool.schema
      .string()
      .describe(
        "The feature id the subagent was implementing (e.g. s5-feat-003).",
      ),
    min_length: tool.schema
      .number()
      .optional()
      .describe("Minimum raw text length to attempt parsing (default 50)."),
  },
  async execute(args: {
    raw_text: string;
    feature_id: string;
    min_length?: number;
  }): Promise<string> {
    const result = parseCompletionSignal(args.raw_text, {
      feature_id: args.feature_id,
      min_length: args.min_length,
    });
    return serializeResult(result);
  },
});
