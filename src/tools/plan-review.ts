// `ghs-plan-review` tool — the core loop of the 3-role plan dispatcher.
//
// This is the middle step of the plan workflow
// (plan §3.5 / §3.7 / §3.4 D1):
//
//     ghs-plan-start
//       → [Task: ghs-context-explorer] → ghs-plan-review(snapshot)
//       → [Task: ghs-plan-designer] → ghs-plan-review(plan)
//       → [Task: ghs-plan-reviewer] → ghs-plan-review(review)
//       → ghs-plan-finalize
//
// The tool is *one* entry point with *three* modes, selected by which of the
// `snapshot` / `plan` / `review` string args the caller supplied. The source
// plugin's SKILL.md ran each parse as a separate Python subprocess invocation
// with a distinct `--kind`; here we collapse them into a single tool whose
// mode is disambiguated by Zod (exactly one of the three must be non-empty —
// plan §5 risk row "ghs-plan-review 的歧义").
//
// Each mode follows the same shape:
//   1. resolve project dir + locate the active plan's status.json
//   2. parse the raw subagent text via the `parse.ts` preset for that family
//      (parse-delimited-output.ts, s3-feat-003)
//   3. branch on parse status:
//        ok / fallback_used → persist artefact, advance the state machine,
//                             return the next dispatch instruction
//        empty / malformed  → return a retry instruction (format recovery)
//   4. for `review` mode additionally branch on the reviewer's verdict:
//        PASS → status `pending_approval`, instruct caller to run
//               `ghs-plan-finalize`
//        FAIL → status `revising`, round+1, instruct caller to re-dispatch
//               the designer with the review feedback; enforce the
//               max-rounds soft cap + MAX_BREACHES hard cap (plan §5 risk
//               row, source SKILL.md "Phase 2" FAIL branch).
//
// Like every other ghs-* tool, `execute` never calls an LLM and never touches
// the agent registry — it only does file I/O, parsing, state writes, and
// returns LLM-facing dispatch text. Style follows s2-feat-003 (sprint.ts):
// thin composition over state.ts + parse.ts + the prompt constants.

import { tool } from "@opencode-ai/plugin";
import type { ToolContext } from "@opencode-ai/plugin/tool";
import { z } from "zod";
import { resolve, join } from "node:path";
import { readdir } from "node:fs/promises";

import {
  readPlanStatus,
  writePlanStatus,
  plansDir,
  stagingPath,
  type PlanStatus,
  type PlanStatusValue,
  type StagingKind,
} from "../lib/state.ts";
import {
  parseContextSnapshot,
  parsePlan,
  parseReview,
  looksTruncated,
  type ParseResult,
  type Verdict,
} from "../lib/parse.ts";
import { getDesignerPrompt } from "../prompts/plan-designer.ts";
import { PLAN_REVIEWER_PROMPT } from "../prompts/plan-reviewer.ts";
import { fileTransportDirective } from "../prompts/file-transport.ts";
import { resolveProjectDir } from "../lib/project.ts";
import { loadGhsConfig, type GhsConfig } from "../lib/config.ts";
import { pluginRoot } from "../lib/paths.ts";
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
 * High-level plan-workflow stages surfaced in the `todoDirective` checklist
 * (mechanism-1 injection point ②, Feature s1-feat-005). Same labels used by
 * `ghs-plan-start` / `ghs-plan-finalize` so the AI's right-panel todo
 * transitions seamlessly across the plan-family tools. `plan:designing` is
 * the snapshot-mode post-advance value too (snapshot handler persists the
 * context file then re-writes status as `designing` while it waits for the
 * designer to run), and `plan:reviewing` is the plan-mode post-advance value
 * (matches the AC #3 explicit setup).
 */
const PLAN_STAGES = ["plan:designing", "plan:reviewing", "plan:finalizing"];

/**
 * The `▶ NEXT ACTION` anchor text used by `ghs-plan-review`'s chrome. The
 * per-mode dispatch directive already lives inside the body (designer /
 * reviewer / finalize hand-off); the anchor is the single concise reminder.
 */
const NEXT_ACTION_PLAN_REVIEW =
  "execute the dispatch directive above, then advance to the next `ghs-plan-review` call";

/**
 * Soft byte threshold above which an extracted context snapshot is considered
 * oversize (Tier 2 of the loop-cost fix). A well-summarised snapshot is
 * typically a few KB; one above this floor almost certainly over-quotes its
 * inputs (e.g. a multi-hundred-KB session log pasted verbatim), which then
 * inflates every downstream designer/reviewer prompt and dominates the token
 * budget. When the extracted snapshot crosses this threshold, the snapshot
 * handler appends a warning nudging a tighter re-run. Non-blocking — the
 * state machine still advances to `designing`.
 */
const SNAPSHOT_OVERSIZE_WARNING_BYTES = 30_000;

// -----------------------------------------------------------------------------
// Mode-disambiguation schema (plan §5 risk row).
// -----------------------------------------------------------------------------

/**
 * The three textual payload args. Exactly one must be a non-empty string;
 * supplying zero or more than one is the classic dispatcher ambiguity the
 * plan §5 risk row calls out.
 *
 * `project_dir` is orthogonal (path resolution) and excluded from the
 * "exactly one" rule.
 */
export const planReviewArgsSchema = z
  .object({
    snapshot: z.string().optional(),
    plan: z.string().optional(),
    review: z.string().optional(),
    project_dir: z.string().optional(),
  })
  .superRefine((args, ctx) => {
    const present: string[] = [];
    if (args.snapshot && args.snapshot.trim().length > 0) present.push("snapshot");
    if (args.plan && args.plan.trim().length > 0) present.push("plan");
    if (args.review && args.review.trim().length > 0) present.push("review");

    if (present.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Exactly one of `snapshot`, `plan`, or `review` must be non-empty " +
          "(all three are empty). Pass the raw subagent response for the mode " +
          "you are advancing: snapshot from ghs-context-explorer, plan from " +
          "ghs-plan-designer, review from ghs-plan-reviewer.",
      });
    } else if (present.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Exactly one of `snapshot`, `plan`, or `review` must be non-empty " +
          `(received ${present.length}: ${present.join(", ")}). The dispatcher ` +
          "advances one mode per call — split into separate ghs-plan-review calls.",
      });
    }
  });

