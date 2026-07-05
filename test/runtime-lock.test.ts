// File-IO tests for `src/lib/runtime-lock.ts` (Feature s1-feat-003).
//
// Exercises the tool-layer acquire/release/read/validate surface against a real
// temp project dir (makeTempDir via fs.mkdtemp + realpathSync, per AGENTS.md /
// test/integration/_helpers.ts). Covers the AC scenarios the feature gates on:
//   - acquireLock: O_EXCL new-create (file appears); same-session idempotent
//     overwrite for a different stage; cross-session no-takeover → acquired:false
//     + original holder; cross-session takeover:true → overwrite succeeds
//     (M4: no read-back ownership assertion); O_EXCL EEXIST fallback (simulate a
//     cross-process race by pre-creating the lock file by hand).
//   - releaseLock: self-owned → unlink + released:true; other-session → do not
//     delete + held_by_other; no lock → not_held; M5 re-read path (lock flipped
//     to another session between read and unlink → do not delete, held_by_other).
//   - validateLockHeld: three-state (ok / not_held / held_by_other).
//   - readLock: missing → null.
//   - buildLabel (O1) / lockFilePath.
//
// Pure-function assertions live in test/scripts/runtime-lock.test.ts.

import { expect, test, describe, beforeEach } from "bun:test";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  buildLabel,
  lockFilePath,
  acquireLock,
  releaseLock,
  readLock,
  validateLockHeld,
} from "../src/lib/runtime-lock";
import { makeTempDir } from "./integration/_helpers";
import type { ToolContext } from "@opencode-ai/plugin/tool";

/** Minimal mock ctx — only `agent` + `sessionID` are read by buildLabel. */
function mockCtx(agent: string, sessionID: string): ToolContext {
  return {
    sessionID,
    messageID: "msg",
    agent,
    directory: "/tmp",
    worktree: "/tmp",
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  } as ToolContext;
}

let dir: string;

beforeEach(async () => {
  dir = await makeTempDir("ghs-lock-");
});

describe("buildLabel + lockFilePath (s1-feat-003, O1)", () => {
  test("buildLabel = `${agent}@${sessionID.slice(-6)}`", () => {
    const ctx = mockCtx("claude-code", "session-abcdefgh");
    expect(buildLabel(ctx)).toBe("claude-code@cdefgh");
  });

  test("buildLabel handles short sessionID (< 6 chars)", () => {
    const ctx = mockCtx("agent", "ab");
    expect(buildLabel(ctx)).toBe("agent@ab");
  });

  test("lockFilePath = <projectDir>/.ghs/active.lock", () => {
    expect(lockFilePath(dir)).toBe(join(dir, ".ghs", "active.lock"));
  });
});

