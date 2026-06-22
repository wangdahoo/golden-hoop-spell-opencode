// Plugin entry point — the OpenCode plugin function.
//
// This module wires together everything implemented in s1-feat-005 through
// s4-feat-005:
//   - Registers all 10 tools (ghs-init / ghs-config / ghs-plan-start /
//     ghs-plan-review / ghs-plan-finalize / ghs-sprint / ghs-code /
//     ghs-status / ghs-archive / ghs-force-archive) under their hyphenated
//     keys — the complete plan §3.4 D2 tool surface (Phase 0 spike 001
//     confirmed hyphenated keys load + round-trip correctly).
//   - Injects 8 `/ghs-*` slash commands into the OpenCode Config via the
//     `config` hook. Source analysis of OpenCode's plugin/index.ts +
//     config/config.ts + command/index.ts confirmed that the `config` hook
//     receives the same mutable Config object reference that the Command
//     service later reads via `config.get()`. The hook runs during plugin
//     initialization (before the HTTP server accepts requests), so the
//     injected commands are available on the very first startup — no file
//     writes or restart needed.
//   - Pushes a single-line workflow hint into the AI's system prompt via the
//     `experimental.chat.system.transform` hook (Phase 0 spike 001 confirmed
//     strings pushed here land in the system prompt verbatim).
//
// The hint lists all 10 implemented tools and the full init → plan → sprint
// → code → status → archive workflow. Per spike 003 divergence, the hint text
// uses descriptive phrasing ("codegraph MCP tools") rather than hardcoding
// double-prefixed tool names (codegraph_codegraph_*) when those tools are
// introduced — those names depend on the MCP server name and would be brittle.

import type { Plugin } from "@opencode-ai/plugin";

import { initTool } from "./tools/init.ts";
import { statusTool } from "./tools/status.ts";
import { archiveTool } from "./tools/archive.ts";
import { forceArchiveTool } from "./tools/force-archive.ts";
import { configTool } from "./tools/config.ts";
import { sprintTool } from "./tools/sprint.ts";
import { planStartTool } from "./tools/plan-start.ts";
import { planReviewTool } from "./tools/plan-review.ts";
import { planFinalizeTool } from "./tools/plan-finalize.ts";
import { codeTool } from "./tools/code.ts";
import { GHS_COMMANDS } from "./lib/commands.ts";
import { recordTodoTick } from "./lib/todo-tracker.ts";

// -----------------------------------------------------------------------------
// Default session key for the disconnect-detection Map (plan §3.1 注入点①).
// -----------------------------------------------------------------------------
//
// The opencode `event` hook input is `{ event: Event }` — there is no
// top-level sessionID on the hook input itself (unlike `chat.message` /
// `tool.execute.after` which carry `sessionID` directly). For `todo.updated`
// specifically the session id is nested at `event.properties.sessionID`, so
// after the narrowing guard we extract it from there; this default constant is
// only used as a defensive fallback if properties is unexpectedly absent (R8
// belt-and-suspenders — the type system says it's always present, but the
// guard already trades strictness for runtime safety).
const DEFAULT_SESSION_ID = "_default";

/**
 * Single-line hint pushed into the AI's system prompt on every chat. Lists
 * all 10 implemented tool names, the workflow order, and the model-config
 * entry point. The plan-dispatcher subagents (ghs-context-haiku /
 * ghs-plan-designer / ghs-plan-reviewer) are invoked by the plan tools via
 * the Task tool; ghs-code's coding subagent is dispatched the same way
 * after ghs-code returns its feature-impl prompt.
 *
 * Kept to one line so it shows up as a single contiguous block in the
 * rendered system prompt (easier for the AI to spot). The user-facing note
 * about `.ghs/ghs.json` is critical for R3: model IDs are user-configurable
 * but only take effect after a `ghs-config` call + OpenCode restart.
 */
