# AGENTS.md

Guidance for OpenCode agents working in this repo. This is an OpenCode plugin
port of the Claude Code `golden-hoop-spell` plugin — pure TypeScript, loaded by
OpenCode as a plugin (no build step, no Python runtime dep).

## Commands

- `bun test` — full suite (286 tests). **See the equivalence caveat below.**
- `bun test test/equivalence/` — only the Python-oracle equivalence tests.
- `bun run typecheck` (`tsc --noEmit`) — typecheck; `tsconfig.json` sets `noEmit`.
- To run everything *except* the machine-specific equivalence suite: run the
  other test dirs explicitly, e.g. `bun test test/integration test/e2e test/codegraph.test.ts`.
- There is **no lint / format / biome / eslint config** and **no CI** — do not
  invent `npm run lint`. Verification = `bun run typecheck && bun test`.

## Critical gotcha: the equivalence suite is machine-specific

`test/equivalence/*.test.ts` assert byte-identical output against the **source
Python plugin**, invoked as a subprocess. Two hard requirements (see
`test/equivalence/_helpers.ts`):

1. `python3` must be on PATH.
2. The original Claude Code plugin repo must be checked out at the **hardcoded
   absolute path** `$HOME/github/golden-hoop-spell/plugin` (the
   `PYTHON_SCRIPTS_DIR` / `GHS_SOURCE_ROOT` constants).

On any other machine these tests fail/error; this is expected and dev-only. Do
not "fix" the hardcoded path by relativising it — it is the intentional oracle.
If you can't run the oracle, run the non-equivalence subset instead.

## Architecture

- **Entrypoint**: `src/index.ts` default-exports `ghsPlugin` (defined in
  `src/plugin.ts`), which registers all 10 `ghs-*` tools and pushes a workflow
  hint into the system prompt. `package.json` `main` → `src/index.ts`.
- `src/tools/*.ts` — one module per `ghs-*` tool (thin orchestration).
- `src/lib/scripts/*.ts` — TypeScript ports of the source plugin's Python
  scripts (`init_project.py` → `init-project.ts`, etc.). These are the
  behavior source-of-truth; each file names its Python counterpart in a header
  comment. Keep ports byte-equivalent to the Python original (the equivalence
  suite enforces this).
- `src/prompts/*.ts` — LLM prompt templates (English — see language policy).
- `shared/` — shipped assets (agent `*.md.template` ×3, `ghs.default.json`,
  references). **Included in `npm pack`**; treat as public surface.
- `opencode.json` uses `"plugin": ["./src/index.ts"]` for local dev.

### Layout that is NOT shipped

- `spikes/` — one-off validation experiments; excluded from `tsconfig.json`
  and `package.json` `files`. Do not import from `src/`.
- `test/`, `docs/`, `.ghs/`, `bun.lock`, `tsconfig.json` — excluded from the
  tarball (see `package.json` `//packVerified`).
- `E2E_CHECKLIST.md` — manual verification checklist; some items cannot be
  automated (need a real OpenCode session + real LLM).

## Key constraints

- **Plugin root resolves via `import.meta.dir`**, never `process.cwd()` or
  `__dirname` (package is ESM). See `src/lib/paths.ts`. Changing this breaks
  asset resolution under `npm` cache / `file:` installs.
- **`.ghs/` is gitignored** except `test/fixtures/.ghs/` (the canonical test
  fixtures). Do not commit other `.ghs/` state.
- **codegraph MCP is optional**: detected by `.codegraph/` dir presence, else
  grep fallback. Don't hardcode `codegraph_codegraph_*` tool names in prompts
  (they depend on the MCP server name) — use descriptive phrasing.

## Conventions

- **Language policy** (from `CLAUDE.md`, applies to all agents/subagents):
  Chinese for human-readable output — conversation, docs, commit messages,
  TODO/FIXME, task/plan descriptions. English for code identifiers, log/error
  strings, and LLM-facing prompts. When spawning subagents, include the
  instruction: `使用中文回复和撰写所有文档/commit message。代码标识符、日志、错误信息用英文。`
- **Commit style**: Conventional Commits with a Chinese description and a
  `(Feature: sX-feat-YYY)` trailer tying back to the ghs sprint tracker,
  e.g. `feat(tools): 实现 ghs-code tool —— feature 实现工作流入口 (Feature: s4-feat-004)`.
