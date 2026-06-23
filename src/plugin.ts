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
import { parseCompletionSignalTool } from "./tools/parse-completion-signal.ts";
import { updateFeatureStatusTool } from "./tools/update-feature-status.ts";
import { GHS_COMMANDS } from "./lib/commands.ts";
import { recordTodoTick, getStageSignature } from "./lib/todo-tracker.ts";

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
 * all 10 implemented tool names, the workflow order, the model-config entry
 * point, and a pointer to the `ghs` skill (plan §3.3 机制三). The
 * plan-dispatcher subagents (ghs-context-explorer / ghs-plan-designer /
 * ghs-plan-reviewer) are invoked by the plan tools via the Task tool;
 * ghs-code's coding subagent is dispatched the same way after ghs-code
 * returns its feature-impl prompt.
 *
 * Slimmed from the pre-机制三 shape (s1-feat-012): the detailed orchestration
 * rules — stage-by-stage workflow discipline, broken-flow recovery, the
 * reading list — now live in `shared/skill/ghs/SKILL.md` (copied to
 * `<projectDir>/.opencode/skill/ghs/SKILL.md` by ghs-init, surfaced in the
 * system prompt as the `ghs` skill). This hint points at that skill and
 * retains only what mechanism one needs as an inline nudge:
 *   - Tool list + workflow order (regression contract: test/commands.test.ts).
 *   - Todo Discipline segment (plan §3.1 注入点① / C1 — the right-side TODO
 *     panel's only driver is the built-in `todowrite` tool, which the
 *     disconnect-detection state machine observes via `todo.updated` events;
 *     without this nudge the panel stays empty and mechanism one is blind).
 *   - ▶ NEXT ACTION anchoring (don't skip the next tool call).
 *
 * Kept to one line so it shows up as a single contiguous block in the
 * rendered system prompt (easier for the AI to spot). The user-facing note
 * about `.ghs/ghs.json` is critical for R3: model IDs are user-configurable
 * but only take effect after a `ghs-config` call + OpenCode restart.
 */
const SYSTEM_HINT_TEXT =
  "Golden Hoop Spell (ghs) plugin — orchestrates a structured init → plan → sprint → code → status → archive workflow. " +
  "Tools implemented: ghs-init, ghs-config, ghs-plan-start, ghs-plan-review, ghs-plan-finalize, ghs-sprint, ghs-code, ghs-parse-completion-signal, ghs-update-feature-status, ghs-status, ghs-archive, ghs-force-archive. " +
  "Workflow order: ghs-init → ghs-config → ghs-plan-start → ghs-plan-review → ghs-plan-finalize → ghs-sprint → ghs-code → ghs-status → ghs-archive. " +
  "Model IDs for the 3 plan-dispatcher subagents are user-configurable via `.ghs/ghs.json`; after editing run `ghs-config` then restart OpenCode. " +
  "Slash commands /ghs-init, /ghs-config, /ghs-plan-start, /ghs-sprint, /ghs-code, /ghs-status, /ghs-archive, /ghs-force-archive are auto-registered on startup. " +
  // --- Skill pointer (plan §3.3 机制三) --------------------------------------
  // Detailed orchestration rules (stage discipline, broken-flow recovery,
  // reading list) live in the ghs skill — SYSTEM_HINT is now a pointer, not
  // a duplicate. SKILL.md is copied by ghs-init to .opencode/skill/ghs/
  // and surfaces in the system prompt's available_skills list.
  "Detailed orchestration rules (stage-by-stage workflow discipline, broken-flow recovery, reading list) live in the `ghs` skill at `.opencode/skill/ghs/SKILL.md` — consult it when a stage is unfamiliar. " +
  // --- Todo Discipline (plan §3.1 注入点①, retained through 机制三 slim) -------
  // Best-effort nudge, not program-level enforcement. Kept inline (rather
  // than moved entirely to SKILL.md) because mechanism one depends on the
  // main AI calling `todowrite` — the only thing that can render to the
  // right-side TODO panel (C1). The fuller justification lives in SKILL.md.
  "Todo Discipline: when entering a ghs multi-step workflow (plan / sprint / code), call the built-in `todowrite` tool to seed a stage checklist and refresh it on every stage transition (prior stage → `completed`, current → `in_progress`). The `▶ NEXT ACTION` anchor at the end of each tool response is mandatory — execute it via the named tool call; do NOT skip ahead or take over the next step yourself.";

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
    "ghs-parse-completion-signal": parseCompletionSignalTool,
    "ghs-update-feature-status": updateFeatureStatusTool,
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
  // --- tool.execute.after hook (plan §3.1 注入点③ 兜底 / channel B) ----------
  // Best-effort tool-card stage annotation. The MAIN path (channel A) is
  // `ctx.metadata()` inside each ghs tool's execute (feat-005); this hook is
  // the FALLBACK that runs after execute returns. Channel B is decoupled from
  // channel A (plan §3.1): if either fails the other is unaffected, and this
  // hook must never throw into the tool-result pipeline.
  //
  // R4 gate (first line): non-ghs tools are returned immediately — no-op. The
  // hook MUST NOT pollute other plugins' / built-in tool cards (todowrite /
  // read / bash / etc.). The `test/plugin-hook.test.ts` suite enforces this
  // with a sample of non-ghs tools.
  //
  // Stage derivation reuses `getStageSignature` (feat-002). It returns null
  // for single-step ghs tools (init/config/sprint/status/archive), terminal
  // plan states, or any status.json read failure (R7) — in all those cases we
  // skip annotation (no meaningful stage to show) and leave output untouched.
  //
  // Decoupling from channel A: we deliberately do NOT call classifyStaleState
  // here. The main path already called it (advancing lastStageSeenByTool); a
  // second call would double-advance the disconnect-detection state machine.
  // This hook only sets the visual title + a minimal metadata blob marking
  // its source — it is a visual fallback, not a second classification pass.
  //
  // projectDir: the hook input carries `{ tool, sessionID, callID, args }`
  // with NO project context (unlike ToolContext). `process.cwd()` is the only
  // available signal — acceptable for a best-effort fallback because
  // getStageSignature already degrades to null on any read failure (R7), so a
  // wrong cwd simply yields "skip" rather than a crash. (AGENTS.md's
  // "never process.cwd()" rule is about PLUGIN ROOT / asset resolution, not
  // the project dir.)
  "tool.execute.after": async (input, output) => {
    // R4 gate — MUST be the first statement.
    if (!input.tool.startsWith("ghs-")) return;

    let stage: string | null = null;
    try {
      stage = await getStageSignature(
        input.tool,
        process.cwd(),
        (input.args ?? {}) as Record<string, unknown>,
      );
    } catch {
      // R7: status.json read failure → skip annotation, do not propagate.
      return;
    }
    if (stage === null) return;

    output.title = `[ghs] ${stage}`;
    output.metadata = { ghsStage: stage, source: "tool.execute.after" };
  },
  "experimental.chat.system.transform": async (_input, output) => {
    output.system.push(SYSTEM_HINT_TEXT);
  },
});