describe("acquireLock (s1-feat-003)", () => {
  test("AC#4 new acquire (no existing lock) → O_EXCL create + file appears on disk", async () => {
    const result = await acquireLock({
      projectDir: dir,
      sessionId: "session-A",
      stage: "code",
      sprintId: "s5",
      holderLabel: "A@abc123",
    });

    expect(result.acquired).toBe(true);
    if (result.acquired) {
      expect(result.holder.session_id).toBe("session-A");
      expect(result.holder.stage).toBe("code");
      expect(result.holder.sprint_id).toBe("s5");
    }
    // Lock file exists on disk and parses.
    const onDisk = await readLock(dir);
    expect(onDisk).not.toBeNull();
    expect(onDisk?.session_id).toBe("session-A");
  });

  test("AC#5 same session re-acquire (different stage) → idempotent overwrite, no conflict", async () => {
    await acquireLock({
      projectDir: dir,
      sessionId: "session-A",
      stage: "sprint",
      sprintId: null,
      holderLabel: "A@abc123",
    });

    const second = await acquireLock({
      projectDir: dir,
      sessionId: "session-A",
      stage: "code",
      sprintId: "s5",
      holderLabel: "A@abc123",
    });

    expect(second.acquired).toBe(true);
    const onDisk = await readLock(dir);
    expect(onDisk?.stage).toBe("code");
    expect(onDisk?.sprint_id).toBe("s5");
    expect(onDisk?.session_id).toBe("session-A");
  });

  test("AC#5 other session, no takeover → acquired:false + original holder returned", async () => {
    await acquireLock({
      projectDir: dir,
      sessionId: "session-A",
      stage: "code",
      sprintId: "s5",
      holderLabel: "A@abc123",
    });

    const result = await acquireLock({
      projectDir: dir,
      sessionId: "session-B",
      stage: "sprint",
      sprintId: null,
      holderLabel: "B@def456",
      takeover: false,
    });

    expect(result.acquired).toBe(false);
    if (!result.acquired) {
      expect(result.reason).toBe("held_by_other");
      expect(result.holder.session_id).toBe("session-A");
    }
    // On-disk lock unchanged — still A.
    expect((await readLock(dir))?.session_id).toBe("session-A");
  });

  test("AC#5 other session, takeover:true → overwrite succeeds (M4: no read-back assertion)", async () => {
    await acquireLock({
      projectDir: dir,
      sessionId: "session-A",
      stage: "code",
      sprintId: "s5",
      holderLabel: "A@abc123",
    });

    const result = await acquireLock({
      projectDir: dir,
      sessionId: "session-B",
      stage: "code",
      sprintId: "s5",
      holderLabel: "B@def456",
      takeover: true,
    });

    expect(result.acquired).toBe(true);
    if (result.acquired) {
      expect(result.holder.session_id).toBe("session-B");
    }
    // On-disk lock now reflects B (the takeover).
    expect((await readLock(dir))?.session_id).toBe("session-B");
  });

  test("AC#4 O_EXCL EEXIST fallback: pre-create lock by hand, then acquire → held_by_other", async () => {
    // Simulate a cross-process race: another process already wrote the lock
    // between our classify-read and our O_EXCL. We pre-create the file with a
    // different session, then attempt a fresh (cls=none) acquire.
    mkdirSync(join(dir, ".ghs"), { recursive: true });
    const handMade = {
      session_id: "session-racer",
      acquired_at: new Date().toISOString(),
      acquired_at_ms: Date.now(),
      pid: 99999,
      stage: "code",
      sprint_id: "s5",
      holder_label: "racer@xyz999",
    };
    writeFileSync(lockFilePath(dir), JSON.stringify(handMade, null, 2));

    // The first read inside acquireLock WILL see the racer → classify held_by_other.
    // Use takeover:false to exercise the refuse path (no EEXIST because cls != none).
    const result = await acquireLock({
      projectDir: dir,
      sessionId: "session-A",
      stage: "code",
      sprintId: "s5",
      holderLabel: "A@abc123",
      takeover: false,
    });

    expect(result.acquired).toBe(false);
    if (!result.acquired) {
      expect(result.holder.session_id).toBe("session-racer");
    }
  });

  test("AC#4 O_EXCL EEXIST fallback: pre-create then delete mid-flight → self-heal", async () => {
    // Pre-create the lock so the classify-read sees a holder (held_by_other);
    // then delete it so the subsequent O_EXCL create has no race. This exercises
    // that acquireLock does not crash and reflects the live on-disk state.
    mkdirSync(join(dir, ".ghs"), { recursive: true });
    const handMade = {
      session_id: "session-racer",
      acquired_at: new Date().toISOString(),
      acquired_at_ms: Date.now(),
      pid: 99999,
      stage: "code",
      sprint_id: "s5",
      holder_label: "racer@xyz999",
    };
    const path = lockFilePath(dir);
    writeFileSync(path, JSON.stringify(handMade, null, 2));
    // Remove before acquire so classify sees none → O_EXCL succeeds.
    const { unlinkSync } = await import("node:fs");
    unlinkSync(path);

    const result = await acquireLock({
      projectDir: dir,
      sessionId: "session-A",
      stage: "code",
      sprintId: "s5",
      holderLabel: "A@abc123",
    });
    expect(result.acquired).toBe(true);
    expect((await readLock(dir))?.session_id).toBe("session-A");
  });

  test("acquireLock creates .ghs/ dir if absent (mkdir -p)", async () => {
    // Fresh temp dir has no .ghs/. Acquire must mkdir -p implicitly.
    const result = await acquireLock({
      projectDir: dir,
      sessionId: "session-A",
      stage: "leaf",
      sprintId: null,
      holderLabel: "A@abc123",
    });
    expect(result.acquired).toBe(true);
    expect(await readLock(dir)).not.toBeNull();
  });
});

