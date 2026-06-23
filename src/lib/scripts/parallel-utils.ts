// Port of golden-hoop-spell/plugin/shared/scripts/parallel_utils.py.
//
// Behavior source-of-truth:
//   golden-hoop-spell/plugin/shared/scripts/parallel_utils.py
//
// Faithful port notes (plan §3.4 D4 — line-by-line port):
//   - The Python source is both a library (`detect_cycles` /
//     `get_ready_features` / `build_parallel_batches`) and a CLI wrapper
//     (`main()` reads features.json via argparse and prints JSON). We port the
//     *library* core verbatim-by-behavior; the CLI layer (argparse / stdout /
//     `json.dump` / `sys.exit`) is intentionally omitted because the OpenCode
//     plugin consumes this as an in-process TS module — the tool layer
//     (`ghs-code`) calls `getReadyFeatures()` / `buildBatches()` directly and
//     renders the result itself.
//   - The three library functions are pure: no FS, no subprocess, no global
//     mutation. They take already-parsed `features.json` objects. File reading
//     is left to the caller (mirrors how the other ports in this directory
//     split: `readFeaturesJson` lives next to each consumer rather than here,
//     and `status.ts` already exposes one).
//   - Iteration-order hazard (called out in the feature's technical_notes):
//       Python dict preserves insertion order and so does JS object iteration,
//       so the `feature_index` / `completed_ids` lookups behave the same.
//       The one place ordering is *observable* is `build_parallel_batches`'s
//       output: we sort by `files_affected.length` descending (Python
//       `sorted(..., key=lambda f: len(f.get('files_affected', [])),
//       reverse=True)`). JS `Array.prototype.sort` is stable as of ES2019, so
//       ties keep their original relative order — same as Python's stable
//       Timsort. No extra tiebreaker is needed for parity.
//   - Cycle detection is the iterative-but-recursive DFS with white/gray/black
//     coloring from the Python source. We keep it recursive in JS too (the
//     feature graphs in practice are tiny — tens of features per sprint — so
//     stack depth is a non-issue).
//   - Style follows s1-feat-008: no `process.exit`, no `console.log`, all
//     exported functions are pure.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Loose structural types mirroring the shape of `features.json`. We keep these
 * deliberately permissive (`Record<string, unknown>`) rather than redefining a
 * strict Zod schema here — the file is already validated upstream by
 * `validate-structure.ts` (s1-feat-012) before any tool invokes this module,
 * and the Python original also operated on untyped `Dict`s. Field access uses
 * the same `.get(...)` / `?? []` defensive pattern as the source.
 */
type JsonObject = Record<string, unknown>;
export type Feature = JsonObject;
export type Sprint = JsonObject;
export type FeaturesData = JsonObject;

/** Color used by the DFS cycle finder. Mirrors Python WHITE/GRAY/BLACK. */
const WHITE = 0;
const GRAY = 1;
const BLACK = 2;

export interface ReadyFeaturesResult {
  /** Features whose status is `pending`, deps all completed, not in a cycle. */
  ready: Feature[];
  /** Everything else: wrong status, unmet deps, or cycle-participating. */
  skipped: Feature[];
  /** Detected cycles; each is a list of feature IDs forming the loop. */
  cycles: string[][];
  /** IDs of any feature that participates in at least one cycle. */
  cycle_feature_ids: string[];
}

// ---------------------------------------------------------------------------
// detect_cycles — 1:1 port of the Python DFS coloring algorithm.
// ---------------------------------------------------------------------------

/**
 * Detect circular dependencies in the feature dependency graph.
 *
 * Uses recursive DFS with white/gray/black coloring to find every cycle.
 * Returns a list of cycles, where each cycle is a list of feature IDs forming
 * the loop. A dependency that is not in `feature_index` is skipped (mirrors
 * Python `if dep not in feature_index: continue`).
 *
 * Port of `detect_cycles(features, feature_index)`.
 */
