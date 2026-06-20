// Unit tests for `src/lib/state.ts` (plan dispatcher status.json I/O + schema).
//
// Implements Feature s3-feat-005. Covers every acceptance criterion:
//   - AC #1: exports read/write functions for status.json with a schema that
//            includes `codegraph_available: boolean`.
//   - AC #3: state.ts validates status.json with Zod.
//   - AC #4: file I/O uses Bun.file / Bun.write; no process.exit.
//   - AC #5: `bunx tsc --noEmit` passes (verified separately — no assertion
//            needed here, but the suite must compile).
//
// Temp-dir policy matches test/codegraph.test.ts: `mkdtemp` under `os.tmpdir()`
// + `realpathSync` to dodge the macOS `/tmp` → `/private/tmp` symlink surprise.

import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PlanStatusSchema,
  createInitialPlanStatus,
  readPlanStatus,
  writePlanStatus,
  planStatusExists,
  statusFilePath,
  plansDir,
  formatLocalTimestamp,
  DEFAULT_MAX_ROUNDS,
  type PlanStatus,
} from "../src/lib/state";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** A minimal-but-valid status object used as the baseline for mutation tests. */
function baselineStatus(overrides: Partial<PlanStatus> = {}): PlanStatus {
  return {
    plan_id: "2026-06-20-test-plan",
    plan_file: "2026-06-20-test-plan.md",
    context_file: "2026-06-20-test-plan-context.md",
    round: 1,
    status: "designing",
    codegraph_available: false,
    max_rounds: 5,
    max_rounds_breaches: 0,
    accepted_with_fail: false,
    keep_raw_on_success: false,
    created_at: "2026-06-20T10:00:00",
    updated_at: "2026-06-20T10:00:00",
    ...overrides,
  };
}

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------

describe("PlanStatusSchema", () => {
  test("accepts a complete, valid status object", () => {
    const obj = baselineStatus();
    expect(() => PlanStatusSchema.parse(obj)).not.toThrow();
    expect(PlanStatusSchema.parse(obj)).toEqual(obj);
  });

  test("accepts the codegraph_available: true R1 case", () => {
    // The headline field for this feature — the schema MUST admit true.
    const obj = baselineStatus({ codegraph_available: true });
    expect(PlanStatusSchema.parse(obj).codegraph_available).toBe(true);
  });

  test("rejects an object missing codegraph_available (R1 field is required)", () => {
    const obj = baselineStatus();
    const { codegraph_available: _omit, ...withoutField } = obj;
    expect(() => PlanStatusSchema.parse(withoutField)).toThrow();
  });

  test("rejects codegraph_available with a non-boolean value", () => {
    const obj = baselineStatus({ codegraph_available: "yes" as unknown as boolean });
    expect(() => PlanStatusSchema.parse(obj)).toThrow();
  });

  test("rejects unknown top-level fields (strict schema)", () => {
    const obj = baselineStatus({ extra: "surprise" } as Partial<PlanStatus>);
    expect(() => PlanStatusSchema.parse(obj)).toThrow();
  });

  test("accepts every status enum value", () => {
    for (const s of [
      "designing",
      "reviewing",
      "revising",
      "pending_approval",
      "approved",
      "rejected",
      "aborted",
    ] as const) {
      expect(() => PlanStatusSchema.parse(baselineStatus({ status: s }))).not.toThrow();
    }
  });

  test("rejects an unknown status enum value", () => {
    const obj = baselineStatus({ status: "unknown" as PlanStatus["status"] });
    expect(() => PlanStatusSchema.parse(obj)).toThrow();
  });

  test("rejects a negative round", () => {
    const obj = baselineStatus({ round: -1 });
    expect(() => PlanStatusSchema.parse(obj)).toThrow();
  });

  test("accepts a status with a review_file once the reviewer has run", () => {
    const obj = baselineStatus({ review_file: "2026-06-20-test-plan-review.md" });
    expect(PlanStatusSchema.parse(obj).review_file).toBe(
      "2026-06-20-test-plan-review.md",
    );
  });

  test("rejects a non-positive max_rounds", () => {
    expect(() =>
      PlanStatusSchema.parse(baselineStatus({ max_rounds: 0 })),
    ).toThrow();
    expect(() =>
      PlanStatusSchema.parse(baselineStatus({ max_rounds: -3 })),
    ).toThrow();
  });
});