/** Discriminated mode label, derived post-validation from which arg is set. */
export type PlanReviewMode = "snapshot" | "plan" | "review";

// -----------------------------------------------------------------------------
// Hard cap on "continue revising anyway" breaches (source SKILL.md Constants).
// -----------------------------------------------------------------------------

/**
 * Maximum number of times the user may override the `max_rounds` soft cap by
 * choosing "Continue revising anyway". Matches the source skill's
 * `MAX_BREACHES = 2` (Phase 2 FAIL @ max_rounds / Phase 3 reject @ max_rounds
 * both consult this). Once `max_rounds_breaches >= MAX_BREACHES`, the
 * dispatcher must NOT offer the continue option — only accept / abort — which
 * guarantees termination in at most `max_rounds + MAX_BREACHES` rounds.
 */
export const MAX_BREACHES = 2;

// -----------------------------------------------------------------------------
// Active-plan discovery.
// -----------------------------------------------------------------------------

/**
 * Scan `<projectDir>/.ghs/plans/` for `*-status.json` files and return the
 * single "active" plan's status — i.e. one whose lifecycle is not yet
 * terminal (`approved` / `rejected` / `aborted`).
 *
 * Rationale: the features.json AC pins the args surface to
 * `snapshot? / plan? / review? / project_dir?` (no `plan_id`). Yet
 * `status.json` is keyed by plan_id (s3-feat-005). We resolve the gap by
 * having the dispatcher track at most one active plan at a time: starting a
 * new plan (`ghs-plan-start`) is expected to archive/abandon any prior
 * active one. So at any moment there is 0 or 1 active status file.
 *
 *   - 0 active  → returns `null` (caller surfaces "no plan in progress, run
 *                `ghs-plan-start` first").
 *   - 1 active  → returns its status.
 *   - >1 active → returns the most recently updated one (defensive; should
 *                not happen in normal use, but we degrade gracefully instead
 *                of refusing to proceed).
 */
export async function findActivePlanStatus(
  projectDir: string,
): Promise<PlanStatus | null> {
  const dir = plansDir(projectDir);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    // Directory missing entirely — no plan has ever been started.
    return null;
  }

  const statuses: PlanStatus[] = [];
  for (const name of entries) {
    if (!name.endsWith("-status.json")) continue;
    // Derive plan_id by stripping the `-status.json` suffix. readPlanStatus
    // re-derives the path, so we pass the bare id.
    const planId = name.slice(0, -"-status.json".length);
    const status = await readPlanStatus(projectDir, planId);
    if (status === null) continue;
    if (isTerminal(status.status)) continue;
    statuses.push(status);
  }

  if (statuses.length === 0) return null;
  // Defensive tie-break: pick the latest `updated_at` (lexicographic compare
  // works because the timestamp format is YYYY-MM-DDTHH:mm:ss).
  statuses.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return statuses[0];
}

/** Whether a lifecycle state is terminal (no further transitions allowed). */
function isTerminal(status: PlanStatusValue): boolean {
  return status === "approved" || status === "rejected" || status === "aborted";
}

// -----------------------------------------------------------------------------
// Artefact persistence helpers.
// -----------------------------------------------------------------------------

/**
 * Write a parsed artefact to its sibling file under `.ghs/plans/`.
 *
 * The source skill writes `<plan_id>-context.md` / `<plan_id>.md` /
 * `<plan_id>-review.md` next to the `-status.json`. For a `fallback_used`
 * parse the source prepends a warning comment so a reader of the artefact
 * knows extraction was lossy; we mirror that exactly.
 *
 * Returns the absolute path written.
 */
async function persistArtefact(
  projectDir: string,
  relativeName: string,
  content: string,
  result: ParseResult,
): Promise<string> {
  const dir = plansDir(projectDir);
  const absPath = join(dir, relativeName);
  let body = content;
  if (result.status === "fallback_used") {
    const warning =
      `<!-- WARNING: extracted via fallback strategy: ${result.strategy}; ` +
      `warnings: ${result.warnings.join("; ") || "(none)"} -->\n`;
    body = warning + body;
  }
  await Bun.write(absPath, body);
  return absPath;
}

/**
 * Persist the raw subagent response as a post-mortem `.raw` file.
 *
 * Only written when parsing failed (empty/malformed) or when
 * `keep_raw_on_success: true` is set on the status — mirroring the source
 * skill's "Format Recovery" section. The dispatcher returns a retry
 * instruction referencing this path so the failing response is auditable.
 */
async function persistRawPostMortem(
  projectDir: string,
  relativeBaseName: string,
  rawText: string,
): Promise<string> {
  const absPath = join(plansDir(projectDir), `${relativeBaseName}.raw`);
  await Bun.write(absPath, rawText);
  return absPath;
}

// -----------------------------------------------------------------------------
// File-transport source resolver (Tier 1 of the loop-cost fix)
// -----------------------------------------------------------------------------

