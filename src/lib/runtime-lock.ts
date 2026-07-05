// Runtime lock tool-layer helpers — file I/O wrapper (Feature s1-feat-003).
//
// This module wraps the pure primitives in `src/lib/scripts/runtime-lock.ts`
// with disk I/O, producing the acquire / release / validate / read surface that
// Phase 3 (s1-feat-005 / s1-feat-006) will wire into sprint / code / append /
// update / archive. It is intentionally NOT referenced by any tool yet — Phase 2
// ships the primitive in isolation so it can be reverted with zero side effects.
//
// Design authority: docs/ghs/plans/2026-07-02-multi-pipeline-concurrency.md
// §3.3 (signatures + semantics) and §4 Phase 2 (acceptance).
//
// Semantics pinning (M4 / M5):
//   - acquireLock: O_EXCL for new (`fs.open(path, "wx")`, EEXIST → re-read &
//     classify as a cross-process race fallback); same-session idempotent
//     overwrite update; `takeover:true` unconditional overwrite (M4 — the
//     read-back ownership check is a self-attesting write and is DELIBERATELY
//     omitted; the residual TOCTOU window is documented and mitigated by the
//     Phase 3 leaf-writer `validateLockHeld`).
//   - releaseLock: unlink is preceded by a SECOND read to confirm ownership
//     still belongs to this session (M5 — shrinks, does not eliminate, the
//     TOCTOU window; the residual is mitigated by Phase 3 validate).
//
// File reads use Bun.file / Bun.write (matches `src/lib/state.ts`); the O_EXCL
// new-create uses Node `fs/promises.open(path, "wx")` (win32/posix both honour
// O_EXCL).

import type { ToolContext } from "@opencode-ai/plugin/tool";
import { resolve, dirname } from "node:path";
import { mkdir, open, unlink } from "node:fs/promises";
import {
  type LockHolder,
  type LockStage,
  buildLockHolder,
  parseLockContent,
  classifyHolder,
} from "./scripts/runtime-lock";

// -----------------------------------------------------------------------------
// Path + label helpers
// -----------------------------------------------------------------------------

/**
 * Build the human-readable holder label (O1): `<agent>@<sessionID last 6>`.
 *
 * The agent name plus the trailing 6 chars of sessionID give a short, stable,
 * human-distinguishable tag surfaced in conflict messages.
 */
export function buildLabel(ctx: ToolContext): string {
  return `${ctx.agent}@${ctx.sessionID.slice(-6)}`;
}

/**
 * Absolute path to the runtime lock file
 * (`<projectDir>/.ghs/active.lock`). Single file per project — serializes all
 * sprint/code/leaf writers across sessions.
 */
export function lockFilePath(projectDir: string): string {
  return resolve(projectDir, ".ghs", "active.lock");
}

// -----------------------------------------------------------------------------
// Internal I/O helpers
// -----------------------------------------------------------------------------

/**
 * Best-effort read of the lock file's raw text. Returns `null` when the file is
 * missing or unreadable (corruption collapses to "no lock", plan §3.5).
 */
async function tryReadRaw(path: string): Promise<string | null> {
  const file = Bun.file(path);
  const exists = await file.exists();
  if (!exists) return null;
  try {
    return await file.text();
  } catch {
    return null;
  }
}

/**
 * O_EXCL create-and-write: opens `path` with flag `"wx"` (fails with EEXIST if
 * the file already exists) and writes the content. Used for race-free new lock
 * acquisition across processes.
 */
async function openWriteExclusive(path: string, content: string): Promise<void> {
  const fh = await open(path, "wx");
  try {
    await fh.writeFile(content);
  } finally {
    await fh.close();
  }
}

/** Serialize a holder to the on-disk pretty JSON form. */
function serialize(holder: LockHolder): string {
  return JSON.stringify(holder, null, 2);
}

// -----------------------------------------------------------------------------
// acquire
// -----------------------------------------------------------------------------

export type AcquireResult =
  | { acquired: true; holder: LockHolder }
  | { acquired: false; reason: "held_by_other"; holder: LockHolder };

/**
 * Acquire (or idempotently re-acquire / forcibly take over) the runtime lock.
 *
 * Decision tree (plan §3.3, M4):
 *   1. Read + classify the existing holder against `sessionId`:
 *      - `none`            → O_EXCL create a new lock file.
 *      - `held_by_self`    → overwrite-update (same process is sequential, no
 *                            race; refreshes stage / sprint_id). No read-back
 *                            check — self-attesting and meaningless within one
 *                            process.
 *      - `held_by_other`:
 *          * `takeover:false` → refuse: return `{ acquired:false, ... }`.
 *          * `takeover:true`  → unconditional overwrite. ⚠ Residual TOCTOU
 *            window (M4): between the read and the overwrite the original
 *            holder may have changed; this write may stomp a freshly-legitimate
 *            acquirer. Accepted under the cooperative-human-pipeline threat
 *            model; the Phase 3 leaf-writer `validateLockHeld` mitigates by
 *            rejecting the stomped session's next write.
 *   2. O_EXCL EEXIST fallback: if the new-create loses a cross-process race
 *      (EEXIST), re-read + classify — either self-heal (file vanished → write)
 *      or surface the holder that won the race.
 *
 * `.ghs/` is mkdir -p'd first (mirrors `writePlanStatus`).
 */