export function detectCycles(
  features: Feature[],
  featureIndex: Record<string, Feature>,
): string[][] {
  const color = new Map<string, number>();
  const cycles: string[][] = [];
  const path: string[] = [];
  const pathSet = new Set<string>();

  const dfs = (node: string): void => {
    color.set(node, GRAY);
    path.push(node);
    pathSet.add(node);

    const feat = featureIndex[node] ?? {};
    const deps = (feat["dependencies"] as string[] | undefined) ?? [];
    for (const dep of deps) {
      if (!(dep in featureIndex)) {
        continue;
      }
      if (color.get(dep) === GRAY) {
        // Found a cycle — extract it from the current DFS path.
        const cycleStart = path.indexOf(dep);
        cycles.push(path.slice(cycleStart));
      } else if ((color.get(dep) ?? WHITE) === WHITE) {
        dfs(dep);
      }
    }

    path.pop();
    pathSet.delete(node);
    color.set(node, BLACK);
  };

  for (const feat of features) {
    const fid = (feat["id"] as string | undefined) ?? "";
    if ((color.get(fid) ?? WHITE) === WHITE) {
      dfs(fid);
    }
  }

  return cycles;
}

// ---------------------------------------------------------------------------
// get_ready_features — 1:1 port of get_ready_features.
// ---------------------------------------------------------------------------

/**
 * Identify features whose dependencies are all completed.
 *
 * Selection of the sprint to analyze mirrors Python exactly:
 *   - If `sprintId` is given, the first sprint with that `id` is used.
 *   - Otherwise the first sprint with `status === "in_progress"` is used; if
 *     none, the first sprint in the array.
 *   - If no sprint matches (empty list, missing id), all four result fields
 *     are empty arrays.
 *
 * A feature is `ready` iff:
 *   1. `status === "pending"`,
 *   2. it is not part of any detected dependency cycle, AND
 *   3. every entry in its `dependencies` is in the completed set.
 *
 * Port of `get_ready_features(features_data, sprint_id=None)`.
 */
export function getReadyFeatures(
  featuresData: FeaturesData,
  sprintId?: string | null,
): ReadyFeaturesResult {
  const empty: ReadyFeaturesResult = {
    ready: [],
    skipped: [],
    cycles: [],
    cycle_feature_ids: [],
  };

  const sprints = (featuresData["sprints"] as Sprint[] | undefined) ?? [];

  let sprint: Sprint | null = null;
  if (sprintId) {
    for (const s of sprints) {
      if (s["id"] === sprintId) {
        sprint = s;
        break;
      }
    }
  } else {
    // Use the first in_progress sprint, or fall back to the first sprint.
    for (const s of sprints) {
      if (s["status"] === "in_progress") {
        sprint = s;
        break;
      }
    }
    if (sprint === null && sprints.length > 0) {
      sprint = sprints[0];
    }
  }

  if (sprint === null) {
    return empty;
  }

  const features = (sprint["features"] as Feature[] | undefined) ?? [];

  // Build index keyed by id, and the completed-id set.
  const featureIndex: Record<string, Feature> = {};
  for (const f of features) {
    const fid = (f["id"] as string | undefined) ?? "";
    if (fid) {
      featureIndex[fid] = f;
    }
  }
  const completedIds = new Set<string>();
  for (const f of features) {
    if (f["status"] === "completed") {
      const fid = (f["id"] as string | undefined) ?? "";
      if (fid) {
        completedIds.add(fid);
      }
    }
  }

  // Detect cycles and union the participating ids.
  const cycles = detectCycles(features, featureIndex);
  const cycleFeatureIdSet = new Set<string>();
  for (const cycle of cycles) {
    for (const id of cycle) {
      cycleFeatureIdSet.add(id);
    }
  }

  const ready: Feature[] = [];
  const skipped: Feature[] = [];

  for (const feat of features) {
    const fid = (feat["id"] as string | undefined) ?? "";
    const status = (feat["status"] as string | undefined) ?? "";

    // Only pending features can be ready.
    if (status !== "pending") {
      skipped.push(feat);
      continue;
    }

    // Skip features involved in dependency cycles.
    if (cycleFeatureIdSet.has(fid)) {
      skipped.push(feat);
      continue;
    }

    // Check all dependencies are completed.
    //
    // Faithful port of the Python conditional — the second disjunct is
    // logically redundant (`dep_id in completed_ids` already covers it) but we
    // keep it verbatim for byte-for-byte behavioral parity:
    //   dep_id in completed_ids or
    //   (dep_id not in feature_index and dep_id in completed_ids)
    const deps = (feat["dependencies"] as string[] | undefined) ?? [];
    const depsMet = deps.every(
      (depId) =>
        completedIds.has(depId) ||
        (!(depId in featureIndex) && completedIds.has(depId)),
    );

    if (depsMet) {
      ready.push(feat);
    } else {
      skipped.push(feat);
    }
  }

  return {
    ready,
    skipped,
    cycles,
    cycle_feature_ids: Array.from(cycleFeatureIdSet),
  };
}

