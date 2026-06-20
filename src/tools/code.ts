// `ghs-code` tool — entry point of the feature-implementation workflow.
//
// This is the s4-feat-004 productisation of the source plugin's coding
// workflow (plan §3.4 D2 / §3.5 / §3.7 step 5: code). It is a *thin wrapper*
// composing three Wave-1 modules:
//   - `getReadyFeatures` / `buildBatches` (s4-feat-002 port of parallel_utils)
//     — finds the current sprint's ready features (status pending AND deps
//     completed) and groups them into conflict-free parallel batches.
//   - `FEATURE_IMPL_PROMPT` (s4-feat-003) — the dispatch prompt the main chat
//     AI hands to the Task tool to spawn an isolated coding subagent that
//     implements ONE feature end-to-end. The template carries two
//     placeholders (`<PROJECT_DIR>` / `<feature_id>`) that we substitute here.
//   - `resolveProjectDir(ctx)` (s1-feat-006) — explicit `project_dir` arg
//     overrides the opencode session's worktree/directory.
//
// What the tool does NOT do (by design — see the feature's technical_notes):
//   - It does NOT spawn the coding subagent itself. The main AI does that via
//     the Task tool using the dispatch text this tool returns.
//   - It does NOT call `parseCompletionSignal`. The main AI invokes the parser
//     after the subagent returns, then updates features.json status itself
//     (e.g. via `ghs-status` / the `update-feature-status` writer).
//   - It does NOT write features.json or touch the agent registry. It only
//     READS features.json and returns dispatch guidance.
//
// Style follows s2-feat-003's `sprint.ts` and s3-feat-006's `plan-start.ts`
// (thin `tool({...})` wrapper, descriptive LLM-facing result prose) and
// s1-feat-008's I/O style (`Bun.file(...).text()` + `JSON.parse`, no
// `process.exit`, no `console.log`). Per CLAUDE.md the returned text mixes
// 中文 prose with English identifiers / field names / paths.

import { tool } from "@opencode-ai/plugin";
import type { ToolContext } from "@opencode-ai/plugin/tool";
import { resolve, join } from "node:path";

import { resolveProjectDir } from "../lib/project.ts";
import {
  getReadyFeatures,
  buildBatches,
  summarizeFeature,
  type FeaturesData,
  type Feature,
} from "../lib/scripts/parallel-utils.ts";
import { FEATURE_IMPL_PROMPT } from "../prompts/feature-impl.ts";

/**
 * Render `FEATURE_IMPL_PROMPT` with its two placeholders substituted.
 *
 * The template (s4-feat-003) carries `<PROJECT_DIR>` and `<feature_id>`
 * placeholders that the main AI expects to be already-filled when it reads the
 * tool result — it then hands the rendered text verbatim to the Task tool to
 * spawn the coding subagent. We substitute defensively so a placeholder that
 * somehow appears inside `projectDir` or `featureId` can't recurse.
 */
function renderFeatureImplPrompt(
  projectDir: string,
  featureId: string,
): string {
  return FEATURE_IMPL_PROMPT.replace(/<PROJECT_DIR>/g, projectDir).replace(
    /<feature_id>/g,
    featureId,
  );
}

/**
 * Project a feature dict onto the small summary the dispatch text needs.
 *
 * Mirrors `summarizeFeature` from parallel-utils but also surfaces the
 * `acceptance_criteria` list, which the dispatch guidance shows the AI inline
 * so it can sanity-check the selected feature before dispatching (the subagent
 * re-reads the full record from features.json itself, but a one-glance summary
 * in the tool result keeps the main chat oriented). Defensive on every field
 * — features.json is validated upstream but we never want a malformed entry to
 * crash the tool.
 */
interface FeatureBrief {
  id: string;
  title: string;
  status: string;
  files_affected: string[];
  dependencies: string[];
  acceptance_criteria: string[];
}

function toBrief(feat: Feature): FeatureBrief {
  const base = summarizeFeature(feat);
  const ac = feat["acceptance_criteria"];
  return {
    ...base,
    acceptance_criteria: Array.isArray(ac) ? (ac as string[]) : [],
  };
}

/**
 * Format a feature brief as the compact multi-line block the dispatch
 * guidance embeds (id / title / status / files / deps / AC bullets). Kept
 * short — the subagent reads the full record itself; this is just the at-a-
 * glance orientation the main AI needs to pick a target and confirm.
 */