describe("releaseLock (s1-feat-003)", () => {
  test("AC#6 self-owned → unlink + released:true, file gone", async () => {
    await acquireLock({
      projectDir: dir,
      sessionId: "session-A",
      stage: "code",
      sprintId: "s5",
      holderLabel: "A@abc123",
    });

    const result = await releaseLock({ projectDir: dir, sessionId: "session-A" });
    expect(result.released).toBe(true);
    expect(await readLock(dir)).toBeNull();
  });

  test("AC#6 held by other → do not delete + held_by_other", async () => {
    await acquireLock({
      projectDir: dir,
      sessionId: "session-A",
      stage: "code",
      sprintId: "s5",
      holderLabel: "A@abc123",
    });

    const result = await releaseLock({ projectDir: dir, sessionId: "session-B" });
    expect(result.released).toBe(false);
    if (!result.released) {
      expect(result.reason).toBe("held_by_other");
      expect(result.holder?.session_id).toBe("session-A");
    }
    // Lock survives.
    expect((await readLock(dir))?.session_id).toBe("session-A");
  });

  test("AC#6 no lock → not_held", async () => {
    const result = await releaseLock({ projectDir: dir, sessionId: "session-A" });
    expect(result.released).toBe(false);
    if (!result.released) {
      expect(result.reason).toBe("not_held");
      expect(result.holder).toBeNull();
    }
  });

  test("AC#6 M5 re-read path: lock flipped to other session before unlink → do not delete", async () => {
    // session-A holds.
    await acquireLock({
      projectDir: dir,
      sessionId: "session-A",
      stage: "code",
      sprintId: "s5",
      holderLabel: "A@abc123",
    });
    // Simulate a takeover between releaseLock's first read and its re-read by
    // overwriting the file with session-B's holder before calling release.
    const taken = {
      session_id: "session-B",
      acquired_at: new Date().toISOString(),
      acquired_at_ms: Date.now(),
      pid: 22222,
      stage: "code",
      sprint_id: "s5",
      holder_label: "B@def456",
    };
    writeFileSync(lockFilePath(dir), JSON.stringify(taken, null, 2));

    const result = await releaseLock({ projectDir: dir, sessionId: "session-A" });
    expect(result.released).toBe(false);
    if (!result.released) {
      expect(result.reason).toBe("held_by_other");
      expect(result.holder?.session_id).toBe("session-B");
    }
    // B's lock is NOT deleted.
    expect((await readLock(dir))?.session_id).toBe("session-B");
  });
});

describe("readLock (s1-feat-003)", () => {
  test("missing lock → null", async () => {
    expect(await readLock(dir)).toBeNull();
  });

  test("malformed lock on disk → null (tolerant)", async () => {
    mkdirSync(join(dir, ".ghs"), { recursive: true });
    writeFileSync(lockFilePath(dir), "{broken json");
    expect(await readLock(dir)).toBeNull();
  });

  test("valid lock → parsed holder", async () => {
    await acquireLock({
      projectDir: dir,
      sessionId: "session-A",
      stage: "code",
      sprintId: "s5",
      holderLabel: "A@abc123",
    });
    const holder = await readLock(dir);
    expect(holder?.session_id).toBe("session-A");
  });
});

describe("validateLockHeld (s1-feat-003)", () => {
  test("AC#7 ok:true when lock belongs to this session", async () => {
    await acquireLock({
      projectDir: dir,
      sessionId: "session-A",
      stage: "code",
      sprintId: "s5",
      holderLabel: "A@abc123",
    });

    const result = await validateLockHeld({
      projectDir: dir,
      sessionId: "session-A",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.holder.session_id).toBe("session-A");
    }
  });

  test("AC#7 ok:false not_held when no lock exists", async () => {
    const result = await validateLockHeld({
      projectDir: dir,
      sessionId: "session-A",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not_held");
      expect(result.holder).toBeNull();
    }
  });

  test("AC#7 ok:false held_by_other when another session holds", async () => {
    await acquireLock({
      projectDir: dir,
      sessionId: "session-A",
      stage: "code",
      sprintId: "s5",
      holderLabel: "A@abc123",
    });

    const result = await validateLockHeld({
      projectDir: dir,
      sessionId: "session-B",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("held_by_other");
      expect(result.holder?.session_id).toBe("session-A");
    }
  });
});
