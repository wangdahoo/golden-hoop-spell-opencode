// Unit tests for `src/lib/config.ts`.
//
// Implements Feature s1-feat-013. Covers 10 sub-cases (a through j):
//   (a) loadGhsConfig with complete user config (all 3 model fields set)
//   (b) loadGhsConfig with missing `.ghs/ghs.json` (full default fallback)
//   (c) loadGhsConfig with partial fields (per-field fallback)
//   (d) loadGhsConfig with malformed JSON (throws — assert specific message)
//   (e) loadGhsConfig with unknown top-level field (Zod strict rejects)
//   (f) renderAgentTemplate substitutes all 3 placeholders
//   (g) renderAgentTemplate with no placeholders returns input unchanged
//   (h) syncAgents writes 3 files to correct paths
//   (i) syncAgents auto-creates `.opencode/agents/` if missing
//   (j) render path without write (syncAgents has no dry_run variant —
//       we exercise renderAgentTemplate for all 3 names and verify outputs
//       without invoking Bun.write, per the feature's documented fallback)
//
// Temp-dir policy: Bun 1.3.11 does NOT expose `Bun.mkdtemp`. We use Node's
// `fs.promises.mkdtemp` under `os.tmpdir()` and `realpathSync` the result
// (avoids macOS `/tmp` → `/private/tmp` symlink surprises).
//
// Fixture wiring: `config.ts` reads templates from
// `<pluginRoot>/shared/agents/<name>.md.template` and defaults from
// `<pluginRoot>/shared/ghs.default.json`. The committed stub templates live
// under `test/fixtures/agents/` (one placeholder per template — the native
// agent model). Each test builds a fake `pluginRoot` temp dir that mirrors
// the production layout (default json + agents templates) so config.ts's
// path resolution works against the real fixture set.
//
// Case (f) needs a single template that exercises all three placeholders
// in one render pass. We synthesise an extra template (`ghs-all-three`)
// inside the fake plugin root for that case rather than mutating the
// committed per-agent fixtures (which belong to s1-feat-007).

import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, cp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  loadGhsConfig,
  renderAgentTemplate,
  syncAgents,
  type GhsConfig,
} from "../src/lib/config";
import { ZodError } from "zod";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/** Absolute path to the repo root (where `shared/` + `test/fixtures/` live). */
const REPO_ROOT = resolve(import.meta.dir, "..");

/** Absolute path to the committed fixture template set. */
const FIXTURE_AGENTS_DIR = join(REPO_ROOT, "test", "fixtures", "agents");

/** Absolute path to the canonical default config shipped with the plugin. */
const DEFAULT_CONFIG_SRC = join(REPO_ROOT, "shared", "ghs.default.json");

/** The default model IDs copied verbatim from `shared/ghs.default.json`. */
const DEFAULT_MODELS = {
  context: "zhipuai-coding-plan/glm-4.5-air",
  designer: "zhipuai-coding-plan/glm-4.6",
  reviewer: "zhipuai-coding-plan/glm-4.6",
} as const;

/** The three agent names config.ts knows how to render. */
const AGENT_NAMES = [
  "ghs-context-haiku",
  "ghs-plan-designer",
  "ghs-plan-reviewer",
] as const;

/**
 * Map from agent name → the placeholder its committed fixture template
 * natively contains. Each fixture has exactly one placeholder, so the
 * substitution contract per agent is verifiable against the real fixture
 * set without mutating it.
 */
const NATIVE_PLACEHOLDER: Record<string, string> = {
  "ghs-context-haiku": "__GHS_MODEL_CONTEXT__",
  "ghs-plan-designer": "__GHS_MODEL_DESIGNER__",
  "ghs-plan-reviewer": "__GHS_MODEL_REVIEWER__",
};

/**
 * Map from agent name → the config.models key whose value is expected to
 * appear in that agent's rendered body (because the fixture references the
 * matching placeholder).
 */
const NATIVE_MODEL_KEY: Record<string, keyof GhsConfig["models"]> = {
  "ghs-context-haiku": "context",
  "ghs-plan-designer": "designer",
  "ghs-plan-reviewer": "reviewer",
};

