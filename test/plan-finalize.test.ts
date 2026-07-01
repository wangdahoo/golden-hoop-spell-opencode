// Unit tests for `src/tools/plan-finalize.ts` (ghs-plan-finalize tool).
//
// Implements Feature s3-feat-008. Covers every acceptance criterion:
//   - AC #1: exports `planFinalizeTool` (hyphenated key 'ghs-plan-finalize').
//   - AC #2: args are `plan_content: string` + `project_dir?: string`
//            (plus the optional `plan_id` / `accepted_with_fail` overrides).
//   - AC #3: execute writes the plan to `.ghs/plans/<YYYY-MM-DD>-<slug>.md`,
//            updates status.json, and returns a success string ending with
//            the 'invoke ghs-sprint' next-step instruction.
//   - AC #4: plan file naming follows the plan_ref convention
//            (`YYYY-MM-DD-<slug>.md`).
//   - AC #5: `bunx tsc --noEmit` passes (verified separately — the suite must
//            compile).
//
// Temp-dir policy matches test/state.test.ts: `mkdtemp` under `os.tmpdir()`
// + `realpathSync` to dodge the macOS `/tmp` → `/private/tmp` symlink surprise.

import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { planFinalizeTool, deriveSlug, detectSuspectedTruncation } from "../src/tools/plan-finalize.ts";
import {
  createInitialPlanStatus,
  writePlanStatus,
  readPlanStatus,
  finalPlansDir,
  type PlanStatus,
} from "../src/lib/state.ts";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** A minimal-but-valid status object used as the baseline for I/O tests. */
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

/** Minimal ToolContext stub — only `worktree` / `directory` are read. */
function ctx(worktree: string) {
  return { worktree, directory: worktree } as never;
}

/** Title + body of a representative plan used across the execute tests.
 * Long enough (trimmed > 1000 chars) to clear the truncation length floor,
 * and free of code fences so the unclosed-fence signal never fires — this
 * keeps the existing happy-path assertions valid under the Phase 3 guard. */
const PLAN_CONTENT = [
  "# Refactor Auth Module",
  "",
  "## Goal",
  "",
  "Unify the three auth code paths behind a single facade so that downstream",
  "callers depend on one stable interface rather than three drifting",
  "implementations. This removes a whole class of bugs where a token-refresh",
  "fix lands in one path but not the other two.",
  "",
  "## Background",
  "",
  "The codebase currently has three authentication code paths that evolved",
  "independently: the legacy session-cookie path, the JWT bearer-token path",
  "added for the mobile API, and the OAuth2 path added for third-party",
  "integrations. Each duplicates token validation, refresh, and revocation",
  "logic with subtle differences that have caused three production incidents",
  "in the last quarter. The duplicated logic also inflates review burden and",
  "slows down security audits because every change must be applied three",
  "times and verified three times.",
  "",
  "## Phases",
  "",
  "1. Extract a common AuthSession interface that all three paths can",
  "implement. The interface owns token validation, refresh, and revocation",
  "and exposes a single authenticate(request) entry point.",
  "2. Migrate each caller to depend on the interface, not the concrete path.",
  "This is the highest-risk phase and will be done behind feature flags so",
  "we can roll back per route if a regression appears.",
  "3. Delete the legacy paths once all callers route through the facade and",
  "the legacy code has been dark for a full release cycle with no traffic.",
  "",
  "## Non-goals",
  "",
  "- Changing the wire format of any existing token.",
  "- Adding new authentication providers.",
  "- Rewriting the permission or authorization system.",
  "",
  "## Risks",
  "",
  "The migration touches every authenticated endpoint. We mitigate by rolling",
  "out behind feature flags, running shadow traffic through the new facade",
  "for a week before cutting over, and keeping the legacy paths reachable",
  "for a fast rollback.",
].join("\n");

/** Build a plan body well above the FINALIZE_MIN_PLAN_LENGTH (1000) floor,
 * titled with the given H1, and free of code fences. Used by tests that need
 * a valid (non-truncated) payload with a specific slug. */
