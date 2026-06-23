// `ghs-plan-finalize` tool — the plan dispatcher's exit step.
//
// After the review-revise loop converges on a reviewer-approved plan, the
// primary AI calls this tool with the final plan text. This tool:
//   1. Resolves the target project dir (explicit `project_dir` arg wins;
//      otherwise `resolveProjectDir(ctx)` reads the opencode session's
//      worktree/directory).
//   2. Resolves the plan file name. When the caller passes `plan_id` (the
//      normal post-dispatcher path), the file is `<plan_id>.md` — the same
//      single canonical artefact the designer drafted, overwritten in place
//      with the reviewer-approved text (source skill's one-file-per-loop
//      convention). When no `plan_id` is supplied (a hand-authored plan), a
//      slug is derived from the plan content's first meaningful line (the
//      title / H1), sanitised to `[a-z0-9-]+`.
//   3. Writes the plan to `<projectDir>/.ghs/plans/<YYYY-MM-DD>-<slug>.md`.
//      This is the canonical, user-facing artefact — the file `features.json`
//      sprint entries reference via their `plan_ref` field, and the file
//      `ghs-sprint` / `ghs-code` consult for downstream context.
//   4. Updates the dispatcher's per-plan `status.json` (located at
//      `<projectDir>/.ghs/plans/<plan_id>-status.json`) to mark the plan as
//      `approved` — provided a status file exists for the plan being
//      finalised. We look up the status file by `plan_id` when the caller
//      passes one, otherwise by the `{date}-{slug}` identifier we just minted
//      (which is what `ghs-plan-start` would have used).
//   5. Returns a success string that tells the AI / user the plan is written
//      AND that the next workflow step is `ghs-sprint` (to break the plan into
//      atomic features). Per the feature spec's acceptance criteria verbatim.
//
// All file I/O is pure — no LLM calls. The returned string is what the AI
// sees as the tool result. Style follows `src/tools/init.ts` (Bun.file /
// Bun.write, no process.exit, descriptive thrown Errors) and `src/tools/
// sprint.ts` (tool() helper + hyphenated registry key, resolved project dir,
// human-readable result lines).

import { tool } from "@opencode-ai/plugin";
import type { ToolContext } from "@opencode-ai/plugin/tool";
import { resolve, join } from "node:path";
import { mkdir } from "node:fs/promises";

import {
  plansDir,
  finalPlansDir,
  readPlanStatus,
  writePlanStatus,
  formatLocalTimestamp,
  type PlanStatus,
} from "../lib/state.ts";
import { resolveProjectDir } from "../lib/project.ts";
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

// -----------------------------------------------------------------------------
// Slug generation
// -----------------------------------------------------------------------------

/**
 * Maximum length of a generated slug. Keeps file names manageable and matches
 * the rough width of the source skill's slug derivation (which truncates long
 * titles). 60 chars is generous enough for real plan titles yet short enough
 * that the resulting `<date>-<slug>.md` file name stays readable in a
 * terminal tab + `ls` output.
 */
const MAX_SLUG_LENGTH = 60;

/**
 * High-level plan-workflow stages surfaced in the `todoDirective` checklist
 * (mechanism-1 injection point ②, Feature s1-feat-005). Same labels used by
 * `ghs-plan-start` so the AI's right-panel todo transitions seamlessly across
 * the plan-family tools. Note: on plan-finalize's success path the active
 * plan flips to `approved` (terminal) and `getStageSignature` returns null →
 * chrome is a no-op (judgment-table row 1) — the checklist labels are still
 * referenced on the partial-failure path where status remains non-terminal.
 */
const PLAN_STAGES = ["plan:designing", "plan:reviewing", "plan:finalizing"];

/**
 * The `▶ NEXT ACTION` anchor text used by `ghs-plan-finalize`'s chrome.
 * Single source so the chrome helper and any future ad-hoc text stay aligned.
 */
const NEXT_ACTION_PLAN_FINALIZE =
  "call `ghs-sprint` to break the approved plan into atomic features";

