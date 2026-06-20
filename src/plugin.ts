// Plugin entry point — the OpenCode plugin function.
//
// This module wires together everything implemented in s1-feat-005 through
// s2-feat-003:
//   - Registers the 6 currently-implemented tools (ghs-init / ghs-config /
//     ghs-sprint / ghs-status / ghs-archive / ghs-force-archive) under their
//     hyphenated keys (Phase 0 spike 001 confirmed hyphenated keys load +
//     round-trip correctly).
//   - Pushes a single-line workflow hint into the AI's system prompt via the
//     `experimental.chat.system.transform` hook (Phase 0 spike 001 confirmed
//     strings pushed here land in the system prompt verbatim).
//
// The hint lists only the 6 implemented tools. The remaining 4 (ghs-code,
// ghs-plan-start, ghs-plan-review, ghs-plan-finalize) arrive in Sprints 3-4
// and will be added to the hint as they ship. Per spike 003 divergence, the
// hint text uses descriptive phrasing ("codegraph MCP tools") rather than
// hardcoding double-prefixed tool names (codegraph_codegraph_*) when those
// tools are introduced — those names depend on the MCP server name and would
// be brittle.

import type { Plugin } from "@opencode-ai/plugin";

import { initTool } from "./tools/init.ts";
import { statusTool } from "./tools/status.ts";
import { archiveTool } from "./tools/archive.ts";
import { forceArchiveTool } from "./tools/force-archive.ts";
import { configTool } from "./tools/config.ts";
import { sprintTool } from "./tools/sprint.ts";

/**
 * Single-line hint pushed into the AI's system prompt on every chat. Lists
 * the 6 implemented tool names (ghs-init, ghs-config, ghs-sprint, ghs-status,
 * ghs-archive, ghs-force-archive), the workflow order, and the model-config
 * entry point. The plan-dispatcher subagents (ghs-context-haiku /
 * ghs-plan-designer / ghs-plan-reviewer) and the plan tools
 * (ghs-plan-start / ghs-plan-review / ghs-plan-finalize / ghs-code) are NOT
 * listed yet — they arrive in Sprints 3-4 and will be added to this hint
 * when implemented (forward-compat: the hint grows as tools ship).
 *
 * Kept to one line so it shows up as a single contiguous block in the
 * rendered system prompt (easier for the AI to spot). The user-facing note
 * about `.ghs/ghs.json` is critical for R3: model IDs are user-configurable
 * but only take effect after a `ghs-config` call + OpenCode restart.
 */
const SYSTEM_HINT_TEXT =
  "Golden Hoop Spell (ghs) plugin — orchestrates a structured init → sprint → code → status → archive workflow. " +
  "Tools implemented: ghs-init, ghs-config, ghs-sprint, ghs-status, ghs-archive, ghs-force-archive. " +
  "Workflow order: ghs-init → ghs-config → ghs-sprint → (ghs-plan-start → ghs-code → ghs-status → ghs-archive). " +
  "Model IDs for the 3 plan-dispatcher subagents are user-configurable via `.ghs/ghs.json`; after editing run `ghs-config` then restart OpenCode.";

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
    "ghs-config": configTool,
    "ghs-sprint": sprintTool,
    "ghs-status": statusTool,
    "ghs-archive": archiveTool,
    "ghs-force-archive": forceArchiveTool,
  },
  "experimental.chat.system.transform": async (_input, output) => {
    output.system.push(SYSTEM_HINT_TEXT);
  },
});
