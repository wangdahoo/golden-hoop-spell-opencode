// `ghs-force-archive` tool — destructive archive of ALL sprints.
//
// Unlike `ghs-archive`, which only touches `status: completed` sprints, this
// tool moves every sprint (including in_progress / planning / blocked ones)
// into `.ghs/archived/`. It is the "I know what I'm doing, wipe it all"
// escape hatch.
//
// Because that's destructive, we gate it behind a transcription nonce:
//   - The user first calls `ghs-archive` (any mode). When there are any
//     incomplete sprints, `ghs-archive` issues a random alphanumeric nonce
//     and writes it to `.ghs/.force-archive-nonce`, surfacing it in the tool
//     result.
//   - The user then calls this tool with the nonce transcribed into the
//     `transcription` arg. We read the nonce file, verify via
//     `verifyTranscribeNonce`, and only then proceed.
//   - The nonce is consumed (file deleted) on a successful verification so a
//     captured nonce can't be replayed.
//
// Per the feature's `technical_notes` this is weaker than the source plugin's
// `AskUserQuestion` sync-block (a nonce is guessable by a determined LLM),
// but it satisfies the AC: "missing or incorrect transcription → error +
// no archive; matching transcription → archive".

import { tool } from "@opencode-ai/plugin";
import type { ToolContext } from "@opencode-ai/plugin/tool";
import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import {
  archiveSprints,
  getAllSprints,
  formatArchiveReport,
  type ArchivedSprintInfo,
} from "../lib/scripts/archive-sprint.ts";
import { verifyTranscribeNonce } from "../lib/nonce.ts";
import { resolveProjectDir } from "../lib/project.ts";
import { readNonce, nonceFilePath } from "./archive.ts";

/** Load features.json. Returns null if missing. */
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

/**
 * The `ghs-force-archive` tool definition. Registered under the
 * `ghs-force-archive` key.
 */
export const forceArchiveTool = tool({
  description:
    "⚠️  Destructive: archive ALL sprints regardless of status (including in_progress / planning / blocked). " +
    "Use `ghs-archive` instead for the normal completed-sprint flow. " +
    "Requires a `transcription` token — call `ghs-archive` first; when incomplete sprints remain it will " +
    "issue a nonce, which you transcribe back here to confirm. Without a matching transcription the tool " +
    "refuses to archive anything.",
  args: {
    project_dir: tool.schema
      .string()
      .optional()
      .describe(
        "Absolute path of the project root. Defaults to the opencode session's worktree/directory.",
      ),
    transcription: tool.schema
      .string()
      .describe(
        "The nonce token issued by a prior `ghs-archive` call (when incomplete sprints existed). " +
          "Must match the issued nonce (case-insensitive, whitespace-trimmed) for the archive to proceed.",
      ),
  },
  async execute(
    args: { project_dir?: string; transcription: string },
    ctx: ToolContext,
  ): Promise<string> {
    const projectDir = args.project_dir
      ? resolve(args.project_dir)
      : resolveProjectDir(ctx);

    // ----- Pre-flight: does the project even have features.json? -----
    const features = await loadFeaturesData(projectDir);
    if (!features) {
      return [
        "=== Sprint Archiver (force) ===",
        "",
        `Project directory: ${projectDir}`,
        "",
        "❌ features.json not found. Run `ghs-init` first.",
      ].join("\n") + "\n";
    }

    const allSprints = getAllSprints(features);
    if (allSprints.length === 0) {
      return formatArchiveReport({
        projectDir,
        mode: "archive",
        force: true,
        sprintsConsidered: [],
        archived: [],
        remainingCount: 0,
        resetProgress: false,
      });
    }

    // ----- Nonce gate -----
    const issuedNonce = await readNonce(projectDir, /* consume: */ false);
    if (issuedNonce === null) {
      return [
        "❌ ghs-force-archive: no transcription nonce on file.",
        "",
        "Call `ghs-archive` first; when there are incomplete sprints it will issue a nonce token.",
        "Then transcribe that token back as the `transcription` arg of this tool.",
        "",
        `Expected nonce file: ${nonceFilePath(projectDir)}`,
      ].join("\n") + "\n";
    }

    const ok = verifyTranscribeNonce(issuedNonce, args.transcription);
    if (!ok) {
      return [
        "❌ ghs-force-archive: transcription does not match the issued nonce.",
        "",
        "No files were modified. To retry:",
        "  1. Call `ghs-archive` (any mode) to get a fresh nonce, OR",
        `  2. Re-transcribe the existing nonce (case-insensitive, trimmed) into the \`transcription\` arg.`,
      ].join("\n") + "\n";
    }

    // Gate passed — consume the nonce so it can't be replayed.
    await readNonce(projectDir, /* consume: */ true);

    // ----- Force archive -----
    // We collect the preview first (force + dry-run) so the report can show
    // sprintsConsidered, then run the real archive.
    const preview = await archiveSprints({
      projectDir,
      dryRun: true,
      force: true,
    });

    const archived: ArchivedSprintInfo[] = await archiveSprints({
      projectDir,
      dryRun: false,
      force: true,
    });

    // After force-archive there are no sprints left → resetProgress is true
    // when archiveSprints actually moved something.
    const featuresAfter = await loadFeaturesData(projectDir);
    const remainingCount = featuresAfter
      ? getAllSprints(featuresAfter).length
      : 0;
    const resetProgress = archived.length > 0 && remainingCount === 0;

    // sprintsConsidered is `Record<string, unknown>[]` which matches the
    // `Sprint[]` param of formatArchiveReport (Sprint === JsonObject
    // internally).
    const sprintsConsidered = preview.map((info) => ({
      id: info.sprint_id,
      name: info.sprint_name,
      status: info.sprint_status,
    }));

    if (archived.length === 0) {
      // Shouldn't normally happen (we checked allSprints.length > 0 above)
      // but guard anyway — return the canonical "no sprints" report.
      return formatArchiveReport({
        projectDir,
        mode: "archive",
        force: true,
        sprintsConsidered,
        archived: [],
        remainingCount,
        resetProgress,
      });
    }

    const report = formatArchiveReport({
      projectDir,
      mode: "archive",
      force: true,
      sprintsConsidered,
      archived,
      remainingCount,
      resetProgress,
    });

    return report;
  },
});