// -----------------------------------------------------------------------------
// Truncation guard (Phase 3, Feature s2-feat-003)
// -----------------------------------------------------------------------------

/**
 * Minimum trimmed length a `plan_content` payload must reach to be considered
 * a complete plan rather than a truncated fragment. 1000 chars is a soft floor
 * — falling below it only triggers a *rejection* (not an irreversible action),
 * so the caller can re-invoke `ghs-plan-finalize` with the full text after
 * recovering it from the Task tool's saved output.
 */
const FINALIZE_MIN_PLAN_LENGTH = 1000;

/**
 * Heuristic guard that rejects `plan_content` payloads suspected of being
 * truncated before they are persisted to disk (Phase 3 / L3 of the
 * truncation-save-fix defence-in-depth stack).
 *
 * Two OR-combined signals:
 *   1. **Unclosed code fence** — an odd count of fenced-code-block delimiters
 *      (lines matching `^\s*``` `) means at least one block was never closed,
 *      a strong truncation tell. A well-formed plan with no code blocks yields
 *      zero fences (even) and passes; a plan with N code blocks yields 2N
 *      fences (even) and passes.
 *   2. **Length floor** — a trimmed length below {@link FINALIZE_MIN_PLAN_LENGTH}
 *      is almost certainly a fragment, not a complete plan.
 *
 * NOTE (v5): the earlier "trailing backtick" signal was removed. A standard
 * closing fence is three backticks — an odd length — which would falsely
 * reject every legitimate plan that ends with a closed code block, trapping
 * the caller in an infinite retry loop.
 */
