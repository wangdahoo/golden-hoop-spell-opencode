// Integration test: R1 codegraph runtime path selection.
//
// Feature s3-feat-010 acceptance criterion #2: `test/integration/codegraph-paths.test.ts`
// exists and covers both the codegraph-available and codegraph-absent paths.
//
// R1 (plan §1.3 / §3.4 D3 / §3.5) says `ghs-plan-start` probes `.codegraph/`
// at runtime and selects the context-collection prompt accordingly:
//   - `.codegraph/` present → `CONTEXT_CODEGRAPH_PROMPT` (graph-aware)
//   - `.codegraph/` absent  → `CONTEXT_GREP_PROMPT` (grep fallback)
//
// This test drives both branches end-to-end by invoking the real
// `planStartTool.execute` against two temp project dirs (one with
// `.codegraph/`, one without) and asserting:
//   - the status.json records the correct `codegraph_available` value
//   - the dispatch directive embeds the matching context prompt
//   - the codegraph-aware prompt references codegraph tooling
//   - the grep prompt references the grep fallback
//
// It also asserts the plan dispatcher's downstream branch — `ghs-plan-review`
// in snapshot mode — preserves the `codegraph_available` flag on the status
// it rewrites (so the path chosen at start is sticky for the whole plan).

import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { planStartTool } from "../../src/tools/plan-start";
import { planReviewTool, findActivePlanStatus } from "../../src/tools/plan-review";
import { plansDir } from "../../src/lib/state";
import { CONTEXT_CODEGRAPH_PROMPT } from "../../src/prompts/context-codegraph";
import { CONTEXT_GREP_PROMPT } from "../../src/prompts/context-grep";
import {
  makeTempDir,
  mockToolContext,
  longBody,
  snapshotBlob,
} from "./_helpers";

describe("integration: codegraph runtime path selection (R1)", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await makeTempDir("ghs-int-cg-");
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  test("codegraph-available path: .codegraph/ present → codegraph prompt + status flag true", async () => {
    // Materialise `.codegraph/` so detectCodegraph() returns true.
    await mkdir(join(projectDir, ".codegraph"), { recursive: true });
    expect(existsSync(join(projectDir, ".codegraph"))).toBe(true);

    const result = await planStartTool.execute({}, mockToolContext(projectDir));

    // Dispatch directive advertises the codegraph path.
    expect(result).toContain("codegraph (.codegraph/ detected)");
    // The codegraph prompt is embedded verbatim.
    expect(result).toContain(CONTEXT_CODEGRAPH_PROMPT);
    // The grep prompt must NOT leak into the codegraph branch.
    expect(result).not.toContain(CONTEXT_GREP_PROMPT);

    // status.json recorded codegraph_available=true.
    // plan-start derives plan_id from today's date + slug "plan".
    const status = await findActivePlanStatus(projectDir);
    expect(status).not.toBeNull();
    expect(status!.codegraph_available).toBe(true);
    expect(status!.round).toBe(1);
    expect(status!.status).toBe("designing");
  });

  test("codegraph-absent path: no .codegraph/ → grep fallback prompt + status flag false", async () => {
    // Deliberately do NOT create `.codegraph/`.
    expect(existsSync(join(projectDir, ".codegraph"))).toBe(false);

    const result = await planStartTool.execute({}, mockToolContext(projectDir));

    // Dispatch directive advertises the grep fallback.
    expect(result).toContain("grep fallback (.codegraph/ absent)");
    // The grep prompt is embedded verbatim.
    expect(result).toContain(CONTEXT_GREP_PROMPT);
    // The codegraph prompt must NOT leak into the grep branch.
    expect(result).not.toContain(CONTEXT_CODEGRAPH_PROMPT);

    // status.json recorded codegraph_available=false.
    const status = await findActivePlanStatus(projectDir);
    expect(status).not.toBeNull();
    expect(status!.codegraph_available).toBe(false);
  });

  test("stray .codegraph file (not directory) → grep fallback (defensive)", async () => {
    // A stray file named `.codegraph` must NOT count as "codegraph initialised".
    // detectCodegraph() checks `stats.isDirectory()`.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(projectDir, ".codegraph"), "not a directory");

    const result = await planStartTool.execute({}, mockToolContext(projectDir));

    expect(result).toContain("grep fallback (.codegraph/ absent)");
    expect(result).not.toContain(CONTEXT_CODEGRAPH_PROMPT);

    const status = await findActivePlanStatus(projectDir);
    expect(status).not.toBeNull();
    expect(status!.codegraph_available).toBe(false);
  });

  test("codegraph_available flag is sticky across the snapshot review step", async () => {
    // Start with codegraph available.
    await mkdir(join(projectDir, ".codegraph"), { recursive: true });
    await planStartTool.execute({}, mockToolContext(projectDir));

    let status = await findActivePlanStatus(projectDir);
    expect(status).not.toBeNull();
    expect(status!.codegraph_available).toBe(true);

    // Simulate the context-explorer subagent returning a snapshot, then feed it
    // to ghs-plan-review(snapshot). The status rewrite must preserve the
    // codegraph_available flag (the path is chosen once at start and sticks
    // for the entire plan lifetime — plan §3.6 / §3.7).
    const snapshot = snapshotBlob(longBody("Arch snapshot via codegraph"));
    const reviewResult = await planReviewTool.execute(
      { snapshot },
      mockToolContext(projectDir),
    );

    // Snapshot mode dispatches the designer (next step).
    expect(reviewResult).toContain("plan-designer");
    // The codegraph path chosen at start is echoed in the snapshot result.
    expect(reviewResult).toContain("Codegraph 路径：codegraph");

    status = await findActivePlanStatus(projectDir);
    expect(status).not.toBeNull();
    expect(status!.codegraph_available).toBe(true);
    // Context artefact persisted.
    const ctxPath = join(plansDir(projectDir), status!.context_file);
    expect(existsSync(ctxPath)).toBe(true);
  });
});
