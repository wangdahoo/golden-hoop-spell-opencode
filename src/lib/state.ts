// Read/write the plan dispatcher's per-plan `status.json` state file.
//
// Each `ghs-plan-*` tool invocation is one step in a multi-round plan
// generation loop (plan §3.5 / §3.7). Between steps the dispatcher persists
// its progress to `<projectDir>/.ghs/plans/<plan_id>-status.json` so that:
//   - the next `ghs-plan-review` call can pick up where the previous one left
//     off (round counter, current phase, codegraph path taken);
//   - `ghs-plan-finalize` can flip `status` to `approved` atomically;
//   - post-hoc auditing (`grep '"accepted_with_fail": true'`) still works
//     exactly as in the source plugin.
//
// Schema field-by-field parity with the source skill
// (`plugin/skills/ghs-plan/SKILL.md` → "State Tracking"), plus the R1 addition
// required by this sprint: `codegraph_available: boolean` records whether the
// Context Subagent for THIS plan took the codegraph path or the grep fallback
// (drives status reporting + downstream tooling decisions).
//
// Style follows s2-feat-001's writer modules (pure, Zod-validated) + s1-feat-008's
// I/O style (Bun.file / Bun.write, no process.exit, no console.log, descriptive
// thrown Errors on failure). The read/write helpers are *not* pure — they touch
// the filesystem — but each is a thin, single-responsibility wrapper that the
// plan tools compose.

import { z } from "zod";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------

/**
 * Lifecycle states a plan moves through, matching the source skill's enum
 * verbatim. We keep this as a literal union (rather than `z.enum(...)`) so
 * callers get precise autocompletion and the type flows into `PlanStatus.status`
 * without a cast.
 */
export const PLAN_STATUS_VALUES = [
  "designing",
  "reviewing",
  "revising",
  "pending_approval",
  "approved",
  "rejected",
  "aborted",
] as const;
export type PlanStatusValue = (typeof PLAN_STATUS_VALUES)[number];

/**
 * Zod schema for `<plan_id>-status.json`.
 *
 * `strict()` rejects unknown fields so a typo in the dispatcher's write path
 * surfaces immediately instead of silently corrupting state. Mirrors the
 * `GhsConfigSchema` discipline in `src/lib/config.ts`.
 *
 * Fields (source: `plugin/skills/ghs-plan/SKILL.md` "State Tracking"):
 *   - `plan_id`:               the `{date}-{slug}` identifier used to derive
 *                              every sibling file name (`<plan_id>.md`,
 *                              `<plan_id>-context.md`, `<plan_id>-review.md`,
 *                              `<plan_id>-status.json`).
 *   - `plan_file`:             relative name of the designer's plan markdown.
 *   - `context_file`:          relative name of the context snapshot markdown.
 *   - `review_file`:           relative name of the reviewer's review markdown
 *                              (optional until the reviewer has run at least
 *                              once — absence is meaningful).
 *   - `round`:                 current review-revise round, 1-indexed.
 *   - `status`:                lifecycle enum (see {@link PLAN_STATUS_VALUES}).
 *   - `codegraph_available`:   R1 addition — whether `.codegraph/` was present
 *                              when `ghs-plan-start` ran. Persists the path
 *                              choice for the entire plan lifetime so later
 *                              phases and status reports stay consistent.
 *   - `max_rounds`:            soft cap on review-revise iterations.
 *   - `max_rounds_breaches`:   how many times the user overrode the soft cap.
 *   - `accepted_with_fail`:    true iff the plan passed with unfixed issues
 *                              (audit flag — `status` stays `approved`).
 *   - `keep_raw_on_success`:   debug flag — when true, raw subagent responses
 *                              are kept on the happy path.
 *   - `created_at` / `updated_at`: ISO-ish timestamps (`YYYY-MM-DDTHH:mm:ss`).
 */
