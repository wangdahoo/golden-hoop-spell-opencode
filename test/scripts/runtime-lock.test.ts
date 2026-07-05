// Pure-function tests for `src/lib/scripts/runtime-lock.ts` (Feature s1-feat-003).
//
// Exercises the behavior-source-of-truth layer with no disk IO:
//   - buildLockHolder: fields, pid=process.pid, stage three-state (O2), ISO8601.
//   - parseLockContent: null / malformed JSON / missing fields → null; valid → LockHolder.
//   - classifyHolder: none / held_by_self / held_by_other.
//   - renderConflictMessage: holder_label/pid/acquired_at/stage/sprint_id present,
//     three-way choice, "重调 ghs-<tool> 带 takeover=true" (prose-contract).
//
// The tool-layer file-IO cascade is covered in test/runtime-lock.test.ts.

import { expect, test, describe } from "bun:test";

import {
  LockHolderSchema,
  buildLockHolder,
  parseLockContent,
  classifyHolder,
  renderConflictMessage,
  type LockHolder,
} from "../../src/lib/scripts/runtime-lock";

/** A fixed Date for deterministic timestamp assertions. */
const FIXED_NOW = new Date("2026-07-02T14:30:00.000Z");

/** Build a known-good holder for parse/classify/render tests. */
function sampleHolder(overrides: Partial<LockHolder> = {}): LockHolder {
  return {
    session_id: "session-A",
    acquired_at: FIXED_NOW.toISOString(),
    acquired_at_ms: FIXED_NOW.getTime(),
    pid: 12345,
    stage: "code",
    sprint_id: "s5",
    holder_label: "claude-code@ab12cd",
    ...overrides,
  };
}

describe("buildLockHolder (s1-feat-003)", () => {
  test("AC#1 fields complete, pid=process.pid, stage three-state, acquired_at ISO8601", () => {
    const holder = buildLockHolder({
      sessionId: "session-A",
      stage: "code",
      sprintId: "s5",
      holderLabel: "claude-code@ab12cd",
      now: FIXED_NOW,
    });

    expect(holder.session_id).toBe("session-A");
    expect(holder.pid).toBe(process.pid);
    expect(holder.stage).toBe("code");
    expect(holder.sprint_id).toBe("s5");
    expect(holder.holder_label).toBe("claude-code@ab12cd");
    expect(holder.acquired_at_ms).toBe(FIXED_NOW.getTime());
    // ISO8601 parseable.
    expect(!isNaN(Date.parse(holder.acquired_at))).toBe(true);
  });

  test("AC#1 stage ∈ {sprint, code, leaf} (O2 three-state)", () => {
    for (const stage of ["sprint", "code", "leaf"] as const) {
      const holder = buildLockHolder({
        sessionId: "session-A",
        stage,
        sprintId: null,
        holderLabel: "agent@abc123",
        now: FIXED_NOW,
      });
      expect(holder.stage).toBe(stage);
      // Each variant parses cleanly against the schema.
      expect(LockHolderSchema.safeParse(holder).success).toBe(true);
    }
  });

  test("AC#1 sprint_id nullable (sprint stage writes null skeleton-first)", () => {
    const holder = buildLockHolder({
      sessionId: "session-A",
      stage: "sprint",
      sprintId: null,
      holderLabel: "agent@abc123",
      now: FIXED_NOW,
    });
    expect(holder.sprint_id).toBeNull();
    expect(LockHolderSchema.safeParse(holder).success).toBe(true);
  });

  test("AC#1 now defaults to new Date() when omitted", () => {
    const before = Date.now();
    const holder = buildLockHolder({
      sessionId: "session-A",
      stage: "code",
      sprintId: "s5",
      holderLabel: "agent@abc123",
    });
    const after = Date.now();
    expect(holder.acquired_at_ms).toBeGreaterThanOrEqual(before);
    expect(holder.acquired_at_ms).toBeLessThanOrEqual(after);
  });
});