- New `src/lib/scripts/*.ts` ports must keep a header comment pointing at the
  Python behavior source-of-truth path, and stay byte-equivalent (add/extend
  the matching `test/equivalence/*.test.ts`).

## ghs 增强:三机制(s1 sprint `workflow-planagent-skill`)

> 行为对照来源:`docs/ghs/plans/2026-06-22-ghs-plan-agent-skill-v41.md`(方案 v4.1 定稿)。
> 三机制正交,可独立落地 / 独立回滚。本节为面向 agent 的工作概览;精确语义以方案 §3 + 各 `src/` 实现为准。

### 机制一 Todo-Anchored Workflow(best-effort nudge,非程序级强制)

解决「plan/code 阶段易跳出 + 无右侧进度」。定性:**best-effort nudge + 检测提醒**,无法 100% 防止主 AI 跳出流程;右侧 TODO 面板**唯一驱动是内置 `todowrite`**(硬约束 C1,`Hooks` 接口无 write-todo hook)。

- **注入点①(SYSTEM_HINT + event hook,`src/plugin.ts`)**:`SYSTEM_HINT_TEXT` 含「Todo Discipline」段(进入 ghs 多步流程时调 `todowrite` 建阶段 checklist,随 stage 推进刷新;`▶ NEXT ACTION` 锚点必须严格执行)。`event` hook 监听 `todo.updated` → 调 `todo-tracker.recordTodoTick` 维护 session Map;带防御性类型守卫 `("type" in input.event) && input.event.type === "todo.updated"`(对应 R8)。
- **注入点②(工具返回文本,`src/lib/workflow-chrome.ts` + 五工具)**:四个纯函数 `stageHeader(stage)` / `todoDirective(stages, currentIdx)` / `nextActionAnchor(action)` / `staleTodoWarning(expectedStage)`,无副作用无 IO,便于快照测试。各多步工具返回文本 prepend `stageHeader`、按判定表 append `todoDirective`/`staleTodoWarning`、append `nextActionAnchor`。
- **断线检测(stage 状态机判定,`src/lib/todo-tracker.ts`)**:放弃 wall-clock,改用磁盘 `status.json` 的 `status` 字段作 stage 推进信号。`getStageSignature(toolName, projectDir, args)` 对 plan-* 读 status.json → `plan:${status}`,对 code → `code:<feature_id-or-batch>`,对单步工具 / 终态(`approved`/`rejected`/`aborted`)/ 无活跃 plan → `null`。`classifyStaleState` 返回判定表四行:`inactive`(`currentStage === null`,不参与)/ `never`(`lastTodoMs === undefined`,发 `todoDirective`)/ `drift`(`lastStageSeenByTool !== currentStage`,发 `staleTodoWarning`)/ `fresh`(相等,无提醒)。**关键时序**:`getStageSignature` 须在 handler 完成 `writePlanStatus` **之后**调用(post-advance),否则两性质落空。
- **注入点③(工具卡片阶段标注,主路径 `ctx.metadata()` + 兜底 `tool.execute.after` hook)**:主路径在各工具 `execute` 内 `ctx.metadata({ title: "[ghs] <stage>" })`;兜底 hook 首行门禁 `if (!input.tool.startsWith("ghs-")) return;`(对应 R4),通道 B 失败不影响通道 A。
- **回归定位**:`test/workflow-chrome.test.ts`(四函数快照)、`test/todo-tracker.test.ts`(判定表四行 + `getStageSignature` 各分支)、`test/event-discriminator.test.ts`(Event union type 判别完备)、`test/plugin-hook.test.ts`(门禁 no-op)、`test/plan-start.test.ts` / `plan-review.test.ts`(post-advance 时序断言)。

### 机制二 内置 plan agent opt-in

解决「未复用 opencode 内置 `Config.agent.plan`」。默认仍走 ghs 自建 dispatcher,不破坏字节级等价契约。

