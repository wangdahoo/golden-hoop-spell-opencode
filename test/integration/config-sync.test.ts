// Integration test: R3 ghs-config agent model sync.
//
// Feature s3-feat-010 acceptance criterion #3: `test/integration/config-sync.test.ts`
// exists and covers the 5 R3 sub-cases (plan §3.5 config-sync spec):
//   (a) After ghs-init-equivalent seeding, `.ghs/ghs.json` and the 3 rendered
//       `.opencode/agents/ghs-*.md` all exist and carry the default model IDs.
//   (b) After editing `models.context` in `.ghs/ghs.json` and calling
//       `ghs-config`, `ghs-context-haiku.md`'s `model` field updates.
//   (c) When `.ghs/ghs.json` is missing, `ghs-config` falls back to plugin
//       defaults (but the tool layer gates on `.ghs/ghs.json` presence and
//       refuses — so here we assert the gate message; the default-fallback
//       behaviour itself is covered by config.ts unit tests).
//   (d) When `.ghs/ghs.json` is malformed JSON, `ghs-config` returns an error
//       and does NOT write any files.
//   (e) `dry_run: true` renders a preview without writing files.
//
// R3 (plan §1.3 / §3.4 D1/D2/D6 / §3.5) is the "model IDs are user-configurable"
// requirement: users edit `.ghs/ghs.json`, invoke `ghs-config`, then restart
// OpenCode. The tool renders the 3 agent markdown files (from the real
// `shared/agents/*.md.template` templates shipped by s3-feat-001) into
// `.opencode/agents/`, substituting the `__GHS_MODEL_*__` placeholders.
//
// This test exercises the real `configTool.execute` (which reads templates
// from the real plugin root via `pluginRoot()`), against a temp project dir,
// so it validates the end-to-end R3 path including s3-feat-001's real agent
// templates (NOT the test/fixtures stubs — that distinction is what s3-feat-010
// depends on per its technical_notes).

import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { configTool } from "../../src/tools/config";
import { makeTempDir, mockToolContext } from "./_helpers";

/** Default model IDs copied verbatim from `shared/ghs.default.json`. */
const DEFAULT_MODELS = {
  context: "zai-coding-plan/glm-4.5-air",
  designer: "zhipuai-coding-plan/glm-4.6",
  reviewer: "zhipuai-coding-plan/glm-4.6",
} as const;

/** The three agent names config.ts renders. */
const AGENT_NAMES = [
  "ghs-context-haiku",
  "ghs-plan-designer",
  "ghs-plan-reviewer",
] as const;

/** Path to a rendered agent markdown inside a project dir. */
function agentPath(projectDir: string, name: string): string {
  return join(projectDir, ".opencode", "agents", `${name}.md`);
}

/** Write a `.ghs/ghs.json` with the given raw content. Creates `.ghs/` if needed. */
async function writeGhsJson(projectDir: string, raw: string): Promise<void> {
  await mkdir(join(projectDir, ".ghs"), { recursive: true });
  await writeFile(join(projectDir, ".ghs", "ghs.json"), raw);
}

