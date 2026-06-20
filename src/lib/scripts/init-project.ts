// Port of golden-hoop-spell/plugin/shared/scripts/init_project.py.
//
// Behavior source-of-truth:
//   /Users/tom/github/golden-hoop-spell/plugin/shared/scripts/init_project.py
//
// Faithful port notes:
//   - JSON output uses `JSON.stringify(obj, null, 2)` which matches Python's
//     `json.dump(obj, f, indent=2)` (both use 2-space indent, comma-newline,
//     colon-space). Python's `ensure_ascii=True` default would escape non-ASCII
//     as \uXXXX — but the source features.json template is pure ASCII, so the
//     byte-for-byte equivalence holds for the generated files in practice.
//   - Date format: Python uses `datetime.now().strftime("%Y-%m-%d")` which is
//     a naive local date. We mirror this via `formatLocalDate()`.
//   - This module exports functions — NO console.log to stdout, NO process.exit.
//     The CLI wrapper (s1-feat-009) is responsible for printing the human-facing
//     status lines. Here we return a structured result.

import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/**
 * Resolve the plugin root (the directory that contains `src/` and `shared/`).
 *
 * Note: This mirrors the behaviour that will be exported from
 * `src/lib/paths.ts` (s1-feat-006). The local copy keeps this module
 * self-contained — s1-feat-008 has no dependency on s1-feat-006, so we
 * duplicate the one-line primitive rather than importing across the
 * not-yet-implemented module boundary. When s1-feat-006 lands and exports
 * `pluginRoot`, callers may pass `pluginRootPath` explicitly to override.
 */