export const PlanStatusSchema = z.strictObject({
  plan_id: z.string().min(1),
  plan_file: z.string().min(1),
  context_file: z.string().min(1),
  review_file: z.string().optional(),
  round: z.number().int().nonnegative(),
  status: z.enum(PLAN_STATUS_VALUES),
  codegraph_available: z.boolean(),
  max_rounds: z.number().int().positive(),
  max_rounds_breaches: z.number().int().nonnegative(),
  accepted_with_fail: z.boolean(),
  keep_raw_on_success: z.boolean(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});

export type PlanStatus = z.infer<typeof PlanStatusSchema>;

// -----------------------------------------------------------------------------
// Path helpers
// -----------------------------------------------------------------------------

/**
 * Directory holding every plan-related artefact for a project
 * (`<projectDir>/.ghs/plans/`). The status file and its sibling
 * plan/context/review markdowns all live here per the source skill's
 * "File Conventions" table.
 */
export function plansDir(projectDir: string): string {
  return resolve(projectDir, ".ghs", "plans");
}

/**
 * Directory holding the committable mirror of finalised plans
 * (`<projectDir>/docs/ghs/plans/`). The `.ghs/` tree is gitignored, so
 * `ghs-plan-finalize` additionally writes each approved plan here — a path
 * users can check into version control and share with reviewers.
 *
 * Additive sibling of {@link plansDir}; it does NOT replace or alter the
 * canonical `.ghs/plans/` location (Phase 4 of the truncation-save-fix sprint,
 * Feature s2-feat-003).
 */
export function finalPlansDir(projectDir: string): string {
  return resolve(projectDir, "docs", "ghs", "plans");
}

/**
 * Absolute path to a plan's status file
 * (`<projectDir>/.ghs/plans/<plan_id>-status.json`).
 *
 * `planId` is the `{date}-{slug}` identifier emitted by `ghs-plan-start`. The
 * `-status.json` suffix matches the source skill's file convention table
 * verbatim.
 */
export function statusFilePath(projectDir: string, planId: string): string {
  return resolve(plansDir(projectDir), `${planId}-status.json`);
}

// -----------------------------------------------------------------------------
// File-transport staging paths (Tier 1 of the loop-cost fix)
// -----------------------------------------------------------------------------

/**
 * The three subagent families whose delimited output can be staged to disk to
 * bypass the lossy Task-return channel. Each maps to one `ghs-plan-review`
 * mode and one delimiter kind.
 */
export type StagingKind = "snapshot" | "plan" | "review";

/**
 * Absolute path to a subagent's raw staging file
 * (`<projectDir>/.ghs/plans/<plan_id>.<kind>.raw.md`).
 *
 * File-based transport (Tier 1): instead of returning a large delimited
 * payload through the OpenCode Task-return channel — which truncates long
 * subagent output and silently corrupts the plan loop — the subagent writes
 * its full delimited output here via the Write tool (direct disk access, no
 * truncation) and returns only a short completion signal. `ghs-plan-review`
 * then reads this file as the primary parse source.
 *
 * The file holds the RAW delimited text (markers included) — not a cleaned
 * artefact — so the parser remains the single extraction/validation source
 * and the `open_ended` / `fallback_used` / WARNING-header semantics are
 * preserved. The cleaned artefacts still land at `plan_file` / `context_file`
 * / `review_file` via `persistArtefact`.
 *
 * Additive sibling of {@link statusFilePath}; does not alter any existing
 * path convention. Staging files live under gitignored `.ghs/plans/`.
 */
export function stagingPath(
  projectDir: string,
  planId: string,
  kind: StagingKind,
): string {
  return resolve(plansDir(projectDir), `${planId}.${kind}.raw.md`);
}

// -----------------------------------------------------------------------------
// Timestamp helper
// -----------------------------------------------------------------------------

/**
 * Produce a `YYYY-MM-DDTHH:mm:ss` timestamp in the *local* timezone, matching
 * the format the source skill writes. The source uses Python
 * `datetime.now().strftime("%Y-%m-%dT%H:%M:%S")` (no `tzinfo` → local time, no
 * millis). We mirror that exactly so a status file written by the TS port is
 * indistinguishable from one the source plugin would have produced.
 *
 * We deliberately avoid `new Date().toISOString()` — that emits UTC with
 * millis and a `Z` suffix, which reads as a different timezone to users
 * diffing `status.json` and breaks the local-time format contract.
 */
export function formatLocalTimestamp(now: Date = new Date()): string {
  const pad = (n: number): string => n.toString().padStart(2, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  );
}

// -----------------------------------------------------------------------------
// Defaults
// -----------------------------------------------------------------------------

/**
 * Default soft cap on review-revise rounds before the dispatcher asks the user
 * whether to breach. Matches the source skill's default (Phase 2 "Constants"
 * block). Exposed as a named constant so the plan tools can reference the same
 * source of truth instead of re-hardcoding `5`.
 */
export const DEFAULT_MAX_ROUNDS = 5;

/**
 * Build a fresh `PlanStatus` object for a newly-started plan, with sensible
 * defaults pulled from the source skill's "State Tracking" section.
 *
 * The caller supplies the identifying fields (`planId`, `planFile`,
 * `contextFile`, `codegraphAvailable`) plus optional overrides (e.g. a
 * non-default `max_rounds`). Everything else gets the source defaults:
 *   - `round: 1`           — first review-revise round.
 *   - `status: "designing"` — initial lifecycle state.
 *   - `max_rounds_breaches: 0`, `accepted_with_fail: false`,
 *     `keep_raw_on_success: false`.
 *   - `created_at` and `updated_at` set to the same local timestamp.
 *
 * This is a pure function — it does NOT touch the filesystem. Pair with
 * {@link writePlanStatus} to persist.
 */
export function createInitialPlanStatus(args: {
  planId: string;
  planFile: string;
  contextFile: string;
  codegraphAvailable: boolean;
  maxRounds?: number;
  now?: Date;
}): PlanStatus {
  const ts = formatLocalTimestamp(args.now);
  return {
    plan_id: args.planId,
    plan_file: args.planFile,
    context_file: args.contextFile,
    round: 1,
    status: "designing",
    codegraph_available: args.codegraphAvailable,
    max_rounds: args.maxRounds ?? DEFAULT_MAX_ROUNDS,
    max_rounds_breaches: 0,
    accepted_with_fail: false,
    keep_raw_on_success: false,
    created_at: ts,
    updated_at: ts,
  };
}

// -----------------------------------------------------------------------------
// I/O — read / write / existence probe
// -----------------------------------------------------------------------------

/**
 * Read + validate a plan's status file.
 *
 * Behaviour:
 *   - If the file does not exist, returns `null` (the caller — typically
 *     `ghs-plan-review` — decides whether that is an error, e.g. "no plan in
 *     progress, call `ghs-plan-start` first"). We do NOT throw here because
 *     "no status yet" is a normal state for the dispatcher's first step.
 *   - If the file exists but is unparseable JSON or fails the Zod schema,
 *     throws a descriptive `Error` (corrupt state should never be silently
 *     ignored — the dispatcher must stop and surface the problem).
 *
 * @param projectDir - absolute host project root.
 * @param planId     - the `{date}-{slug}` plan identifier.
 * @returns the validated `PlanStatus`, or `null` when no status file exists.
 */
export async function readPlanStatus(
  projectDir: string,
  planId: string,
): Promise<PlanStatus | null> {
  const path = statusFilePath(projectDir, planId);
  const file = Bun.file(path);
  const exists = await file.exists();
  if (!exists) {
    return null;
  }

  let text: string;
  try {
    text = await file.text();
  } catch (err) {
    throw new Error(
      `Failed to read plan status at ${path}: ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Failed to parse plan status at ${path}: invalid JSON — ${(err as Error).message}`,
    );
  }

  // Zod validation surfaces structural corruption (missing fields, wrong
  // types, unknown fields via `.strict()`) as a thrown ZodError. We let it
  // propagate — the plan tools catch Errors and return the message to the AI.
  return PlanStatusSchema.parse(parsed);
}

/**
 * Write a `PlanStatus` to its status file.
 *
 * Side effects:
 *   - Creates `<projectDir>/.ghs/plans/` (recursively) if it does not already
 *     exist, so a fresh project that just ran `ghs-init` does not need a
 *     separate `mkdir`. Matches the source skill's Phase 0 step 3 behaviour.
 *   - Validates `status` against the schema BEFORE writing — a caller that
 *     built an invalid object (e.g. forgot `codegraph_available`) fails loudly
 *     here rather than persisting corrupt state.
 *
 * The on-disk format is `JSON.stringify(status, null, 2)` (pretty-printed,
 * matching the source skill's `json.dump(indent=2)` convention so diffs stay
 * reviewable). No trailing newline is added — the source does not emit one
 * either (`json.dump` has no trailing newline).
 *
 * @param projectDir - absolute host project root.
 * @param status     - the status object to persist (validated + written).
 * @returns the absolute path the status was written to.
 */
export async function writePlanStatus(
  projectDir: string,
  status: PlanStatus,
): Promise<string> {
  // Validate first so we never write a structurally-invalid status to disk.
  // Zod `.parse` throws ZodError on failure; the plan tools surface that.
  const validated = PlanStatusSchema.parse(status);

  const dir = plansDir(projectDir);
  // mkdir -p the plans dir. `recursive: true` makes this a no-op when the dir
  // already exists, so repeated writes are cheap.
  await mkdir(dir, { recursive: true });

  const path = statusFilePath(projectDir, validated.plan_id);
  await Bun.write(path, JSON.stringify(validated, null, 2));
  return path;
}

/**
 * Whether a status file exists for the given plan. Convenience wrapper around
 * `Bun.file(...).exists()` so callers don't have to import BunFile plumbing
 * just to do an existence check (mirrors the `fileExists` helper in
 * `src/lib/config.ts`).
 */
export async function planStatusExists(
  projectDir: string,
  planId: string,
): Promise<boolean> {
  return Bun.file(statusFilePath(projectDir, planId)).exists();
}
