// Unit tests for the three s2-feat-001 "writer" modules:
//   - src/lib/scripts/append-sprint.ts          (appendSprint)
//   - src/lib/scripts/update-feature-status.ts  (updateFeatureStatus)
//   - src/lib/scripts/append-progress-session.ts (appendProgressSession)
//
// Implements Feature s2-feat-004. Covers core paths + edge cases for each
// module. There is no Python source equivalent to diff against (the source
// plugin had the AI edit features.json / progress.md directly), so these are
// pure behavioural tests validating the TS implementation itself.
//
// Style follows test/config.test.ts: bun:test, describe/test blocks,
// JSON.parse(JSON.stringify(...)) for deep-cloning mutable fixtures, and
// string includes/startsWith assertions for the markdown tests (more robust
// than full-string equality).
//
// Fixture reuse: the canonical `test/fixtures/.ghs/features.json` and
// `test/fixtures/.ghs/progress.md` (created in s1-feat-012) provide realistic
// starting structures. Each test deep-clones them so suites stay independent;
// nothing here touches the real project `.ghs/` directory.

import { expect, test, describe } from "bun:test";
import { resolve, join } from "node:path";
import { readFileSync } from "node:fs";
import { ZodError } from "zod";

import { appendSprint } from "../src/lib/scripts/append-sprint";
import { updateFeatureStatus } from "../src/lib/scripts/update-feature-status";
import { appendProgressSession } from "../src/lib/scripts/append-progress-session";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dir, "..");
const FIXTURE_GHS_DIR = join(REPO_ROOT, "test", "fixtures", ".ghs");
const FIXTURE_FEATURES_JSON = join(FIXTURE_GHS_DIR, "features.json");
const FIXTURE_PROGRESS_MD = join(FIXTURE_GHS_DIR, "progress.md");

/** Deep-clone helper — keeps each test's mutations isolated from the others. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Read + parse the canonical fixture features.json (deep-cloned for safety). */
function fixtureFeaturesData(): Record<string, unknown> {
  const raw = readFileSync(FIXTURE_FEATURES_JSON, "utf8");
  return clone(JSON.parse(raw));
}

/** Read the canonical fixture progress.md as a string. */
function fixtureProgressMd(): string {
  return readFileSync(FIXTURE_PROGRESS_MD, "utf8");
}

/**
 * Zod v3 throws a ZodError (or a subclass) on parse failure. We accept either
 * so the assertion is resilient across patch versions.
 */
function expectZodError(fn: () => unknown): void {
  expect(fn).toThrow(ZodError);
}

// =============================================================================
// appendSprint
// =============================================================================