/**
 * Resolve the raw text to parse for one plan-review mode, preferring a
 * subagent-written staging file over the (possibly truncated) inline payload.
 *
 * The OpenCode Task-return channel truncates long subagent output, so the
 * inline `snapshot` / `plan` / `review` arg the main AI passes may be a
 * short completion signal (file-transport path) or a clipped fragment
 * (truncation path). To eliminate truncation at the source, each subagent is
 * instructed to Write its full delimited output to a deterministic staging
 * file (see `fileTransportDirective`); this helper reads that file when it
 * is the more complete source.
 *
 * Selection rule (regression-free):
 *   - If the inline payload already contains the END marker it is complete →
 *     use it verbatim. This preserves byte-for-byte behaviour for legacy
 *     callers that paste the full text (existing tests + the v5 ok-path AC).
 *   - Otherwise the inline payload is a short signal or a truncated stream →
 *     read the staging file. If it exists and contains the START marker (the
 *     subagent actually wrote its delimited output there), use it.
 *   - Otherwise fall back to the inline payload (and the v5 open_ended /
 *     recovery-nudge mitigation handles any residual truncation).
 *
 * The END/START marker checks make the pick robust to a stale staging file
 * from a prior round: a stale file without the START marker is ignored.
 *
 * @returns the raw text to feed the parser, plus where it came from so the
 *   caller can surface it for diagnostics.
 */
async function readStagingOrInline(args: {
  projectDir: string;
  planId: string;
  kind: StagingKind;
  startToken: string;
  endToken: string;
  inline: string;
}): Promise<{ rawText: string; source: "staging" | "inline" }> {
  const { projectDir, planId, kind, startToken, endToken, inline } = args;

  // Complete inline payload → use it directly (legacy / non-truncated path).
  if (inline.includes(endToken)) {
    return { rawText: inline, source: "inline" };
  }

  // Inline is incomplete (short signal or truncated) → try the staging file.
  const path = stagingPath(projectDir, planId, kind);
  let stagingText: string | null = null;
  try {
    const file = Bun.file(path);
    if (await file.exists()) {
      stagingText = await file.text();
    }
  } catch {
    // Unreadable staging file → degrade to inline (do not crash the tool).
    stagingText = null;
  }
  if (stagingText !== null && stagingText.includes(startToken)) {
    return { rawText: stagingText, source: "staging" };
  }

  return { rawText: inline, source: "inline" };
}

// -----------------------------------------------------------------------------
// Dispatch-text builders — LLM-facing, Chinese prose + English identifiers
// (per CLAUDE.md language policy).
// -----------------------------------------------------------------------------

/** Header block common to every mode's result, for AI + human orientation. */
function resultHeader(args: {
  projectDir: string;
  planId: string;
  mode: PlanReviewMode;
  round: number;
  status: PlanStatusValue;
}): string {
  return [
    "=== ghs-plan-review ===",
    "",
    `Project directory: ${args.projectDir}`,
    `Active plan:       ${args.planId}`,
    `Mode:              ${args.mode}`,
    `Round:             ${args.round}`,
    `Plan status:       ${args.status}`,
    "",
  ].join("\n");
}

/**
 * Truncation-recovery nudge appended (best-effort) when a parse result looks
 * truncated — i.e. the raw text had a START delimiter but no END delimiter
 * (the upstream subagent output was clipped mid-stream by the display layer).
 *
 * This is Phase 2 of the layered truncation defence (plan §Phase 2). It
 * surfaces in two places:
 *   - `buildRetryInstruction` when `looksTruncated(rawText) === true` (retry
 *     path: empty/malformed/verdict-null);
 *   - `handlePlanMode` success branch when `result.strategy === "open_ended"`
 *     (the open_ended fallback extracted START..EOF — not exact, so the user
 *     should recover the full text before advancing).
 *
 * The nudge is non-blocking: the ok/exact path bytes are unchanged, and the
 * open_ended success branch still advances the state machine to `reviewing`.
 */
const TRUNCATION_RECOVERY_NUDGE =
  "疑似截断——查上次 Task 结果的 'Full output saved to:' 行，读该文件尾部取回完整 END 标记与裁决行后，用完整文本重新调用 ghs-plan-review（同模式）。";

/**
 * Build the retry instruction when parsing failed (empty/malformed/verdict-less).
 *
 * Mirrors the source skill's "Format Recovery" appendix trigger: the
 * dispatcher tells the main AI to re-dispatch the SAME subagent with the
 * delimiter-contract reminder + the raw post-mortem path for context.
 */