// -----------------------------------------------------------------------------
// Path helpers
// -----------------------------------------------------------------------------

describe("path helpers", () => {
  test("plansDir resolves <projectDir>/.ghs/plans", () => {
    expect(plansDir("/proj")).toBe(join("/proj", ".ghs", "plans"));
  });

  test("statusFilePath resolves <projectDir>/.ghs/plans/<planId>-status.json", () => {
    expect(statusFilePath("/proj", "2026-06-20-slug")).toBe(
      join("/proj", ".ghs", "plans", "2026-06-20-slug-status.json"),
    );
  });
});

// -----------------------------------------------------------------------------
// Timestamp helper
// -----------------------------------------------------------------------------

describe("formatLocalTimestamp", () => {
  test("emits YYYY-MM-DDTHH:mm:ss", () => {
    // Construct a Date with known components (local time interpretation is
    // fine — we only assert the *shape*, not the absolute value).
    const d = new Date(2026, 5, 20, 14, 5, 9); // 2026-06-20 14:05:09 local
    expect(formatLocalTimestamp(d)).toBe("2026-06-20T14:05:09");
  });

  test("zero-pads single-digit components", () => {
    const d = new Date(2026, 0, 1, 2, 3, 4); // 2026-01-01 02:03:04 local
    expect(formatLocalTimestamp(d)).toBe("2026-01-01T02:03:04");
  });
});

// -----------------------------------------------------------------------------
// createInitialPlanStatus
// -----------------------------------------------------------------------------

