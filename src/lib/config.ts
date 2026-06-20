// Load `.ghs/ghs.json`, merge with defaults, and render agent markdown
// templates with the resolved model IDs.
//
// This module is the load-bearing implementation for R3 (Round 6): user-
// configurable model IDs. The user's `.ghs/ghs.json` overrides
// `shared/ghs.default.json` on a per-field basis. The merged config drives
// `syncAgents()`, which renders the three subagent markdown templates
// (`ghs-context-haiku`, `ghs-plan-designer`, `ghs-plan-reviewer`) into
// `<projectDir>/.opencode/agents/` so opencode picks them up on next start.
//
// Spike 004 verified that `String.replaceAll()` over the template body +
// fresh opencode process is sufficient — no template engine needed.

import { z } from "zod";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------

/**
 * Zod schema for `.ghs/ghs.json`. `strict()` rejects unknown top-level fields
 * (e.g. a typo like `"model"` instead of `"models"`) so misconfiguration is
 * surfaced loudly rather than silently ignored.
 */
export const GhsConfigSchema = z.strictObject({
  models: z.strictObject({
    context: z.string(),
    designer: z.string(),
    reviewer: z.string(),
  }),
});

export type GhsConfig = z.infer<typeof GhsConfigSchema>;

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

/**
 * The three placeholders recognised inside `*.md.template` files. Each is
 * substituted with the corresponding model ID from the resolved config.
 */
const PLACEHOLDERS = {
  context: "__GHS_MODEL_CONTEXT__",
  designer: "__GHS_MODEL_DESIGNER__",
  reviewer: "__GHS_MODEL_REVIEWER__",
} as const;

/**
 * Map from agent name → the placeholder it cares about. All three templates
 * share the same substitution pass (every placeholder is replaced on every
 * template), but this map documents which placeholder each template is
 * *expected* to contain. Templates without placeholders pass through
 * unchanged (acceptance criterion #7).
 */
const AGENT_NAMES = ["ghs-context-haiku", "ghs-plan-designer", "ghs-plan-reviewer"] as const;
type AgentName = (typeof AGENT_NAMES)[number];

/** Resolve the default config path under the plugin root. */
function defaultConfigPath(pluginRootDir: string): string {
  return resolve(pluginRootDir, "shared", "ghs.default.json");
}

/** Resolve the user config path under the project directory. */
function userConfigPath(projectDir: string): string {
  return resolve(projectDir, ".ghs", "ghs.json");
}

/** Resolve a template path under `<pluginRoot>/shared/agents/<name>.md.template`. */
function templatePath(pluginRootDir: string, name: string): string {
  return resolve(pluginRootDir, "shared", "agents", `${name}.md.template`);
}

/** Resolve an output agent markdown path under `<projectDir>/.opencode/agents/`. */
function outputPath(projectDir: string, name: string): string {
  return resolve(projectDir, ".opencode", "agents", `${name}.md`);
}

/**
 * Check whether a file exists. Thin wrapper over `Bun.file().exists()` so
 * callers can `await fileExists(p)` without juggling a BunFile object.
 */
export async function fileExists(path: string): Promise<boolean> {
  return Bun.file(path).exists();
}

