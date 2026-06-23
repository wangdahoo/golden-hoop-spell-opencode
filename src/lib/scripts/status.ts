// Port of golden-hoop-spell/plugin/shared/scripts/status.py.
//
// Behavior source-of-truth:
//   golden-hoop-spell/plugin/shared/scripts/status.py
//
// Faithful port notes:
//   - The original script prints the formatted status to stdout. Here we
//     return the same text via `formatStatus()` so the tool layer can render
//     or post-process it. The text is byte-for-byte stable (verified by
//     walking through each `print()` call).
//   - The H2-section splitter mirrors Python's `re.split(r"^## ", content,
//     flags=re.MULTILINE)`: in JS we use `/^## /m` and keep only sections
//     whose first line contains a `\d{4}-\d{2}-\d{2}` date.

import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

type JsonObject = Record<string, unknown>;
type Feature = JsonObject;
type Sprint = JsonObject;
type FeaturesData = JsonObject;

/** Read and parse features.json. Returns `null` when the file does not exist. */
export async function readFeaturesJson(
  filepath: string,
): Promise<FeaturesData | null> {
  if (!existsSync(filepath)) {
    return null;
  }
  const text = await readFile(filepath, "utf8");
  return JSON.parse(text) as FeaturesData;
}

/** Read the last `lastN` sessions from progress.md. Returns `null` if the file is missing. */
export async function readProgressMd(
  filepath: string,
  lastN = 5,
): Promise<string[] | null> {
  if (!existsSync(filepath)) {
    return null;
  }
  const content = await readFile(filepath, "utf8");
  return extractSessions(content, lastN);
}

/**
 * Split content on `^## ` headings (multiline) and keep only sections whose
 * first line contains a `\d{4}-\d{2}-\d{2}` date.
 *
 * Mirrors Python:
 *   sections = re.split(r"^## ", content, flags=re.MULTILINE)
 *   sessions = [s for s in sections if re.search(r"\d{4}-\d{2}-\d{2}", s.split("\n", 1)[0])]
 *   return sessions[:last_n]
 */
