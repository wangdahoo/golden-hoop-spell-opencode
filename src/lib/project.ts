// Resolve the active project directory from an OpenCode tool context.
//
// `ToolContext` exposes two path fields:
//   - `worktree`:  the project worktree root (stable across agent working dirs)
//   - `directory`: the per-session working directory (may be a subdir)
//
// Per the feature spec we prefer `worktree` when set so writes land in a
// stable location regardless of which subdirectory the agent is currently
// operating in. We fall back to `directory` when `worktree` is empty.
//
// Note: this is the OpenCode TS port. The source Python script
// `plugin/shared/scripts/resolve_project_dir.py` walks up from a start dir
// looking for `.ghs/features.json`. Here we don't walk — we trust the
// context's fields, which the runtime has already resolved for us. The
// walk-up behaviour is implemented separately in `scripts/resolve-project-dir.ts`
// (s1-feat-008) for parity with the Python entry-point script.

import type { ToolContext } from "@opencode-ai/plugin/tool";

/**
 * Resolve the project directory the plugin should read/write under.
 *
 * @param ctx - the OpenCode tool execution context.
 * @returns `ctx.worktree` when non-empty, otherwise `ctx.directory`.
 */
export function resolveProjectDir(ctx: ToolContext): string {
  return ctx.worktree || ctx.directory;
}