function formatBrief(feat: FeatureBrief): string {
  const lines: string[] = [];
  lines.push(`id:     ${feat.id}`);
  lines.push(`title:  ${feat.title}`);
  lines.push(`status: ${feat.status}`);
  lines.push(
    `files:  ${feat.files_affected.length > 0 ? feat.files_affected.join(", ") : "(none)"}`,
  );
  lines.push(
    `deps:   ${feat.dependencies.length > 0 ? feat.dependencies.join(", ") : "(none)"}`,
  );
  if (feat.acceptance_criteria.length > 0) {
    lines.push("acceptance_criteria:");
    for (const ac of feat.acceptance_criteria) {
      lines.push(`  - ${ac}`);
    }
  }
  return lines.join("\n");
}

/**
 * The `ghs-code` tool definition. Registered by the plugin entry point
 * (s4-feat-005) under the hyphenated `ghs-code` key — the 10th and final tool
 * in the plan-§3.4-D2 surface.
 */
export const codeTool = tool({
  description:
    "Entry point of the feature-implementation workflow. Reads features.json, finds the current " +
    "sprint's ready features (status pending AND all dependencies completed), and returns LLM-facing " +
    "dispatch guidance embedding the FEATURE_IMPL_PROMPT plus the selected feature's id/title/AC " +
    "summary — telling the main AI to spawn an isolated coding subagent via the Task tool. " +
    "Pass `parallel=true` to also get conflict-free parallel batches (dispatch plan). Pin a specific " +
    "feature with `feature_id`. The tool does NOT spawn the subagent or write features.json status " +
    "itself — the main AI dispatches via Task, then parses the subagent's completion signal " +
    "(parse-completion-signal) and updates the feature status.",
  args: {
    feature_id: tool.schema
      .string()
      .optional()
      .describe(
        "Pin a single feature by id. The feature must exist in the current sprint and be ready " +
        "(status pending + deps completed); otherwise the tool returns an error text.",
      ),
    parallel: tool.schema
      .boolean()
      .optional()
      .describe(
        "Parallel mode. When true, the tool returns ALL ready features plus conflict-free " +
        "parallel batches (a dispatch plan) instead of pinning a single target.",
      ),
    project_dir: tool.schema
      .string()
      .optional()
      .describe(
        "Absolute path of the project root. Defaults to the opencode session's worktree/directory.",
      ),
  },
  async execute(
    args: {
      feature_id?: string;
      parallel?: boolean;
      project_dir?: string;
    },
    ctx: ToolContext,
  ): Promise<string> {
    // (1) Resolve the project dir. Explicit arg wins; otherwise read it off
    // the opencode session context (worktree > directory).
    const projectDir = args.project_dir
      ? resolve(args.project_dir)
      : resolveProjectDir(ctx);

    // (2) Read features.json. Same defensive read as sprint.ts / status.ts:
    // if the file is missing we return a指向 ghs-init 的错误文本而不是抛
    // 异常 —— AI 可以据此引导用户初始化。
    const featuresPath = join(projectDir, ".ghs", "features.json");
    const featuresFile = Bun.file(featuresPath);
    if (!(await featuresFile.exists())) {
      return [
        `❌ features.json not found at ${featuresPath}.`,
        "",
        "Run `ghs-init` first to bootstrap the .ghs/ tracking files.",
      ].join("\n");
    }

    let featuresData: FeaturesData;
    try {
      const text = await featuresFile.text();
      featuresData = JSON.parse(text) as FeaturesData;
    } catch (err) {
      return [
        `❌ Failed to parse ${featuresPath}:`,
        "",
        (err as Error).message,
        "",
        "Fix the JSON (or re-run `ghs-init`) before invoking `ghs-code` again.",
      ].join("\n");
    }

    // (3) Find the current sprint's ready features. We pass NO sprint_id so
    // getReadyFeatures mirrors the Python source: the first sprint with
    // status === "in_progress", else the first sprint in the array. A feature
    // is "ready" iff status === "pending", it is not in a dependency cycle,
    // and every entry in its `dependencies` is in the completed set.
    const result = getReadyFeatures(featuresData);
    const ready = result.ready;
    const skipped = result.skipped;
    const cycles = result.cycles;

    // (3a) Surface any detected dependency cycle as a loud warning block at
    // the top of the result. Cycles make those features permanently un-ready,
    // so ignoring them would silently drop work the user expects to see.
    const cycleWarning =
      cycles.length > 0
        ? [
            `⚠️ Detected ${cycles.length} dependency cycle(s) — these features are NOT ready until the cycle is broken:`,
            ...cycles.map((c) => `  - ${c.join(" → ")}`),
            "",
          ].join("\n")
        : "";

    // (4) No-ready-feature short-circuit. AC: "无 ready feature 时返回 'no
    // pending features' 提示". We keep the message informative (count of
    // skipped + any cycle) so the AI can tell "sprint done" apart from
    // "blocked by unmet deps".
    if (ready.length === 0) {
      const lines: string[] = [];
      lines.push("=== ghs-code: no ready features ===");
      lines.push("");
      lines.push(`Project directory: ${projectDir}`);
      if (cycleWarning) {
        lines.push(cycleWarning.trimEnd());
        lines.push("");
      }
      if (skipped.length === 0) {
        lines.push("当前 sprint 没有 pending feature（已全部完成，或 sprint 为空）。");
      } else {
        lines.push(
          `当前 sprint 有 ${skipped.length} 个 feature 但无一 ready（依赖未完成、状态非 pending、或处于依赖环中）。`,
        );
        lines.push("用 `ghs-status` 查看各 feature 状态与依赖。");
      }
      return lines.join("\n");
    }

    // (5) Branch on args.
    //
    // `feature_id` pin (highest priority) → validate + single-feature dispatch.
    // `parallel=true` → multi-feature dispatch plan (batches).
    // default → pick the first ready feature (stable, deterministic order —
    //   getReadyFeatures preserves features.json order) and dispatch it.
    const parallelMode = args.parallel === true;

    if (args.feature_id) {
      return dispatchPinnedFeature(
        args.feature_id,
        ready,
        skipped,
        projectDir,
        cycleWarning,
      );
    }

    if (parallelMode) {
      return dispatchParallelPlan(ready, projectDir, cycleWarning);
    }

    return dispatchSingleFeature(ready[0], projectDir, cycleWarning);
  },
});

