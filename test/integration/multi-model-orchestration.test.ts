// Integration test: multi-model orchestration (R2/R3 model fan-out).
//
// Feature s5-feat-003 acceptance criteria: `test/integration/multi-model-orchestration.test.ts`
// exists and verifies the 3 plan-dispatcher subagents each read their model
// from `.ghs/ghs.json` via `ghs-config`, which renders into the
// `.opencode/agents/ghs-*.md` frontmatter `model:` field.
//
// `plan-dispatch.test.ts` already asserts model fan-out as one of its sub-cases
// (the "model IDs from ghs.json are respected when customised (R3)" test) and
// `config-sync.test.ts` covers the broader ghs-config → .md sync flow. This
// file is the DEDICATED, more thorough multi-model test: it walks the three
// orchestration scenarios from the acceptance criteria end-to-end —
//
//   1. Default models  — all 3 roles fall back to `shared/ghs.default.json`.
//   2. Custom models   — all 3 roles carry distinct user-supplied model IDs.
//   3. Partial custom  — some roles custom, others fall back to defaults.
//
// — asserting on the `.opencode/agents/ghs-{context-explorer,plan-designer,plan-reviewer}.md`
// frontmatter `model:` field for each role. The dispatcher's per-role model
// selection is driven entirely by these markdown files (the OpenCode Task tool
// reads them at spawn time), so asserting their `model:` field IS asserting
// the multi-model orchestration contract.
//
// Temp-dir isolation via `_helpers.ts` (`makeTempDir`, `mockToolContext`); the
// project's own `.ghs/` and `.opencode/` are never touched.

import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { configTool } from "../../src/tools/config";
import { loadGhsConfig } from "../../src/lib/config";
import { pluginRoot } from "../../src/lib/paths";
import { makeTempDir, mockToolContext } from "./_helpers";

// Default model IDs imported from the real `shared/ghs.default.json` (NOT
// hardcoded — the acceptance criteria explicitly forbid hardcoding). The
// `resolveJsonModule: true` flag in tsconfig.json lets us statically import
// the JSON, which type-checks under `tsc --noEmit` and resolves at runtime
// under bun:test.
import ghsDefaultJson from "../../shared/ghs.default.json";

/**
 * Default model IDs sourced from the real `shared/ghs.default.json`. The
 * config tool renders these into `.opencode/agents/ghs-*.md` whenever a model
 * field is absent or empty in the user's `.ghs/ghs.json`.
 */
const DEFAULT_MODELS = {
  context: ghsDefaultJson.models.context,
  designer: ghsDefaultJson.models.designer,
  reviewer: ghsDefaultJson.models.reviewer,
};

/**
 * The three plan-dispatcher subagent names (R2 fan-out). Each one's
 * `.opencode/agents/<name>.md` carries exactly one model, read by the Task
 * tool at spawn time.
 */
const AGENTS = [
  { name: "ghs-context-explorer", role: "context" as const },
  { name: "ghs-plan-designer", role: "designer" as const },
  { name: "ghs-plan-reviewer", role: "reviewer" as const },
];

/** Path to a rendered agent markdown inside a project dir. */
function agentPath(projectDir: string, name: string): string {
  return join(projectDir, ".opencode", "agents", `${name}.md`);
}

/**
 * Extract the `model:` value from a rendered agent markdown's frontmatter.
 * The templates emit a single `model: <id>` line at the top of the file; we
 * parse it out so the assertion is robust to surrounding whitespace and can
 * distinguish a real match from a substring coincidence (e.g. a model id that
 * happens to appear in prose).
 */
function extractModel(body: string): string {
  const m = body.match(/^model:\s*(.+?)\s*$/m);
  if (!m) throw new Error("No `model:` field found in agent markdown frontmatter");
  return m[1];
}

/** Write a `.ghs/ghs.json` with the given raw content. Creates `.ghs/` if needed. */
async function writeGhsJson(projectDir: string, raw: string): Promise<void> {
  await mkdir(join(projectDir, ".ghs"), { recursive: true });
  await writeFile(join(projectDir, ".ghs", "ghs.json"), raw);
}