// -----------------------------------------------------------------------------
// Temp-dir / fixture scaffolding
// -----------------------------------------------------------------------------

/**
 * Create a fresh temp directory. Bun 1.3.11 has no `Bun.mkdtemp`, so we lean
 * on `fs.mkdtemp` + `realpathSync`.
 */
async function makeTempDir(prefix: string): Promise<string> {
  const raw = await mkdtemp(join(tmpdir(), prefix));
  return realpathSync(raw);
}

/**
 * Build a fake "plugin root" temp dir containing:
 *   <dir>/shared/ghs.default.json   ← copied from repo's canonical default
 *   <dir>/shared/agents/*.md.template ← copied from test fixtures
 *
 * This lets `config.ts` resolve templates + defaults by the same path
 * conventions it uses in production.
 */
async function makeFakePluginRoot(): Promise<string> {
  const pluginRoot = await makeTempDir("ghs-cfg-pluginroot-");
  const sharedDir = join(pluginRoot, "shared");
  const agentsDir = join(sharedDir, "agents");
  await mkdir(agentsDir, { recursive: true });
  await cp(DEFAULT_CONFIG_SRC, join(sharedDir, "ghs.default.json"));
  for (const name of AGENT_NAMES) {
    await cp(
      join(FIXTURE_AGENTS_DIR, `${name}.md.template`),
      join(agentsDir, `${name}.md.template`),
    );
  }
  return pluginRoot;
}

/** Write a user `.ghs/ghs.json` into a project dir. Creates `.ghs/` if needed. */
async function writeUserConfig(
  projectDir: string,
  raw: string,
): Promise<string> {
  const ghsDir = join(projectDir, ".ghs");
  await mkdir(ghsDir, { recursive: true });
  const path = join(ghsDir, "ghs.json");
  await writeFile(path, raw);
  return path;
}

// -----------------------------------------------------------------------------
// Test suite
// -----------------------------------------------------------------------------