/**
 * Build the dispatch text for a single pinned feature.
 *
 * Validates the `feature_id` arg: it must (a) exist somewhere in the current
 * sprint's features AND (b) be in the ready set. If it's in `skipped`, we
 * explain why (wrong status or unmet deps); if it's not in the sprint at all,
 * we say so. On success we return the FEATURE_IMPL_PROMPT (placeholders
 * substituted) plus the feature brief.
 */
function dispatchPinnedFeature(
  featureId: string,
  ready: Feature[],
  skipped: Feature[],
  projectDir: string,
  cycleWarning: string,
): string {
  // Is it ready?
  const readyMatch = ready.find(
    (f) => (f["id"] as string | undefined) === featureId,
  );
  if (readyMatch) {
    const brief = toBrief(readyMatch);
    const lines: string[] = [];
    lines.push("=== ghs-code: feature pinned & ready ===");
    lines.push("");
    lines.push(`Project directory: ${projectDir}`);
    if (cycleWarning) {
      lines.push(cycleWarning.trimEnd());
      lines.push("");
    }
    lines.push("Selected feature:");
    lines.push(formatBrief(brief));
    lines.push("");
    lines.push(
      "Next: 用 Task tool 派发 coding subagent（派发 prompt 见下，已注入 project dir 与 feature_id），",
    );
    lines.push(
      "subagent 返回后用 parse-completion-signal 解析其完成信号，再调 update-feature-status 更新该 feature 的 status。",
    );
    lines.push("");
    lines.push("--- feature-impl dispatch prompt ---");
    lines.push(renderFeatureImplPrompt(projectDir, brief.id));
    return lines.join("\n");
  }

  // Not ready — is it in skipped (i.e. exists in this sprint but not ready)?
  const skippedMatch = skipped.find(
    (f) => (f["id"] as string | undefined) === featureId,
  );
  if (skippedMatch) {
    const brief = toBrief(skippedMatch);
    const lines: string[] = [];
    lines.push(`❌ feature ${featureId} 存在但 NOT ready。`);
    lines.push("");
    lines.push(`Project directory: ${projectDir}`);
    lines.push("");
    lines.push("Feature 状态:");
    lines.push(formatBrief(brief));
    lines.push("");
    if (brief.status !== "pending") {
      lines.push(
        `原因：status 为 "${brief.status}"（仅 "pending" 才可派发）。`,
      );
    } else if (brief.dependencies.length > 0) {
      lines.push("原因：存在未完成的依赖（依赖 feature 须先 completed）。");
    } else {
      lines.push("原因：未通过 ready 判定（可能处于依赖环中）。");
    }
    lines.push("");
    lines.push("用 `ghs-status` 查看依赖与状态详情。");
    return lines.join("\n");
  }

  // Not in the current sprint at all.
  const lines: string[] = [];
  lines.push(`❌ feature ${featureId} 不在当前 sprint 中。`);
  lines.push("");
  lines.push(`Project directory: ${projectDir}`);
  lines.push("");
  lines.push("请核对 feature_id，或调用 `ghs-code`（不带 feature_id）让工具按依赖顺序选一个 ready feature。");
  return lines.join("\n");
}