export async function acquireLock(args: {
  projectDir: string;
  sessionId: string;
  stage: LockStage;
  sprintId?: string | null;
  holderLabel?: string;
  takeover?: boolean;
}): Promise<AcquireResult> {
  const path = lockFilePath(args.projectDir);
  await mkdir(dirname(path), { recursive: true });

  const existing = parseLockContent(await tryReadRaw(path));
  const cls = classifyHolder(existing, args.sessionId);
  const holder = buildLockHolder({
    sessionId: args.sessionId,
    stage: args.stage,
    sprintId: args.sprintId ?? null,
    holderLabel: args.holderLabel ?? args.sessionId,
  });

  if (cls === "held_by_other" && !args.takeover) {
    return { acquired: false, reason: "held_by_other", holder: existing! };
  }

  if (cls === "none") {
    try {
      await openWriteExclusive(path, serialize(holder));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      // Cross-process race: another session created the lock between our read
      // and our O_EXCL. Re-read + classify to surface the actual winner.
      const reread = parseLockContent(await tryReadRaw(path));
      if (reread === null) {
        // Winner released between EEXIST and re-read → self-heal by writing.
        await Bun.write(path, serialize(holder));
      } else if (classifyHolder(reread, args.sessionId) === "held_by_self") {
        // We won after all (same session beat us in the race) → refresh.
        await Bun.write(path, serialize(holder));
      } else {
        return { acquired: false, reason: "held_by_other", holder: reread };
      }
    }
  } else {
    // held_by_self OR held_by_other+takeover → overwrite-update. No read-back
    // check (M4: a self-attesting write proves nothing about cross-process order).
    await Bun.write(path, serialize(holder));
  }

  return { acquired: true, holder };
}

// -----------------------------------------------------------------------------
// release
// -----------------------------------------------------------------------------

export type ReleaseResult =
  | { released: true }
  | { released: false; reason: "not_held" | "held_by_other"; holder: LockHolder | null };

/**
 * Release the runtime lock iff it still belongs to this session (M5).
 *
 * Reads the holder, then RE-READS immediately before unlink to shrink the
 * TOCTOU window: if another session took over between the two reads, the unlink
 * is skipped (never delete a takeover's lock). The residual window between the
 * second read and the unlink is documented and mitigated by Phase 3
 * `validateLockHeld`.
 *
 *   - no lock              → `{ released:false, reason:"not_held" }`.
 *   - held by self         → re-read; if still self → unlink → `{ released:true }`.
 *                            if taken over       → `{ released:false, "held_by_other" }`.
 *   - held by other        → `{ released:false, reason:"held_by_other" }` (do not delete).
 *
 * ENOENT on the final unlink is swallowed (the file is gone — the desired state).
 */
export async function releaseLock(args: {
  projectDir: string;
  sessionId: string;
}): Promise<ReleaseResult> {
  const path = lockFilePath(args.projectDir);

  const first = parseLockContent(await tryReadRaw(path));
  if (first === null) {
    return { released: false, reason: "not_held", holder: null };
  }
  if (classifyHolder(first, args.sessionId) !== "held_by_self") {
    return { released: false, reason: "held_by_other", holder: first };
  }

  // M5: re-read immediately before unlink to shrink the takeover race window.
  const reread = parseLockContent(await tryReadRaw(path));
  if (reread !== null && classifyHolder(reread, args.sessionId) !== "held_by_self") {
    return { released: false, reason: "held_by_other", holder: reread };
  }

  try {
    await unlink(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
    // File already gone — desired state; treat as released.
  }
  return { released: true };
}

// -----------------------------------------------------------------------------
// read / validate
// -----------------------------------------------------------------------------

/**
 * Read + parse the current lock holder, or `null` if absent/malformed.
 */
export async function readLock(projectDir: string): Promise<LockHolder | null> {
  return parseLockContent(await tryReadRaw(lockFilePath(projectDir)));
}

export type ValidateResult =
  | { ok: true; holder: LockHolder }
  | { ok: false; reason: "not_held" | "held_by_other"; holder: LockHolder | null };

/**
 * Pre-write ownership check for leaf writers (Phase 3 mandatory, M1).
 *
 *   - `ok:true`                  — lock exists and belongs to this session.
 *   - `ok:false, "not_held"`     — no lock; caller degrades to a leaf short-lock.
 *   - `ok:false, "held_by_other` — a different session holds; caller MUST refuse
 *                                  the write (the takeover anti-double-write wall).
 */
export async function validateLockHeld(args: {
  projectDir: string;
  sessionId: string;
}): Promise<ValidateResult> {
  const current = await readLock(args.projectDir);
  const kind = classifyHolder(current, args.sessionId);
  if (kind === "held_by_self") {
    return { ok: true, holder: current! };
  }
  if (kind === "held_by_other") {
    return { ok: false, reason: "held_by_other", holder: current };
  }
  return { ok: false, reason: "not_held", holder: null };
}
