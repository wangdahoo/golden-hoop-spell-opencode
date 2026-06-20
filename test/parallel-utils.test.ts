// Unit tests for src/lib/scripts/parallel-utils.ts (Feature s4-feat-002).
//
// There is no Python source test file (`test_parallel_utils.py` does not
// exist), so these are pure behavioural tests validating the TS port itself.
//
// Style follows test/writer.test.ts (s2-feat-004): bun:test, describe/test
// blocks, hand-built temp feature objects, and JSON.parse(JSON.stringify(...))
// deep-cloning so every test starts from a pristine fixture and mutations in
// one suite never leak into another. Nothing here touches the real project
// `.ghs/` directory.
//
// Coverage map (acceptance_criteria):
//   - ready-feature judgment ................. describe("getReadyFeatures - ready")
//   - batch grouping ......................... describe("buildBatches - grouping")
//   - file-conflict isolation ................ describe("buildBatches - file conflicts")
//   - cycle detection ........................ describe("detectCycles" + "getReadyFeatures - cycles")
//   - max-parallel truncation ................ describe("buildBatches - max-parallel")

import { expect, test, describe } from "bun:test";

import {
  detectCycles,
  getReadyFeatures,
  buildBatches,
  summarizeFeature,
  type Feature,
  type FeaturesData,
} from "../src/lib/scripts/parallel-utils";

// -----------------------------------------------------------------------------
// Fixture helpers
// -----------------------------------------------------------------------------

/** Deep-clone helper — keeps each test's mutations isolated. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Minimal feature factory; only the fields the parallel-utils code reads. */
function feat(
  id: string,
  opts: {
    status?: string;
    dependencies?: string[];
    files_affected?: string[];
    title?: string;
  } = {},
): Feature {
  return {
    id,
    title: opts.title ?? id,
    status: opts.status ?? "pending",
    dependencies: opts.dependencies ?? [],
    files_affected: opts.files_affected ?? [],
  };
}

/** Wrap a features array into a single-sprint FeaturesData shape. */
function sprintData(
  features: Feature[],
  sprintId = "s1",
  sprintStatus = "in_progress",
): FeaturesData {
  return {
    project: { name: "test" },
    sprints: [{ id: sprintId, name: "Test", status: sprintStatus, features }],
  };
}

// =============================================================================
// getReadyFeatures — ready-feature judgment
// =============================================================================

describe("getReadyFeatures - ready judgment (s4-feat-002)", () => {
  test("(a) a pending feature with no deps is ready", () => {
    const data = sprintData([feat("f1"), feat("f2")]);
    const result = getReadyFeatures(clone(data));
    expect(result.ready.map((f) => f["id"]).sort()).toEqual(["f1", "f2"]);
    expect(result.skipped).toEqual([]);
    expect(result.cycles).toEqual([]);
    expect(result.cycle_feature_ids).toEqual([]);
  });

  test("(b) a pending feature whose dep is completed is ready", () => {
    const data = sprintData([
      feat("f1", { status: "completed" }),
      feat("f2", { status: "pending", dependencies: ["f1"] }),
    ]);
    const result = getReadyFeatures(clone(data));
    expect(result.ready.map((f) => f["id"])).toEqual(["f2"]);
    expect(result.skipped.map((f) => f["id"])).toEqual(["f1"]);
  });

  test("(c) a pending feature whose dep is still pending is skipped", () => {
    const data = sprintData([
      feat("f1", { status: "pending" }),
      feat("f2", { status: "pending", dependencies: ["f1"] }),
    ]);
    const result = getReadyFeatures(clone(data));
    expect(result.ready.map((f) => f["id"])).toEqual(["f1"]);
    expect(result.skipped.map((f) => f["id"])).toEqual(["f2"]);
  });

  test("(d) a dependency id that is unknown to the sprint cannot be completed", () => {
    // f1 depends on an external id that is not in the sprint index and has no
    // completed marker -> deps not met -> skipped.
    const data = sprintData([
      feat("f1", { status: "pending", dependencies: ["external-id"] }),
    ]);
    const result = getReadyFeatures(clone(data));
    expect(result.ready).toEqual([]);
    expect(result.skipped.map((f) => f["id"])).toEqual(["f1"]);
  });

  test("(e) in_progress / completed / blocked features are never ready", () => {
    const data = sprintData([
      feat("f1", { status: "in_progress" }),
      feat("f2", { status: "completed" }),
      feat("f3", { status: "blocked" }),
      feat("f4", { status: "pending" }),
    ]);
    const result = getReadyFeatures(clone(data));
    expect(result.ready.map((f) => f["id"])).toEqual(["f4"]);
    expect(result.skipped.map((f) => f["id"]).sort()).toEqual([
      "f1",
      "f2",
      "f3",
    ]);
  });

  test("(f) features with multiple deps need ALL of them completed", () => {
    const data = sprintData([
      feat("a", { status: "completed" }),
      feat("b", { status: "pending" }),
      feat("c", { status: "completed" }),
      feat("d", { status: "pending", dependencies: ["a", "b", "c"] }),
    ]);
    const result = getReadyFeatures(clone(data));
    // d is not ready because b is still pending.
    expect(result.ready.map((f) => f["id"]).sort()).toEqual(["b"]);
    expect(result.skipped.map((f) => f["id"]).sort()).toEqual([
      "a",
      "c",
      "d",
    ]);
  });
});