function buildRetryInstruction(args: {
  projectDir: string;
  planId: string;
  mode: PlanReviewMode;
  result: ParseResult;
  rawPath: string;
  /**
   * When `true`, the retry instruction appends the truncation-recovery nudge
   * (Phase 2) pointing the caller at the saved tool-output file. Computed by
   * the caller via `looksTruncated(rawText, startToken, endToken)`. When
   * `false`/omitted the retry body is byte-identical to the pre-Phase-2 output.
   */
  truncationSuspected?: boolean;
}): string {
  const subagent =
    args.mode === "snapshot"
      ? "ghs-context-explorer"
      : args.mode === "plan"
        ? "ghs-plan-designer"
        : "ghs-plan-reviewer";
  const delimiterContract =
    args.mode === "snapshot"
      ? "`<<<CONTEXT_SNAPSHOT_START>>>` / `<<<CONTEXT_SNAPSHOT_END>>>`"
      : args.mode === "plan"
        ? "`<<<PLAN_START>>>` / `<<<PLAN_END>>>`"
        : "`<<<REVIEW_START>>>` / `<<<REVIEW_END>>>` + 裁决行 `REVIEW COMPLETE | Verdict: PASS|FAIL | ...`";

  const lines = [
    resultHeader({
      projectDir: args.projectDir,
      planId: args.planId,
      mode: args.mode,
      round: 0, // round not advanced on retry
      status: "designing",
    }),
    `⚠️ 解析失败（status: ${args.result.status}, strategy: ${args.result.strategy}）。`,
    "",
    `原始响应已存档到 ${args.rawPath} 供诊断。`,
    "",
    `请重新用 Task tool 派发 \`${subagent}\`，并强调分隔标记契约：`,
    `- 结构化内容必须放在 ${delimiterContract} 之间`,
    "- 不要把标记包进 markdown 代码围栏",
    "- 使用字面 ASCII 字符 `<`、`>`、`_`",
    "- 解析器警告：" + (args.result.warnings.join("; ") || "(none)"),
    "",
    "收到合规输出后，再次调用 `ghs-plan-review`（同模式）推进。",
  ];
  if (args.truncationSuspected) {
    lines.push("", TRUNCATION_RECOVERY_NUDGE);
  }
  return lines.join("\n");
}

// -----------------------------------------------------------------------------
// Mode handlers.
// -----------------------------------------------------------------------------

// Mechanism 二 §3.2.1 改造点(b) — Feature s1-feat-009.
//
// The two designer-dispatch points (handleSnapshotMode success + handleReview
// Mode revise branch) read `.ghs/ghs.json` via `loadGhsConfig(projectDir,
// pluginRoot())` and pass `config.planner_backend` to `getDesignerPrompt`.
// Default backend (`ghs-plan-designer`) returns the existing
// PLAN_DESIGNER_PROMPT verbatim → byte-equivalent regression. The opt-in
// `builtin-plan` returns PLAN_DESIGNER_PROMPT_BUILTIN (inlined delimiter
// contract for the built-in `plan` agent).
//
// Two-class error handling (plan §3.2.1(b), explicit discrimination):
//   - Default-file error → `err.message` contains the label `ghs.default.json`
//     (config.ts readJsonFile uses that label for shared/ghs.default.json) →
//     fall back to `ghs-plan-designer` and surface a warning line in the
//     returned string (execute() only returns plain strings, C2 — no
//     console.*). Rare: plugin package corrupt.
//   - Otherwise (user ghs.json invalid: JSON parse error labelled `ghs.json`
//     or a ZodError with no file label) → re-throw so the misconfiguration is
//     surfaced loudly, consistent with ghs-config strict reporting.
// Normal path (no user ghs.json) never throws — loadGhsConfig returns full
// defaults — so the try/catch only engages on actual read/parse failures.

/**
 * Configurable loader used by {@link resolveDesignerDispatch}. Defaults to the
 * real {@link loadGhsConfig}; tests override it via {@link
 * setGhsConfigLoaderForTest} to simulate config-read failures. This is a
 * module-level seam rather than Bun `mock.module` to stay robust across the
 * ESM live-binding semantics the rest of the suite relies on (no other test
 * in this repo uses module mocking).
 */
let _ghsConfigLoader: (
  projectDir: string,
  pluginRootDir: string,
) => Promise<{ config: GhsConfig; defaults_used: boolean }> = loadGhsConfig;

/**
 * @internal Test seam — override the config loader used by designer-dispatch
 * resolution. Pass `null` to restore the real {@link loadGhsConfig}.
 */
export function setGhsConfigLoaderForTest(
  loader: typeof _ghsConfigLoader | null,
): void {
  _ghsConfigLoader = loader ?? loadGhsConfig;
}

/**
 * Resolve the plan-designer dispatch prompt (and optional fallback warning)
 * by reading the merged ghs config.
 *
 * @returns `{ prompt, warning }` — `warning` is `""` on the normal / opt-in
 *          paths, and a non-empty human-readable line when the default-file
 *          read failed and the backend fell back to `ghs-plan-designer`.
 * @throws when the USER's `ghs.json` is invalid (re-thrown unchanged) — never
 *         throws for a default-file failure (those fall back instead).
 */
async function resolveDesignerDispatch(projectDir: string): Promise<{
  prompt: string;
  warning: string;
}> {
  let backend: "ghs-plan-designer" | "builtin-plan";
  try {
    const { config } = await _ghsConfigLoader(projectDir, pluginRoot());
    backend = config.planner_backend;
  } catch (err) {
    const msg = (err as Error | undefined)?.message ?? String(err);
    if (msg.includes("ghs.default.json")) {
      return {
        prompt: getDesignerPrompt("ghs-plan-designer"),
        warning:
          "⚠️ ghs.default.json 缺失或非法，已落回默认 plan-designer 后端" +
          "（插件包可能损坏，建议重装）。",
      };
    }
    throw err;
  }
  return { prompt: getDesignerPrompt(backend), warning: "" };
}

/**
 * Snapshot mode — parse the context-explorer subagent's response, persist the
 * snapshot, and return the dispatch instruction for the plan-designer.
 *
 * State transition: `status` → `designing` (the snapshot is now available
 * for the designer to consume). The snapshot file name is recorded on the
 * status's `context_file` if it wasn't already (it usually is, set by
 * `ghs-plan-start`).
 */