describe("parseLockContent (s1-feat-003)", () => {
  test("AC#2 null input → null", () => {
    expect(parseLockContent(null)).toBeNull();
  });

  test("AC#2 malformed JSON → null", () => {
    expect(parseLockContent("{not json")).toBeNull();
    expect(parseLockContent("")).toBeNull();
    expect(parseLockContent("undefined")).toBeNull();
  });

  test("AC#2 missing required field → null", () => {
    // Omit session_id.
    const partial = {
      acquired_at: FIXED_NOW.toISOString(),
      acquired_at_ms: FIXED_NOW.getTime(),
      pid: 12345,
      stage: "code",
      sprint_id: "s5",
      holder_label: "agent@abc123",
    };
    expect(parseLockContent(JSON.stringify(partial))).toBeNull();
  });

  test("AC#2 wrong type → null", () => {
    const bad = { ...sampleHolder(), pid: "not-a-number" };
    expect(parseLockContent(JSON.stringify(bad))).toBeNull();
  });

  test("AC#2 unknown extra field (strict) → null", () => {
    const extra = { ...sampleHolder(), rogue_field: "boom" };
    expect(parseLockContent(JSON.stringify(extra))).toBeNull();
  });

  test("AC#2 illegal stage enum → null", () => {
    const badStage = { ...sampleHolder(), stage: "danger" };
    expect(parseLockContent(JSON.stringify(badStage))).toBeNull();
  });

  test("AC#2 valid holder → LockHolder", () => {
    const parsed = parseLockContent(JSON.stringify(sampleHolder()));
    expect(parsed).not.toBeNull();
    expect(parsed?.session_id).toBe("session-A");
    expect(parsed?.stage).toBe("code");
    expect(parsed?.sprint_id).toBe("s5");
  });

  test("AC#2 valid holder with null sprint_id → LockHolder", () => {
    const parsed = parseLockContent(
      JSON.stringify(sampleHolder({ sprint_id: null, stage: "sprint" })),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.sprint_id).toBeNull();
  });
});

describe("classifyHolder (s1-feat-003)", () => {
  test("AC#3 current null → none", () => {
    expect(classifyHolder(null, "session-A")).toBe("none");
  });

  test("AC#3 same session_id → held_by_self", () => {
    const holder = sampleHolder({ session_id: "session-A" });
    expect(classifyHolder(holder, "session-A")).toBe("held_by_self");
  });

  test("AC#3 different session_id → held_by_other", () => {
    const holder = sampleHolder({ session_id: "session-A" });
    expect(classifyHolder(holder, "session-B")).toBe("held_by_other");
  });
});

describe("renderConflictMessage (s1-feat-003)", () => {
  test("AC#8 contains holder_label/pid/acquired_at/stage/sprint_id", () => {
    const other = sampleHolder();
    const msg = renderConflictMessage(other, "ghs-code 推进", "ghs-code");

    expect(msg).toContain(other.holder_label);
    expect(msg).toContain(String(other.pid));
    expect(msg).toContain(other.acquired_at);
    expect(msg).toContain(other.stage);
    expect(msg).toContain(other.sprint_id!);
  });

  test("AC#8 contains three-way choice (takeover/wait/cancel)", () => {
    const msg = renderConflictMessage(sampleHolder(), "推进", "ghs-code");
    expect(msg).toContain("接管");
    expect(msg).toContain("等待");
    expect(msg).toContain("取消");
  });

  test("AC#8 instructs 重调 ghs-<tool> 带 takeover=true (prose-contract)", () => {
    const msg = renderConflictMessage(sampleHolder(), "推进", "ghs-sprint");
    expect(msg).toContain("重调 ghs-sprint 带 takeover=true");
    // NEXT ACTION anchor also references the full ghs-* name.
    expect(msg).toContain("ghs-sprint（takeover=true）");
  });

  test("AC#8 attempted action surfaced in the refusal line", () => {
    const msg = renderConflictMessage(
      sampleHolder(),
      "自定义操作描述",
      "ghs-code",
    );
    expect(msg).toContain("自定义操作描述");
  });

  test("AC#8 null sprint_id rendered gracefully (no sprint)", () => {
    const msg = renderConflictMessage(
      sampleHolder({ sprint_id: null, stage: "sprint" }),
      "推进",
      "ghs-sprint",
    );
    expect(msg).toContain("无 sprint");
  });
});