/** Read + JSON-parse a file, throwing a descriptive error on any failure. */
async function readJsonFile(path: string, label: string): Promise<unknown> {
  const file = Bun.file(path);
  const exists = await file.exists();
  if (!exists) {
    throw new Error(`Failed to read ${label}: file not found at ${path}`);
  }
  let text: string;
  try {
    text = await file.text();
  } catch (err) {
    throw new Error(`Failed to read ${label} at ${path}: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Failed to parse ${label} at ${path}: invalid JSON — ${(err as Error).message}`,
    );
  }
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Load and validate the GHS config, merging the user's `.ghs/ghs.json` with
 * the plugin's `shared/ghs.default.json` on a per-field basis.
 *
 * Field-level fallback rules:
 *   - If `.ghs/ghs.json` does not exist → all three model fields come from
 *     defaults; `defaults_used` is `true`.
 *   - If `.ghs/ghs.json` exists and is missing one or more model fields →
 *     those fields fall back to defaults; `defaults_used` is `true`.
 *   - If `.ghs/ghs.json` exists with all three model fields set → no
 *     fallback; `defaults_used` is `false`.
 *
 * `defaults_used` is therefore `true` whenever ANY field fell back, and
 * `false` only when the user's file fully specified all three models.
 *
 * Unknown top-level fields in either file are rejected by Zod `.strict()`.
 *
 * @param projectDir   - absolute path to the host project (where `.ghs/` lives).
 * @param pluginRootDir - absolute path to this plugin's package root.
 * @returns `{ config, defaults_used }` where `config` matches `GhsConfig`.
 * @throws {Error} if either file is missing (defaults must exist), unparseable,
 *         or schema-invalid.
 */
export async function loadGhsConfig(
  projectDir: string,
  pluginRootDir: string,
): Promise<{ config: GhsConfig; defaults_used: boolean }> {
  // Defaults are always required — they ship with the plugin.
  const defaultRaw = await readJsonFile(defaultConfigPath(pluginRootDir), "ghs.default.json");
  const defaultParsed = GhsConfigSchema.parse(defaultRaw);

  // User file is optional; if present, overlay per-field.
  const userFile = userConfigPath(projectDir);
  const userExists = await fileExists(userFile);

  if (!userExists) {
    return { config: defaultParsed, defaults_used: true };
  }

  const userRaw = await readJsonFile(userFile, "ghs.json");

  // Validate user file shape with the same strict schema — this is what
  // surfaces "extra top-level field" as a hard error (AC #5) and what
  // catches malformed structures before the per-field merge below.
  const userParsed = GhsConfigSchema.parse(userRaw);

  // Per-field merge. A field falls back to its default when the user's
  // value is absent *or* the empty string. Empty-string fallback matters
  // because the feature's AC #3 explicitly tests `models.context: ""`.
  //
  // `defaults_used` is true if ANY of the three fields fell back — i.e. if
  // the user's config did not fully specify all three models. This matches
  // the feature's task notes:
  //   - all 3 from default     → defaults_used = true
  //   - some fields missing    → defaults_used = true (partial fallback)
  //   - all 3 set by user      → defaults_used = false
  let contextFellBack = false;
  let designerFellBack = false;
  let reviewerFellBack = false;

  const context =
    userParsed.models.context && userParsed.models.context.length > 0
      ? userParsed.models.context
      : ((contextFellBack = true), defaultParsed.models.context);
  const designer =
    userParsed.models.designer && userParsed.models.designer.length > 0
      ? userParsed.models.designer
      : ((designerFellBack = true), defaultParsed.models.designer);
  const reviewer =
    userParsed.models.reviewer && userParsed.models.reviewer.length > 0
      ? userParsed.models.reviewer
      : ((reviewerFellBack = true), defaultParsed.models.reviewer);

  const merged: GhsConfig = { models: { context, designer, reviewer } };
  const defaults_used = contextFellBack || designerFellBack || reviewerFellBack;

  return { config: merged, defaults_used };
}

/**
 * Render a single agent template by substituting the three model-ID
 * placeholders with values from `config`.
 *
 * Templates without placeholders pass through unchanged (AC #7) —
 * `String.replaceAll()` is a no-op when the target string is absent.
 *
 * @param name         - agent template name (without `.md.template`).
 * @param config       - resolved config providing the substitution values.
 * @param pluginRootDir - plugin package root (where `shared/agents/` lives).
 * @returns the rendered template body.
 * @throws {Error} if the template file is missing or unreadable.
 */
export async function renderAgentTemplate(
  name: string,
  config: GhsConfig,
  pluginRootDir: string,
): Promise<string> {
  const path = templatePath(pluginRootDir, name);
  const file = Bun.file(path);
  const exists = await file.exists();
  if (!exists) {
    throw new Error(`Agent template not found: ${path}`);
  }
  const body = await file.text();
  return body
    .replaceAll(PLACEHOLDERS.context, config.models.context)
    .replaceAll(PLACEHOLDERS.designer, config.models.designer)
    .replaceAll(PLACEHOLDERS.reviewer, config.models.reviewer);
}

/**
 * Result of `syncAgents()`. Returned to tool callers so they can report
 * which files were written, which models were applied, and whether any
 * defaults leaked through.
 */
export interface SyncAgentsResult {
  /** Absolute paths of the 3 rendered agent markdown files written. */
  written: string[];
  /** The model IDs that were substituted into the templates. */
  models: GhsConfig["models"];
  /** `true` if any of the 3 model fields fell back to the default config. */
  defaults_used: boolean;
}

/**
 * Load config + render all three agent templates + write them to
 * `<projectDir>/.opencode/agents/ghs-*.md`.
 *
 * Creates `<projectDir>/.opencode/agents/` if missing. Does NOT touch the
 * opencode runtime — the caller (e.g. the `ghs-config` tool) is responsible
 * for telling the user to restart opencode (per spike 004's finding that
 * agent markdown requires a fresh process).
 *
 * @param projectDir    - host project directory (target of `.opencode/agents/`).
 * @param pluginRootDir - plugin package root (source of templates + defaults).
 * @returns `SyncAgentsResult`.
 */
export async function syncAgents(
  projectDir: string,
  pluginRootDir: string,
): Promise<SyncAgentsResult> {
  const { config, defaults_used } = await loadGhsConfig(projectDir, pluginRootDir);

  const written: string[] = [];
  // Ensure `<projectDir>/.opencode/agents/` exists before we write into it.
  // Bun.write creates parent dirs automatically in recent versions, but we
  // mkdir explicitly so behaviour is stable across versions and obvious to
  // readers (and so AC #8 "creates .opencode/agents/ if missing" holds even
  // on a clean project dir).
  await mkdir(resolve(projectDir, ".opencode", "agents"), { recursive: true });

  for (const name of AGENT_NAMES) {
    const rendered = await renderAgentTemplate(name, config, pluginRootDir);
    const out = outputPath(projectDir, name);
    await Bun.write(out, rendered);
    written.push(out);
  }

  return {
    written,
    models: config.models,
    defaults_used,
  };
}
