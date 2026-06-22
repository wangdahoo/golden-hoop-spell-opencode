// Port of golden-hoop-spell/plugin/shared/scripts/archive_sprint.py.
//
// Behavior source-of-truth:
//   /Users/tom/github/golden-hoop-spell/plugin/shared/scripts/archive_sprint.py
//
// Faithful port notes:
//   - JSON output uses `JSON.stringify(obj, null, 2)` — matches Python's
//     `json.dump(obj, f, indent=2)` for ASCII content (the source template
//     is pure ASCII; archive data is derived from it).
//   - Timestamps use the local timezone (Python `datetime.now().strftime(...)`
//     is naive local time). See `formatTimestamp()` / `formatArchiveDate()`.
//   - The H2 splitter mirrors Python `re.split(r"^## ", content, flags=re.
//     MULTILINE)` via JS `/^## /m`.
//   - This module exports pure functions returning structured results. No
//     stdout writes — the CLI layer (s1-feat-009) renders text using
//     `formatArchiveReport`.

import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

type JsonObject = Record<string, unknown>;
type Sprint = JsonObject;
type Feature = JsonObject;
type FeaturesData = JsonObject;

const ARCHIVED_DIR = ".ghs/archived";
const GHS_DIR = ".ghs";

/** All sprints. Mirrors Python `get_all_sprints`. */
export function getAllSprints(featuresData: FeaturesData): Sprint[] {
  return (featuresData.sprints ?? []) as Sprint[];
}

/** Sprints with status == "completed". Mirrors Python `get_completed_sprints`. */
export function getCompletedSprints(featuresData: FeaturesData): Sprint[] {
  const sprints = (featuresData.sprints ?? []) as Sprint[];
  return sprints.filter((s) => s.status === "completed");
}

/**
 * First sprint whose status is `in_progress` or `planning`, or null.
 * Mirrors Python `get_in_progress_sprint`.
 */
export function getInProgressSprint(
  featuresData: FeaturesData,
): Sprint | null {
  const sprints = (featuresData.sprints ?? []) as Sprint[];
  for (const sprint of sprints) {
    const status = sprint.status;
    if (status === "in_progress" || status === "planning") {
      return sprint;
    }
  }
  return null;
}

/** Create `.ghs/archived/` if missing; return its absolute path. */
export async function createArchiveStructure(
  projectDir: string,
): Promise<string> {
  const archivedPath = join(projectDir, ARCHIVED_DIR);
  await mkdir(archivedPath, { recursive: true });
  return archivedPath;
}

/** Info record about an archived sprint (one per sprint). */
export interface ArchivedSprintInfo {
  sprint_id: string;
  sprint_name: string;
  sprint_status: string;
  /** Set when dry_run is true; otherwise archive_path is set. */
  dry_run?: boolean;
  /** Absolute path of the created archive folder (omitted when dry_run). */
  archive_path?: string;
}

/**
 * Archive a single sprint's data: write `features.json` (containing project +
 * archived_sprint + metadata) and — when relevant — `progress.md` (containing
 * the sessions that matched this sprint ID).
 *
 * Mirrors Python `archive_sprint_files`. Returns `[archiveFeaturesPath,
 * archiveProgressPath]`.
 *
 * Faithfulness note: the Python source captures `datetime.now()` three times
 * (once for the folder timestamp, once for `metadata.archived_at`, once for
 * the progress.md `Archived:` header). To stay byte-faithful at the second
 * granularity — while still allowing deterministic tests — we accept up to
 * three Date values via optional parameters; each defaults to `new Date()`
 * at call time so production callers see the same behaviour as Python.
 */