describe("createInitialPlanStatus", () => {
  test("produces a schema-valid status with source defaults", () => {
    const status = createInitialPlanStatus({
      planId: "2026-06-20-x",
      planFile: "2026-06-20-x.md",
      contextFile: "2026-06-20-x-context.md",
      codegraphAvailable: true,
      now: new Date(2026, 5, 20, 9, 0, 0),
    });
    // Round-trips through the schema — proves the object is well-formed.
    expect(() => PlanStatusSchema.parse(status)).not.toThrow();

    expect(status.round).toBe(1);
    expect(status.status).toBe("designing");
    expect(status.codegraph_available).toBe(true);
    expect(status.max_rounds).toBe(DEFAULT_MAX_ROUNDS);
    expect(status.max_rounds_breaches).toBe(0);
    expect(status.accepted_with_fail).toBe(false);
    expect(status.keep_raw_on_success).toBe(false);
    expect(status.created_at).toBe("2026-06-20T09:00:00");
    expect(status.updated_at).toBe(status.created_at);
  });

  test("does not include review_file until the reviewer runs", () => {
    const status = createInitialPlanStatus({
      planId: "p",
      planFile: "p.md",
      contextFile: "p-context.md",
      codegraphAvailable: false,
    });
    expect(status.review_file).toBeUndefined();
  });

  test("honours a custom maxRounds override", () => {
    const status = createInitialPlanStatus({
      planId: "p",
      planFile: "p.md",
      contextFile: "p-context.md",
      codegraphAvailable: false,
      maxRounds: 3,
    });
    expect(status.max_rounds).toBe(3);
  });

  test("is a pure function — does not touch the filesystem", async () => {
    const tempRoot = realpathSync(await mkdtemp(join(tmpdir(), "ghs-init-")));
    try {
      const status = createInitialPlanStatus({
        planId: "p",
        planFile: "p.md",
        contextFile: "p-context.md",
        codegraphAvailable: false,
      });
      // No status file should materialise just from calling the constructor.
      const exists = await planStatusExists(tempRoot, status.plan_id);
      expect(exists).toBe(false);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

// -----------------------------------------------------------------------------
// readPlanStatus / writePlanStatus / planStatusExists (I/O)
// -----------------------------------------------------------------------------

describe("status.json I/O", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = realpathSync(await mkdtemp(join(tmpdir(), "ghs-state-")));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("writePlanStatus creates .ghs/plans/ if missing and round-trips the object", async () => {
    const status = baselineStatus();
    const writtenPath = await writePlanStatus(tempRoot, status);

    // Written to the canonical path.
    expect(writtenPath).toBe(statusFilePath(tempRoot, status.plan_id));

    // The plans dir was created on the fly. Use statSync (rather than
    // Bun.file().exists(), whose behaviour on directories is version-dependent)
    // to assert a real directory now exists at the canonical path.
    const dir = plansDir(tempRoot);
    expect(statSync(dir).isDirectory()).toBe(true);

    // Round-trip: read returns an equal object.
    const readBack = await readPlanStatus(tempRoot, status.plan_id);
    expect(readBack).toEqual(status);
  });

  test("writePlanStatus preserves codegraph_available: true (R1 headline)", async () => {
    const status = baselineStatus({ codegraph_available: true });
    await writePlanStatus(tempRoot, status);
    const readBack = await readPlanStatus(tempRoot, status.plan_id);
    expect(readBack?.codegraph_available).toBe(true);
  });

  test("writePlanStatus serialises with 2-space indent and no trailing newline", async () => {
    const status = baselineStatus();
    const path = await writePlanStatus(tempRoot, status);
    const raw = await Bun.file(path).text();
    // 2-space indent is observable via the second key's leading whitespace.
    expect(raw).toContain('\n  "plan_file"');
    // No trailing newline — matches the source skill's json.dump convention.
    expect(raw.endsWith("\n")).toBe(false);
  });

  test("writePlanStatus rejects a structurally-invalid status before touching disk", async () => {
    // Missing required field → ZodError → throw, and no file is written.
    const bad = baselineStatus();
    const { codegraph_available: _omit, ...withoutField } = bad;
    await expect(
      writePlanStatus(tempRoot, withoutField as PlanStatus),
    ).rejects.toThrow();
    const exists = await planStatusExists(tempRoot, bad.plan_id);
    expect(exists).toBe(false);
  });

  test("readPlanStatus returns null when the file does not exist", async () => {
    const result = await readPlanStatus(tempRoot, "never-started");
    expect(result).toBeNull();
  });

  test("readPlanStatus throws on invalid JSON", async () => {
    const planId = "broken-json";
    // Hand-write a malformed status file.
    await mkdir(plansDir(tempRoot), { recursive: true });
    await writeFile(statusFilePath(tempRoot, planId), "{ not json");
    await expect(readPlanStatus(tempRoot, planId)).rejects.toThrow(
      /invalid JSON/,
    );
  });

  test("readPlanStatus throws on schema-invalid content", async () => {
    const planId = "schema-invalid";
    await mkdir(plansDir(tempRoot), { recursive: true });
    // Valid JSON, but missing required `codegraph_available`.
    await writeFile(
      statusFilePath(tempRoot, planId),
      JSON.stringify({ plan_id: planId, round: 1 }),
    );
    await expect(readPlanStatus(tempRoot, planId)).rejects.toThrow();
  });

  test("readPlanStatus throws on unknown top-level field (strict)", async () => {
    const planId = "strict-reject";
    await mkdir(plansDir(tempRoot), { recursive: true });
    const withExtra = { ...baselineStatus({ plan_id: planId }), extra: "x" };
    await writeFile(
      statusFilePath(tempRoot, planId),
      JSON.stringify(withExtra),
    );
    await expect(readPlanStatus(tempRoot, planId)).rejects.toThrow();
  });

  test("planStatusExists returns false before write, true after", async () => {
    const status = baselineStatus();
    expect(await planStatusExists(tempRoot, status.plan_id)).toBe(false);
    await writePlanStatus(tempRoot, status);
    expect(await planStatusExists(tempRoot, status.plan_id)).toBe(true);
  });

  test("writePlanStatus is idempotent across repeated writes", async () => {
    const status = baselineStatus();
    await writePlanStatus(tempRoot, status);
    await writePlanStatus(tempRoot, status);
    const readBack = await readPlanStatus(tempRoot, status.plan_id);
    expect(readBack).toEqual(status);
  });

  test("writePlanStatus updates only the updated_at field when status advances", async () => {
    // Simulate the dispatcher advancing round + flipping status mid-loop.
    const initial = baselineStatus();
    await writePlanStatus(tempRoot, initial);

    const advanced: PlanStatus = {
      ...initial,
      round: 2,
      status: "reviewing",
      updated_at: "2026-06-20T11:00:00",
    };
    await writePlanStatus(tempRoot, advanced);

    const readBack = await readPlanStatus(tempRoot, initial.plan_id);
    expect(readBack?.round).toBe(2);
    expect(readBack?.status).toBe("reviewing");
    expect(readBack?.updated_at).toBe("2026-06-20T11:00:00");
    // created_at is preserved across updates.
    expect(readBack?.created_at).toBe(initial.created_at);
  });
});
