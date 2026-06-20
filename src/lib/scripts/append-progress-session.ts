// Insert a new progress session entry into a progress.md document (in-memory).
//
// This is one of the three "writer" modules introduced in s2-feat-001. Like
// its siblings it has no source-plugin Python equivalent — the source
// `ghs-sprint` skill had the AI edit progress.md directly. This module
// refactors that into a pure function that returns the updated markdown.
//
// Design principles match append-sprint.ts / update-feature-status.ts: pure
// function, no I/O, no stdout, no process.exit, immutable return, Zod-validated
// session object.

import { z } from "zod";

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------

/**
 * Zod schema for a single progress session.
 *
 * The rendered markdown mirrors the `## Session Template` block in
 * `shared/assets/progress.md`. Required fields are the ones that make a session
 * identifiable and useful; the rest are optional so a minimal session still
 * renders cleanly.
 *
 * - `title`: the `## Session N - YYYY-MM-DD` heading line (without the leading
 *   `## `). Required.
 * - `agent`: rendered as `**Agent**: <value>`.
 * - `sprint`, `feature`: optional metadata lines.
 * - `work_completed`, `tests_performed`, `issues`, `decisions`, `next_steps`:
 *   optional string arrays rendered as `- <item>` bullet lists under their
 *   respective `### ` sub-headings.
 */
const stringList = z.array(z.string()).default([]);

export const ProgressSessionSchema = z.object({
  title: z.string().min(1, "title is required"),
  agent: z.string().min(1, "agent is required"),
  sprint: z.string().optional(),
  feature: z.string().optional(),
  work_completed: stringList,
  tests_performed: stringList,
  issues: stringList,
  decisions: stringList,
  next_steps: stringList,
});

export type ProgressSession = z.infer<typeof ProgressSessionSchema>;

// -----------------------------------------------------------------------------
// Renderer
// -----------------------------------------------------------------------------

/**
 * Render a {@link ProgressSession} as a markdown block (without a trailing
 * newline beyond the single one that ends the block).
 *
 * Section sub-headings are always emitted (even when the list is empty) so the
 * shape matches the `## Session Template` in `shared/assets/progress.md` — this
 * keeps the file skimmable and gives the AI consistent anchors to fill in
 * later.
 */
export function renderSession(session: ProgressSession): string {
  const lines: string[] = [];
  lines.push(`## ${session.title}`);
  lines.push(`**Agent**: ${session.agent}`);
  if (session.sprint !== undefined && session.sprint !== "") {
    lines.push(`**Sprint**: ${session.sprint}`);
  }
  if (session.feature !== undefined && session.feature !== "") {
    lines.push(`**Feature**: ${session.feature}`);
  }
  lines.push("");
  lines.push("### Work Completed");
  if (session.work_completed.length > 0) {
    for (const item of session.work_completed) lines.push(`- ${item}`);
  }
  lines.push("");
  lines.push("### Tests Performed");
  if (session.tests_performed.length > 0) {
    for (const item of session.tests_performed) lines.push(`- ${item}`);
  }
  lines.push("");
  lines.push("### Issues Encountered");
  if (session.issues.length > 0) {
    for (const item of session.issues) lines.push(`- ${item}`);
  }
  lines.push("");
  lines.push("### Decisions Made");
  if (session.decisions.length > 0) {
    for (const item of session.decisions) lines.push(`- ${item}`);
  }
  lines.push("");
  lines.push("### Next Steps");
  if (session.next_steps.length > 0) {
    for (const item of session.next_steps) lines.push(`- ${item}`);
  }
  return lines.join("\n");
}

// -----------------------------------------------------------------------------
// Writer
// -----------------------------------------------------------------------------

/**
 * Insert `session` into `progressMd` immediately after the `## Sessions`
 * heading and before the first existing session entry, so the newest session
 * stays at the top.
 *
 * Behavior:
 *   1. Validate `session` against {@link ProgressSessionSchema} (throws
 *      ZodError on invalid input).
 *   2. Locate the `## Sessions` heading (matched case-sensitively as a line
 *      starting with `## Sessions`). If missing, throw a descriptive Error —
 *      appending to a progress.md without the anchor would silently corrupt
 *      the document structure.
 *   3. Find the position of the first *existing session entry*: the next
 *      `## ` heading after `## Sessions` that is NOT `## Sessions` itself. This
 *      skips template scaffolding (HTML comments, the `## Session Template`
 *      block that lives above `## Sessions`, etc.) and lands the new entry
 *      directly above the previous newest session.
 *   4. If no existing session entry exists, append at the end of the document.
 *   5. Return the new markdown string. The new session is separated from
 *      surrounding content by blank lines.
 *
 * This function does NOT write to disk. The caller (tool layer) is responsible
 * for persistence.
 */
export function appendProgressSession(
  progressMd: string,
  session: ProgressSession,
): string {
  const validated = ProgressSessionSchema.parse(session);
  const rendered = renderSession(validated);

  const lines = progressMd.split("\n");

  // Locate the `## Sessions` heading line. Matched case-sensitively and
  // anchored so `## Session Template` (which lives above this heading in the
  // default template) is not confused with it.
  let sessionsHeadingIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Sessions\s*$/.test(lines[i])) {
      sessionsHeadingIndex = i;
      break;
    }
  }
  if (sessionsHeadingIndex === -1) {
    throw new Error(
      "progress.md is missing the '## Sessions' heading — cannot insert session",
    );
  }

  // Find the position immediately before the first existing session entry.
  // An "existing session entry" is any `## ` heading that appears AFTER the
  // `## Sessions` heading. Content between the heading and that first entry
  // (e.g. the `<!-- New sessions should be added above this line -->`
  // comment in the default template) is preserved verbatim and ends up below
  // the newly inserted session — which is exactly the "newest on top"
  // invariant the acceptance criterion asks for.
  let firstEntryIndex = -1;
  for (let i = sessionsHeadingIndex + 1; i < lines.length; i++) {
    if (/^##\s+\S/.test(lines[i])) {
      firstEntryIndex = i;
      break;
    }
  }
  // When there is no existing session entry, append at the end of the file.
  const insertAt = firstEntryIndex === -1 ? lines.length : firstEntryIndex;

  // Build the insertion: a blank line, the rendered session, a blank line.
  // The trailing blank line guarantees separation from whatever follows
  // (the first existing entry, or end-of-document).
  const block = ["", rendered, ""];

  const next = lines.slice(0, insertAt).concat(block, lines.slice(insertAt));
  return next.join("\n");
}