async function handleSnapshotMode(args: {
  projectDir: string;
  status: PlanStatus;
  rawText: string;
}): Promise<{ body: string; warning: string }> {
  const { projectDir, status } = args;
  // File-transport (Tier 1): prefer a subagent-written staging file over the
  // inline payload when the inline payload is incomplete (short signal or
  // truncated). See `readStagingOrInline`.
  const { rawText, source } = await readStagingOrInline({
    projectDir,
    planId: status.plan_id,
    kind: "snapshot",
    startToken: "<<<CONTEXT_SNAPSHOT_START>>>",
    endToken: "<<<CONTEXT_SNAPSHOT_END>>>",
    inline: args.rawText,
  });
  const result = parseContextSnapshot(rawText);

  if (result.status === "empty" || result.status === "malformed") {
    const rawPath = await persistRawPostMortem(
      projectDir,
      status.context_file.replace(/\.md$/, ""),
      rawText,
    );
    return {
      body: buildRetryInstruction({
        projectDir,
        planId: status.plan_id,
        mode: "snapshot",
        result,
        rawPath,
        truncationSuspected: looksTruncated(
          rawText,
          "<<<CONTEXT_SNAPSHOT_START>>>",
          "<<<CONTEXT_SNAPSHOT_END>>>",
        ),
      }),
      warning: "",
    };
  }

  // Success — persist the snapshot.
  await persistArtefact(projectDir, status.context_file, result.content, result);

  // Tier 2 context-sizing guard: warn when the extracted snapshot is
  // oversize (it almost certainly over-quotes a large input and will bloat
  // every downstream prompt). Non-blocking — best-effort nudge to re-run
  // the explorer with tighter summarisation.
  const snapshotBytes = Buffer.byteLength(result.content, "utf8");
  const oversizeWarning =
    snapshotBytes > SNAPSHOT_OVERSIZE_WARNING_BYTES
      ? `⚠️ Snapshot 约 ${snapshotBytes} 字节（>${SNAPSHOT_OVERSIZE_WARNING_BYTES}），疑似过度逐字转述了大体量输入 —— 会膨胀下游每个 designer/reviewer prompt。建议重跑 context-explorer，对超大文件只采样+grep 定位关键段并摘要（见 context-snapshot-guide.md「Large-Input Handling」）。`
      : null;

  // Advance state: the snapshot is ready, the designer is next.
  const nextStatus: PlanStatus = {
    ...status,
    status: "designing",
    updated_at: nowTimestamp(),
  };
  await writePlanStatus(projectDir, nextStatus);

  // Read planner_backend once before emitting the dispatch directive
  // (mechanism 二 §3.2.1 改造点(b), Feature s1-feat-009).
  const { prompt: designerPrompt, warning } =
    await resolveDesignerDispatch(projectDir);

  return {
    body: [
      resultHeader({
        projectDir,
        planId: status.plan_id,
        mode: "snapshot",
        round: nextStatus.round,
        status: nextStatus.status,
      }),
      `✅ Context snapshot 已提取（status: ${result.status}, strategy: ${result.strategy}${source === "staging" ? ", source: staging" : ""}）。`,
      "",
      `Snapshot 写入：${join(plansDir(projectDir), status.context_file)}`,
      `Codegraph 路径：${status.codegraph_available ? "codegraph" : "grep 回退"}`,
      ...(oversizeWarning ? ["", oversizeWarning] : []),
      "",
      "下一步：派发 plan-designer 设计技术方案。",
      "",
      "--- plan-designer dispatch ---",
      designerPrompt,
      "",
      fileTransportDirective(stagingPath(projectDir, status.plan_id, "plan"), "plan"),
    ].join("\n"),
    warning,
  };
}

/**
 * Plan mode — parse the plan-designer subagent's response, persist the plan,
 * and return the dispatch instruction for the plan-reviewer.
 *
 * State transition: `status` → `reviewing`.
 */
async function handlePlanMode(args: {
  projectDir: string;
  status: PlanStatus;
  rawText: string;
}): Promise<{ body: string; warning: string }> {
  const { projectDir, status } = args;
  // File-transport (Tier 1): prefer a subagent-written staging file over the
  // inline payload when the inline payload is incomplete. See
  // `readStagingOrInline`.
  const { rawText, source } = await readStagingOrInline({
    projectDir,
    planId: status.plan_id,
    kind: "plan",
    startToken: "<<<PLAN_START>>>",
    endToken: "<<<PLAN_END>>>",
    inline: args.rawText,
  });
  const result = parsePlan(rawText);

  if (result.status === "empty" || result.status === "malformed") {
    const rawPath = await persistRawPostMortem(
      projectDir,
      status.plan_file.replace(/\.md$/, ""),
      rawText,
    );
    return {
      body: buildRetryInstruction({
        projectDir,
        planId: status.plan_id,
        mode: "plan",
        result,
        rawPath,
        truncationSuspected: looksTruncated(
          rawText,
          "<<<PLAN_START>>>",
          "<<<PLAN_END>>>",
        ),
      }),
      warning: "",
    };
  }

  await persistArtefact(projectDir, status.plan_file, result.content, result);

  const nextStatus: PlanStatus = {
    ...status,
    status: "reviewing",
    updated_at: nowTimestamp(),
  };
  await writePlanStatus(projectDir, nextStatus);

  // Build the success body. When the parse landed via the `open_ended`
  // fallback (START present, END absent → truncated stream), append the
  // truncation-recovery nudge after the ✅ line (best-effort; the state
  // machine still advances to `reviewing`). The ok/exact inline path is
  // byte-identical to the pre-Phase-2 output (Phase 2 AC #4); the staging
  // source is surfaced only when file-transport actually fired.
  const successLines: string[] = [
    resultHeader({
      projectDir,
      planId: status.plan_id,
      mode: "plan",
      round: nextStatus.round,
      status: nextStatus.status,
    }),
    `✅ Plan 已提取（status: ${result.status}, strategy: ${result.strategy}${source === "staging" ? ", source: staging" : ""}）。`,
  ];
  if (result.strategy === "open_ended") {
    successLines.push("", TRUNCATION_RECOVERY_NUDGE);
  }
  successLines.push(
    "",
    `Plan 写入：${join(plansDir(projectDir), status.plan_file)}`,
    "",
    "下一步：派发 plan-reviewer 评审技术方案。",
    "",
    "--- plan-reviewer dispatch ---",
    PLAN_REVIEWER_PROMPT,
    "",
    fileTransportDirective(stagingPath(projectDir, status.plan_id, "review"), "review"),
  );

  return {
    body: successLines.join("\n"),
    warning: "",
  };
}