- **配置(`.ghs/ghs.json` + `shared/ghs.default.json`)**:`GhsConfigSchema` 加 `planner_backend: z.enum(["ghs-plan-designer", "builtin-plan"]).default("ghs-plan-designer")`。合法值 `ghs-plan-designer`(默认)/ `builtin-plan`;非法值 ZodError 上抛(由 `ghs-config` strict 报错 surfaced)。
- **合并逻辑(`src/lib/config.ts` `loadGhsConfig`)**:新增 `plannerBackendFellBack` 分支,并入现有 `*FellBack` 模式;`merged` 含 `planner_backend` 字段;`defaults_used` 累加。当前 schema 下 `.default()`+enum 使 `plannerBackendFellBack` 恒 `false`(保留为类型对称 + 前向兼容锚点)。老项目 ghs.json 缺该字段 → `.default(...)` 填默认,无须迁移。
- **读取入口(`src/tools/plan-review.ts`)**:`handleSnapshotMode` 与 `handleReviewMode` revise 分支返回派发指令前各调一次 `loadGhsConfig(projectDir, pluginRoot())`,`config.planner_backend` 传 `getDesignerPrompt(backend)`。**两类错误处理(按 `err.message` 是否含默认文件 label `ghs.default.json` 区分)**:命中(默认文件缺失/非法)→ 落回 `ghs-plan-designer` + warning 拼接进返回字符串末尾(非 `console.*`,`execute()` 只返回纯字符串 C2);否则(用户 ghs.json 非法:JSON 解析错 / ZodError)→ re-throw 上抛。
- **双 prompt 选择器(`src/prompts/plan-designer.ts`)**:`getDesignerPrompt(backend)` 返回 `PLAN_DESIGNER_PROMPT`(默认)或 `PLAN_DESIGNER_PROMPT_BUILTIN`(内嵌分隔标记契约说明,只用名称指代起始/结束分隔标记,不写死字面量)。
- **回归定位**:`test/config.test.ts`(planner_backend 7 类断言)、`test/plan-review.test.ts`(builtin 派发指令 + 两类错误处理)。
- **降级预案(对应 R3/D3)**:内置 plan agent 输出不带分隔标记 → `parsePlan` empty/malformed 重试;`planner_backend` 默认 `ghs-plan-designer`;最坏 `builtin-plan` 仅作文档引导(见 `shared/references/plan-designer.md`「可选:复用内置 plan agent」一节)。LLM 遵循度待 E2E 确认(见 `E2E_CHECKLIST.md`)。

### 机制三 Skill 封装

解决「commands 无法被 `/skill-creator` eval/回归」。把 ghs 编排能力封装为 skill。

- **`shared/skill/ghs/SKILL.md`**:编排规则(引用机制一 Todo Discipline + stage 推进刷新 todo + `▶ NEXT ACTION` 衔接 + 断线恢复)。**frontmatter `name: ghs` + `description` 必填**,否则被剔出 `available_skills` 系统提示(硬约束,feat-010 spike 反编译确认 opencode v1.17.9 加载 glob `{skill,skills}/**/SKILL.md`)。
- **`ghs-init` 复制**:`shared/skill/ghs/SKILL.md` → `<projectDir>/.opencode/skill/ghs/SKILL.md`(复用 `pluginRoot()`,源存在保护、幂等)。
- **SYSTEM_HINT 瘦身**:瘦身为指向 ghs skill 的指针,**保留** Todo Discipline + 工具列表(机制一依赖 hint nudge 主 AI 调 `todowrite`,右侧面板纪律仍需 hint 提示,不能全删)。agent markdown 仅启动加载、无热重载(C4),新增/改 skill 须重启 OpenCode。
- **回归定位**:`test/init.test.ts`(SKILL.md 字节一致)、`test/commands.test.ts`(SYSTEM_HINT 仍含工具列表)。
- **定位澄清(对应 R5)**:`/skill-creator eval` 对编排型 skill 的 benchmark 需对「工具调用序列」断言;即便 benchmark 不划算,SKILL.md 作「人类可读编排规范 + 系统提示内可见 skill」已兑现机制三核心价值。

### 验证命令(不变)

- `bun run typecheck`(`tsc --noEmit`)。
- `bun test`(非 equivalence 子集):见本文档「## Commands」与「## Critical gotcha: the equivalence suite is machine-specific」。三机制均不动 `src/lib/scripts/*` 移植输出,不在 equivalence 对照范围(对应 R6)。
- 手动 E2E 项见 `E2E_CHECKLIST.md`。