describe("integration: multi-model orchestration (R2/R3 model fan-out)", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await makeTempDir("ghs-int-mmo-");
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  // (1) Default models --------------------------------------------------------
  test("(1) default models: all 3 roles fall back to shared/ghs.default.json", async () => {
    // Seed a `.ghs/ghs.json` whose model fields are all empty strings. The
    // tool-layer gate checks for the FILE's presence (not field contents), so
    // an empty-fields file passes the gate; `loadGhsConfig` then falls every
    // empty field back to the plugin default. This is the "empty" branch of
    // acceptance criterion #1.
    //
    // (The "absent file" branch is covered by the loadGhsConfig assertion
    // further below — the tool layer refuses an absent file with "Run ghs-init
    // first." and delegates the actual default fallback to the library, per
    // config-sync.test.ts case (c). Both branches must resolve to the same
    // default model IDs.)
    await writeGhsJson(
      projectDir,
      JSON.stringify({
        models: { context: "", designer: "", reviewer: "" },
      }),
    );

    const result = await configTool.execute(
      { project_dir: projectDir },
      mockToolContext(projectDir),
    );
    expect(result).toContain("Agent markdown files synced");
    // Every field fell back → defaults_used: yes.
    expect(result).toContain("Defaults used: yes");

    // All 3 rendered markdowns carry their default model in the frontmatter,
    // and no raw placeholder survives.
    for (const agent of AGENTS) {
      const path = agentPath(projectDir, agent.name);
      expect(existsSync(path)).toBe(true);
      const body = await Bun.file(path).text();
      expect(extractModel(body)).toBe(DEFAULT_MODELS[agent.role]);
      expect(body).not.toContain("__GHS_MODEL_");
    }

    // Complement the tool-level path with a direct `loadGhsConfig` check for
    // the "absent file" branch: when `.ghs/ghs.json` does not exist at all,
    // the library still resolves all three roles to the defaults and reports
    // `defaults_used: true`. (The tool layer's refusal of an absent file is a
    // UX gate, not a semantic difference — the resolved models are identical.)
    const freshDir = await makeTempDir("ghs-int-mmo-absent-");
    try {
      expect(existsSync(join(freshDir, ".ghs", "ghs.json"))).toBe(false);
      const { config, defaults_used } = await loadGhsConfig(freshDir, pluginRoot());
      expect(defaults_used).toBe(true);
      expect(config.models).toEqual(DEFAULT_MODELS);
    } finally {
      await rm(freshDir, { recursive: true, force: true });
    }
  });

  // (2) Custom models (all 3 distinct) ---------------------------------------
  test("(2) custom models: all 3 roles carry distinct user-supplied model IDs", async () => {
    const custom = {
      context: "anthropic/claude-haiku-4-5",
      designer: "anthropic/claude-sonnet-4-5",
      reviewer: "openai/gpt-5",
    };
    // All three distinct — none must fall back.
    expect(new Set(Object.values(custom)).size).toBe(3);
    await writeGhsJson(projectDir, JSON.stringify({ models: custom }));

    const result = await configTool.execute(
      { project_dir: projectDir },
      mockToolContext(projectDir),
    );
    expect(result).toContain("Agent markdown files synced");
    // Fully specified → no defaults leaked through.
    expect(result).toContain("Defaults used: no");

    // Each rendered markdown's frontmatter `model:` field carries its own
    // custom value — proving the dispatcher's per-role fan-out is driven by
    // user config.
    for (const agent of AGENTS) {
      const body = await Bun.file(agentPath(projectDir, agent.name)).text();
      expect(extractModel(body)).toBe(custom[agent.role]);
    }

    // Sanity: the defaults are NOT present in any file (each role is distinct
    // from its default AND from its siblings).
    for (const agent of AGENTS) {
      const body = await Bun.file(agentPath(projectDir, agent.name)).text();
      expect(body).not.toContain(DEFAULT_MODELS[agent.role]);
    }
  });

  // (3) Partial custom (mixed default fallback) ------------------------------
  test("(3) partial custom: custom roles use user values, empty roles fall back to defaults", async () => {
    // Customize only `designer`; leave `context` and `reviewer` as empty
    // strings so they fall back to the plugin defaults. This exercises the
    // per-field merge (loadGhsConfig's empty-string fallback branch).
    const customDesigner = "anthropic/claude-opus-4-1";
    await writeGhsJson(
      projectDir,
      JSON.stringify({
        models: {
          context: "",
          designer: customDesigner,
          reviewer: "",
        },
      }),
    );

    const result = await configTool.execute(
      { project_dir: projectDir },
      mockToolContext(projectDir),
    );
    expect(result).toContain("Agent markdown files synced");
    // Two of three fields fell back → defaults_used: yes.
    expect(result).toContain("Defaults used: yes");

    // The customized role carries the user value…
    const designerBody = await Bun.file(
      agentPath(projectDir, "ghs-plan-designer"),
    ).text();
    expect(extractModel(designerBody)).toBe(customDesigner);
    expect(designerBody).not.toContain(DEFAULT_MODELS.designer);

    // …while the two empty-string roles fall back to their defaults.
    const contextBody = await Bun.file(
      agentPath(projectDir, "ghs-context-explorer"),
    ).text();
    expect(extractModel(contextBody)).toBe(DEFAULT_MODELS.context);
    expect(contextBody).not.toContain(customDesigner);

    const reviewerBody = await Bun.file(
      agentPath(projectDir, "ghs-plan-reviewer"),
    ).text();
    expect(extractModel(reviewerBody)).toBe(DEFAULT_MODELS.reviewer);
    expect(reviewerBody).not.toContain(customDesigner);
  });
});
