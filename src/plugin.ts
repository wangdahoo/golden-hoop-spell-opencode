// Plugin entry point — the OpenCode plugin function.
//
// This module wires together everything implemented in s1-feat-005 through
// s1-feat-010:
//   - Registers the 5 foundational tools (ghs-init / ghs-status / ghs-archive
//     / ghs-force-archive / ghs-config) under their hyphenated keys (Phase 0
//     spike 001 confirmed hyphenated keys load + round-trip correctly).
//   - Pushes a single-line workflow hint into the AI's system prompt via the
//     `experimental.chat.system.transform` hook (Phase 0 spike 001 confirmed
//     strings pushed here land in the system prompt verbatim).
//
// The hint is forward-looking: it lists ALL 10 ghs-* tool names even though
// only 5 are implemented this sprint. The missing 5 (ghs-sprint, ghs-code,
// ghs-plan-start, ghs-plan-review, ghs-plan-finalize) arrive in Sprints 2-4.
// Per spike 003 divergence, the hint text uses descriptive phrasing
// ("codegraph MCP tools") rather than hardcoding double-prefixed tool names
// (codegraph_codegraph_*) — those names depend on the MCP server name and
// would be brittle.

import type { Plugin } from "@opencode-ai/plugin";

import { initTool } from "./tools/init.ts";
import { statusTool } from "./tools/status.ts";
import { archiveTool } from "./tools/archive.ts";
import { forceArchiveTool } from "./tools/force-archive.ts";
import { configTool } from "./tools/config.ts";

/**
 * Single-line hint pushed into the AI's system prompt on every chat. Lists
 * all 10 tool names (only 5 implemented this sprint), the 3 plan-dispatcher
 * subagents, the workflow order, and the model-config entry point.
 *
 * Kept to one line so it shows up as a single contiguous block in the
 * rendered system prompt (easier for the AI to spot). The user-facing note
 * about `.ghs/ghs.json` is critical for R3: model IDs are user-configurable
 * but only take effect after a `ghs-config` call + OpenCode restart.
 */
const SYSTEM_HINT_TEXT =
  "Golden Hoop Spell (ghs) plugin — orchestrates a multi-role plan/sprint/code workflow. " +
  "Tools: ghs-init, ghs-config, ghs-sprint, ghs-code, ghs-status, ghs-archive, ghs-force-archive, " +
  "ghs-plan-start, ghs-plan-review, ghs-plan-finalize. " +
  "Subagents (dispatched via the Task tool): ghs-context-haiku (extracts context using the codegraph MCP tools), " +
  "ghs-plan-designer, ghs-plan-reviewer. " +
  "Workflow order: ghs-init → ghs-config → (ghs-plan-start → ghs-sprint → ghs-code → ghs-status → ghs-archive). " +
  "Model IDs for the 3 subagents are user-configurable via `.ghs/ghs.json`; after editing run `ghs-config` then restart OpenCode.";

/**
 * The ghs OpenCode plugin. Default-exported from `src/index.ts`.
 *
 * Signature conforms to the canonical `Plugin` type from
 * `@opencode-ai/plugin`: `async (input) => Hooks`. We don't currently use
 * the input (session/project context); tools resolve the project dir from
 * their own `ToolContext` (see `src/lib/project.ts`).
 */
export const ghsPlugin: Plugin = async () => ({
  tool: {
    "ghs-init": initTool,
    "ghs-status": statusTool,
    "ghs-archive": archiveTool,
    "ghs-force-archive": forceArchiveTool,
    "ghs-config": configTool,
  },
  "experimental.chat.system.transform": async (_input, output) => {
    output.system.push(SYSTEM_HINT_TEXT);
  },
});