// =============================================================================
// getReadyFeatures — sprint selection
// =============================================================================

describe("getReadyFeatures - sprint selection (s4-feat-002)", () => {
  test("(g) explicit sprintId selects that sprint even if not in_progress", () => {
    const data: FeaturesData = {
      project: { name: "x" },
      sprints: [
        { id: "sA", name: "A", status: "completed", features: [feat("a1")] },
        { id: "sB", name: "B", status: "planning", features: [feat("b1")] },
      ],
    };
    const result = getReadyFeatures(clone(data), "sB");
    expect(result.ready.map((f) => f["id"])).toEqual(["b1"]);
  });

  test("(h) no sprintId -> uses first in_progress sprint", () => {
    const data: FeaturesData = {
      project: { name: "x" },
      sprints: [
        { id: "sA", name: "A", status: "completed", features: [feat("a1")] },
        { id: "sB", name: "B", status: "in_progress", features: [feat("b1")] },
      ],
    };
    const result = getReadyFeatures(clone(data));
    expect(result.ready.map((f) => f["id"])).toEqual(["b1"]);
  });

  test("(i) no in_progress sprint -> falls back to first sprint", () => {
    const data: FeaturesData = {
      project: { name: "x" },
      sprints: [
        { id: "sA", name: "A", status: "planning", features: [feat("a1")] },
        { id: "sB", name: "B", status: "completed", features: [feat("b1")] },
      ],
    };
    const result = getReadyFeatures(clone(data));
    expect(result.ready.map((f) => f["id"])).toEqual(["a1"]);
  });

  test("(j) no sprints at all -> empty result", () => {
    const data: FeaturesData = { project: { name: "x" }, sprints: [] };
    const result = getReadyFeatures(clone(data));
    expect(result).toEqual({
      ready: [],
      skipped: [],
      cycles: [],
      cycle_feature_ids: [],
    });
  });

  test("(k) unknown sprintId -> empty result", () => {
    const data: FeaturesData = {
      project: { name: "x" },
      sprints: [
        { id: "sA", name: "A", status: "in_progress", features: [feat("a1")] },
      ],
    };
    const result = getReadyFeatures(clone(data), "nonexistent");
    expect(result.ready).toEqual([]);
    expect(result.skipped).toEqual([]);
  });
});

// =============================================================================
// buildBatches — basic grouping
// =============================================================================