function longPlan(title: string): string {
  const pad = (
    "This plan body is intentionally long enough to clear the truncation " +
    "length floor enforced by ghs-plan-finalize. "
  ).repeat(16);
  return `# ${title}\n\n${pad}\n`;
}

// -----------------------------------------------------------------------------
// deriveSlug — pure unit tests
// -----------------------------------------------------------------------------

describe("deriveSlug", () => {
  test("derives a slug from a Markdown H1 title", () => {
    expect(deriveSlug("# Refactor Auth Module\nbody")).toBe("refactor-auth-module");
  });

  test("strips leading hashes from deeper heading levels", () => {
    expect(deriveSlug("## Section Title\n")).toBe("section-title");
  });

  test("skips blank lines and frontmatter delimiter to reach the title", () => {
    expect(deriveSlug("\n---\n# Real Title\n")).toBe("real-title");
  });

  test("falls back to the first non-empty line when there is no heading", () => {
    expect(deriveSlug("Some Plain Title Line\nbody")).toBe("some-plain-title-line");
  });

  test("lowercases and hyphenates internal whitespace", () => {
    expect(deriveSlug("#  Mixed   CASE  Title\n")).toBe("mixed-case-title");
  });

  test("drops non [a-z0-9-] characters", () => {
    // "Plan v2.0: The Re-Write!?" → lowercase → "plan v2.0: the re-write!?"
    // → spaces to hyphens → "plan-v2.0:-the-re-write!?" → strip non
    // [a-z0-9-] (drops '.', ':', '!') → "plan-v20-the-re-write".
    expect(deriveSlug("# Plan v2.0: The Re-Write!?\n")).toBe("plan-v20-the-re-write");
  });

  test("returns 'plan' when the content yields no usable characters", () => {
    expect(deriveSlug("# !!! ???\n")).toBe("plan");
    expect(deriveSlug("")).toBe("plan");
    expect(deriveSlug("   \n\t  ")).toBe("plan");
  });

  test("truncates long titles on a hyphen boundary", () => {
    const longWord = "a".repeat(80);
    const slug = deriveSlug(`# ${longWord} more`);
    // The single 80-char word has no internal hyphen, so truncation lands at
    // MAX_SLUG_LENGTH and the trailing trim removes nothing.
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug).toBe("a".repeat(60));
  });

  test("truncates multi-word titles on a hyphen boundary (no half words)", () => {
    const words = Array.from({ length: 20 }, (_, i) => `word${i}`).join(" ");
    const slug = deriveSlug(`# ${words}`);
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith("-")).toBe(false);
    // Every surviving segment is a whole word (wordN form).
    for (const segment of slug.split("-")) {
      expect(segment).toMatch(/^word\d+$/);
    }
  });
});

// -----------------------------------------------------------------------------
// planFinalizeTool — structure
// -----------------------------------------------------------------------------

describe("planFinalizeTool structure", () => {
  test("is exported and has a description", () => {
    expect(typeof planFinalizeTool).toBe("object");
    expect(typeof planFinalizeTool.description).toBe("string");
    expect(planFinalizeTool.description.length).toBeGreaterThan(0);
  });

  test("exposes plan_content (required) and project_dir (optional) args", () => {
    // The opencode plugin SDK surfaces args on the tool definition. We assert
    // shape rather than exact internal representation so this test doesn't
    // break if the SDK changes its arg storage key.
    const args = (planFinalizeTool as unknown as { args: Record<string, unknown> }).args;
    expect(args).toBeTruthy();
    expect(args.plan_content).toBeTruthy();
    expect(args.project_dir).toBeTruthy();
    // Optional overrides also present.
    expect(args.plan_id).toBeTruthy();
    expect(args.accepted_with_fail).toBeTruthy();
  });
});

// -----------------------------------------------------------------------------
// planFinalizeTool.execute — I/O behaviour
// -----------------------------------------------------------------------------

