// `ghs-archive` tool — archive completed sprints (or preview / list them).
//
// Three modes (mutually exclusive; `list` wins, then `dry_run`, then the
// default `archive`):
//   - `list:    true`  → print all completed sprints without archiving.
//   - `dry_run: true`  → preview what would be archived; write no files.
//   - (neither)        → actually move completed sprints to `.ghs/archived/`.
//
// The dry-run path ALSO writes a nonce file (`.ghs/.force-archive-nonce`)
// when there are any *incomplete* sprints remaining. This is the gate the
// `ghs-force-archive` tool reads back: the user is expected to transcribe
// the nonce to confirm a subsequent force-archive call. The nonce persists
// across calls on disk (simpler than threading per-invocation state through
// the tool protocol — see the feature's technical_notes).
//
// Output text mirrors the original `archive_sprint.py` script byte-for-byte;
// we append a short nonce section to the dry-run output when one is issued.

import { tool } from "@opencode-ai/plugin";
import type { ToolContext } from "@opencode-ai/plugin/tool";
import { existsSync } from "node:fs";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  archiveSprints,
  getAllSprints,
  getCompletedSprints,
  formatArchiveReport,
  formatListReport,
  type ArchivedSprintInfo,
} from "../lib/scripts/archive-sprint.ts";
import { generateNonce } from "../lib/nonce.ts";
import { resolveProjectDir } from "../lib/project.ts";
import {
  acquireLock,
  releaseLock,
  buildLabel,
} from "../lib/runtime-lock.ts";
import { renderConflictMessage } from "../lib/scripts/runtime-lock.ts";

/** Path of the per-project nonce file used by `ghs-force-archive`. */
function nonceFilePath(projectDir: string): string {
  return join(resolve(projectDir), ".ghs", ".force-archive-nonce");
}

/**
 * Write the issued nonce to disk so `ghs-force-archive` can read it back.
 * Truncated on each call so stale nonces from a prior run can't be reused.
 */
async function writeNonce(projectDir: string, nonce: string): Promise<void> {
  await writeFile(nonceFilePath(projectDir), nonce, "utf8");
}

/**
 * Read (and delete) the nonce file. Deleting on read means a captured nonce
 * can only be transcribed once — a stale `ghs-force-archive` call after the
 * nonce has been consumed will fail the gate.
 *
 * Returns the nonce string, or null when the file is absent. If `consume`
 * is false the file is left in place (used by `ghs-force-archive`'s own
 * pre-flight check; the actual consume happens after the gate passes).
 */
async function readNonce(
  projectDir: string,
  consume: boolean,
): Promise<string | null> {
  const path = nonceFilePath(projectDir);
  if (!existsSync(path)) {
    return null;
  }
  const nonce = (await readFile(path, "utf8")).trim();
  if (consume) {
    try {
      await unlink(path);
    } catch {
      // Nonce file may already be gone (concurrent call) — non-fatal.
    }
  }
  return nonce;
}

/**
 * Count sprints that are NOT completed (i.e. could still be force-archived).
 * Used to decide whether the nonce gate is even relevant for this project.
 */
function countIncompleteSprints(featuresData: Record<string, unknown>): number {
  const all = getAllSprints(featuresData);
  return all.filter((s) => s.status !== "completed").length;
}

/** Load features.json from `<projectDir>/.ghs/features.json`. Returns null if missing. */
async function loadFeaturesData(
  projectDir: string,
): Promise<Record<string, unknown> | null> {
  const path = join(resolve(projectDir), ".ghs", "features.json");
  if (!existsSync(path)) {
    return null;
  }
  const text = await readFile(path, "utf8");
  return JSON.parse(text) as Record<string, unknown>;
}

// Exported for `ghs-force-archive` to read + consume the nonce file.
export { readNonce, writeNonce, nonceFilePath };

/**
 * The `ghs-archive` tool definition. Registered under the `ghs-archive` key.
 */
