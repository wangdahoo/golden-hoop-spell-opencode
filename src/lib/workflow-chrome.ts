// Workflow-chrome pure functions for mechanism-1 (Todo-Anchored Workflow),
// plan §3.1 injection point ② (Feature s1-feat-001).
//
// These four functions render the short text snippets ("chrome") that ghs
// multi-step tools prepend/append to their `execute()` return string to make
// the current workflow stage visible and to nudge the main AI to keep the
// right-panel `todowrite` checklist in sync:
//
//   stageHeader(stage)                -> prepended; banner naming the stage
//   todoDirective(stages, currentIdx) -> appended (never branch, judgment
//                                        table row 2); lists the checklist and
//                                        marks the current stage in_progress
//   nextActionAnchor(action)          -> appended; the ▶ NEXT ACTION handoff
//   staleTodoWarning(expectedStage)   -> appended (drift branch, judgment
//                                        table row 3); stage advanced but the
//                                        todo was not refreshed
//
// Design constraints (plan §3.1):
//   - Pure functions, no side effects, no IO. This keeps them trivially
//     snapshot-testable and lets feat-005 import them without pulling in
//     todo-tracker (the stage-state machine lives in a sibling module).
//   - Does NOT import todo-tracker; classification is the caller's job.
//   - `todoDirective`'s `(stages: string[], currentIdx: number)` signature is
//     the extension point for the code-parallel scenario: the caller passes
//     the batch's feature ids as `stages`, so the same function expands a
//     batch checklist with no separate code path.
//   - English output (language policy: LLM-facing text is English).

/**
 * Render the stage banner prepended to a ghs multi-step tool's return text.
 *
 * `stage` is the stage signature produced by `getStageSignature` in
 * todo-tracker (e.g. `plan:designing`, `plan:reviewing`, `code:s1-feat-005`).
 * The banner makes the current stage visible in the LLM-facing text channel
 * (mechanism-1 injection point ②).
 */
export function stageHeader(stage: string): string {
  return `--- ghs stage: ${stage} ---`;
}

/**
 * Render the directive appended when the right-panel todo has never been seen
 * for this session (judgment table row 2: `lastTodoMs === undefined`).
 *
 * `stages` is the ordered list of upcoming stage labels; `currentIdx` is the
 * index that should be marked `in_progress` (earlier indices render as
 * completed, later ones as pending). For the code-parallel scenario the caller
 * passes the batch's feature ids as `stages`, so a batch checklist expands via
 * the same code path — the parameter signature is the extension point.
 *
 * Defensive boundary (acceptance criterion #2): an empty `stages` array OR an
 * out-of-bounds `currentIdx` MUST NOT throw. Empty stages falls back to a
 * minimal nudge; an out-of-range `currentIdx` simply renders no `in_progress`
 * marker (nothing is completed either, unless `currentIdx` exceeds the length).
 */
export function todoDirective(stages: string[], currentIdx: number): string {
  if (!Array.isArray(stages) || stages.length === 0) {
    return [
      "TODO: call the `todowrite` tool to create a stage checklist, marking",
      " the current ghs stage in_progress and refreshing it as each stage",
      " advances.",
    ].join("\n");
  }
  const lines: string[] = [
    "TODO: call the `todowrite` tool to build a stage checklist, then keep",
    " it in sync as each ghs stage advances:",
  ];
  for (let i = 0; i < stages.length; i++) {
    let marker: string;
    if (i === currentIdx) {
      marker = "[in_progress]";
    } else if (i < currentIdx) {
      marker = "[completed]";
    } else {
      marker = "[pending]";
    }
    lines.push(`  ${marker} ${stages[i]}`);
  }
  return lines.join("\n");
}

/**
 * Render the `▶ NEXT ACTION` anchor appended to every ghs multi-step tool's
 * return text. `action` names the exact next tool call the main AI must
 * execute; mechanism-1 relies on the main AI not skipping past it.
 */
export function nextActionAnchor(action: string): string {
  return `▶ NEXT ACTION: ${action}`;
}

/**
 * Render the drift warning appended when `classifyStaleState` returns `drift`
 * (judgment table row 3: `lastTodoMs` is set and `lastStageSeenByTool !==
 * currentStage`). `expectedStage` is the stage the todo should now reflect.
 */
export function staleTodoWarning(expectedStage: string): string {
  return [
    `STALE TODO: the ghs stage advanced to \`${expectedStage}\` but the`,
    " right-panel todo was not refreshed. Call the `todowrite` tool now: mark",
    ` the previous stage completed and \`${expectedStage}\` in_progress.`,
  ].join("\n");
}