/**
 * Build the dispatch text for parallel mode: all ready features + conflict-
 * free batches from `buildBatches`. Each batch is a set of features that touch
 * disjoint `files_affected` sets, so the main AI can dispatch them
 * concurrently without merge conflicts.
 *
 * The dispatch plan lists every ready feature (so nothing is silently
 * dropped), groups them into batches, and ends with the shared FEATURE_IMPL
 * PROMPT (placeholders left as `<feature_id>` / `<PROJECT_DIR>`-filled —
 * rendered once per target in the per-feature block) so the AI has the exact
 * subagent prompt to hand to Task for each target.
 */
function dispatchParallelPlan(
  ready: Feature[],
  projectDir: string,
  cycleWarning: string,
): string {
  const batches = buildBatches(ready);
  const briefs = ready.map(toBrief);

  const lines: string[] = [];
  lines.push("=== ghs-code: parallel dispatch plan ===");
  lines.push("");
  lines.push(`Project directory: ${projectDir}`);
  if (cycleWarning) {
    lines.push(cycleWarning.trimEnd());
    lines.push("");
  }
  lines.push(
    `当前 sprint 有 ${ready.length} 个 ready feature，分成 ${batches.length} 个无文件冲突批次：`,
  );
  lines.push("");

  batches.forEach((batch, batchIdx) => {
    lines.push(`## Batch ${batchIdx + 1}（${batch.length} feature，文件无冲突，可并发派发）`);
    lines.push("");
    for (const feat of batch) {
      const brief = briefs.find((b) => b.id === (feat["id"] as string | undefined));
      if (!brief) continue;
      lines.push(`### ${brief.id} — ${brief.title}`);
      lines.push(formatBrief(brief));
      lines.push("");
      lines.push("--- feature-impl dispatch prompt ---");
      lines.push(renderFeatureImplPrompt(projectDir, brief.id));
      lines.push("");
    }
  });

  lines.push(
    "每个 feature 独立派发 coding subagent（各 Task call 互不依赖）。所有 subagent 返回后，",
  );
  lines.push(
    "用 parse-completion-signal 逐个解析完成信号，再调 update-feature-status 更新对应 feature 的 status。",
  );
  lines.push(
    "并行 git 守则：每个 subagent 显式 `git add <实现文件路径>` 做**恰好一次** commit（禁 `git add -A`/`add .`/`reset`，禁提交 `.ghs/*`），避免兄弟 commit 被 orphan。",
  );
  return lines.join("\n");
}

/**
 * Build the dispatch text for the default single-feature path: pick the first
 * ready feature (stable order) and return its brief + the rendered
 * FEATURE_IMPL_PROMPT.
 */
function dispatchSingleFeature(
  feat: Feature,
  projectDir: string,
  cycleWarning: string,
): string {
  const brief = toBrief(feat);
  const lines: string[] = [];
  lines.push("=== ghs-code: feature ready ===");
  lines.push("");
  lines.push(`Project directory: ${projectDir}`);
  if (cycleWarning) {
    lines.push(cycleWarning.trimEnd());
    lines.push("");
  }
  lines.push(
    "已按依赖顺序选取第一个 ready feature（如需并发派发多个，用 `ghs-code` 并传 `parallel: true`）：",
  );
  lines.push("");
  lines.push("Selected feature:");
  lines.push(formatBrief(brief));
  lines.push("");
  lines.push(
    "Next: 用 Task tool 派发 coding subagent（派发 prompt 见下，已注入 project dir 与 feature_id），",
  );
  lines.push(
    "subagent 返回后用 parse-completion-signal 解析其完成信号，再调 update-feature-status 更新该 feature 的 status。",
  );
  lines.push("");
  lines.push("--- feature-impl dispatch prompt ---");
  lines.push(renderFeatureImplPrompt(projectDir, brief.id));
  return lines.join("\n");
}