describe("integration: ghs-config agent model sync (R3)", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await makeTempDir("ghs-int-cfg-");
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  // (a) -------------------------------------------------------------------
  test("(a) default ghs.json → 3 agent markdowns exist with default model IDs", async () => {
    // Seed a default-shape ghs.json (what ghs-init would write).
    await writeGhsJson(projectDir, JSON.stringify({ models: DEFAULT_MODELS }));

    const result = await configTool.execute(
      { project_dir: projectDir },
      mockToolContext(projectDir),
    );

    expect(result).toContain("Agent markdown files synced");
    expect(result).toContain("Defaults used: no");

    // All 3 files exist and carry their default model in the frontmatter.
    for (const name of AGENT_NAMES) {
      const path = agentPath(projectDir, name);
      expect(existsSync(path)).toBe(true);
      const body = await Bun.file(path).text();
      const expected =
        name === "ghs-context-haiku"
          ? DEFAULT_MODELS.context
          : name === "ghs-plan-designer"
            ? DEFAULT_MODELS.designer
            : DEFAULT_MODELS.reviewer;
      expect(body).toContain(`model: ${expected}`);
      // No raw placeholder may survive the render.
      expect(body).not.toContain("__GHS_MODEL_");
    }
  });

  // (b) -------------------------------------------------------------------
  test("(b) editing models.context then re-running ghs-config updates ghs-context-haiku.md", async () => {
    await writeGhsJson(projectDir, JSON.stringify({ models: DEFAULT_MODELS }));
    await configTool.execute(
      { project_dir: projectDir },
      mockToolContext(projectDir),
    );

    // User customises ONLY the context model.
    const customContext = "anthropic/claude-haiku-4-5";
    await writeGhsJson(
      projectDir,
      JSON.stringify({
        models: { ...DEFAULT_MODELS, context: customContext },
      }),
    );

    const result = await configTool.execute(
      { project_dir: projectDir },
      mockToolContext(projectDir),
    );
    expect(result).toContain(customContext);

    // The context agent's model field updated.
    const ctxBody = await Bun.file(
      agentPath(projectDir, "ghs-context-haiku"),
    ).text();
    expect(ctxBody).toContain(`model: ${customContext}`);
    expect(ctxBody).not.toContain(DEFAULT_MODELS.context);

    // The other two agents are untouched (still default).
    const designerBody = await Bun.file(
      agentPath(projectDir, "ghs-plan-designer"),
    ).text();
    expect(designerBody).toContain(`model: ${DEFAULT_MODELS.designer}`);
    const reviewerBody = await Bun.file(
      agentPath(projectDir, "ghs-plan-reviewer"),
    ).text();
    expect(reviewerBody).toContain(`model: ${DEFAULT_MODELS.reviewer}`);
  });

  // (c) -------------------------------------------------------------------
  test("(c) .ghs/ghs.json missing → ghs-config refuses with the init hint (tool-layer gate)", async () => {
    // No `.ghs/ghs.json` written — the tool must gate and refuse.
    expect(existsSync(join(projectDir, ".ghs", "ghs.json"))).toBe(false);

    const result = await configTool.execute(
      { project_dir: projectDir },
      mockToolContext(projectDir),
    );

    // The config tool gates on `.ghs/ghs.json` presence (it returns the
    // "Run ghs-init first." message rather than proceeding). This is the
    // tool-layer contract; the library-level default fallback (loadGhsConfig)
    // is covered separately by test/config.test.ts case (b).
    expect(result).toContain("ghs-init");

    // No files were written.
    expect(existsSync(join(projectDir, ".opencode"))).toBe(false);
  });

  // (d) -------------------------------------------------------------------
  test("(d) malformed .ghs/ghs.json → error returned, no files written", async () => {
    // Pre-create `.opencode/agents/` with a sentinel file so we can prove the
    // malformed-config path did NOT touch the dir (no new writes, no deletes).
    const agentsDir = join(projectDir, ".opencode", "agents");
    await mkdir(agentsDir, { recursive: true });
    const sentinel = join(agentsDir, "sentinel.md");
    await writeFile(sentinel, "pre-existing");

    await writeGhsJson(projectDir, "{ this is not valid json }");

    const result = await configTool.execute(
      { project_dir: projectDir },
      mockToolContext(projectDir),
    );

    // Error surfaced, with the parse-failure marker.
    expect(result).toContain("Failed to load ghs config");
    expect(result).toContain("No files were written");

    // The pre-existing sentinel survived (no agent markdowns were written,
    // and the dir was not wiped).
    expect(existsSync(sentinel)).toBe(true);
    for (const name of AGENT_NAMES) {
      expect(existsSync(agentPath(projectDir, name))).toBe(false);
    }
  });

  // (e) -------------------------------------------------------------------
  test("(e) dry_run=true → preview rendered, no files written", async () => {
    await writeGhsJson(projectDir, JSON.stringify({ models: DEFAULT_MODELS }));

    const result = await configTool.execute(
      { project_dir: projectDir, dry_run: true },
      mockToolContext(projectDir),
    );

    // Dry-run banner + resolved model IDs in the preview.
    expect(result).toContain("Dry run");
    expect(result).toContain("no files will be written");
    expect(result).toContain(DEFAULT_MODELS.context);
    expect(result).toContain(DEFAULT_MODELS.designer);
    expect(result).toContain(DEFAULT_MODELS.reviewer);

    // Nothing was actually written — `.opencode/` must not exist.
    expect(existsSync(join(projectDir, ".opencode"))).toBe(false);
  });
});