export async function archiveSprintFiles(
  sprint: Sprint,
  featuresData: FeaturesData,
  projectDir: string,
  archivedPath: string,
  /**
   * Dates used for the various timestamp outputs. Production callers can
   * leave this undefined to mirror Python's repeated `datetime.now()` calls;
   * tests can pass fixed dates for deterministic output.
   */
  dates: {
    /** Used for the archive folder name (`<sprint>_<name>_<YYYYMMDD_HHMMSS>`). */
    folder?: Date;
    /** Used for `metadata.archived_at`. */
    archivedAt?: Date;
    /** Used for the progress.md `Archived:` header. */
    progressArchivedAt?: Date;
  } = {},
): Promise<[string, string]> {
  const sprintId = (sprint.id as string | undefined) ?? "unknown";
  const rawName = (sprint.name as string | undefined) ?? "unnamed";
  const sprintName = rawName.replace(/ /g, "_").toLowerCase();
  const timestamp = formatTimestamp(dates.folder ?? new Date());

  const archiveFolder = join(
    archivedPath,
    `${sprintId}_${sprintName}_${timestamp}`,
  );
  await mkdir(archiveFolder, { recursive: true });

  const archiveFeatures = join(archiveFolder, "features.json");
  const archiveProgress = join(archiveFolder, "progress.md");

  const archivedAt = formatArchiveDate(dates.archivedAt ?? new Date());
  const archivedSprintData = {
    project: featuresData.project ?? {},
    archived_sprint: sprint,
    metadata: {
      archived_at: archivedAt,
      original_sprint_id: sprintId,
    },
  };

  await writeFile(
    archiveFeatures,
    JSON.stringify(archivedSprintData, null, 2),
    "utf8",
  );

  const progressPath = join(projectDir, GHS_DIR, "progress.md");
  if (existsSync(progressPath)) {
    const sessions = await extractSprintSessions(progressPath, sprintId);
    if (sessions.length > 0) {
      const progressArchivedAt = formatArchiveDate(
        dates.progressArchivedAt ?? new Date(),
      );
      const lines: string[] = [];
      lines.push(`# Progress Log - ${(sprint.name as string | undefined) ?? sprintId}`);
      lines.push("");
      lines.push(`Archived: ${progressArchivedAt}`);
      lines.push("");
      lines.push("---");
      lines.push("");
      lines.push(sessions);
      await writeFile(archiveProgress, lines.join("\n"), "utf8");
    }
  }

  return [archiveFeatures, archiveProgress];
}

/**
 * Check whether a session entry belongs to a given sprint by inspecting only
 * the title line and the first ~10 metadata lines — NOT the full body text.
 *
 * Mirrors Python `_entry_matches_sprint`: title-case-insensitive substring
 * match of `sprint_id` within the first 11 lines.
 */
export function entryMatchesSprint(entry: string, sprintId: string): boolean {
  const lines = entry.trim().split("\n");
  const headerLines = lines.slice(0, 11);
  const headerText = headerLines.join("\n").toLowerCase();
  return headerText.includes(sprintId.toLowerCase());
}

/**
 * Split progress.md content by `## ` H2 headings, returning individual
 * entries (each prefixed with `## `).
 *
 * Mirrors Python `_split_entries`: drops everything before the first H2.
 */