describe("appendSprint (s2-feat-001)", () => {
  // (a) Normal: append to an empty sprints array --------------------------------
  test("(a) appends a sprint to an empty sprints array", () => {
    const data = { project: { name: "X" }, sprints: [] };
    const out = appendSprint(data, {
      id: "s1",
      name: "First",
      goal: "Lay foundation",
      created_at: "2026-06-20",
    });
    const sprints = out.sprints as Array<Record<string, unknown>>;
    expect(sprints).toHaveLength(1);
    expect(sprints[0].id).toBe("s1");
    expect(sprints[0].name).toBe("First");
    expect(sprints[0].status).toBe("planning");
    expect(sprints[0].features).toEqual([]);
  });

  // (b) Normal: append to a non-empty array -------------------------------------
  test("(b) appends to a non-empty sprints array without disturbing existing entries", () => {
    const data = fixtureFeaturesData();
    const before = (data.sprints as unknown[]).length;
    const out = appendSprint(data, {
      id: "s3",
      name: "Third Sprint",
      goal: "Extend",
      created_at: "2026-03-01",
    });
    const sprints = out.sprints as Array<Record<string, unknown>>;
    expect(sprints).toHaveLength(before + 1);
    // Existing sprints remain intact by id.
    expect(sprints[0].id).toBe("s1");
    expect(sprints[1].id).toBe("s2");
    // New sprint sits at the tail.
    expect(sprints[sprints.length - 1].id).toBe("s3");
    expect(sprints[sprints.length - 1].features).toEqual([]);
  });

  // (c) Edge: sprint id clash throws --------------------------------------------
  test("(c) throws a descriptive Error when the sprint id already exists", () => {
    const data = fixtureFeaturesData(); // already has s1, s2
    expect(() =>
      appendSprint(data, {
        id: "s2",
        name: "Dup",
        goal: "x",
        created_at: "2026-06-20",
      }),
    ).toThrow(/already exists/);
  });

  // (d) Edge: spec missing required field is rejected by Zod --------------------
  test("(d) rejects a spec missing a required field (goal)", () => {
    const data = { sprints: [] };
    // Missing `goal`.
    expectZodError(() =>
      appendSprint(data, {
        id: "s1",
        name: "First",
        created_at: "2026-06-20",
      } as unknown as Parameters<typeof appendSprint>[1]),
    );
  });

  // (d.2) Edge: malformed id / date also rejected -------------------------------
  test("(d2) rejects an invalid sprint id format and a malformed created_at", () => {
    const data = { sprints: [] };
    expectZodError(() =>
      appendSprint(data, {
        id: "sprint-1",
        name: "First",
        goal: "g",
        created_at: "2026-06-20",
      }),
    );
    expectZodError(() =>
      appendSprint(data, {
        id: "s1",
        name: "First",
        goal: "g",
        created_at: "06/20/2026",
      }),
    );
  });

  // (e) Immutable: input object not mutated -------------------------------------
  test("(e) returns a new object and does not mutate the input", () => {
    const data = fixtureFeaturesData();
    const originalSnapshot = clone(data);
    const out = appendSprint(data, {
      id: "s9",
      name: "New",
      goal: "g",
      created_at: "2026-06-20",
    });
    // Returned object is a different reference.
    expect(out).not.toBe(data);
    // Returned sprints array is a different reference.
    expect(out.sprints).not.toBe(data.sprints);
    // Input was not mutated.
    expect(data).toEqual(originalSnapshot);
    // Existing sprint objects are shared by reference (intentional shallow clone).
    expect((out.sprints as unknown[])[0]).toBe(
      (data.sprints as unknown[])[0],
    );
  });
});

// =============================================================================
// updateFeatureStatus
// =============================================================================

