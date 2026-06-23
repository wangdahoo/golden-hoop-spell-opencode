// `ghs-plan-start` tool — entry point of the 3-role plan dispatcher.
//
// This is the s3-feat-006 productisation of the source plugin's plan dispatcher
// Detection phase (plan §3.5 / §3.7 step 1). It is a *thin wrapper* composing:
//   - `resolveProjectDir(ctx)`      (s1-feat-006) — explicit arg overrides the
//                                                        opencode session's dir.
//   - `detectCodegraph(projectDir)` (s3-feat-002) — R1 runtime probe for
//                                                        `.codegraph/`.
//   - `writePlanStatus(...)`        (s3-feat-005) — persist the initial
//                                                        `status.json` carrying
//                                                        `codegraph_available`.
//   - `CONTEXT_CODEGRAPH_PROMPT` /  (s3-feat-004) — the context-collection
//     `CONTEXT_GREP_PROMPT`             dispatch directive chosen by the probe.
//
// The tool `execute` never calls an LLM and never touches the agent registry.
// It only:
//   1. resolves the project dir,
//   2. probes codegraph availability,
//   3. generates a `{date}-{slug}` plan_id,
//   4. writes the initial status.json (round 1, status `designing`,
//      codegraph_available = probe result),
//   5. returns an LLM-facing dispatch directive telling the main chat AI to
//      spawn the `ghs-context-explorer` subagent via the Task tool, and then —
//      once the snapshot is back — to feed it to `ghs-plan-review(snapshot)`.
//
// The dispatch directive carries the codegraph-vs-grep prompt inline so the AI
// has everything it needs to drive the plan loop forward without a second tool
// round-trip. Style follows s2-feat-003's `sprint.ts` (thin wrapper, descriptive
// result text) and s1-feat-008's I/O style (Bun.file / Bun.write, no
// process.exit, no console.log). The returned string is LLM-facing prose
// (中文正文 + 英文 identifiers, per CLAUDE.md).

import { tool } from "@opencode-ai/plugin";
import type { ToolContext } from "@opencode-ai/plugin/tool";
import { resolve } from "node:path";

import { resolveProjectDir } from "../lib/project.ts";
import { detectCodegraph } from "../lib/codegraph.ts";
import {
  createInitialPlanStatus,
  writePlanStatus,
  DEFAULT_MAX_ROUNDS,
} from "../lib/state.ts";
import { CONTEXT_CODEGRAPH_PROMPT } from "../prompts/context-codegraph.ts";
import { CONTEXT_GREP_PROMPT } from "../prompts/context-grep.ts";
import { formatLocalDate } from "../lib/scripts/archive-sprint.ts";
import {
  stageHeader,
  todoDirective,
  nextActionAnchor,
  staleTodoWarning,
} from "../lib/workflow-chrome.ts";
import {
  getStageSignature,
  classifyStaleState,
} from "../lib/todo-tracker.ts";

/**
 * Maximum slug length (in characters) we keep from a sanitised requirement.
 *
 * Slugs end up in on-disk file names (`<plan_id>-status.json` etc.). A bounded
 * length keeps directory listings readable and avoids OS path-length limits
 * even when the AI hands us an unusually long requirement string. 60 chars is
 * comfortably below every common file-name ceiling while still being
 * descriptive enough to disambiguate plans on the same day.
 */
const MAX_SLUG_LENGTH = 60;

/**
 * High-level plan-workflow stages surfaced in the `todoDirective` checklist
 * (mechanism-1 injection point ②, Feature s1-feat-005). The labels match the
 * `plan:<status>` signatures produced by `getStageSignature` so the
 * in_progress marker lines up with the stage banner the same tool prepends.
 * `plan:finalizing` is the post-review hand-off bucket — it doesn't map to a
 * literal `status.json` value (finalize flips `status` to `approved`, which
 * is terminal and therefore untracked), but the AI's todo checklist still
 * benefits from showing "finalize" as a pending stage before the sprint
 * transition.
 */
const PLAN_STAGES = ["plan:designing", "plan:reviewing", "plan:finalizing"];