describe("config.ts (s1-feat-013)", () => {
  let projectDir: string;
  let pluginRoot: string;

  beforeEach(async () => {
    projectDir = await makeTempDir("ghs-cfg-project-");
    pluginRoot = await makeFakePluginRoot();
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
    await rm(pluginRoot, { recursive: true, force: true });
  });

  // (a) ---------------------------------------------------------------------
  test("(a) loadGhsConfig with complete user config returns merged config with defaults_used=false", async () => {
    const userModels: GhsConfig["models"] = {
      context: "openai/gpt-5",
      designer: "anthropic/claude-opus-4.1",
      reviewer: "anthropic/claude-sonnet-4.5",
    };
    await writeUserConfig(
      projectDir,
      JSON.stringify({ models: userModels }),
    );

    const { config, defaults_used } = await loadGhsConfig(projectDir, pluginRoot);

    expect(defaults_used).toBe(false);
    expect(config.models).toEqual(userModels);
    // Sanity: none of the resolved fields leaked a default.
    expect(config.models.context).toBe("openai/gpt-5");
    expect(config.models.designer).toBe("anthropic/claude-opus-4.1");
    expect(config.models.reviewer).toBe("anthropic/claude-sonnet-4.5");
  });

  // (b) ---------------------------------------------------------------------
  test("(b) loadGhsConfig with missing .ghs/ghs.json returns full defaults with defaults_used=true", async () => {
    // Deliberately do NOT create `.ghs/ghs.json`.
    const { config, defaults_used } = await loadGhsConfig(projectDir, pluginRoot);

    expect(defaults_used).toBe(true);
    expect(config.models).toEqual(DEFAULT_MODELS);
  });

  // (c) ---------------------------------------------------------------------
  test("(c) loadGhsConfig with partial fields falls back per-field with defaults_used=true", async () => {
    // Only `context` is set; `designer` and `reviewer` fall back to defaults.
    // Empty-string fallback is exercised in config.ts's per-field merge;
    // covering both "missing key" and "empty string" forms of partial.
    await writeUserConfig(
      projectDir,
      JSON.stringify({
        models: {
          context: "openai/gpt-5",
          designer: "",
          reviewer: "",
        },
      }),
    );

    const { config, defaults_used } = await loadGhsConfig(projectDir, pluginRoot);

    expect(defaults_used).toBe(true);
    // Set field comes through from the user file.
    expect(config.models.context).toBe("openai/gpt-5");
    // Missing/empty fields fall back to the canonical defaults.
    expect(config.models.designer).toBe(DEFAULT_MODELS.designer);
    expect(config.models.reviewer).toBe(DEFAULT_MODELS.reviewer);
  });

  // (d) ---------------------------------------------------------------------
  test("(d) loadGhsConfig with malformed JSON throws a descriptive parse error", async () => {
    await writeUserConfig(projectDir, "{ this is not valid json }");

    let caught: unknown;
    try {
      await loadGhsConfig(projectDir, pluginRoot);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    // Specific markers from readJsonFile()'s parse-error wrapper.
    expect(msg).toContain("Failed to parse ghs.json");
    expect(msg).toContain("invalid JSON");
    // The underlying SyntaxError detail should be preserved.
    expect(msg.toLowerCase()).toMatch(/json|unexpected|expected/);
  });

  // (e) ---------------------------------------------------------------------
  test("(e) loadGhsConfig with unknown top-level field is rejected by Zod strict mode", async () => {
    // Valid JSON shape but with a typo at the top level (`model` instead of
    // `models`) plus an extra unknown key. Zod .strict() must surface this as
    // an `unrecognized_keys` issue rather than silently dropping the field.
    await writeUserConfig(
      projectDir,
      JSON.stringify({
        models: {
          context: "openai/gpt-5",
          designer: "openai/gpt-5",
          reviewer: "openai/gpt-5",
        },
        // Unknown top-level key — strict schema must reject this.
        typo_field: "should not be allowed",
      }),
    );

    let caught: unknown;
    try {
      await loadGhsConfig(projectDir, pluginRoot);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ZodError);
    const issues = (caught as ZodError).issues;
    // At least one issue must be the `unrecognized_keys` shape with the
    // offending key name surfaced (matches the assertion contract).
    const unrecognized = issues.find(
      (i) => i.code === "unrecognized_keys",
    );
    expect(unrecognized).toBeDefined();
    expect(unrecognized!.keys).toContain("typo_field");
  });

  // (f) ---------------------------------------------------------------------
  test("(f) renderAgentTemplate substitutes all 3 placeholders", async () => {
    // The committed per-agent fixtures each contain exactly one placeholder
    // (their native agent model). To verify all three placeholders substitute
    // in a single render pass we synthesise a template that references all
    // three — this exercises config.ts's three-step replaceAll chain.
    const config: GhsConfig = {
      models: {
        context: "ctx/model-1",
        designer: "des/model-2",
        reviewer: "rev/model-3",
      },
      planner_backend: "ghs-plan-designer",
    };
    const allThreeBody = [
      "---",
      "mode: subagent",
      "model: __GHS_MODEL_CONTEXT__",
      "---",
      "",
      "context=__GHS_MODEL_CONTEXT__",
      "designer=__GHS_MODEL_DESIGNER__",
      "reviewer=__GHS_MODEL_REVIEWER__",
      "",
    ].join("\n");
    const templatePath = join(
      pluginRoot,
      "shared",
      "agents",
      "ghs-all-three.md.template",
    );
    await writeFile(templatePath, allThreeBody);

    const rendered = await renderAgentTemplate("ghs-all-three", config, pluginRoot);

    // All three substituted values must appear.
    expect(rendered).toContain("ctx/model-1");
    expect(rendered).toContain("des/model-2");
    expect(rendered).toContain("rev/model-3");
    // None of the raw placeholders should survive.
    expect(rendered).not.toContain("__GHS_MODEL_CONTEXT__");
    expect(rendered).not.toContain("__GHS_MODEL_DESIGNER__");
    expect(rendered).not.toContain("__GHS_MODEL_REVIEWER__");
  });

  // (g) ---------------------------------------------------------------------
  test("(g) renderAgentTemplate with no placeholders returns input unchanged", async () => {
    // Drop a placeholder-free template into the fake plugin root and render it.
    // `String.replaceAll()` is a no-op on absent targets, so the output must
    // equal the input verbatim.
    const plainBody = "---\nmode: subagent\n---\nNo placeholders here.\n";
    const plainTemplatePath = join(
      pluginRoot,
      "shared",
      "agents",
      "ghs-plain.md.template",
    );
    await writeFile(plainTemplatePath, plainBody);

    const config: GhsConfig = {
      models: {
        context: "ignored/context",
        designer: "ignored/designer",
        reviewer: "ignored/reviewer",
      },
      planner_backend: "ghs-plan-designer",
    };

    const rendered = await renderAgentTemplate("ghs-plain", config, pluginRoot);
    expect(rendered).toBe(plainBody);
  });

  // (h) ---------------------------------------------------------------------
  test("(h) syncAgents writes 3 files to correct paths with correct content", async () => {
    const userModels: GhsConfig["models"] = {
      context: "openai/gpt-5",
      designer: "anthropic/claude-opus-4.1",
      reviewer: "anthropic/claude-sonnet-4.5",
    };
    await writeUserConfig(
      projectDir,
      JSON.stringify({ models: userModels }),
    );

    const result = await syncAgents(projectDir, pluginRoot);

    // Three files reported, one per known agent name.
    expect(result.written).toHaveLength(3);
    expect(result.defaults_used).toBe(false);
    expect(result.models).toEqual(userModels);

    // Each file must exist on disk at the expected path, with placeholders
    // substituted for that agent's model.
    for (const name of AGENT_NAMES) {
      const outPath = join(projectDir, ".opencode", "agents", `${name}.md`);
      expect(existsSync(outPath)).toBe(true);
      expect(result.written).toContain(outPath);

      const body = await readFile(outPath, "utf8");
      // No raw placeholders may survive — verify all three are gone even
      // though only the native one was present (replace-on-absent is a no-op).
      expect(body).not.toContain("__GHS_MODEL_CONTEXT__");
      expect(body).not.toContain("__GHS_MODEL_DESIGNER__");
      expect(body).not.toContain("__GHS_MODEL_REVIEWER__");
      // The agent's native placeholder must have been replaced by its model.
      const expectedModel = userModels[NATIVE_MODEL_KEY[name]];
      expect(body).toContain(expectedModel);
    }
  });

  // (i) ---------------------------------------------------------------------
  test("(i) syncAgents auto-creates .opencode/agents/ if missing", async () => {
    // Pre-condition: the target dir must not exist before the call.
    const agentsDir = join(projectDir, ".opencode", "agents");
    expect(existsSync(agentsDir)).toBe(false);

    const result = await syncAgents(projectDir, pluginRoot);

    // Post-condition: dir + 3 files now exist.
    expect(existsSync(agentsDir)).toBe(true);
    expect(result.written).toHaveLength(3);
    for (const name of AGENT_NAMES) {
      expect(existsSync(join(agentsDir, `${name}.md`))).toBe(true);
    }
  });

  // (j) ---------------------------------------------------------------------
  test("(j) render path without write produces expected preview (syncAgents has no dry_run)", async () => {
    // `syncAgents()` has no `dry_run` parameter (config.ts ships only the
    // write-through implementation). Per the feature's documented fallback,
    // case (j) exercises the render path directly: call `renderAgentTemplate`
    // for all 3 agent names and assert the rendered outputs are correct
    // WITHOUT touching `.opencode/agents/` — i.e. nothing is written.
    const userModels: GhsConfig["models"] = {
      context: "preview/context-9",
      designer: "preview/designer-9",
      reviewer: "preview/reviewer-9",
    };
    const config: GhsConfig = { models: userModels, planner_backend: "ghs-plan-designer" };

    const preview: Record<string, string> = {};
    for (const name of AGENT_NAMES) {
      preview[name] = await renderAgentTemplate(name, config, pluginRoot);
    }

    // Each rendered body must carry its native model ID and contain no raw
    // placeholders — same contract as syncAgents, but without the write.
    for (const name of AGENT_NAMES) {
      const body = preview[name];
      expect(body).not.toContain(NATIVE_PLACEHOLDER[name]);
      expect(body).toContain(userModels[NATIVE_MODEL_KEY[name]]);
    }

    // Nothing was written: `.opencode/` must not exist in the project dir
    // (we never invoked syncAgents or Bun.write).
    expect(existsSync(join(projectDir, ".opencode"))).toBe(false);
  });

  // (k) ---------------------------------------------------------------------
  test("(k) loadGhsConfig with missing .ghs/ghs.json defaults planner_backend to 'ghs-plan-designer'", async () => {
    // No `.ghs/ghs.json` — schema `.default(...)` plus the default file both
    // point at "ghs-plan-designer". The merged config must surface this as a
    // required field (zod `.default()` makes the input optional but the
    // output required).
    const { config } = await loadGhsConfig(projectDir, pluginRoot);

    expect(config.planner_backend).toBe("ghs-plan-designer");
  });

  // (l) ---------------------------------------------------------------------
  test("(l) loadGhsConfig honors user-specified planner_backend='builtin-plan'", async () => {
    await writeUserConfig(
      projectDir,
      JSON.stringify({
        models: {
          context: "openai/gpt-5",
          designer: "openai/gpt-5",
          reviewer: "openai/gpt-5",
        },
        planner_backend: "builtin-plan",
      }),
    );

    const { config } = await loadGhsConfig(projectDir, pluginRoot);

    // User value wins; the merged product carries the field verbatim.
    expect(config.planner_backend).toBe("builtin-plan");
  });

  // (m) ---------------------------------------------------------------------
  test("(m) loadGhsConfig with invalid planner_backend enum value is rejected by Zod", async () => {
    // Valid JSON shape, but planner_backend carries a value outside the enum.
    // z.enum must surface this as an `invalid_enum_value` issue rather than
    // silently coercing.
    await writeUserConfig(
      projectDir,
      JSON.stringify({
        models: {
          context: "openai/gpt-5",
          designer: "openai/gpt-5",
          reviewer: "openai/gpt-5",
        },
        planner_backend: "foo",
      }),
    );

    let caught: unknown;
    try {
      await loadGhsConfig(projectDir, pluginRoot);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ZodError);
    const issues = (caught as ZodError).issues;
    const enumIssue = issues.find((i) => i.code === "invalid_enum_value");
    expect(enumIssue).toBeDefined();
    // The offending value plus the two valid options must be surfaced.
    expect(enumIssue!.received).toBe("foo");
    expect(enumIssue!.options).toEqual(["ghs-plan-designer", "builtin-plan"]);
  });

  // (n) ---------------------------------------------------------------------
  test("(n) loadGhsConfig with ghs.json omitting planner_backend fills via .default() and keeps defaults_used false when all models are set", async () => {
    // User fully specifies all three models but omits planner_backend. Zod's
    // `.default(...)` fills it in, and `plannerBackendFellBack` stays false
    // (it is unreachable under the current schema — plan §3.2.1). Therefore
    // `defaults_used` must reflect only the model fallback state (here:
    // false). This pins the forward-compatibility anchor: planner_backend
    // going through `.default()` does NOT on its own flip `defaults_used`.
    await writeUserConfig(
      projectDir,
      JSON.stringify({
        models: {
          context: "openai/gpt-5",
          designer: "anthropic/claude-opus-4.1",
          reviewer: "anthropic/claude-sonnet-4.5",
        },
        // planner_backend deliberately omitted
      }),
    );

    const { config, defaults_used } = await loadGhsConfig(projectDir, pluginRoot);

    expect(config.planner_backend).toBe("ghs-plan-designer");
    expect(defaults_used).toBe(false);
  });
});
