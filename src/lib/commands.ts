// Slash command definitions for the ghs-* workflow tools.
//
// These are injected into the OpenCode Config object's `command` field via
// the plugin's `config` hook (see src/plugin.ts). OpenCode reads
// `cfg.command` when the TUI requests `GET /command`, so the commands are
// available on the very first startup — no file writes or restart needed.
//
// Each entry conforms to the OpenCode Command shape:
//   - `template`:  The prompt sent to the LLM when the user types the command.
//                  Supports `$ARGUMENTS`, `$1`, `$2`, … for argument passing.
//   - `description`: Shown in the TUI command palette.
//
// Commands map 1:1 to the 8 user-facing ghs-* tools. The two internal
// dispatcher tools (ghs-plan-review, ghs-plan-finalize) are intentionally
// excluded — they consume raw delimited subagent output and are never
// invoked directly by the user.

/**
 * A single slash command definition matching OpenCode's Config.command shape.
 */
export interface GhCommand {
  template: string;
  description: string;
}

/**
 * The 8 user-facing `/ghs-*` slash commands, keyed by command name.
 *
 * Injected into `cfg.command` by the plugin's `config` hook. When the user
 * types `/ghs-status` (etc.) in the TUI, OpenCode sends the corresponding
 * `template` string to the LLM, which then calls the matching tool.
 *
 * Argument-passing commands use OpenCode's built-in placeholders:
 *   - `$ARGUMENTS` — the entire argument string
 *   - `$1`, `$2`, … — positional arguments
 */
export const GHS_COMMANDS: Record<string, GhCommand> = {
  "ghs-init": {
    description: "初始化 ghs 追踪文件（.ghs/ + .opencode/agents/）",
    template:
      'Call the `ghs-init` tool to initialise the Golden Hoop Spell tracking files for this project.\n\n' +
      'Arguments: $ARGUMENTS\n\n' +
      "If arguments are provided, use the first argument as `project_name`. " +
      "If `--description` is followed by a quoted string, pass it as `description`. " +
      "If `--force` is present, set `force: true`. " +
      "If no project name is given, ask the user for one before calling the tool.",
  },
  "ghs-config": {
    description: "重新生成 ghs 子代理 markdown（编辑 .ghs/ghs.json 后调用）",
    template:
      "Call the `ghs-config` tool to regenerate the ghs subagent markdown files " +
      "from the current `.ghs/ghs.json` config.\n\n" +
      "If `--dry-run` is present in the arguments, pass `dry_run: true`.",
  },
  "ghs-plan-start": {
    description: "启动 ghs 计划生成流程（上下文快照 → 计划设计 → 评审）",
    template:
      "Call the `ghs-plan-start` tool to start a new Golden Hoop Spell " +
      "plan-generation loop.",
  },
  "ghs-sprint": {
    description: "创建新的 ghs sprint（分解为原子 feature）",
    template:
      "Call the `ghs-sprint` tool to create a new sprint skeleton in features.json.\n\n" +
      "Arguments: $ARGUMENTS\n\n" +
      "Parse the arguments as: the first quoted string as `sprint_name`, " +
      "and the remainder (or second quoted string) as `goal`. " +
      "If either is missing, ask the user for the missing value(s) before calling the tool.",
  },
  "ghs-code": {
    description: "派发 ghs feature 实现（单个或并行批次）",
    template:
      "Call the `ghs-code` tool to dispatch feature implementation.\n\n" +
      "Arguments: $ARGUMENTS\n\n" +
      "If a feature ID (e.g. `s5-feat-003`) is provided, pass it as `feature_id`. " +
      "If `--parallel` is present, set `parallel: true`. " +
      "If no arguments are given, call without `feature_id` to get the next ready feature.",
  },
  "ghs-status": {
    description: "显示 ghs 项目状态（sprint/feature 进度）",
    template:
      "Call the `ghs-status` tool to display the current Golden Hoop Spell project status.",
  },
  "ghs-archive": {
    description: "归档已完成的 ghs sprint",
    template:
      "Call the `ghs-archive` tool to archive completed sprints.\n\n" +
      "Arguments: $ARGUMENTS\n\n" +
      "If `--dry-run` is present, pass `dry_run: true` for a preview. " +
      "If `--list` is present, pass `list: true` to list without archiving.",
  },
  "ghs-force-archive": {
    description: "强制归档所有 ghs sprint（含未完成的）",
    template:
      "Call the `ghs-force-archive` tool to force-archive all sprints regardless of status.\n\n" +
      "This requires a `transcription` nonce token — call `ghs-archive` first " +
      "to obtain one, then pass it here.\n\n" +
      "Arguments: $ARGUMENTS\n\n" +
      "Use the first argument as the `transcription` value.",
  },
};