/**
 * Review mode — parse the plan-reviewer subagent's response, persist the
 * review, read the verdict, and branch:
 *
 *   PASS  → status `pending_approval`, instruct caller to run
 *           `ghs-plan-finalize` (source Phase 2 PASS branch + Phase 3).
 *   FAIL  → status `revising`, round+1, instruct caller to re-dispatch the
 *           designer with the review feedback; enforce max_rounds +
 *           MAX_BREACHES caps (source Phase 2 FAIL branch).
 *   null  → fall through to the retry path (verdict line missing).
 *
 * The user-approval Phase 3 step from the source skill is collapsed into the
 * PASS instruction text (OpenCode has no sync `AskUserQuestion`; the main AI
 * asks the user in chat between tool calls).
 */
async function handleReviewMode(args: {
  projectDir: string;
  status: PlanStatus;
  rawText: string;
}): Promise<{ body: string; warning: string }> {
  const { projectDir, status } = args;
  // File-transport (Tier 1): prefer a subagent-written staging file over the
  // inline payload when the inline payload is incomplete. See
  // `readStagingOrInline`. The review's verdict line lives at the tail, so a
  // truncated stream is especially damaging here — the staging file is the
  // primary defence for recovering the verdict.
  const { rawText } = await readStagingOrInline({
    projectDir,
    planId: status.plan_id,
    kind: "review",
    startToken: "<<<REVIEW_START>>>",
    endToken: "<<<REVIEW_END>>>",
    inline: args.rawText,
  });
  const result = parseReview(rawText);
  const verdict: Verdict = result.verdict;

  // Persist the review file path on the status (first reviewer run).
  const reviewFile =
    status.review_file ?? `${status.plan_id}-review.md`;

  // empty / malformed / verdict-less → retry path (source: "verdict == null"
  // is treated as a format deviation).
  if (
    result.status === "empty" ||
    result.status === "malformed" ||
    verdict === null
  ) {
    // Persist review artefact if we have any content, else raw post-mortem.
    let rawPath: string;
    if (result.content.trim().length > 0) {
      await persistArtefact(projectDir, reviewFile, result.content, result);
      rawPath = join(plansDir(projectDir), reviewFile);
    } else {
      rawPath = await persistRawPostMortem(
        projectDir,
        reviewFile.replace(/\.md$/, ""),
        rawText,
      );
    }
    const retry = buildRetryInstruction({
      projectDir,
      planId: status.plan_id,
      mode: "review",
      result,
      rawPath,
      truncationSuspected: looksTruncated(
        rawText,
        "<<<REVIEW_START>>>",
        "<<<REVIEW_END>>>",
      ),
    });
    return {
      body: retry.replace(
        /解析失败（status:.*?\)/,
        `解析失败（status: ${result.status}, verdict: ${verdict ?? "null"}）`,
      ),
      warning: "",
    };
  }

  // We have a usable review — persist it + record review_file on the status.
  await persistArtefact(projectDir, reviewFile, result.content, result);

  if (verdict === "PASS") {
    const nextStatus: PlanStatus = {
      ...status,
      review_file: reviewFile,
      status: "pending_approval",
      updated_at: nowTimestamp(),
    };
    await writePlanStatus(projectDir, nextStatus);

    return {
      body: [
        resultHeader({
          projectDir,
          planId: status.plan_id,
          mode: "review",
          round: nextStatus.round,
          status: nextStatus.status,
        }),
        "✅ Review PASS —— 方案通过评审（仅 Optimization 项，无 Severe/Medium）。",
        "",
        `Review 写入：${join(plansDir(projectDir), reviewFile)}`,
        "",
        "下一步：请向用户确认是否批准该方案。用户批准后调用 `ghs-plan-finalize` 写出最终 plan。",
        "（OpenCode 无同步阻塞询问 —— 在 chat 中向用户提问即可。）",
      ].join("\n"),
      warning: "",
    };
  }

  // verdict === "FAIL" — enforce the round / breach caps before instructing
  // a revise. Source Phase 2 FAIL branch.
  const atSoftCap = status.round >= status.max_rounds;
  const atHardCap = status.max_rounds_breaches >= MAX_BREACHES;

  if (atSoftCap && atHardCap) {
    // Hard cap reached: refuse to start another round. Surface the user
    // decision (accept-with-fail vs abort). We do NOT mutate status here —
    // the next tool call (finalize or a fresh start) drives the transition.
    const nextStatus: PlanStatus = {
      ...status,
      review_file: reviewFile,
      status: "pending_approval",
      updated_at: nowTimestamp(),
    };
    await writePlanStatus(projectDir, nextStatus);

    return {
      body: [
        resultHeader({
          projectDir,
          planId: status.plan_id,
          mode: "review",
          round: nextStatus.round,
          status: nextStatus.status,
        }),
        "🛑 Review FAIL 且已达硬上限（max_rounds=" + status.max_rounds +
          ", breaches=" + status.max_rounds_breaches +
          "/" + MAX_BREACHES + "）—— 不再允许修订轮次。",
        "",
        `Review 写入：${join(plansDir(projectDir), reviewFile)}`,
        "",
        "用户须二选一（在 chat 中向用户提问）：",
        "  1. 接受当前方案（带 Severe/Medium 未修复项）→ 调用 `ghs-plan-finalize`，",
        "     产物 plan 顶部会标注 `WARNING: accepted with unfixed issues`。",
        "  2. 终止 → 状态改为 aborted；用户重新 `ghs-plan-start` 启动新 plan。",
      ].join("\n"),
      warning: "",
    };
  }

  if (atSoftCap) {
    // Soft cap reached but breaches remaining — surface the 3-way user
    // decision (continue-breach / accept-with-fail / abort). We do NOT
    // auto-advance round until the user picks "continue". Status stays as
    // reviewing so the caller knows the loop is paused on a decision.
    const nextStatus: PlanStatus = {
      ...status,
      review_file: reviewFile,
      status: "pending_approval",
      updated_at: nowTimestamp(),
    };
    await writePlanStatus(projectDir, nextStatus);

    const remaining = MAX_BREACHES - status.max_rounds_breaches;
    return {
      body: [
        resultHeader({
          projectDir,
          planId: status.plan_id,
          mode: "review",
          round: nextStatus.round,
          status: nextStatus.status,
        }),
        "⚠️ Review FAIL 且已达软上限 max_rounds=" + status.max_rounds +
          "（剩余 breach 额度 " + remaining + "/" + MAX_BREACHES + "）。",
        "",
        `Review 写入：${join(plansDir(projectDir), reviewFile)}`,
        "",
        "用户须三选一（在 chat 中向用户提问，附上评审报告）：",
        "  1. 继续修订（一次性 breach）→ 再次调用 `ghs-plan-review(review=...)` 无法触发，",
        "     请改用 `ghs-plan-review(plan=<修订后的 designer 输出>)`；调用前请告知 AI",
        "     用户选择了 breach，AI 会确保 status 的 max_rounds_breaches 自增。（注：",
        "     当前实现把 breach 计数委托给下一次 plan 模式调用时推进 —— 见下方说明。）",
        "  2. 接受当前方案（带未修复项）→ 调用 `ghs-plan-finalize`。",
        "  3. 终止 → 重新 `ghs-plan-start`。",
        "",
        "说明：breach 计数 (max_rounds_breaches) 在下一轮 designer 产物被 ghs-plan-review(plan) 接收时",
        "自增并推进 round —— 这样状态机始终在单一入口推进，避免双写。",
      ].join("\n"),
      warning: "",
    };
  }

  // Below soft cap — auto-advance to the next revise round.
  const nextStatus: PlanStatus = {
    ...status,
    review_file: reviewFile,
    status: "revising",
    round: status.round + 1,
    // If this revise round is itself a breach continuation (round already
    // exceeded max_rounds on a prior pass), carry the breach increment here.
    max_rounds_breaches:
      status.round + 1 > status.max_rounds
        ? status.max_rounds_breaches + 1
        : status.max_rounds_breaches,
    updated_at: nowTimestamp(),
  };
  await writePlanStatus(projectDir, nextStatus);

  // Read planner_backend once before emitting the re-dispatch directive
  // (mechanism 二 §3.2.1 改造点(b), Feature s1-feat-009).
  const { prompt: designerPrompt, warning } =
    await resolveDesignerDispatch(projectDir);

  return {
    body: [
      resultHeader({
        projectDir,
        planId: status.plan_id,
        mode: "review",
        round: nextStatus.round,
        status: nextStatus.status,
      }),
      "⚠️ Review FAIL —— 触发修订轮次 round " + status.round + " → " + nextStatus.round + "。",
      "",
      `Review 写入：${join(plansDir(projectDir), reviewFile)}`,
      `剩余轮次预算：${status.max_rounds - nextStatus.round} 轮（max_rounds=${status.max_rounds}）`,
      "",
      "下一步：用 Task tool 重新派发 `ghs-plan-designer`，把本轮评审报告作为修订反馈一并传入。",
      "designer 产出后，再次调用 `ghs-plan-review(plan=...)`。",
      "",
      "--- plan-designer dispatch (revise) ---",
      designerPrompt,
      "",
      fileTransportDirective(stagingPath(projectDir, status.plan_id, "plan"), "plan"),
    ].join("\n"),
    warning,
  };
}