describe("planFinalizeTool.execute", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = realpathSync(await mkdtemp(join(tmpdir(), "ghs-plan-finalize-")));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("writes the plan to <projectDir>/.ghs/plans/<YYYY-MM-DD>-<slug>.md", async () => {
    // Freeze the date so the expected file name is deterministic. We pass the
    // plan content with an H1 so the slug is stable across runs.
    const result = await planFinalizeTool.execute(
      { plan_content: PLAN_CONTENT, project_dir: tempRoot },
      ctx(tempRoot),
    );

    // The slug for "# Refactor Auth Module" is "refactor-auth-module". The
    // date prefix is today's local date; we verify the shape rather than the
    // exact date to stay timezone-independent.
    const plansDir = join(tempRoot, ".ghs", "plans");
    const written = (await import("node:fs/promises")).readdir(plansDir);
    const files = await written;
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}-refactor-auth-module\.md$/);

    // The file content is the plan content verbatim — no metadata prepended.
    const file = Bun.file(join(plansDir, files[0]!));
    expect(await file.text()).toBe(PLAN_CONTENT);

    // Result string announces success + the next-step instruction.
    expect(result).toContain("=== ghs-plan-finalize complete ===");
    expect(result).toContain("invoke ghs-sprint to break this plan into features.");
  });

  test("creates .ghs/plans/ when it does not already exist", async () => {
    // tempRoot is brand-new — no .ghs/ tree at all.
    await planFinalizeTool.execute(
      { plan_content: PLAN_CONTENT, project_dir: tempRoot },
      ctx(tempRoot),
    );
    const plansDir = join(tempRoot, ".ghs", "plans");
    const stat = await Bun.file(join(plansDir, "marker")).exists().catch(() => false);
    // The directory exists if we can stat it (use readdir as the existence probe).
    const { readdir } = await import("node:fs/promises");
    await expect(readdir(plansDir)).resolves.toBeDefined();
    expect(stat).toBe(false); // sanity: we didn't accidentally create files
  });

  test("reports 'no status.json found' when the plan id has no state file", async () => {
    // No status.json seeded — finalising a hand-authored plan is a legitimate
    // path. The result should say so rather than failing.
    const result = await planFinalizeTool.execute(
      { plan_content: PLAN_CONTENT, project_dir: tempRoot },
      ctx(tempRoot),
    );
    expect(result).toContain("no status.json found for this plan id");
  });

  test("flips an existing status.json to approved when plan_id matches", async () => {
    // Seed a status file with the SAME plan_id the tool will derive
    // (today's date + the slug). Because the slug is derived from the plan
    // content, we mirror that derivation here to stay in sync.
    const slug = deriveSlug(PLAN_CONTENT);
    const today = (() => {
      const n = new Date();
      const y = n.getFullYear();
      const m = String(n.getMonth() + 1).padStart(2, "0");
      const d = String(n.getDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    })();
    const planId = `${today}-${slug}`;
    const status = baselineStatus({ plan_id: planId });
    await writePlanStatus(tempRoot, status);

    const result = await planFinalizeTool.execute(
      { plan_content: PLAN_CONTENT, project_dir: tempRoot },
      ctx(tempRoot),
    );

    expect(result).toContain("status: approved");
    expect(result).not.toContain("no status.json found");

    // The persisted status is now approved.
    const after = await readPlanStatus(tempRoot, planId);
    expect(after?.status).toBe("approved");
    expect(after?.accepted_with_fail).toBe(false);
    // updated_at advanced; created_at preserved.
    expect(after?.created_at).toBe(status.created_at);
  });

  test("honours an explicit plan_id arg to locate the status file", async () => {
    // Seed a status file under a custom plan_id that does NOT match the
    // derived id — the caller must be able to point at it explicitly.
    const customPlanId = "2025-01-01-legacy-plan";
    const status = baselineStatus({ plan_id: customPlanId });
    await writePlanStatus(tempRoot, status);

    const result = await planFinalizeTool.execute(
      {
        plan_content: PLAN_CONTENT,
        project_dir: tempRoot,
        plan_id: customPlanId,
      },
      ctx(tempRoot),
    );

    expect(result).toContain("status: approved");
    const after = await readPlanStatus(tempRoot, customPlanId);
    expect(after?.status).toBe("approved");
  });

  test("sets accepted_with_fail=true when the arg is passed", async () => {
    const slug = deriveSlug(PLAN_CONTENT);
    const today = (() => {
      const n = new Date();
      const y = n.getFullYear();
      const m = String(n.getMonth() + 1).padStart(2, "0");
      const d = String(n.getDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    })();
    const planId = `${today}-${slug}`;
    await writePlanStatus(tempRoot, baselineStatus({ plan_id: planId }));

    const result = await planFinalizeTool.execute(
      {
        plan_content: PLAN_CONTENT,
        project_dir: tempRoot,
        accepted_with_fail: true,
      },
      ctx(tempRoot),
    );

    expect(result).toContain("accepted_with_fail=true");
    const after = await readPlanStatus(tempRoot, planId);
    expect(after?.accepted_with_fail).toBe(true);
    expect(after?.status).toBe("approved");
  });

  test("plan file naming matches the plan_ref convention (YYYY-MM-DD-<slug>.md)", async () => {
    await planFinalizeTool.execute(
      { plan_content: longPlan("My Cool Plan"), project_dir: tempRoot },
      ctx(tempRoot),
    );
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(join(tempRoot, ".ghs", "plans"));
    // Matches the exact convention used by .ghs/plans/*.md plan_ref values
    // (e.g. this sprint's own plan_ref "2026-06-20-opencode-port.md").
    expect(files[0]).toMatch(
      /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(-[a-z0-9]+)*\.md$/,
    );
  });

  test("uses ctx.worktree when project_dir is omitted", async () => {
    // project_dir omitted — the tool should fall back to the context's worktree.
    const result = await planFinalizeTool.execute(
      { plan_content: PLAN_CONTENT },
      ctx(tempRoot),
    );
    expect(result).toContain(`Project directory: ${tempRoot}`);
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(join(tempRoot, ".ghs", "plans"));
    expect(files).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // Phase 3 guard + docs dual-write (Feature s2-feat-003)
  // ---------------------------------------------------------------------------

  test("REJECTED on unclosed code fence — no file written, status unchanged", async () => {
    // Seed a non-terminal status so we can assert it was NOT flipped.
    const slug = deriveSlug(PLAN_CONTENT);
    const today = (() => {
      const n = new Date();
      const y = n.getFullYear();
      const m = String(n.getMonth() + 1).padStart(2, "0");
      const d = String(n.getDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    })();
    const planId = `${today}-${slug}`;
    await writePlanStatus(tempRoot, baselineStatus({ plan_id: planId, status: "pending_approval" }));

    // Odd number of fences (one opening, no closing) + length over the floor
    // so the ONLY trigger is the unclosed-fence signal.
    const truncated = PLAN_CONTENT + "\n\n```ts\nconst x = 1;\n";
    const result = await planFinalizeTool.execute(
      { plan_content: truncated, project_dir: tempRoot },
      ctx(tempRoot),
    );

    // REJECTED body.
    expect(result).toContain("=== ghs-plan-finalize REJECTED (suspected truncation) ===");
    expect(result).toContain("未写盘、status 未变");
    // Recovery instruction.
    expect(result).toContain("ghs-plan-finalize");

    // No plan file was written to .ghs/plans/.
    const { readdir } = await import("node:fs/promises");
    const ghsFiles = await readdir(join(tempRoot, ".ghs", "plans")).catch(() => []);
    // Only the status.json should be present (seeded by us), no .md artefact.
    expect(ghsFiles.some((f) => f.endsWith(".md"))).toBe(false);

    // No docs mirror either.
    const docsFiles = await readdir(finalPlansDir(tempRoot)).catch(() => []);
    expect(docsFiles).toHaveLength(0);

    // status.json still pending_approval (unchanged).
    const after = await readPlanStatus(tempRoot, planId);
    expect(after?.status).toBe("pending_approval");
  });

  test("even fences + length >= 1000 passes the guard and dual-writes", async () => {
    // A legal plan that ENDS with a properly closed code block — two fences
    // (even) — must NOT be falsely rejected by the guard.
    const content =
      longPlan("Closed Fence Plan") +
      "\n```ts\nconst answer = 42;\n```\n";
    // Sanity: the content really is over the floor and has even fences.
    expect(detectSuspectedTruncation(content)).toBe(false);

    const result = await planFinalizeTool.execute(
      { plan_content: content, project_dir: tempRoot },
      ctx(tempRoot),
    );

    expect(result).toContain("=== ghs-plan-finalize complete ===");
    // Both locations written.
    expect(result).toContain("Mirrored to:");
    const { readdir } = await import("node:fs/promises");
    const ghsFiles = (await readdir(join(tempRoot, ".ghs", "plans"))).filter((f) =>
      f.endsWith(".md"),
    );
    const docsFiles = await readdir(finalPlansDir(tempRoot));
    expect(ghsFiles).toHaveLength(1);
    expect(docsFiles).toHaveLength(1);
    // Same file name in both trees.
    expect(docsFiles[0]).toBe(ghsFiles[0]);
  });

  test("legal plan writes byte-for-byte to both .ghs and docs mirrors", async () => {
    const result = await planFinalizeTool.execute(
      { plan_content: PLAN_CONTENT, project_dir: tempRoot },
      ctx(tempRoot),
    );

    expect(result).toContain("=== ghs-plan-finalize complete ===");
    expect(result).toContain("Mirrored to:");

    const { readdir } = await import("node:fs/promises");
    const ghsFiles = (await readdir(join(tempRoot, ".ghs", "plans"))).filter((f) =>
      f.endsWith(".md"),
    );
    const docsFiles = await readdir(finalPlansDir(tempRoot));
    expect(ghsFiles).toHaveLength(1);
    expect(docsFiles).toHaveLength(1);
    expect(docsFiles[0]).toBe(ghsFiles[0]);

    // Byte-for-byte equality between the two mirrors AND with the input.
    const ghsText = await Bun.file(join(tempRoot, ".ghs", "plans", ghsFiles[0]!)).text();
    const docsText = await Bun.file(join(finalPlansDir(tempRoot), docsFiles[0]!)).text();
    expect(ghsText).toBe(PLAN_CONTENT);
    expect(docsText).toBe(PLAN_CONTENT);
    expect(ghsText).toBe(docsText);
  });

  test("legal plan with matching status.json flips to approved", async () => {
    const slug = deriveSlug(PLAN_CONTENT);
    const today = (() => {
      const n = new Date();
      const y = n.getFullYear();
      const m = String(n.getMonth() + 1).padStart(2, "0");
      const d = String(n.getDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    })();
    const planId = `${today}-${slug}`;
    await writePlanStatus(tempRoot, baselineStatus({ plan_id: planId, status: "pending_approval" }));

    const result = await planFinalizeTool.execute(
      { plan_content: PLAN_CONTENT, project_dir: tempRoot },
      ctx(tempRoot),
    );

    expect(result).toContain("status: approved");
    expect(result).toContain("Mirrored to:");
    const after = await readPlanStatus(tempRoot, planId);
    expect(after?.status).toBe("approved");
  });

  // -------------------------------------------------------------------------
  // Commit instruction for the committable docs mirror (regression: the
  // approved plan used to sit uncommitted in the working tree because no
  // ghs tool or prompt told the AI to `git commit` it).
  // -------------------------------------------------------------------------

  test("success body instructs committing the docs mirror to git", async () => {
    const result = await planFinalizeTool.execute(
      { plan_content: PLAN_CONTENT, project_dir: tempRoot },
      ctx(tempRoot),
    );

    expect(result).toContain("=== ghs-plan-finalize complete ===");
    // The commit instruction points at the committable docs mirror (relative
    // path, forward slashes for cross-OS git compatibility).
    expect(result).toContain("git add docs/ghs/plans/");
    expect(result).toContain("git commit");
    // Message format: docs(plan): <title derived from the plan H1>.
    expect(result).toContain("docs(plan): Refactor Auth Module");
  });

  test("commit instruction omitted when the docs mirror failed to write", async () => {
    // Block the docs tree so the mirror write fails.
    await writeFile(join(tempRoot, "docs"), "i am a file not a dir");

    const result = await planFinalizeTool.execute(
      { plan_content: PLAN_CONTENT, project_dir: tempRoot },
      ctx(tempRoot),
    );

    expect(result).toContain("Failed to mirror plan to docs/ghs/plans/");
    // Nothing committable was produced → no commit instruction.
    expect(result).not.toContain("git commit");
  });

  test("docs mirror failure degrades gracefully — .ghs written + warning + approved", async () => {
    // Block the docs tree by creating a regular FILE at `docs` so mkdir of
    // `docs/ghs/plans` fails with ENOTDIR. The .ghs write + status flip must
    // still succeed, with a warning appended to the result.
    await writeFile(join(tempRoot, "docs"), "i am a file not a dir");

    const slug = deriveSlug(PLAN_CONTENT);
    const today = (() => {
      const n = new Date();
      const y = n.getFullYear();
      const m = String(n.getMonth() + 1).padStart(2, "0");
      const d = String(n.getDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    })();
    const planId = `${today}-${slug}`;
    await writePlanStatus(tempRoot, baselineStatus({ plan_id: planId, status: "pending_approval" }));

    const result = await planFinalizeTool.execute(
      { plan_content: PLAN_CONTENT, project_dir: tempRoot },
      ctx(tempRoot),
    );

    // .ghs artefact written.
    const { readdir } = await import("node:fs/promises");
    const ghsFiles = (await readdir(join(tempRoot, ".ghs", "plans"))).filter((f) =>
      f.endsWith(".md"),
    );
    expect(ghsFiles).toHaveLength(1);
    expect(await Bun.file(join(tempRoot, ".ghs", "plans", ghsFiles[0]!)).text()).toBe(
      PLAN_CONTENT,
    );
    // Status still flipped to approved.
    expect(result).toContain("status: approved");
    const after = await readPlanStatus(tempRoot, planId);
    expect(after?.status).toBe("approved");
    // Warning present, no "Mirrored to:" success line.
    expect(result).toContain("Failed to mirror plan to docs/ghs/plans/");
    expect(result).not.toContain("Mirrored to:");
  });

  test("REJECTED body contains ghs-plan-finalize title and 未写盘 note", async () => {
    // Too-short content triggers the length-floor signal.
    const result = await planFinalizeTool.execute(
      { plan_content: "# Too Short\n", project_dir: tempRoot },
      ctx(tempRoot),
    );
    expect(result).toContain("ghs-plan-finalize REJECTED");
    expect(result).toContain("未写盘、status 未变");
    // finalize-specific recovery instruction.
    expect(result).toContain("重新调用 ghs-plan-finalize");
  });
});

// -----------------------------------------------------------------------------
// detectSuspectedTruncation — pure unit tests (Feature s2-feat-003)
// -----------------------------------------------------------------------------

describe("detectSuspectedTruncation", () => {
  test("odd fences (unclosed) -> true even when length is over the floor", () => {
    const long = "x".repeat(1200);
    // One opening fence, no closing fence.
    expect(detectSuspectedTruncation(long + "\n```ts\ncode\n")).toBe(true);
  });

  test("even fences (properly closed) + length >= 1000 -> false", () => {
    const long = "x".repeat(1200);
    expect(detectSuspectedTruncation(long + "\n```ts\ncode\n```\n")).toBe(false);
  });

  test("zero fences + length >= 1000 -> false", () => {
    expect(detectSuspectedTruncation("y".repeat(1000))).toBe(false);
  });

  test("length < 1000 (trimmed) -> true", () => {
    expect(detectSuspectedTruncation("short")).toBe(true);
    // Whitespace-only padding must not fool the trim.
    expect(detectSuspectedTruncation("   \n\t  ")).toBe(true);
  });

  test("length exactly 1000 (trimmed) -> false (boundary)", () => {
    expect(detectSuspectedTruncation("a".repeat(1000))).toBe(false);
  });

  test("three fences (odd) -> true", () => {
    const long = "x".repeat(1200);
    // Two blocks opened+closed (4 fences) plus one dangling opener = 5... use 3.
    expect(detectSuspectedTruncation("```\n```\n```\n" + long)).toBe(true);
  });

  test("a closing fence with leading whitespace still counts", () => {
    // The regex `^\s*```/gm` tolerates indented fences.
    const long = "x".repeat(1200);
    // 2 indented fences = even.
    expect(detectSuspectedTruncation(long + "\n  ```\n  code\n  ```\n")).toBe(false);
  });
});