function defaultPluginRoot(): string {
  // import.meta.dir is the directory of this source file
  // (src/lib/scripts/), so the plugin root is three levels up.
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

/** Options accepted by initProject. */
export interface InitProjectOptions {
  /** Project name (required). */
  projectName: string;
  /** Optional project description; defaults to `<projectName> project`. */
  description?: string;
  /**
   * Output directory (the project root where `.ghs/` will be created).
   * Defaults to the current working directory.
   */
  projectDir?: string;
  /** When true, overwrite existing `.ghs/features.json` or `.ghs/progress.md`. */
  force?: boolean;
  /**
   * Override the plugin root (used to locate `shared/assets/` templates).
   * Defaults to the plugin root resolved from `import.meta.dir`.
   */
  pluginRootPath?: string;
}

/** Result returned by initProject. */
export interface InitProjectResult {
  /** Absolute path to the project directory the files were written into. */
  outputDir: string;
  /** Absolute path of the created features.json. */
  featuresFile: string;
  /** Absolute path of the created progress.md. */
  progressFile: string;
  /** Absolute path of the touched .gitignore. */
  gitignoreFile: string;
  /** Whether .gitignore was modified (true) or already contained `.ghs` (false). */
  gitignoreUpdated: boolean;
  /** The project name written into features.json. */
  projectName: string;
  /** The project description written into features.json. */
  projectDescription: string;
}

/** Format a Date the way Python's `datetime.now().strftime("%Y-%m-%d")` does. */
export function formatLocalDate(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Create `.ghs/features.json` from the shared template, substituting
 * `project.name`, `project.description`, `project.created_at`, and
 * `metadata.last_updated`.
 *
 * Mirrors Python `create_features_json`.
 */
export async function createFeaturesJson(
  projectName: string,
  projectDescription: string,
  outputDir: string,
  pluginRootPath: string = defaultPluginRoot(),
): Promise<string> {
  const templatePath = join(pluginRootPath, "shared", "assets", "features.json");

  if (!existsSync(templatePath)) {
    throw new Error(`Template not found: ${templatePath}`);
  }

  const templateText = await readFile(templatePath, "utf8");
  const featuresData = JSON.parse(templateText) as Record<string, unknown>;

  const project = (featuresData.project ?? {}) as Record<string, unknown>;
  project.name = projectName;
  project.description = projectDescription;
  project.created_at = formatLocalDate();
  featuresData.project = project;

  const metadata = (featuresData.metadata ?? {}) as Record<string, unknown>;
  metadata.last_updated = formatLocalDate();
  featuresData.metadata = metadata;

  const outputFile = join(outputDir, ".ghs", "features.json");
  await mkdir(dirname(outputFile), { recursive: true });
  await writeFile(outputFile, JSON.stringify(featuresData, null, 2), "utf8");

  return outputFile;
}

/**
 * Append `.ghs` to `.gitignore` if not already present; create the file if
 * missing. Mirrors Python `ensure_gitignore`.
 *
 * @returns `[absolutePath, updated]` — `updated` is true when the file was
 *   created or modified, false when `.ghs` was already present.
 */
export async function ensureGitignore(
  outputDir: string,
): Promise<[string, boolean]> {
  const gitignorePath = join(outputDir, ".gitignore");
  const entry = ".ghs";

  if (existsSync(gitignorePath)) {
    const content = await readFile(gitignorePath, "utf8");
    const lines = content.split(/\r?\n/).map((l) => l.trim());
    if (lines.includes(entry)) {
      return [gitignorePath, false];
    }
    let next = content;
    if (content.length > 0 && !content.endsWith("\n")) {
      next += "\n";
    }
    next += `${entry}\n`;
    await writeFile(gitignorePath, next, "utf8");
    return [gitignorePath, true];
  }

  await writeFile(gitignorePath, `${entry}\n`, "utf8");
  return [gitignorePath, true];
}

/**
 * Copy the shared `assets/progress.md` template to `<outputDir>/.ghs/progress.md`.
 * Mirrors Python `create_progress_md`.
 */
export async function createProgressMd(
  outputDir: string,
  pluginRootPath: string = defaultPluginRoot(),
): Promise<string> {
  const templatePath = join(pluginRootPath, "shared", "assets", "progress.md");

  if (!existsSync(templatePath)) {
    throw new Error(`Template not found: ${templatePath}`);
  }

  const ghsDir = join(outputDir, ".ghs");
  await mkdir(ghsDir, { recursive: true });
  const outputFile = join(ghsDir, "progress.md");
  await copyFile(templatePath, outputFile);

  return outputFile;
}

/**
 * Initialize the `.ghs/` tracking files for a project.
 *
 * Mirrors the body of Python `main()` minus the stdout prints: it validates
 * preconditions (existing files vs `force`), creates features.json +
 * progress.md, and updates .gitignore.
 *
 * @throws when the templates cannot be found, or when files already exist and
 *   `force` is not set.
 */
export async function initProject(
  options: InitProjectOptions,
): Promise<InitProjectResult> {
  const outputDir = pyResolve(options.projectDir ?? process.cwd());
  await mkdir(outputDir, { recursive: true });

  const projectName = options.projectName;
  const projectDescription = options.description?.length
    ? options.description
    : `${projectName} project`;

  // Check for existing .ghs files unless --force is passed.
  if (!options.force) {
    const existingFiles: string[] = [];
    const featuresPath = join(outputDir, ".ghs", "features.json");
    const progressPath = join(outputDir, ".ghs", "progress.md");
    if (existsSync(featuresPath)) {
      existingFiles.push(relativeOrSame(featuresPath, outputDir));
    }
    if (existsSync(progressPath)) {
      existingFiles.push(relativeOrSame(progressPath, outputDir));
    }
    if (existingFiles.length > 0) {
      throw new InitFilesExistError(existingFiles, outputDir);
    }
  }

  const pluginRootPath = options.pluginRootPath ?? defaultPluginRoot();
  const featuresFile = await createFeaturesJson(
    projectName,
    projectDescription,
    outputDir,
    pluginRootPath,
  );
  const progressFile = await createProgressMd(outputDir, pluginRootPath);
  const [gitignoreFile, gitignoreUpdated] = await ensureGitignore(outputDir);

  return {
    outputDir,
    featuresFile,
    progressFile,
    gitignoreFile,
    gitignoreUpdated,
    projectName,
    projectDescription,
  };
}

/** Compute path relative to `outputDir`, falling back to the absolute path. */
function relativeOrSame(target: string, base: string): string {
  const rel = target.startsWith(base + "/") || target.startsWith(base)
    ? target.slice(base.length).replace(/^\/+/, "")
    : target;
  return rel;
}

/**
 * Error thrown when `.ghs/features.json` or `.ghs/progress.md` already exist
 * and the caller did not pass `force: true`. Mirrors Python's diagnostic
 * output: the file list + the `Use --force to overwrite existing files` hint.
 */
export class InitFilesExistError extends Error {
  readonly existingFiles: string[];
  readonly outputDir: string;

  constructor(existingFiles: string[], outputDir: string) {
    const lines = [
      "Error: The following .ghs files already exist:",
      ...existingFiles.map((f) => `  - ${f}`),
      "Use --force to overwrite existing files.",
    ].join("\n");
    super(lines);
    this.name = "InitFilesExistError";
    this.existingFiles = existingFiles;
    this.outputDir = outputDir;
  }
}