describe("buildBatches - grouping (s4-feat-002)", () => {
  test("(a) empty input -> empty batches", () => {
    expect(buildBatches([])).toEqual([]);
  });

  test("(b) single feature -> single batch of one", () => {
    const result = buildBatches([feat("f1")]);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(1);
    expect(result[0][0]["id"]).toBe("f1");
  });

  test("(c) two non-conflicting features -> one batch of two (default max-parallel=5)", () => {
    const result = buildBatches([
      feat("f1", { files_affected: ["a.ts"] }),
      feat("f2", { files_affected: ["b.ts"] }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(2);
    // Sort assertion — placement order within a batch depends on the
    // descending-file-count sort; with equal file counts the stable sort
    // preserves input order.
    expect(result[0].map((f) => f["id"])).toEqual(["f1", "f2"]);
  });

  test("(d) many non-conflicting features collapse into a single batch up to max-parallel", () => {
    const features = Array.from({ length: 5 }, (_, i) =>
      feat(`f${i}`, { files_affected: [`file${i}.ts`] }),
    );
    const result = buildBatches(features);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(5);
  });
});

// =============================================================================
// buildBatches — file-conflict isolation
// =============================================================================

describe("buildBatches - file conflicts (s4-feat-002)", () => {
  test("(a) two features sharing a file go to different batches", () => {
    const result = buildBatches([
      feat("f1", { files_affected: ["shared.ts", "x.ts"] }),
      feat("f2", { files_affected: ["shared.ts", "y.ts"] }),
    ]);
    // f1 and f2 both touch shared.ts -> cannot share a batch.
    expect(result).toHaveLength(2);
    expect(result[0][0]["id"]).toBe("f1");
    expect(result[1][0]["id"]).toBe("f2");
  });

  test("(b) descending-file-count sort places high-overlap features first", () => {
    // f3 has 3 files, f1/f2 have 1 each. Sorted desc, f3 is processed first.
    // f1 shares a file with f3; f2 does not.
    const result = buildBatches([
      feat("f1", { files_affected: ["a.ts"] }),
      feat("f2", { files_affected: ["b.ts"] }),
      feat("f3", { files_affected: ["a.ts", "b.ts", "c.ts"] }),
    ]);
    // First batch starts with f3 (most files). f1 conflicts with f3 (a.ts).
    // f2 conflicts with f3 (b.ts). So f3 alone in batch 0; f1 and f2 (no
    // overlap with each other) share batch 1.
    expect(result[0].map((f) => f["id"])).toEqual(["f3"]);
    expect(result[1].map((f) => f["id"]).sort()).toEqual(["f1", "f2"]);
  });

  test("(c) partial overlap: feature can join a batch that has free capacity and no overlap", () => {
    // f1: {a}, f2: {b}, f3: {c} -> all disjoint, all join batch 0.
    // f4: {a} -> conflicts with f1; must start batch 1.
    const result = buildBatches([
      feat("f1", { files_affected: ["a.ts"] }),
      feat("f2", { files_affected: ["b.ts"] }),
      feat("f3", { files_affected: ["c.ts"] }),
      feat("f4", { files_affected: ["a.ts"] }),
    ]);
    expect(result).toHaveLength(2);
    expect(result[0].map((f) => f["id"]).sort()).toEqual(["f1", "f2", "f3"]);
    expect(result[1].map((f) => f["id"])).toEqual(["f4"]);
  });

  test("(d) features with no files_affected never conflict", () => {
    // Three features with no files_affected — all mutually disjoint (empty
    // intersection), so all land in one batch.
    const result = buildBatches([feat("f1"), feat("f2"), feat("f3")]);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(3);
  });
});

// =============================================================================
// buildBatches — max-parallel truncation
// =============================================================================

describe("buildBatches - max-parallel truncation (s4-feat-002)", () => {
  test("(a) max-parallel=2 splits 3 disjoint features across 2 batches", () => {
    const features = [
      feat("f1", { files_affected: ["a.ts"] }),
      feat("f2", { files_affected: ["b.ts"] }),
      feat("f3", { files_affected: ["c.ts"] }),
    ];
    const result = buildBatches(features, 2);
    // f1, f2 fill batch 0 (capacity 2, no overlap); f3 starts batch 1.
    expect(result).toHaveLength(2);
    expect(result[0].map((f) => f["id"])).toEqual(["f1", "f2"]);
    expect(result[1].map((f) => f["id"])).toEqual(["f3"]);
  });

  test("(b) max-parallel=1 puts every feature in its own batch", () => {
    const features = [
      feat("f1", { files_affected: ["a.ts"] }),
      feat("f2", { files_affected: ["b.ts"] }),
    ];
    const result = buildBatches(features, 1);
    expect(result).toHaveLength(2);
    expect(result.every((b) => b.length === 1)).toBe(true);
  });

  test("(c) max-parallel larger than feature count -> single batch", () => {
    const features = [
      feat("f1", { files_affected: ["a.ts"] }),
      feat("f2", { files_affected: ["b.ts"] }),
    ];
    const result = buildBatches(features, 100);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(2);
  });

  test("(d) default max-parallel is 5", () => {
    // 6 disjoint features: first 5 fill batch 0, the 6th starts batch 1.
    const features = Array.from({ length: 6 }, (_, i) =>
      feat(`f${i}`, { files_affected: [`file${i}.ts`] }),
    );
    const result = buildBatches(features); // no max -> default 5
    expect(result[0]).toHaveLength(5);
    expect(result[1]).toHaveLength(1);
  });

  test("(e) batch is never split by max-parallel after it is full", () => {
    // With max-parallel=2 and four features all sharing one file, every pair
    // conflicts so each feature lands in its own batch.
    const features = Array.from({ length: 4 }, (_, i) =>
      feat(`f${i}`, { files_affected: ["shared.ts"] }),
    );
    const result = buildBatches(features, 2);
    expect(result).toHaveLength(4);
    expect(result.every((b) => b.length === 1)).toBe(true);
  });
});

// =============================================================================
// detectCycles — direct
// =============================================================================

describe("detectCycles (s4-feat-002)", () => {
  test("(a) no dependencies -> no cycles", () => {
    const features = [feat("f1"), feat("f2"), feat("f3")];
    const index = Object.fromEntries(
      features.map((f) => [f["id"] as string, f]),
    );
    expect(detectCycles(features, index)).toEqual([]);
  });

  test("(b) simple two-node cycle f1 -> f2 -> f1", () => {
    const features = [
      feat("f1", { dependencies: ["f2"] }),
      feat("f2", { dependencies: ["f1"] }),
    ];
    const index = Object.fromEntries(
      features.map((f) => [f["id"] as string, f]),
    );
    const cycles = detectCycles(features, index);
    expect(cycles).toHaveLength(1);
    expect(cycles[0].sort()).toEqual(["f1", "f2"]);
  });

  test("(c) three-node cycle f1 -> f2 -> f3 -> f1", () => {
    const features = [
      feat("f1", { dependencies: ["f2"] }),
      feat("f2", { dependencies: ["f3"] }),
      feat("f3", { dependencies: ["f1"] }),
    ];
    const index = Object.fromEntries(
      features.map((f) => [f["id"] as string, f]),
    );
    const cycles = detectCycles(features, index);
    expect(cycles).toHaveLength(1);
    expect(cycles[0].sort()).toEqual(["f1", "f2", "f3"]);
  });

  test("(d) self-loop f1 -> f1 is a cycle", () => {
    const features = [feat("f1", { dependencies: ["f1"] })];
    const index = { f1: features[0] };
    const cycles = detectCycles(features, index);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toEqual(["f1"]);
  });

  test("(e) dependency pointing outside the index is ignored (no cycle)", () => {
    const features = [feat("f1", { dependencies: ["ghost"] })];
    const index = { f1: features[0] }; // note: no "ghost"
    expect(detectCycles(features, index)).toEqual([]);
  });

  test("(f) DAG with no cycles returns empty", () => {
    // f3 -> f2 -> f1 (a chain, no back-edge).
    const features = [
      feat("f1"),
      feat("f2", { dependencies: ["f1"] }),
      feat("f3", { dependencies: ["f2"] }),
    ];
    const index = Object.fromEntries(
      features.map((f) => [f["id"] as string, f]),
    );
    expect(detectCycles(features, index)).toEqual([]);
  });
});

// =============================================================================
// getReadyFeatures — cycle interaction
// =============================================================================

describe("getReadyFeatures - cycles (s4-feat-002)", () => {
  test("(a) features in a cycle are skipped even if their status is pending", () => {
    // f1 <-> f2 form a cycle; both are pending. Neither should be ready.
    const data = sprintData([
      feat("f1", { dependencies: ["f2"] }),
      feat("f2", { dependencies: ["f1"] }),
    ]);
    const result = getReadyFeatures(clone(data));
    expect(result.ready).toEqual([]);
    expect(result.skipped.map((f) => f["id"]).sort()).toEqual(["f1", "f2"]);
    expect(result.cycles).toHaveLength(1);
    expect(result.cycles[0].sort()).toEqual(["f1", "f2"]);
    expect(result.cycle_feature_ids.sort()).toEqual(["f1", "f2"]);
  });

  test("(b) a cycle-free feature stays ready alongside a cycle elsewhere", () => {
    // f1 <-> f2 cycle; f3 is independent and pending.
    const data = sprintData([
      feat("f1", { dependencies: ["f2"] }),
      feat("f2", { dependencies: ["f1"] }),
      feat("f3"),
    ]);
    const result = getReadyFeatures(clone(data));
    expect(result.ready.map((f) => f["id"])).toEqual(["f3"]);
    expect(result.cycle_feature_ids.sort()).toEqual(["f1", "f2"]);
  });

  test("(c) feature depending on a cycle member is not ready", () => {
    // f1 <-> f2 cycle. f3 depends on f1 (pending, never completable).
    const data = sprintData([
      feat("f1", { dependencies: ["f2"] }),
      feat("f2", { dependencies: ["f1"] }),
      feat("f3", { dependencies: ["f1"] }),
    ]);
    const result = getReadyFeatures(clone(data));
    expect(result.ready).toEqual([]);
    expect(result.skipped.map((f) => f["id"]).sort()).toEqual([
      "f1",
      "f2",
      "f3",
    ]);
  });
});

// =============================================================================
// summarizeFeature
// =============================================================================

describe("summarizeFeature (s4-feat-002)", () => {
  test("(a) projects the five summary fields with defaults for missing", () => {
    expect(summarizeFeature(feat("f1"))).toEqual({
      id: "f1",
      title: "f1",
      status: "pending",
      files_affected: [],
      dependencies: [],
    });
  });

  test("(b) preserves provided values", () => {
    const f = feat("f1", {
      title: "Do thing",
      status: "completed",
      dependencies: ["a", "b"],
      files_affected: ["x.ts", "y.ts"],
    });
    expect(summarizeFeature(f)).toEqual({
      id: "f1",
      title: "Do thing",
      status: "completed",
      files_affected: ["x.ts", "y.ts"],
      dependencies: ["a", "b"],
    });
  });

  test("(c) an empty feature dict yields empty-string defaults", () => {
    expect(summarizeFeature({})).toEqual({
      id: "",
      title: "",
      status: "",
      files_affected: [],
      dependencies: [],
    });
  });
});