/** Current local timestamp in the state.ts format (YYYY-MM-DDTHH:mm:ss). */
function nowTimestamp(): string {
  // Local import to avoid a date-time round-trip mismatch with state.ts.
  // We re-implement the same formatter inline rather than importing
  // `formatLocalTimestamp` to keep this module's dependency surface tight —
  // but the output is byte-identical (verified by state.test.ts).
  const now = new Date();
  const pad = (n: number): string => n.toString().padStart(2, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  );
}

// -----------------------------------------------------------------------------
// Tool definition.
// -----------------------------------------------------------------------------

/**
 * The `ghs-plan-review` tool definition. Registered by the plugin entry
 * point under the `ghs-plan-review` key (hyphenated, per spike 001 / D1).
 *
 * The SDK's `args` shape is a flat `ZodRawShape`; the "exactly one of
 * snapshot/plan/review non-empty" constraint is enforced by
 * {@link planReviewArgsSchema} via a `.superRefine` run inside `execute`.
 */
export const planReviewTool = tool({
  description:
    "Core loop of the 3-role plan dispatcher (ghs-plan-start → review × N → finalize). " +
    "Three modes, selected by which payload arg is non-empty: " +
    "`snapshot` (parse ghs-context-explorer output → dispatch ghs-plan-designer), " +
    "`plan` (parse ghs-plan-designer output → dispatch ghs-plan-reviewer), " +
    "`review` (parse ghs-plan-reviewer output → PASS advances to ghs-plan-finalize, " +
    "FAIL triggers a revise round with max-rounds + breach caps). " +
    "Exactly one of snapshot/plan/review must be non-empty (Zod-enforced). " +
    "Locates the active plan's status.json automatically (no plan_id arg).",
  args: {
    snapshot: tool.schema
      .string()
      .optional()
      .describe(
        "Raw response from the ghs-context-explorer subagent (snapshot mode). " +
          "Must include the <<<CONTEXT_SNAPSHOT_START>>>/<<<CONTEXT_SNAPSHOT_END>>> delimiters.",
      ),
    plan: tool.schema
      .string()
      .optional()
      .describe(
        "Raw response from the ghs-plan-designer subagent (plan mode). " +
          "Must include the <<<PLAN_START>>>/<<<PLAN_END>>> delimiters.",
      ),
    review: tool.schema
      .string()
      .optional()
      .describe(
        "Raw response from the ghs-plan-reviewer subagent (review mode). " +
          "Must include the <<<REVIEW_START>>>/<<<REVIEW_END>>> delimiters and the " +
          "`REVIEW COMPLETE | Verdict: PASS|FAIL | ...` verdict line.",
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
      snapshot?: string;
      plan?: string;
      review?: string;
      project_dir?: string;
    },
    ctx: ToolContext,
  ): Promise<string> {
    // Enforce the "exactly one payload non-empty" constraint. Throws a
    // ZodError on violation, which the OpenCode runtime surfaces to the AI
    // as a tool-call error — exactly the disambiguation the plan §5 risk
    // row prescribes.
    const validated = planReviewArgsSchema.parse(args);

    const projectDir = validated.project_dir
      ? resolve(validated.project_dir)
      : resolveProjectDir(ctx);

    // Locate the active plan.
    const status = await findActivePlanStatus(projectDir);
    if (status === null) {
      const body = [
        "=== ghs-plan-review ===",
        "",
        `Project directory: ${projectDir}`,
        "",
        "❌ 当前没有进行中的 plan（.ghs/plans/ 下无 active status.json）。",
        "",
        "请先调用 `ghs-plan-start` 启动一个新 plan，再用 Task tool 派发对应 subagent，",
        "然后把 subagent 的分隔标记输出原样传给本 tool 的 snapshot/plan/review 参数。",
      ].join("\n");
      // No active plan → getStageSignature returns null → no chrome.
      return composeChrome({
        ctx,
        projectDir,
        toolName: "ghs-plan-review",
        toolArgs: args,
        body,
      });
    }

    const mode: PlanReviewMode = validated.snapshot
      ? "snapshot"
      : validated.plan
        ? "plan"
        : "review";

    const rawText =
      mode === "snapshot"
        ? (validated.snapshot as string)
        : mode === "plan"
          ? (validated.plan as string)
          : (validated.review as string);

    let outcome: { body: string; warning: string };
    if (mode === "snapshot") {
      outcome = await handleSnapshotMode({ projectDir, status, rawText });
    } else if (mode === "plan") {
      outcome = await handlePlanMode({ projectDir, status, rawText });
    } else {
      outcome = await handleReviewMode({ projectDir, status, rawText });
    }
    // Apply workflow chrome (mechanism-1 injection point ② main path).
    // Post-advance timing (plan §3.1 时序约束 — 关键): composeChrome invokes
    // getStageSignature AFTER the mode handler completed its writePlanStatus,
    // so it observes the post-advance status (e.g. handlePlanMode's just-
    // written `reviewing`). This is the self-consistency premise for the
    // staleTodoWarning drift test (AC #3): a prior call established
    // lastStageSeenByTool='plan:designing' and this call reads
    // post-advance 'plan:reviewing' → drift → staleTodoWarning.
    const composed = await composeChrome({
      ctx,
      projectDir,
      toolName: "ghs-plan-review",
      toolArgs: args,
      body: outcome.body,
    });
    // Feature s1-feat-009: when loadGhsConfig fell back to the default
    // backend due to a default-file error, the warning is concatenated to
    // the END of execute()'s returned string (C2: execute only returns plain
    // strings — no console.*). Appended after chrome so it is the last thing
    // the main AI reads.
    return outcome.warning ? `${composed}\n\n${outcome.warning}` : composed;
  },
});

/**
 * Compose the workflow chrome around an arbitrary body string and call
 * `ctx.metadata` to set the tool-card title (mechanism-1 injection point ② +
 * ③ main paths, Feature s1-feat-005).
 *
 * When `getStageSignature` returns null (single-step tool, terminal status,
 * no active plan, or read failure — judgment table row 1) the body is
 * returned verbatim with no chrome and `ctx.metadata` is NOT called.
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
  const anchor = nextActionAnchor(NEXT_ACTION_PLAN_REVIEW);

  const prefix = `${header}\n\n`;
  const suffixParts: string[] = [];
  if (todoLine) suffixParts.push(todoLine);
  suffixParts.push(anchor);
  const suffix = `\n\n${suffixParts.join("\n\n")}`;
  return `${prefix}${body}${suffix}`;
}