// ---------------------------------------------------------------------------
// build_parallel_batches — 1:1 port of build_parallel_batches.
// ---------------------------------------------------------------------------

/**
 * Group non-conflicting ready features into parallel batches.
 *
 * Heuristic (verbatim from Python): sort by `files_affected` length descending,
 * then greedily place each feature into the first existing batch that (a) is
 * under `maxParallel` and (b) has no `files_affected` overlap. If none fits,
 * start a new batch.
 *
 * The descending-file-count sort tends to spread high-overlap features across
 * different batches first. Features with overlapping `files_affected` are never
 * placed in the same batch to avoid merge conflicts during parallel execution.
 *
 * Port of `build_parallel_batches(ready_features, max_parallel=5)`.
 */
export function buildBatches(
  readyFeatures: Feature[],
  maxParallel = 5,
): Feature[][] {
  if (readyFeatures.length === 0) {
    return [];
  }

  // Sort by number of files_affected descending. JS Array.sort is stable
  // (ES2019+), so ties preserve input order — matching Python's Timsort.
  const sortedFeatures = [...readyFeatures].sort(
    (a, b) =>
      (((b["files_affected"] as unknown[] | undefined) ?? []).length) -
      (((a["files_affected"] as unknown[] | undefined) ?? []).length),
  );

  const batches: Feature[][] = [];
  const assigned = new Set<string>();

  for (const feat of sortedFeatures) {
    const fid = (feat["id"] as string | undefined) ?? "";
    if (assigned.has(fid)) {
      continue;
    }

    const featFiles = new Set<string>(
      ((feat["files_affected"] as string[] | undefined) ?? []),
    );

    // Try to place in an existing batch.
    let placed = false;
    for (const batch of batches) {
      if (batch.length >= maxParallel) {
        continue;
      }

      // Check for file conflicts with features already in the batch.
      let hasConflict = false;
      for (const existing of batch) {
        const existingFiles = new Set<string>(
          ((existing["files_affected"] as string[] | undefined) ?? []),
        );
        // Set intersection: if any element of featFiles is in existingFiles.
        for (const f of featFiles) {
          if (existingFiles.has(f)) {
            hasConflict = true;
            break;
          }
        }
        if (hasConflict) {
          break;
        }
      }

      if (!hasConflict) {
        batch.push(feat);
        assigned.add(fid);
        placed = true;
        break;
      }
    }

    // If no existing batch fits, start a new one.
    if (!placed) {
      batches.push([feat]);
      assigned.add(fid);
    }
  }

  return batches;
}

// ---------------------------------------------------------------------------
// summarizeFeature — port of the inline `summarize_feature` used by main().
//   Kept here (not in the CLI) because the ghs-code tool wants the same
//   trimmed projection of a feature for its dispatch-plan output.
// ---------------------------------------------------------------------------

export interface FeatureSummary {
  id: string;
  title: string;
  status: string;
  files_affected: string[];
  dependencies: string[];
}

/**
 * Project a feature dict onto the small summary shape the Python CLI emitted
 * in its JSON output (`id`, `title`, `status`, `files_affected`,
 * `dependencies`). Port of `summarize_feature` inside `main()`.
 */
export function summarizeFeature(feat: Feature): FeatureSummary {
  return {
    id: (feat["id"] as string | undefined) ?? "",
    title: (feat["title"] as string | undefined) ?? "",
    status: (feat["status"] as string | undefined) ?? "",
    files_affected: (feat["files_affected"] as string[] | undefined) ?? [],
    dependencies: (feat["dependencies"] as string[] | undefined) ?? [],
  };
}