const SYSTEM_HINT_TEXT =
  "Golden Hoop Spell (ghs) plugin — orchestrates a structured init → plan → sprint → code → status → archive workflow. " +
  "Tools implemented: ghs-init, ghs-config, ghs-plan-start, ghs-plan-review, ghs-plan-finalize, ghs-sprint, ghs-code, ghs-status, ghs-archive, ghs-force-archive. " +
  "Workflow order: ghs-init → ghs-config → ghs-plan-start → ghs-plan-review → ghs-plan-finalize → ghs-sprint → ghs-code → ghs-status → ghs-archive. " +
  "Model IDs for the 3 plan-dispatcher subagents are user-configurable via `.ghs/ghs.json`; after editing run `ghs-config` then restart OpenCode. " +
  "Slash commands /ghs-init, /ghs-config, /ghs-plan-start, /ghs-sprint, /ghs-code, /ghs-status, /ghs-archive, /ghs-force-archive are auto-registered on startup. " +
  // --- Todo Discipline (plan §3.1 注入点①) -----------------------------------
  // Nudges the main AI to drive the right-side TODO panel via the built-in
  // `todowrite` tool — the ONLY thing that can render to that panel (C1).
  // Without this, the panel stays empty and the disconnect-detection signals
  // (todo.updated events) never fire, making mechanism one blind. This is a
  // best-effort nudge, not a program-level enforcement.
  "Todo Discipline: when entering a ghs multi-step workflow (plan / sprint / code), call the built-in `todowrite` tool to build a stage checklist and keep it in sync as stages advance — every stage transition marks the prior stage `completed` and the current one `in_progress`. The `▶ NEXT ACTION` anchor at the end of each tool response is mandatory: execute it via the named tool call, do NOT skip ahead or take over the next step yourself. This keeps the right-side TODO panel accurate and lets the disconnect-detection state machine observe your progress.";

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
    "ghs-plan-start": planStartTool,
    "ghs-plan-review": planReviewTool,
    "ghs-plan-finalize": planFinalizeTool,
    "ghs-sprint": sprintTool,
    "ghs-code": codeTool,
    "ghs-status": statusTool,
    "ghs-archive": archiveTool,
    "ghs-force-archive": forceArchiveTool,
  },
  config: async (cfg) => {
    cfg.command ??= {};
    Object.assign(cfg.command, GHS_COMMANDS);
  },
  // --- event hook (plan §3.1 注入点①) ---------------------------------------
  // Feeds `todo.updated` ticks into the disconnect-detection Map maintained
  // by `src/lib/todo-tracker.ts`. This is the ONLY way the plugin can observe
  // right-side TODO panel activity — there is no read-todo API on the Hooks
  // surface, so the `todo.updated` event is the sole旁路 signal (plan §3.1).
  //
  // Defensive discriminator guard (plan §3.1 / R8): the `Event` union
  // (~32 members in types.gen.d.ts:602) is *expected* to carry a `type`
  // literal on every member, but a missing field would throw
  // `undefined.type` without this guard. The `("type" in input.event)`
  // short-circuit makes access safe regardless of the runtime shape; the
  // `test/event-discriminator.test.ts` suite additionally verifies union
  // completeness (every member has a `type` literal at compile time +
  // a matching runtime sample).
  //
  // sessionID source: the event hook input is `{ event: Event }` with no
  // top-level sessionID; after narrowing to EventTodoUpdated the sessionID
  // lives at `event.properties.sessionID`, which we read there. If
  // properties is unexpectedly absent we fall back to DEFAULT_SESSION_ID so
  // tracking degrades gracefully rather than throwing.
  event: async (input) => {
    if ("type" in input.event && input.event.type === "todo.updated") {
      const props = (input.event as { properties?: { sessionID?: string } })
        .properties;
      const sessionID =
        props && typeof props.sessionID === "string"
          ? props.sessionID
          : DEFAULT_SESSION_ID;
      recordTodoTick(sessionID);
    }
  },
  "experimental.chat.system.transform": async (_input, output) => {
    output.system.push(SYSTEM_HINT_TEXT);
  },
});