function detectSuspectedTruncation(content: string): boolean {
  const fences = content.match(/^\s*```/gm);
  if (fences && fences.length % 2 !== 0) return true;
  if (content.trim().length < FINALIZE_MIN_PLAN_LENGTH) return true;
  return false;
}
export { detectSuspectedTruncation };

/**
 * Derive a filesystem-safe slug from a plan's text content.
 *
 * Strategy (matches the source skill's `derive_slug` intent):
 *   1. Take the first non-empty, non-frontmatter line of the plan. We prefer
 *      a Markdown H1 (`# Title`) when present since plan designers conventionally
 *      lead with one; otherwise we fall back to the first heading or the first
 *      non-blank line.
 *   2. Strip leading `#` heading markers, trailing punctuation, and
 *      surrounding whitespace.
 *   3. Lowercase, collapse internal whitespace into single hyphens, drop
 *      every character outside `[a-z0-9-]`.
 *   4. Collapse runs of hyphens, trim leading/trailing hyphens.
 *   5. Truncate to {@link MAX_SLUG_LENGTH} on a hyphen boundary (so we don't
 *      cut a word in half).
 *   6. Fall back to `"plan"` when the result is empty (e.g. the plan content
 *      was only whitespace or punctuation) — we MUST return a non-empty slug
 *      because it forms part of the file name.
 *
 * The output is guaranteed to match `/^[a-z0-9]+(-[a-z0-9]+)*$/` or be the
 * literal `"plan"`, which keeps the resulting file name safe across every
 * filesystem OpenCode users are likely to run on.
 */
export function deriveSlug(planContent: string): string {
  // Locate the first meaningful line. Skip blank lines and YAML-ish frontmatter
  // delimiters (`---`) so a plan that opens with frontmatter doesn't produce a
  // slug of empty string.
  const lines = planContent.split(/\r?\n/);
  let title = "";
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line === "---") continue; // frontmatter delimiter
    title = line;
    break;
  }

  // Strip leading Markdown heading hashes (`#`, `##`, ...).
  let cleaned = title.replace(/^#+\s*/, "");
  // Trim trailing punctuation that would otherwise become dangling hyphens.
  cleaned = cleaned.replace(/[\s._:=#-]+$/g, "");

  const slug = cleaned
    .toLowerCase()
    .trim()
    // Replace any run of whitespace with a single hyphen.
    .replace(/\s+/g, "-")
    // Drop every character that is not a lowercase letter, digit, or hyphen.
    .replace(/[^a-z0-9-]/g, "")
    // Collapse runs of hyphens produced by the two replacements above.
    .replace(/-+/g, "-")
    // Trim leading/trailing hyphens.
    .replace(/^-+|-+$/g, "");

  if (!slug) {
    return "plan";
  }

  // Truncate on a hyphen boundary so we never cut a word in half.
  if (slug.length <= MAX_SLUG_LENGTH) {
    return slug;
  }
  const truncated = slug.slice(0, MAX_SLUG_LENGTH);
  const lastHyphen = truncated.lastIndexOf("-");
  return (lastHyphen > 0 ? truncated.slice(0, lastHyphen) : truncated).replace(
    /-+$/,
    "",
  );
}

// -----------------------------------------------------------------------------
// Status update
// -----------------------------------------------------------------------------

/**
 * Mark the dispatcher state for `planId` as `approved`, preserving every other
 * field. Bumps `updated_at` to "now".
 *
 * Returns the absolute path the updated status was written to, or `null` when
 * no status file exists for `planId` (which is a legitimate state — the user
 * may be calling `ghs-plan-finalize` with a hand-written plan that never went
 * through `ghs-plan-start`'s state machine). In that case the caller simply
 * reports that no state file was updated rather than failing the whole
 * finalisation.
 *
 * `acceptedWithFail` propagates onto the status object so post-hoc auditing
 * (`grep '"accepted_with_fail": true'`) still works exactly as in the source
 * plugin — a plan that shipped with unfixed reviewer findings stays flagged.
 */
async function markPlanApproved(
  projectDir: string,
  planId: string,
  acceptedWithFail: boolean,
  now: Date,
): Promise<string | null> {
  const existing = await readPlanStatus(projectDir, planId);
  if (!existing) {
    return null;
  }

  const updated: PlanStatus = {
    ...existing,
    status: "approved",
    accepted_with_fail: acceptedWithFail,
    updated_at: formatLocalTimestamp(now),
  };
  return writePlanStatus(projectDir, updated);
}

// -----------------------------------------------------------------------------
// Tool definition
// -----------------------------------------------------------------------------

/**
 * The `ghs-plan-finalize` tool definition. Registered by the plugin entry
 * point under the `ghs-plan-finalize` key (hyphenated, per spike 001 / D1).
 *
 * This is the exit step of the 3-role plan dispatcher (plan §3.5 / §3.7). The
 * primary AI invokes it once the `ghs-plan-reviewer` subagent has returned a
 * `Verdict: PASS`, handing over the final, reviewer-approved plan text.
 */
export const planFinalizeTool = tool({
  description:
    "Finalise a plan: write the reviewer-approved plan content to " +
    "`.ghs/plans/<YYYY-MM-DD>-<slug>.md` (slug derived from the plan title), " +
    "mark the dispatcher's status.json as `approved`, and return the next-step " +
    "instruction (invoke `ghs-sprint` to break the plan into atomic features). " +
    "This is the exit step of the 3-role plan dispatcher.",
  args: {
    plan_content: tool.schema
      .string()
      .min(1)
      .describe(
        "The final, reviewer-approved plan content (Markdown). Written verbatim to " +
          "`<projectDir>/.ghs/plans/<YYYY-MM-DD>-<slug>.md`.",
      ),
    project_dir: tool.schema
      .string()
      .optional()
      .describe(
        "Absolute path of the project root. Defaults to the opencode session's worktree/directory.",
      ),
    plan_id: tool.schema
      .string()
      .optional()
      .describe(
        "Optional plan identifier (the `{date}-{slug}` string emitted by ghs-plan-start) " +
          "used to locate the dispatcher's status.json. When omitted, the tool derives " +
          "the id from the current date + the plan's slug.",
      ),
    accepted_with_fail: tool.schema
      .boolean()
      .optional()
      .describe(
        "When true, the plan shipped with unfixed reviewer findings. Sets the " +
          "`accepted_with_fail` audit flag on status.json (status still flips to `approved`). " +
          "Default false.",
      ),
  },
  async execute(
    args: {
      plan_content: string;
      project_dir?: string;
      plan_id?: string;
      accepted_with_fail?: boolean;
    },
    ctx: ToolContext,
  ): Promise<string> {
    const projectDir = args.project_dir
      ? resolve(args.project_dir)
      : resolveProjectDir(ctx);

    const now = new Date();

    // (0) Truncation guard (Phase 3 / L3). Reject suspected-truncated content
    // BEFORE any disk write or status flip — a truncated plan must never be
    // silently persisted. This is an early return: no file is written, no
    // status.json is mutated, and the body carries a finalize-specific
    // recovery instruction pointing the caller at the Task tool's saved
    // output to recover the full text.
    if (detectSuspectedTruncation(args.plan_content)) {
      const rejectedBody = [
        "=== ghs-plan-finalize REJECTED (suspected truncation) ===",
        "",
        "未写盘、status 未变。",
        "",
        "查上次 Task 结果的 Full output saved to 行，读该文件尾部取回完整",
        "plan_content 后，用完整文本重新调用 ghs-plan-finalize。",
      ].join("\n");
      return rejectedBody;
    }

    // (a) Resolve the plan identifier + file name. The plan artefact lives at
    // `<YYYY-MM-DD>-<slug>.md`, matching the source skill's single-file
    // convention (ghs-plan/SKILL.md "File Conventions"): the designer writes
    // its draft to this file and finalize overwrites it in place with the
    // reviewer-approved text, so there is exactly one canonical plan `.md`
    // per loop (not two). When the caller passes `plan_id` (the normal
    // post-dispatcher path), we name the file after it — that id equals
    // `<date>-<slug>` and corresponds to `status.plan_file`. When no `plan_id`
    // is supplied (a hand-authored plan that never ran ghs-plan-start), we
    // derive the slug from the plan content's title.
    const slug = deriveSlug(args.plan_content);
    const datePart = formatLocalDate(now);
    const derivedPlanId = `${datePart}-${slug}`;
    const planId = args.plan_id ?? derivedPlanId;
    const planFileName = `${planId}.md`;
    const planFilePath = join(plansDir(projectDir), planFileName);

    // (b) Ensure `.ghs/plans/` exists. `ghs-init` / `ghs-plan-start` usually
    // create it, but a user calling finalize directly on a fresh project
    // (e.g. with a hand-authored plan) shouldn't have to pre-create it.
    // `recursive: true` makes this a no-op when the dir already exists.
    await mkdir(plansDir(projectDir), { recursive: true });

    // (c) Write the plan content verbatim. We do not prepend a timestamp or
    // any metadata — the plan text is the user-visible artefact and the
    // designer already formatted it. The file name carries the date.
    await Bun.write(planFilePath, args.plan_content);

    // (c.5) Mirror the plan to the committable `docs/ghs/plans/` tree (Phase 4
    // / L4). The `.ghs/` artefact above is gitignored; this mirror is the path
    // users check into version control and share with reviewers. The write is
    // wrapped in try/catch because the canonical `.ghs/` write already
    // succeeded — a docs-mirror failure is a degraded-mode condition, not a
    // reason to abort finalisation. On failure we append a warning to the
    // result string instead of throwing.
    const docsPlanFilePath = join(finalPlansDir(projectDir), planFileName);
    let docsWarning: string | null = null;
    try {
      await mkdir(finalPlansDir(projectDir), { recursive: true });
      await Bun.write(docsPlanFilePath, args.plan_content);
    } catch (err) {
      docsWarning = `⚠️  Failed to mirror plan to docs/ghs/plans/: ${(err as Error).message}`;
    }

    // (d) Flip the dispatcher status to `approved` if a status file exists for
    // this plan. `markPlanApproved` returns null when there is no status file
    // (e.g. a hand-authored plan that never ran through ghs-plan-start) — we
    // report that honestly instead of failing the whole finalisation.
    const acceptedWithFail = args.accepted_with_fail === true;
    let statusPath: string | null = null;
    try {
      statusPath = await markPlanApproved(
        projectDir,
        planId,
        acceptedWithFail,
        now,
      );
    } catch (err) {
      // A corrupt status.json (unparseable JSON / schema failure) should NOT
      // silently abort a finalisation that already wrote the plan file. We
      // surface the error in the result text so the AI/user can diagnose,
      // while the plan artefact itself is safely on disk.
      const partialBody = [
        "=== ghs-plan-finalize PARTIAL ===",
        "",
        `Plan written to: ${planFilePath}`,
        "",
        "⚠️  Failed to update status.json:",
        `   ${(err as Error).message}`,
        "",
        "The plan artefact is safely on disk, but the dispatcher state was not",
        "flipped to `approved`. Inspect the status file referenced above.",
      ].join("\n");
      // On the partial-failure path the status file was NOT mutated by us, so
      // its on-disk `status` field is whatever it was before (typically
      // `pending_approval` — non-terminal). Post-advance chrome therefore
      // still applies if there is an active plan.
      return composeChrome({
        ctx,
        projectDir,
        toolName: "ghs-plan-finalize",
        toolArgs: args,
        body: partialBody,
      });
    }

    // (e) Compose the result. Lead with the success marker, the file path, the
    // plan id, and the status-update outcome, then the explicit next-step
    // instruction per the acceptance criteria.
    const lines: string[] = [];
    lines.push("=== ghs-plan-finalize complete ===");
    lines.push("");
    lines.push(`Project directory: ${projectDir}`);
    lines.push(`Plan written to:   ${planFilePath}`);
    if (docsWarning) {
      lines.push(docsWarning);
    } else {
      lines.push(`Mirrored to:       ${docsPlanFilePath}`);
    }
    lines.push(`Plan id:           ${planId}`);
    if (statusPath) {
      lines.push(`Status updated:    ${statusPath} (status: approved)`);
      if (acceptedWithFail) {
        lines.push(
          "Audit flag:        accepted_with_fail=true (plan shipped with unfixed findings)",
        );
      }
    } else {
      lines.push(
        "Status:            no status.json found for this plan id — skipped approval flip",
      );
      lines.push(
        "                   (this is expected when finalising a hand-authored plan)",
      );
    }
    lines.push("");
    lines.push("Next: invoke ghs-sprint to break this plan into features.");
    // (f) Apply workflow chrome (mechanism-1 injection point ② main path).
    // Post-advance timing: getStageSignature is invoked AFTER
    // markPlanApproved returned. On the success path status is now `approved`
    // (terminal) → getStageSignature returns null → no chrome (judgment-table
    // row 1) and the existing "Next: invoke ghs-sprint" hand-off carries the
    // transition. When no prior status.json existed at all (hand-authored
    // plan) the read is likewise null. The chrome only fires when there is a
    // non-terminal active plan left behind by some other condition — which is
    // exactly the safe default we want.
    return composeChrome({
      ctx,
      projectDir,
      toolName: "ghs-plan-finalize",
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
 * `getStageSignature` reads the post-advance `status` field.
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
  const anchor = nextActionAnchor(NEXT_ACTION_PLAN_FINALIZE);

  const prefix = `${header}\n\n`;
  const suffixParts: string[] = [];
  if (todoLine) suffixParts.push(todoLine);
  suffixParts.push(anchor);
  const suffix = `\n\n${suffixParts.join("\n\n")}`;
  return `${prefix}${body}${suffix}`;
}

// -----------------------------------------------------------------------------
// Local helpers re-exported so this module is self-contained for tests that
// want to exercise the slug derivation without going through the tool layer.
// `formatLocalDate` lives in src/lib/scripts/init-project.ts (and is mirrored
// in archive-sprint.ts); we re-implement a tiny local copy here to avoid a
// cross-sprint-file import into scripts/ that would pull init-project's full
// surface into this thin tool module. The implementation is a verbatim copy
// of init-project.ts's `formatLocalDate` so the output stays byte-identical.
// -----------------------------------------------------------------------------

/** Format a Date as `YYYY-MM-DD` in the local timezone (mirrors Python's
 * `datetime.now().strftime("%Y-%m-%d")`). */
function formatLocalDate(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