describe("updateFeatureStatus (s2-feat-001)", () => {
  // (a) Normal: pending -> in_progress -> completed lifecycle -------------------
  test("(a) transitions a feature pending -> in_progress -> completed", () => {
    const data = fixtureFeaturesData();
    // s2-feat-001 starts as "pending" in the fixture.
    const step1 = updateFeatureStatus(data, {
      feature_id: "s2-feat-001",
      status: "in_progress",
    });
    const feat1 = findFeature(step1, "s2-feat-001");
    expect(feat1.status).toBe("in_progress");

    const step2 = updateFeatureStatus(step1, {
      feature_id: "s2-feat-001",
      status: "completed",
    });
    const feat2 = findFeature(step2, "s2-feat-001");
    expect(feat2.status).toBe("completed");
  });

  // (a.2) Blocked with a reason round-trips ------------------------------------
  test("(a2) sets status=blocked with a blocked_reason and stores it on the feature", () => {
    const data = fixtureFeaturesData();
    const out = updateFeatureStatus(data, {
      feature_id: "s1-feat-001",
      status: "blocked",
      blocked_reason: "Waiting on upstream API",
    });
    const feat = findFeature(out, "s1-feat-001");
    expect(feat.status).toBe("blocked");
    expect(feat.blocked_reason).toBe("Waiting on upstream API");
  });

  // (a.3) Transitioning out of blocked drops the stale reason ------------------
  test("(a3) removes blocked_reason when transitioning out of blocked", () => {
    const data = fixtureFeaturesData();
    // s1-feat-002 starts as blocked with a reason in the fixture.
    expect(findFeature(data, "s1-feat-002").blocked_reason).toBeDefined();
    const out = updateFeatureStatus(data, {
      feature_id: "s1-feat-002",
      status: "in_progress",
    });
    const feat = findFeature(out, "s1-feat-002");
    expect(feat.status).toBe("in_progress");
    expect(feat.blocked_reason).toBeUndefined();
  });

  // (b) Edge: status=blocked without blocked_reason is rejected ----------------
  test("(b) rejects status=blocked when blocked_reason is missing or empty", () => {
    const data = fixtureFeaturesData();
    // Missing entirely.
    expectZodError(() =>
      updateFeatureStatus(data, {
        feature_id: "s1-feat-001",
        status: "blocked",
      } as unknown as Parameters<typeof updateFeatureStatus>[1]),
    );
    // Empty string.
    expectZodError(() =>
      updateFeatureStatus(data, {
        feature_id: "s1-feat-001",
        status: "blocked",
        blocked_reason: "",
      }),
    );
  });

  // (c) Edge: unknown feature_id throws ----------------------------------------
  test("(c) throws a descriptive Error when feature_id is not found", () => {
    const data = fixtureFeaturesData();
    expect(() =>
      updateFeatureStatus(data, {
        feature_id: "s9-feat-999",
        status: "completed",
      }),
    ).toThrow(/not found/);
  });

  // (d) Edge: invalid status value is rejected by Zod --------------------------
  test("(d) rejects an invalid status enum value", () => {
    const data = fixtureFeaturesData();
    expectZodError(() =>
      updateFeatureStatus(data, {
        feature_id: "s1-feat-001",
        status: "done" as unknown as "completed",
      }),
    );
  });

  // (d.2) Edge: malformed feature_id is rejected -------------------------------
  test("(d2) rejects a malformed feature_id format", () => {
    const data = fixtureFeaturesData();
    expectZodError(() =>
      updateFeatureStatus(data, {
        feature_id: "feature-1",
        status: "completed",
      }),
    );
  });

  // (e) Cross-sprint lookup -----------------------------------------------------
  test("(e) finds a feature across multiple sprints (s2-feat-001 lives in s2, not s1)", () => {
    const data = fixtureFeaturesData();
    // Confirm the fixture layout: s2-feat-001 is in the second sprint.
    const sprints = data.sprints as Array<Record<string, unknown>>;
    const s1Features = sprints[0].features as Array<Record<string, unknown>>;
    const s2Features = sprints[1].features as Array<Record<string, unknown>>;
    expect(s1Features.map((f) => f.id)).not.toContain("s2-feat-001");
    expect(s2Features.map((f) => f.id)).toContain("s2-feat-001");

    // Now update it — the writer must locate it regardless of which sprint.
    const out = updateFeatureStatus(data, {
      feature_id: "s2-feat-001",
      status: "in_progress",
    });
    expect(findFeature(out, "s2-feat-001").status).toBe("in_progress");
    // Sibling feature in the same sprint is untouched.
    expect(findFeature(out, "s2-feat-000").status).toBe("in_progress");
    // Feature in the OTHER sprint is untouched.
    expect(findFeature(out, "s1-feat-001").status).toBe("completed");
  });

  // (e.2) Immutable: input not mutated -----------------------------------------
  test("(e2) returns a new object and does not mutate the input", () => {
    const data = fixtureFeaturesData();
    const originalSnapshot = clone(data);
    const out = updateFeatureStatus(data, {
      feature_id: "s2-feat-001",
      status: "completed",
    });
    expect(out).not.toBe(data);
    expect(data).toEqual(originalSnapshot);
    // The untouched sibling feature object is shared by reference.
    const origSibling = findFeature(data, "s2-feat-000");
    const outSibling = findFeature(out, "s2-feat-000");
    expect(outSibling).toBe(origSibling);
  });
});

/** Locate a feature by id across all sprints in `data`. Throws if missing. */
function findFeature(
  data: Record<string, unknown>,
  featureId: string,
): Record<string, unknown> {
  const sprints = (data.sprints as Array<Record<string, unknown>>) ?? [];
  for (const sprint of sprints) {
    const features = (sprint.features as Array<Record<string, unknown>>) ?? [];
    for (const f of features) {
      if (f.id === featureId) return f;
    }
  }
  throw new Error(`test helper: feature ${featureId} missing from data`);
}