export function extractSessions(content: string, lastN = 5): string[] {
  const sections = content.split(/^## /m);
  const sessions: string[] = [];
  for (const section of sections) {
    const firstLine = section.split("\n", 1)[0];
    if (/\d{4}-\d{2}-\d{2}/.test(firstLine)) {
      sessions.push(section);
    }
  }
  return sessions.slice(0, lastN);
}

/** Compute per-status feature counts. Mirrors Python `format_feature_status`. */
export function formatFeatureStatus(
  features: Feature[],
): Record<"pending" | "in_progress" | "completed" | "blocked", number> {
  const statusCounts = {
    pending: 0,
    in_progress: 0,
    completed: 0,
    blocked: 0,
  } as Record<"pending" | "in_progress" | "completed" | "blocked", number>;

  for (const feature of features) {
    const status = ((feature.status as string | undefined) ?? "pending") as
      | "pending"
      | "in_progress"
      | "completed"
      | "blocked";
    if (status in statusCounts) {
      statusCounts[status] += 1;
    } else {
      // Mirrors Python's `.get(status, 0) + 1` — we don't track unknown
      // statuses in the counts dict but we do keep the call side-effect-free.
      // Python silently drops unknown statuses; we mirror that.
    }
  }

  return statusCounts;
}

/** Options accepted by formatStatus / status. */
export interface StatusOptions {
  /** Project directory (the directory containing `.ghs/`). Defaults to cwd. */
  projectDir?: string;
}

/** Result returned by `status()`. */
export interface StatusResult {
  /** Byte-identical to what status.py would have printed to stdout. */
  text: string;
  /** 0 on success, 1 when features.json is missing (matches Python exit code). */
  exitCode: 0 | 1;
}

/**
 * Format the project status as a text block.
 *
 * The returned string is byte-for-byte stable, including the trailing blank
 * lines. Mirrors the early-return when features.json is missing (text =
 * `❌ features.json not found. Run init-project.py first.\n`).
 */
export async function formatStatus(options: StatusOptions = {}): Promise<string> {
  const projectDir = pyResolve(options.projectDir ?? process.cwd());
  const featuresPath = join(projectDir, ".ghs", "features.json");
  const progressPath = join(projectDir, ".ghs", "progress.md");

  const lines: string[] = [];

  if (!existsSync(featuresPath)) {
    lines.push("❌ features.json not found. Run init-project.py first.");
    return lines.join("\n") + "\n";
  }

  lines.push("=== Project Status ===");
  lines.push("");

  const featuresData = (await readFeaturesJson(featuresPath)) as FeaturesData | null;

  if (featuresData) {
    const project = (featuresData.project ?? {}) as JsonObject;
    lines.push(`📦 Project: ${(project.name as string | undefined) ?? "Unknown"}`);
    lines.push(
      `📝 Description: ${(project.description as string | undefined) ?? "No description"}`,
    );
    lines.push(`📅 Created: ${(project.created_at as string | undefined) ?? "Unknown"}`);
    lines.push("");

    const sprints = (featuresData.sprints ?? []) as Sprint[];

    if (sprints.length === 0) {
      lines.push("⚠️  No sprints defined yet. Run Sprint Agent to plan features.");
      // Python `return 0` here — no further output (no progress sessions).
      return lines.join("\n") + "\n";
    }

    for (const sprint of sprints) {
      const sprintId = (sprint.id as string | undefined) ?? "unknown";
      const sprintName = (sprint.name as string | undefined) ?? "Unnamed Sprint";
      const sprintStatus = (sprint.status as string | undefined) ?? "planning";
      const features = (sprint.features ?? []) as Feature[];

      const statusEmoji = sprintStatusEmoji(sprintStatus);
      lines.push(`${statusEmoji} Sprint: ${sprintName} (${sprintId})`);
      lines.push(`   Status: ${sprintStatus}`);
      lines.push(`   Goal: ${(sprint.goal as string | undefined) ?? "No goal defined"}`);
      lines.push("");

      const statusCounts = formatFeatureStatus(features);

      lines.push("   Features:");
      lines.push(`     ✅ Completed:    ${statusCounts.completed}`);
      lines.push(`     🚧 In Progress:  ${statusCounts.in_progress}`);
      lines.push(`     ⏳ Pending:      ${statusCounts.pending}`);
      lines.push(`     🚫 Blocked:      ${statusCounts.blocked}`);
      lines.push(`     ━━━━━━━━━━━━━━━━━━━━`);
      lines.push(`     📊 Total:        ${features.length}`);
      lines.push("");

      if (statusCounts.in_progress > 0) {
        const inProgress = features.filter((f) => f.status === "in_progress");
        for (const feat of inProgress) {
          lines.push(
            `   🔨 Working on: ${(feat.title as string | undefined) ?? "Unknown"} (${(feat.id as string | undefined) ?? ""})`,
          );
        }
      }

      if (statusCounts.pending > 0) {
        const pending = features.filter((f) => f.status === "pending");
        const completedIds = new Set(
          features.filter((f) => f.status === "completed").map((f) => f.id as string),
        );
        const ready = pending.filter((f) => {
          const deps = (f.dependencies ?? []) as string[];
          return deps.every((dep) => completedIds.has(dep));
        });
        if (ready.length > 0) {
          const nextFeature = ready[0];
          lines.push(
            `   ▶️  Next up: ${(nextFeature.title as string | undefined) ?? "Unknown"} (${(nextFeature.id as string | undefined) ?? ""})`,
          );
        } else {
          lines.push(
            "   ⏸️  No ready features — all pending features have unmet dependencies",
          );
        }
      }

      lines.push("");
    }
  }

  const sessions = await readProgressMd(progressPath);
  if (sessions && sessions.length > 0) {
    lines.push("📜 Recent Sessions:");
    for (const session of sessions.slice(0, 3)) {
      const sessionLines = session.trim().split("\n").slice(0, 3);
      for (const line of sessionLines) {
        if (line.trim()) {
          lines.push(`   ${line.trim()}`);
        }
      }
    }
    lines.push("");
  }

  return lines.join("\n") + "\n";
}

/**
 * Resolve the sprint status emoji. Mirrors Python's `status_emoji.get(..., "❓")`.
 */
function sprintStatusEmoji(status: string): string {
  switch (status) {
    case "planning":
      return "📋";
    case "in_progress":
      return "🚀";
    case "completed":
      return "✅";
    case "on_hold":
      return "⏸️";
    default:
      return "❓";
  }
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

/**
 * Compute the project status and return `{ text, exitCode }`.
 *
 * `exitCode` mirrors Python's `main()` return value: 0 on success, 1 when
 * features.json is missing. The tool layer decides whether to surface the
 * non-zero code as a tool error.
 */
export async function status(options: StatusOptions = {}): Promise<StatusResult> {
  const projectDir = pyResolve(options.projectDir ?? process.cwd());
  const featuresPath = join(projectDir, ".ghs", "features.json");

  if (!existsSync(featuresPath)) {
    return {
      text: "❌ features.json not found. Run init-project.py first.\n",
      exitCode: 1,
    };
  }

  const text = await formatStatus(options);
  return { text, exitCode: 0 };
}
