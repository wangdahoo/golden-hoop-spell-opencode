// `ghs-plan-finalize` tool — the plan dispatcher's exit step.
//
// After the review-revise loop converges on a reviewer-approved plan, the
// primary AI calls this tool with the final plan text. This tool:
//   1. Resolves the target project dir (explicit `project_dir` arg wins;
//      otherwise `resolveProjectDir(ctx)` reads the opencode session's
//      worktree/directory).
//   2. Derives a slug from the plan content's first meaningful line (the
//      title / H1), sanitising it to `[a-z0-9-]+` so the file name is
//      filesystem-safe and matches the source skill's convention.
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
  readPlanStatus,
  writePlanStatus,
  formatLocalTimestamp,
  type PlanStatus,
} from "../lib/state.ts";
import { resolveProjectDir } from "../lib/project.ts";

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

    // (a) Derive the plan identifier + file name. The convention is
    // `<YYYY-MM-DD>-<slug>.md`, matching the plan_ref field on this very
    // sprint (`2026-06-20-opencode-port.md`) and the source skill's "File
    // Conventions" table. The plan_id (used to locate status.json) shares the
    // same `{date}-{slug}` form, minus the `.md` extension.
    const slug = deriveSlug(args.plan_content);
    const datePart = formatLocalDate(now);
    const derivedPlanId = `${datePart}-${slug}`;
    const planId = args.plan_id ?? derivedPlanId;
    const planFileName = `${derivedPlanId}.md`;
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
      return [
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
    }

    // (e) Compose the result. Lead with the success marker, the file path, the
    // plan id, and the status-update outcome, then the explicit next-step
    // instruction per the acceptance criteria.
    const lines: string[] = [];
    lines.push("=== ghs-plan-finalize complete ===");
    lines.push("");
    lines.push(`Project directory: ${projectDir}`);
    lines.push(`Plan written to:   ${planFilePath}`);
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
    return lines.join("\n");
  },
});

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