// =============================================================================
// appendProgressSession
// =============================================================================

/**
 * Build a `ProgressSession` with all the optional list fields defaulted to
 * empty arrays. `ProgressSessionSchema` uses `.default([])` on those fields, so
 * at runtime Zod fills them in — but the TS output type marks them required,
 * which makes a literal `{ title, agent }` fail to type-check. Centralising
 * the construction here keeps the call sites readable while staying type-safe.
 */
function minimalSession(
  overrides: Partial<Parameters<typeof appendProgressSession>[1]> &
    Pick<Parameters<typeof appendProgressSession>[1], "title" | "agent">,
): Parameters<typeof appendProgressSession>[1] {
  return {
    work_completed: [],
    tests_performed: [],
    issues: [],
    decisions: [],
    next_steps: [],
    ...overrides,
  };
}

describe("appendProgressSession (s2-feat-001)", () => {
  // (a) Insert the first session into a template-only progress.md --------------
  test("(a) inserts the first session into a template-only progress.md (no existing entries)", () => {
    // Synthesise a template-only progress.md: heading + comment, no entries.
    const templateOnly =
      "# Project Progress Log\n\n" +
      "---\n\n" +
      "## Sessions\n\n" +
      "<!-- New sessions should be added above this line -->\n";

    const out = appendProgressSession(
      templateOnly,
      minimalSession({
        title: "Session 1 - 2026-06-20",
        agent: "Sprint Agent",
      }),
    );

    // The session heading is present.
    expect(out).toContain("## Session 1 - 2026-06-20");
    expect(out).toContain("**Agent**: Sprint Agent");
    // The original comment is preserved verbatim further down the file.
    expect(out).toContain("<!-- New sessions should be added above this line -->");
    // The `## Sessions` heading still exists exactly once.
    expect(out.match(/^## Sessions$/gm)).toHaveLength(1);
  });

  // (b) Insert before an existing session — newest stays on top ----------------
  test("(b) inserts a new session above the previous newest (newest-on-top)", () => {
    const md = fixtureProgressMd(); // already has Session 2, then Session 1
    const out = appendProgressSession(
      md,
      minimalSession({
        title: "Session 3 - 2026-06-20",
        agent: "Coding Agent",
        sprint: "s2 - Active Sprint",
      }),
    );

    const session3Idx = out.indexOf("## Session 3 - 2026-06-20");
    const session2Idx = out.indexOf("## Session 2 - 2026-02-10");
    const session1Idx = out.indexOf("## Session 1 - 2026-01-15");

    expect(session3Idx).toBeGreaterThan(-1);
    expect(session2Idx).toBeGreaterThan(-1);
    expect(session1Idx).toBeGreaterThan(-1);
    // Ordering: Session 3 before Session 2 before Session 1.
    expect(session3Idx).toBeLessThan(session2Idx);
    expect(session2Idx).toBeLessThan(session1Idx);
  });

  // (c) Full-field session renders all sub-sections ----------------------------
  test("(c) renders all sub-sections when the session carries every field", () => {
    const md = "## Sessions\n\n<!-- marker -->\n";
    const out = appendProgressSession(md, {
      title: "Session 5 - 2026-06-20",
      agent: "Coding Agent",
      sprint: "s2",
      feature: "s2-feat-001",
      work_completed: ["Implemented X", "Wrote tests for X"],
      tests_performed: ["bun test", "tsc --noEmit"],
      issues: ["Flaky test on macOS"],
      decisions: ["Use Zod for validation"],
      next_steps: ["Refactor Y"],
    });

    // Metadata lines.
    expect(out).toContain("**Agent**: Coding Agent");
    expect(out).toContain("**Sprint**: s2");
    expect(out).toContain("**Feature**: s2-feat-001");
    // All five sub-headings present.
    expect(out).toContain("### Work Completed");
    expect(out).toContain("### Tests Performed");
    expect(out).toContain("### Issues Encountered");
    expect(out).toContain("### Decisions Made");
    expect(out).toContain("### Next Steps");
    // Bullet items rendered with the `- ` prefix.
    expect(out).toContain("- Implemented X");
    expect(out).toContain("- bun test");
    expect(out).toContain("- Flaky test on macOS");
    expect(out).toContain("- Use Zod for validation");
    expect(out).toContain("- Refactor Y");
  });

  // (d) Minimal session (only required fields) renders cleanly -----------------
  test("(d) renders a minimal session with only required fields (no sprint/feature/lists)", () => {
    // Use a template-only md (no pre-existing sessions) so we can assert the
    // new session's own rendered block in isolation — the fixture's existing
    // sessions carry their own `**Sprint**:` lines which would pollute a
    // global not.toContain check.
    const md =
      "## Sessions\n\n<!-- New sessions should be added above this line -->\n";
    const out = appendProgressSession(
      md,
      minimalSession({
        title: "Session 4 - 2026-06-20",
        agent: "Bot",
      }),
    );

    // Isolate the newly inserted session block (from its heading to the
    // first sub-heading, which always follows the metadata lines).
    const headingIdx = out.indexOf("## Session 4 - 2026-06-20");
    const workIdx = out.indexOf("### Work Completed");
    expect(headingIdx).toBeGreaterThan(-1);
    expect(workIdx).toBeGreaterThan(headingIdx);
    const sessionHeader = out.slice(headingIdx, workIdx);

    // Heading + agent line present within the new session's metadata area.
    expect(sessionHeader).toContain("## Session 4 - 2026-06-20");
    expect(sessionHeader).toContain("**Agent**: Bot");
    // No sprint/feature metadata lines emitted for a minimal session.
    expect(sessionHeader).not.toContain("**Sprint**:");
    expect(sessionHeader).not.toContain("**Feature**:");
    // Sub-headings are still emitted (shape matches the template).
    expect(out).toContain("### Work Completed");
  });

  // (d.2) Edge: missing required field is rejected -----------------------------
  test("(d2) rejects a session missing the required `agent` field", () => {
    const md = "## Sessions\n\n";
    expectZodError(() =>
      appendProgressSession(md, {
        title: "Session X",
      } as unknown as Parameters<typeof appendProgressSession>[1]),
    );
  });

  // (d.3) Edge: progress.md without `## Sessions` heading throws ---------------
  test("(d3) throws when progress.md is missing the '## Sessions' heading", () => {
    const md = "# Some other doc\n\nNo sessions here.\n";
    expect(() =>
      appendProgressSession(
        md,
        minimalSession({
          title: "Session 1",
          agent: "Bot",
        }),
      ),
    ).toThrow(/## Sessions/);
  });

  // (d.4) Edge: `## Session Template` above must NOT be mistaken for an entry -
  test("(d4) does not confuse '## Session Template' (above ## Sessions) with a session entry", () => {
    // Mirror the real shipped progress.md layout: Session Template block above
    // the Sessions heading, then an HTML comment marker.
    const md =
      "# Project Progress Log\n\n" +
      "## Session Template\n\n```markdown\n## Session N\n```\n\n" +
      "---\n\n## Sessions\n\n" +
      "<!-- New sessions should be added above this line -->\n";

    const out = appendProgressSession(
      md,
      minimalSession({
        title: "Session 1 - 2026-06-20",
        agent: "Sprint Agent",
      }),
    );

    // The `## Session Template` block above `## Sessions` is preserved intact.
    expect(out).toContain("## Session Template");
    // The new session lands AFTER `## Sessions` (not inside the template).
    const sessionsIdx = out.indexOf("## Sessions\n");
    const newSessionIdx = out.indexOf("## Session 1 - 2026-06-20");
    expect(newSessionIdx).toBeGreaterThan(sessionsIdx);
    // The template block above `## Sessions` is NOT disturbed: it still
    // precedes the `## Sessions` heading.
    const templateIdx = out.indexOf("## Session Template");
    expect(templateIdx).toBeLessThan(sessionsIdx);
  });
});