export const archiveTool = tool({
  description:
    "Archive completed sprints to `.ghs/archived/` and remove them from features.json. " +
    "Three modes: `list: true` lists completed sprints without changing anything; " +
    "`dry_run: true` previews what would be archived without writing files; " +
    "neither flag actually moves completed sprints to `.ghs/archived/`. " +
    "Only sprints with status 'completed' are archived — use `ghs-force-archive` to archive incomplete sprints.",
  args: {
    dry_run: tool.schema
      .boolean()
      .optional()
      .describe(
        "When true, preview what would be archived without modifying any files.",
      ),
    list: tool.schema
      .boolean()
      .optional()
      .describe(
        "When true, list completed sprints without archiving. Takes precedence over `dry_run`.",
      ),
    project_dir: tool.schema
      .string()
      .optional()
      .describe(
        "Absolute path of the project root. Defaults to the opencode session's worktree/directory.",
      ),
    takeover: tool.schema
      .boolean()
      .optional()
      .describe(
        "Set true to forcibly take over the ghs runtime lock (.ghs/active.lock) " +
        "when another session holds it. Use only after seeing a conflict message " +
        "and consciously deciding to 接管 (the other session's subsequent writes " +
        "will be rejected by the leaf-writer pre-write validate).",
      ),
  },
  async execute(
    args: { dry_run?: boolean; list?: boolean; project_dir?: string; takeover?: boolean },
    ctx: ToolContext,
  ): Promise<string> {
    const projectDir = args.project_dir
      ? resolve(args.project_dir)
      : resolveProjectDir(ctx);

    const listMode = args.list === true;
    const dryRunMode = !listMode && args.dry_run === true;
    const archiveMode = !listMode && !dryRunMode;

    // ----- list mode -----
    if (listMode) {
      const features = await loadFeaturesData(projectDir);
      if (!features) {
        return [
          "=== Sprint Archiver ===",
          "",
          `Project directory: ${projectDir}`,
          "",
          "❌ features.json not found. Run `ghs-init` first.",
        ].join("\n") + "\n";
      }
      const completed = getCompletedSprints(features);
      return formatListReport({
        projectDir,
        force: false,
        sprints: completed,
      });
    }

    // ----- dry-run + archive modes both go through archiveSprints -----
    // (M2/M3) acquireLock as a stage owner AFTER the list-mode dispatch and
    // BEFORE any write. list mode is a pure read and skips the lock. archive
    // is the sprint-closing action, so it reuses the `sprint` stage (same-
    // session idempotent with a pre-existing sprint/code lock). Every return
    // path below goes through the finally → releaseLock, so the lock never
    // leaks; an exception in the post-acquire section also releases.
    const lock = await acquireLock({
      projectDir,
      sessionId: ctx.sessionID,
      stage: "sprint",
      sprintId: null,
      holderLabel: buildLabel(ctx),
      takeover: args.takeover ?? false,
    });
    if (!lock.acquired) {
      return renderConflictMessage(
        lock.holder,
        "ghs-archive 归档 sprint",
        "ghs-archive",
      );
    }

    try {
      // We call archiveSprints twice for the archive path: once with
      // dryRun=true to get the preview info, then once with dryRun=false to
      // actually move the files. This keeps the report identical to Python's
      // (which prints the per-sprint "Archiving sprint:" line *before* the
      // move) without reaching into archiveSprintFiles' internals.
      //
      // For dry-run, the single dryRun=true call is enough.
      const preview = await archiveSprints({
        projectDir,
        dryRun: true,
        force: false,
      });

      // Pre-load the features data — we need it to compute remainingCount and
      // to decide whether to issue a force-archive nonce below.
      const featuresBefore = await loadFeaturesData(projectDir);

      if (preview.length === 0) {
        // Nothing completed to archive. But if there are *incomplete* sprints,
        // we still want to issue a nonce so the user can `ghs-force-archive`
        // them. Short-circuit the normal report and append a nonce hint.
        const report = formatArchiveReport({
          projectDir,
          mode: dryRunMode ? "dry-run" : "archive",
          force: false,
          sprintsConsidered: [],
          archived: [],
          remainingCount: featuresBefore ? getAllSprints(featuresBefore).length : 0,
          resetProgress: false,
        });
        return maybeAppendNonce(projectDir, report, featuresBefore);
      }

      let archived: ArchivedSprintInfo[];
      let featuresAfter: Record<string, unknown> | null = null;
      if (dryRunMode) {
        archived = preview;
      } else {
        // archiveMode: actually archive.
        archived = await archiveSprints({
          projectDir,
          dryRun: false,
          force: false,
        });
        featuresAfter = await loadFeaturesData(projectDir);
      }

      // Compute remainingCount + resetProgress for the report.
      const featuresForReport = featuresAfter ?? (await loadFeaturesData(projectDir));
      const remainingSprints: Record<string, unknown>[] = featuresForReport
        ? getAllSprints(featuresForReport)
        : [];
      const remainingCount = remainingSprints.length;
      const resetProgress = archived.length > 0 && remainingCount === 0;

      // sprintsConsidered for the report: the preview (completed sprints).
      // `formatArchiveReport` accepts `sprintsConsidered: Sprint[]` where
      // `Sprint` is `Record<string, unknown>` internally — so the mapped
      // object literal matches without a cast.
      const sprintsConsidered = preview.map((info) => ({
        id: info.sprint_id,
        name: info.sprint_name,
        status: info.sprint_status,
      }));

      const report = formatArchiveReport({
        projectDir,
        mode: archiveMode ? "archive" : "dry-run",
        force: false,
        sprintsConsidered,
        archived,
        remainingCount,
        resetProgress,
      });

      // ----- nonce gate hook -----
      return maybeAppendNonce(projectDir, report, featuresForReport);
    } finally {
      await releaseLock({ projectDir, sessionId: ctx.sessionID });
    }
  },
});

/**
 * Append a force-archive nonce hint to the report when there are any
 * incomplete sprints remaining. Issues a fresh nonce and writes it to
 * `.ghs/.force-archive-nonce`. When there are no incomplete sprints,
 * returns `report` unchanged.
 *
 * The features data is passed in (rather than re-loaded) so callers that
 * already have a recent copy can avoid a redundant disk read.
 */
async function maybeAppendNonce(
  projectDir: string,
  report: string,
  features: Record<string, unknown> | null,
): Promise<string> {
  if (!features) {
    return report;
  }
  const incomplete = countIncompleteSprints(features);
  if (incomplete === 0) {
    return report;
  }
  const nonce = generateNonce();
  await writeNonce(projectDir, nonce);
  return (
    report +
    [
      "",
      "⚠️  Incomplete sprints remain and can only be removed with `ghs-force-archive`.",
      `   To confirm a force-archive, transcribe this token back: ${nonce}`,
      "   (Call `ghs-force-archive` with `transcription: \"<token>\"`.)",
    ].join("\n") +
    "\n"
  );
}
