// Port of golden-hoop-spell/plugin/shared/scripts/resolve_project_dir.py.
//
// Behavior source-of-truth:
//   /Users/tom/github/golden-hoop-spell/plugin/shared/scripts/resolve_project_dir.py
//
// Faithful port notes:
//   - Walks up from the start directory looking for a `.ghs/` directory that
//     contains at least one marker file (`features.json` or `progress.md`).
//   - Mirrors Python's loop-termination: the loop `while current != current.parent`
//     stops one level before the filesystem root, then the root is checked
//     separately. We do the same with `current === current.parent` as the
//     termination sentinel.

import { existsSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

const GHS_DIR = ".ghs";
const MARKER_FILES = ["features.json", "progress.md"];

/**
 * Resolve a path the way Python's `pathlib.Path.resolve(strict=False)` does:
 * apply `realpathSync` to the longest existing prefix, then append the
 * remaining components verbatim. This matters on macOS where `/tmp` is a
 * symlink to `/private/tmp` — Node's `path.resolve()` does NOT follow
 * symlinks, but Python's `Path.resolve()` does. To stay byte-faithful with
 * the source script we mirror the Python behaviour.
 *
 * Falls back to `path.resolve(...)` when no prefix of the path exists.
 */
function pyResolve(p: string): string {
  const absolute = resolve(p);
  // Walk from the full path upward, find the longest existing prefix.
  let existing = absolute;
  while (existing !== parentOf(existing) && !existsSync(existing)) {
    existing = parentOf(existing);
  }
  if (!existsSync(existing)) {
    // Nothing on disk matches — fall back to lexical resolution.
    return absolute;
  }
  const real = realpathSync(existing);
  if (existing === absolute) {
    return real;
  }
  const tail = absolute.slice(existing.length);
  return real + tail;
}

/**
 * Walk up from `startDir` to find the directory whose `.ghs/` subdirectory
 * contains at least one marker file.
 *
 * Returns `null` if no marker files are found in any ancestor — mirrors
 * Python's `find_project_dir`.
 */
export function findProjectDir(startDir: string): string | null {
  let current = pyResolve(startDir);

  while (current !== parentOf(current)) {
    if (hasMarkerFiles(current)) {
      return current;
    }
    current = parentOf(current);
  }

  // Check the root directory too (mirrors Python's post-loop check).
  if (hasMarkerFiles(current)) {
    return current;
  }

  return null;
}

/**
 * Resolve the ghs project directory or throw a descriptive error.
 *
 * Mirrors Python's `main()` minus the stderr print: instead of printing +
 * exit(1), we throw `ProjectDirNotFoundError` so the tool layer can format
 * the user-facing message.
 */
export function resolveProjectDir(startDir?: string): string {
  const start = startDir ? pyResolve(startDir) : pyResolve(process.cwd());
  const projectDir = findProjectDir(start);

  if (projectDir === null) {
    throw new ProjectDirNotFoundError(start);
  }

  return projectDir;
}

/** Return the parent directory of `dir`, or `dir` itself when already at root. */
function parentOf(dir: string): string {
  const parent = resolve(dir, "..");
  // On the filesystem root, resolve(dir, "..") === dir.
  return parent === dir ? dir : parent;
}

/** True iff `<dir>/.ghs/` is a directory that contains a marker file. */
function hasMarkerFiles(dir: string): boolean {
  const ghs = join(dir, GHS_DIR);
  if (!existsSync(ghs) || !statSync(ghs).isDirectory()) {
    return false;
  }
  for (const marker of MARKER_FILES) {
    if (existsSync(join(ghs, marker))) {
      return true;
    }
  }
  return false;
}

/** Error thrown when no `.ghs/` directory is found in any ancestor. */
export class ProjectDirNotFoundError extends Error {
  readonly startDir: string;

  constructor(startDir: string) {
    super(
      "Error: No project directory found. No .ghs/features.json or .ghs/progress.md in any parent directory. " +
        "Run /ghs:init to create a new project.",
    );
    this.name = "ProjectDirNotFoundError";
    this.startDir = startDir;
  }
}

// Re-exported to keep the `sep` import meaningful for downstream tooling
// that may want to know the platform separator (currently unused at runtime
// but referenced by tests).
export const pathSeparator: typeof sep = sep;