export function splitEntries(content: string): string[] {
  const parts = content.split(/^## /m);
  const entries: string[] = [];
  // Skip parts[0] (everything before the first H2 heading).
  for (let i = 1; i < parts.length; i++) {
    entries.push("## " + parts[i]);
  }
  return entries;
}

/**
 * Extract sessions related to a specific sprint from progress.md.
 *
 * Mirrors Python `extract_sprint_sessions`: returns the matching entries
 * joined by `\n\n`.
 */
export async function extractSprintSessions(
  progressPath: string,
  sprintId: string,
): Promise<string> {
  const content = await readFile(progressPath, "utf8");
  const entries = splitEntries(content);
  const relevant: string[] = [];
  for (const entry of entries) {
    if (entryMatchesSprint(entry, sprintId)) {
      relevant.push(entry);
    }
  }
  return relevant.join("\n\n");
}

/**
 * Remove an archived sprint from features.json (mutates a copy and returns it).
 * Sets `metadata.last_updated` to today's date.
 *
 * Mirrors Python `remove_archived_sprint`.
 */
export function removeArchivedSprint(
  featuresData: FeaturesData,
  sprintId: string,
  now: Date = new Date(),
): FeaturesData {
  const sprints = (featuresData.sprints ?? []) as Sprint[];
  featuresData.sprints = sprints.filter((s) => s.id !== sprintId);
  const metadata = (featuresData.metadata ?? {}) as JsonObject;
  metadata.last_updated = formatLocalDate(now);
  featuresData.metadata = metadata;
  return featuresData;
}

/**
 * Read the default progress.md template from `shared/assets/progress.md`.
 *
 * Mirrors Python `get_progress_template`. Throws when the template is missing.
 */
export async function getProgressTemplate(
  pluginRootPath: string = defaultPluginRoot(),
): Promise<string> {
  const templatePath = join(pluginRootPath, "shared", "assets", "progress.md");
  if (!existsSync(templatePath)) {
    throw new Error(`Progress template not found: ${templatePath}`);
  }
  return readFile(templatePath, "utf8");
}

/** Reset progress.md to the default template. Mirrors Python `reset_progress_md`. */
export async function resetProgressMd(
  progressPath: string,
  pluginRootPath: string = defaultPluginRoot(),
): Promise<void> {
  const template = await getProgressTemplate(pluginRootPath);
  await writeFile(progressPath, template, "utf8");
}

/**
 * Remove sessions belonging to any of the given sprint IDs from progress.md.
 *
 * Mirrors Python `remove_sprint_sessions`: keeps entries that don't match any
 * of the archived sprint IDs; preserves the pre-`## ` header verbatim and
 * inserts a `\n\n` separator between header and remaining entries.
 */
export async function removeSprintSessions(
  progressPath: string,
  sprintIds: string[],
): Promise<void> {
  const content = await readFile(progressPath, "utf8");
  const entries = splitEntries(content);
  // Everything before the first H2 heading is the header.
  const parts = content.split(/^## /m);
  const header = parts[0];

  const remaining: string[] = [];
  for (const entry of entries) {
    if (!sprintIds.some((sid) => entryMatchesSprint(entry, sid))) {
      remaining.push(entry);
    }
  }

  let next = header;
  if (remaining.length > 0) {
    if (!header.endsWith("\n\n")) {
      next += "\n\n";
    }
    next += remaining.join("\n\n");
  }
  await writeFile(progressPath, next, "utf8");
}

/** Options accepted by `archiveSprints`. */
export interface ArchiveOptions {
  projectDir: string;
  /** When true, no files are modified; the result lists what would be archived. */
  dryRun?: boolean;
  /** When true, archive all sprints regardless of status. */
  force?: boolean;
  /**
   * Override the plugin root used to locate the progress.md template.
   * Defaults to the plugin root resolved from `import.meta.dir`.
   */
  pluginRootPath?: string;
}

/**
 * Archive completed sprints (or all sprints when `force` is true).
 *
 * Mirrors Python `archive_completed_sprints`. Returns the list of archived
 * sprint info records. When `dryRun` is true, no files are touched and each
 * record carries `dry_run: true` instead of `archive_path`.
 */
export async function archiveSprints(
  options: ArchiveOptions,
): Promise<ArchivedSprintInfo[]> {
  const projectDir = pyResolve(options.projectDir);
  const featuresPath = join(projectDir, GHS_DIR, "features.json");
  const progressPath = join(projectDir, GHS_DIR, "progress.md");
  const dryRun = options.dryRun === true;
  const force = options.force === true;
  const pluginRootPath = options.pluginRootPath ?? defaultPluginRoot();

  if (!existsSync(featuresPath)) {
    return [];
  }

  const featuresText = await readFile(featuresPath, "utf8");
  let featuresData = JSON.parse(featuresText) as FeaturesData;

  let sprintsToArchive: Sprint[];
  if (force) {
    sprintsToArchive = getAllSprints(featuresData);
  } else {
    sprintsToArchive = getCompletedSprints(featuresData);
  }

  if (sprintsToArchive.length === 0) {
    return [];
  }

  const archivedPath = await createArchiveStructure(projectDir);
  const archivedInfo: ArchivedSprintInfo[] = [];

  for (const sprint of sprintsToArchive) {
    const sprintId = (sprint.id as string | undefined) ?? "unknown";
    const sprintName = (sprint.name as string | undefined) ?? "unknown";
    const sprintStatus = (sprint.status as string | undefined) ?? "unknown";

    if (!dryRun) {
      const [featPath] = await archiveSprintFiles(
        sprint,
        featuresData,
        projectDir,
        archivedPath,
      );
      featuresData = removeArchivedSprint(featuresData, sprintId);

      archivedInfo.push({
        sprint_id: sprintId,
        sprint_name: sprintName,
        sprint_status: sprintStatus,
        archive_path: dirname(featPath),
      });
    } else {
      archivedInfo.push({
        sprint_id: sprintId,
        sprint_name: sprintName,
        sprint_status: sprintStatus,
        dry_run: true,
      });
    }
  }

  if (!dryRun && archivedInfo.length > 0) {
    await writeFile(featuresPath, JSON.stringify(featuresData, null, 2), "utf8");

    const remainingSprints = (featuresData.sprints ?? []) as Sprint[];
    if (remainingSprints.length === 0) {
      await resetProgressMd(progressPath, pluginRootPath);
    } else {
      const archivedSprintIds = archivedInfo.map((info) => info.sprint_id);
      await removeSprintSessions(progressPath, archivedSprintIds);
    }
  }

  return archivedInfo;
}

// ---------------------------------------------------------------------------
// CLI-friendly formatters. The original script prints a lot of human-facing
// status lines; the tool layer (s1-feat-009) renders them via these helpers
// to keep byte-identical stdout.

/** "Project directory: <dir>" header used at the top of every archive run. */
export function formatProjectHeader(projectDir: string): string {
  return `Project directory: ${projectDir}`;
}

/** "Force archiving ALL <N> sprint(s)" line. */
export function formatForceArchivingAll(count: number): string {
  return `Force archiving ALL ${count} sprint(s)`;
}

/** Per-sprint "Archiving sprint: <name> (<id>)" + status block. */
export function formatArchivingSprint(sprint: Sprint): string {
  const name = (sprint.name as string | undefined) ?? "unknown";
  const id = (sprint.id as string | undefined) ?? "unknown";
  const status = (sprint.status as string | undefined) ?? "unknown";
  return [`Archiving sprint: ${name} (${id})`, `  Status: ${status}`].join("\n");
}

/**
 * Render the full archive report — byte-identical to what `main()`
 * prints to stdout for a given set of inputs.
 *
 * This is a pure function over structured inputs; it does NOT touch the
 * filesystem. The caller is expected to have invoked `archiveSprints` (or
 * `listSprints`) and pass the results here.
 */
export function formatArchiveReport(args: {
  projectDir: string;
  mode: "archive" | "dry-run";
  force: boolean;
  sprintsConsidered: Sprint[];
  archived: ArchivedSprintInfo[];
  remainingCount: number;
  resetProgress: boolean;
}): string {
  const lines: string[] = [];
  lines.push("=== Sprint Archiver ===");
  lines.push("");
  lines.push(formatProjectHeader(args.projectDir));
  lines.push("");

  if (args.force && args.sprintsConsidered.length > 0) {
    lines.push(formatForceArchivingAll(args.sprintsConsidered.length));
    lines.push("");
  } else if (args.sprintsConsidered.length === 0) {
    lines.push(args.force ? "No sprints found to archive." : "No completed sprints to archive.");
    return lines.join("\n") + "\n";
  }

  const archivedPath = join(args.projectDir, ARCHIVED_DIR);
  for (const info of args.archived) {
    lines.push(`Archiving sprint: ${info.sprint_name} (${info.sprint_id})`);
    lines.push(`  Status: ${info.sprint_status}`);
    if (info.dry_run) {
      lines.push(`  [DRY RUN] Would archive to: ${archivedPath}/${info.sprint_id}_...`);
    } else if (info.archive_path) {
      lines.push(`  Created: ${info.archive_path}`);
    }
  }

  if (args.archived.length === 0) {
    return lines.join("\n") + "\n";
  }

  if (args.mode === "archive") {
    lines.push("");
    lines.push(
      `Updated features.json - removed ${args.archived.length} archived sprint(s)`,
    );
    if (args.resetProgress) {
      lines.push("Reset progress.md to default template");
    } else {
      lines.push(
        `Removed ${args.archived.length} archived sprint session(s) from progress.md ` +
          `(${args.remainingCount} sprint(s) remaining)`,
      );
    }
  }

  lines.push("");
  lines.push(`Archived ${args.archived.length} sprint(s)`);
  return lines.join("\n") + "\n";
}

/**
 * List sprints without archiving. Returns the rendered text identical to
 * Python's `--list` branch.
 */
export function formatListReport(args: {
  projectDir: string;
  force: boolean;
  sprints: Sprint[];
}): string {
  const lines: string[] = [];
  lines.push("=== Sprint Archiver ===");
  lines.push("");
  lines.push(formatProjectHeader(args.projectDir));
  lines.push("");

  if (args.sprints.length === 0) {
    lines.push(args.force ? "No sprints found." : "No completed sprints found.");
    return lines.join("\n") + "\n";
  }

  lines.push(args.force ? "All sprints:" : "Completed sprints:");
  lines.push("");

  for (const sprint of args.sprints) {
    const features = (sprint.features ?? []) as Feature[];
    const completedFeatures = features.filter((f) => f.status === "completed").length;
    const status = (sprint.status as string | undefined) ?? "unknown";
    lines.push(
      `  - ${(sprint.name as string | undefined) ?? "unknown"} (${sprint.id ?? ""}) [${status}]`,
    );
    lines.push(`    Features: ${completedFeatures}/${features.length} completed`);
    lines.push(`    Goal: ${(sprint.goal as string | undefined) ?? "No goal defined"}`);
    lines.push("");
  }

  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Datetime helpers. Python uses naive local time throughout.

/** Format like Python's `datetime.now().strftime("%Y%m%d_%H%M%S")`. */
export function formatTimestamp(now: Date = new Date()): string {
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const h = String(now.getHours()).padStart(2, "0");
  const mi = String(now.getMinutes()).padStart(2, "0");
  const s = String(now.getSeconds()).padStart(2, "0");
  return `${y}${mo}${d}_${h}${mi}${s}`;
}

/** Format like Python's `datetime.now().strftime("%Y-%m-%d %H:%M:%S")`. */
export function formatArchiveDate(now: Date = new Date()): string {
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const h = String(now.getHours()).padStart(2, "0");
  const mi = String(now.getMinutes()).padStart(2, "0");
  const s = String(now.getSeconds()).padStart(2, "0");
  return `${y}-${mo}-${d} ${h}:${mi}:${s}`;
}

/** Format like Python's `datetime.now().strftime("%Y-%m-%d")`. */
export function formatLocalDate(now: Date = new Date()): string {
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${mo}-${d}`;
}

/**
 * Resolve the plugin root. Local copy kept self-contained (s1-feat-008 has no
 * dependency on s1-feat-006).
 */
function defaultPluginRoot(): string {
  return resolve(import.meta.dir, "..", "..", "..");
}

/**
 * Resolve a path the way Python's `pathlib.Path.resolve(strict=False)` does:
 * apply `realpathSync` to the longest existing prefix, then append the
 * remaining components verbatim. Necessary on macOS where `/tmp` is a
 * symlink to `/private/tmp`. See resolve-project-dir.ts for the same helper.
 */
function pyResolve(p: string): string {
  const absolute = resolve(p);
  let existing = absolute;
  while (existing !== parentOf(existing) && !existsSync(existing)) {
    existing = parentOf(existing);
  }
  if (!existsSync(existing)) {
    return absolute;
  }
  const real = realpathSync(existing);
  if (existing === absolute) {
    return real;
  }
  return real + absolute.slice(existing.length);
}

/** Parent directory of `dir`, or `dir` itself at the filesystem root. */
function parentOf(dir: string): string {
  const parent = resolve(dir, "..");
  return parent === dir ? dir : parent;
}