/**
 * Sanitise an arbitrary human-readable string into a filesystem-safe slug.
 *
 * The slug is the `<slug>` half of the `plan_id` (`{date}-{slug}`) and ends up
 * as part of every sibling file name. Rules (defensive, idempotent):
 *   - Trim + collapse internal whitespace into single `-`.
 *   - Lower-case ASCII letters / digits are kept verbatim.
 *   - Underscores, hyphens, dots are kept verbatim.
 *   - Any other character (punctuation, CJK, emoji, accented Latin, …) is
 *     collapsed into a single `-`. We deliberately do NOT try to romanise CJK
 *     — the requirement is filesystem-safety, not transliteration; the human
 *     description is preserved separately in the dispatch text.
 *   - Collapse runs of `-`/`.` separators, strip leading/trailing separators.
 *   - Truncate to {@link MAX_SLUG_LENGTH} chars on a `-` boundary.
 *   - Empty result falls back to `plan` so we always emit a non-empty slug.
 *
 * Pure function; safe to call with any input (including empty / non-string).
 */
export function slugifyRequirement(input: string): string {
  const raw = typeof input === "string" ? input : "";
  // Normalise whitespace and strip characters that are not filesystem-safe.
  // We keep ASCII alphanumerics, `-`, `_`, `.`; everything else becomes `-`.
  const sanitised = raw
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/[-.]{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .toLowerCase();

  if (sanitised.length === 0) {
    return "plan";
  }

  // Truncate on a `-` boundary so we don't end mid-word.
  const truncated =
    sanitised.length <= MAX_SLUG_LENGTH
      ? sanitised
      : sanitised.slice(0, MAX_SLUG_LENGTH).replace(/-[^-]*$/, "");
  return truncated.length === 0 ? "plan" : truncated;
}

/**
 * Build the `{YYYY-MM-DD}-{slug}` plan identifier from a requirement string.
 *
 * Exported so the sibling `ghs-plan-review` / `ghs-plan-finalize` tools (and
 * tests) can re-derive the exact same id from the same inputs without
 * duplicating the date/slug logic. `now` is injectable for deterministic tests.
 */
export function buildPlanId(
  requirement: string,
  now: Date = new Date(),
): string {
  return `${formatLocalDate(now)}-${slugifyRequirement(requirement)}`;
}

/**
 * The `ghs-plan-start` tool definition. Registered by the plugin entry point
 * under the hyphenated `ghs-plan-start` key (per spike 001 / D1).
 */
export const planStartTool = tool({
  description:
    "Start a new Golden Hoop Spell plan-generation loop (the plan dispatcher's entry point). " +
    "Resolves the project dir, probes whether `.codegraph/` is initialised (R1 runtime detection), " +
    "writes the initial `.ghs/plans/<plan_id>-status.json` (plan_id = `{YYYY-MM-DD}-{slug}`, " +
    "where the slug is derived from the optional `slug_seed`) carrying `codegraph_available`, " +
    "and returns a Task-tool dispatch directive telling the AI to spawn the `ghs-context-explorer` " +
    "subagent to collect an architecture snapshot (codegraph-aware or grep-fallback prompt) " +
    "and then feed the result to `ghs-plan-review(snapshot)`.",
  args: {
    project_dir: tool.schema
      .string()
      .optional()
      .describe(
        "Absolute path of the project root. Defaults to the opencode session's worktree/directory.",
      ),
    slug_seed: tool.schema
      .string()
      .optional()
      .describe(
        "English ASCII kebab-case slug derived by the caller from the user's requirement " +
          "description (e.g. \"a todo app\" → \"todo-app\"). Sanitised into the `<slug>` half " +
          "of the plan_id (`{YYYY-MM-DD}-{slug}`). The raw requirement stays in chat context " +
          "(fed to the context-explorer subagent) — do NOT pass the verbatim requirement here, " +
          "since CJK / mixed-script text collapses to an unhelpful slug under sanitisation. " +
          "Empty / missing → falls back to the stable `plan` stem (backward-compatible).",
      ),
  },
  async execute(
    args: { project_dir?: string; slug_seed?: string },
    ctx: ToolContext,
  ): Promise<string> {
    // (1) Resolve the project dir. Explicit arg wins; otherwise read it off
    // the opencode session context (worktree > directory).
    const projectDir = args.project_dir
      ? resolve(args.project_dir)
      : resolveProjectDir(ctx);

    // (2) Probe codegraph availability (R1). `detectCodegraph` is defensive —
    // empty/invalid paths return `false` rather than throwing, so this call
    // never crashes the tool; the worst case is we take the grep path.
    const codegraphAvailable = detectCodegraph(projectDir);

    // (3) Generate the plan_id. The slug half comes from `slug_seed` (an
    // English ASCII kebab-case slug the caller derives from the user's
    // requirement description — e.g. "a todo app" → "todo-app"). We do NOT
    // take the raw requirement itself: the dispatcher keeps that in chat
    // context (passed verbatim to the context-explorer subagent via the Task
    // tool), and CJK / mixed-script requirements would collapse to an
    // unhelpful slug under slugify. An empty / missing `slug_seed` falls back
    // to the stable `plan` stem (backward-compatible with older callers /
    // tests). With a semantic slug, same-day different-requirement starts no
    // longer collide; same-day same-slug starts still overwrite (a fresh
    // start resets the loop anyway).
    const now = new Date();
    const planId = buildPlanId(args.slug_seed?.trim() || "plan", now);
    const slug = planId.replace(/^\d{4}-\d{2}-\d{2}-/, "");

    // (4) Write the initial status.json. `createInitialPlanStatus` gives us
    // the source-skill defaults (round 1, status `designing`, max_rounds 5,
    // codegraph_available from the probe). `writePlanStatus` validates the
    // object against the Zod schema and `mkdir -p`s `.ghs/plans/` first.
    const status = createInitialPlanStatus({
      planId,
      planFile: `${planId}.md`,
      contextFile: `${planId}-context.md`,
      codegraphAvailable,
      now,
      maxRounds: DEFAULT_MAX_ROUNDS,
    });

    let statusPath: string;
    try {
      statusPath = await writePlanStatus(projectDir, status);
    } catch (err) {
      // writePlanStatus can throw if mkdir fails (permissions, disk full) or
      // if the Zod schema somehow rejects our object (shouldn't happen for a
      // freshly-built status). Surface the message so the AI/user can diagnose.
      const errorBody = [
        "❌ ghs-plan-start failed to write initial status.json:",
        "",
        (err as Error).message,
        "",
        `Project directory: ${projectDir}`,
        `Plan id:          ${planId}`,
        `Codegraph path:   ${codegraphAvailable ? "codegraph" : "grep fallback"}`,
      ].join("\n");
      // Even on the failure path we attempt the post-advance chrome read —
      // the write may have partially succeeded OR a prior plan's status may
      // still be active — but if no active plan exists getStageSignature
      // returns null and the chrome is a no-op (judgment-table row 1).
      return composeChrome({
        ctx,
        projectDir,
        toolName: "ghs-plan-start",
        toolArgs: args,
        body: errorBody,
      });
    }

    // (5) Select the context-collection dispatch directive based on the probe.
    // Both prompts are command-style LLM-facing text (中文 prose + English
    // identifiers) that tell the AI exactly how to spawn `ghs-context-explorer`
    // via the Task tool and what delimiter contract to enforce — they live in
    // `src/prompts/context-{codegraph,grep}.ts`.
    const contextPrompt = codegraphAvailable
      ? CONTEXT_CODEGRAPH_PROMPT
      : CONTEXT_GREP_PROMPT;

    // (6) Compose the result. Lead with the bookkeeping summary (plan_id,
    // status file path, codegraph path) so the AI can echo it back to the
    // user, then the dispatch directive. The directive ends with an explicit
    // "next step = ghs-plan-review(snapshot)" instruction so the loop's first
    // transition is unambiguous.
    const lines: string[] = [];
    lines.push("=== ghs-plan-start complete ===");
    lines.push("");
    lines.push(`Project directory: ${projectDir}`);
    lines.push(`Plan id:           ${planId}`);
    lines.push(`Slug:              ${slug}`);
    lines.push(`Status file:       ${statusPath}`);
    lines.push(`Round:             1 / ${status.max_rounds}`);
    lines.push(
      `Codegraph path:    ${codegraphAvailable ? "codegraph (.codegraph/ detected)" : "grep fallback (.codegraph/ absent)"}`,
    );
    lines.push("");
    lines.push(
      "Next step: dispatch the context-explorer subagent (directive below), then call",
    );
    lines.push("`ghs-plan-review(snapshot=...)` with its delimited output.");
    lines.push("");
    lines.push("--- context-explorer dispatch directive ---");
    lines.push(contextPrompt);
    // (7) Apply workflow chrome (mechanism-1 injection point ② main path).
    // Post-advance timing: getStageSignature is invoked AFTER writePlanStatus
    // completed, so it observes the just-written `designing` status — this is
    // the self-consistency premise for the never branch firing on the first
    // ghs-plan-start call (plan §3.1 时序约束).
    return composeChrome({
      ctx,
      projectDir,
      toolName: "ghs-plan-start",
      toolArgs: args,
      body: lines.join("\n"),
    });
  },
});

/**
 * Compose the workflow chrome around an arbitrary body string and call
 * `ctx.metadata` to set the tool-card title (mechanism-1 injection point ② +
 * ③ main paths, Feature s1-feat-005).
 *
 * Post-advance timing (plan §3.1 时序约束 — 关键): the caller MUST invoke
 * this helper AFTER its own `writePlanStatus` / equivalent state write so
 * `getStageSignature` reads the post-advance `status` field. The two key
 * properties (first call → todoDirective; stage transition → staleTodoWarning)
 * are only self-consistent on the post-advance read.
 *
 * When `getStageSignature` returns null (single-step tool, terminal status,
 * no active plan, or read failure — judgment table row 1) the body is
 * returned verbatim with no chrome and `ctx.metadata` is NOT called: this
 * tool invocation is not participating in disconnect detection.
 *
 * Otherwise:
 *   - prepend `stageHeader(stage)`
 *   - append `todoDirective(PLAN_STAGES, currentIdx)` when `never`
 *   - append `staleTodoWarning(stage)` when `drift`
 *   - append nothing stale/todo-related when `fresh`
 *   - always append `nextActionAnchor(NEXT_ACTION_PLAN_START)`
 *   - set `ctx.metadata({ title: "[ghs] <stage>" })` (injection point ③ main)
 *
 * `body` is the existing return text; the helper returns the chrome-wrapped
 * string ready for `execute` to return.
 */
async function composeChrome(args: {
  ctx: ToolContext;
  projectDir: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  body: string;
}): Promise<string> {
  const { ctx, projectDir, toolName, toolArgs, body } = args;
  const stage = await getStageSignature(toolName, projectDir, toolArgs);
  const staleClass = classifyStaleState(ctx.sessionID, stage);

  if (stage === null) {
    return body;
  }

  // Injection point ③ main path (channel B) — best-effort visual chrome on
  // the tool card; does NOT drive the right-panel todo. Wrapped in a guard
  // so a throwing ctx.metadata impl cannot poison the tool's text channel.
  try {
    ctx.metadata({
      title: `[ghs] ${stage}`,
      metadata: { stage, stale: staleClass },
    });
  } catch {
    // best-effort: visual chrome must never crash the tool result.
  }

  const header = stageHeader(stage);
  const currentIdx = Math.max(0, PLAN_STAGES.indexOf(stage));
  const todoLine =
    staleClass === "never"
      ? todoDirective(PLAN_STAGES, currentIdx)
      : staleClass === "drift"
        ? staleTodoWarning(stage)
        : "";
  const anchor = nextActionAnchor(NEXT_ACTION_PLAN_START);

  const prefix = `${header}\n\n`;
  const suffixParts: string[] = [];
  if (todoLine) suffixParts.push(todoLine);
  suffixParts.push(anchor);
  const suffix = `\n\n${suffixParts.join("\n\n")}`;
  return `${prefix}${body}${suffix}`;
}

/**
 * The `▶ NEXT ACTION` anchor text used by `ghs-plan-start`. Single source so
 * the chrome helper and any future ad-hoc text stay aligned.
 */
const NEXT_ACTION_PLAN_START =
  "dispatch the `ghs-context-explorer` subagent via the Task tool, then call `ghs-plan-review(snapshot=...)` with its delimited output";
