# ghs 插件：内置 plan agent 集成 + 流程连贯性 + 右侧进度 + skill 化方案（定稿 v4.1）

> 演进：v1(round-1 FAIL) → v2(FAIL) → v3(FAIL) → v4(round-4 PASS, 3 Optimization) → v4.1（定稿，fold 进 round-4 的 3 条 Optimization 提质建议）。
>
> 本方案在现有 10-tool + 8-slash-command 架构上做**增强**（不重写状态机、不迁移工具到 skill），通过三个正交机制解决用户诉求 1/2/3/5/6（用户原始编号 4 与 3 同根源——slash 命令形态限制——合并入机制三）。

---

## §1 背景与目标

### §1.1 需求根因映射表

| 编号 | 用户诉求 | 根因（现状） | 本方案机制 |
|------|---------|-------------|-----------|
| 1 | ghs-plan-designer 未复用 opencode 内置 Plan Agent | ghs 自建 3 个 subagent markdown + Task 派发 + delimited 解析，未触碰 Config.agent.plan | 机制二：opt-in planner_backend 切换 |
| 2 | 套件执行断续，plan 阶段易跳出，agent 自己接手 | 工具间无程序级编排，唯一耦合是磁盘 status.json + 返回文本 + SYSTEM_HINT | 机制一：Todo-Anchored Workflow（三注入点 nudge + 断线检测） |
| 3 | commands 暴露无法用 /skill-creator 做 eval/回归 | 8 个 /ghs-* 是 cfg.command 提示串，非 skill 形态 | 机制三：Skill 封装 |
| 5 | plan 阶段全在主窗口，无右侧 TODO 式进度 | 右侧面板只由内置 todowrite 驱动（C1），SYSTEM_HINT 当前未要求主 AI 调 todowrite | 机制一注入点①+②：nudge 主 AI 调 todowrite |
| 6 | code --parallel 同样断续 + 无右侧进度 | dispatchParallelPlan 全程依赖主 AI 顺承文本，并行场景断点更多 | 机制一注入点②+③：code 工具同样追加 todo 指令 + 批次卡片标注 |

### §1.2 硬约束（不可违反）

- **C1**：`Hooks` 接口无「写 todo」hook；右侧 TODO 面板只由内置 `todowrite` 工具（主 AI 在会话内主动调用）驱动，插件工具的 `execute()` 无法直接 push todo / 渲染面板。
- **C2**：`execute(args, ctx)` 只返回**纯字符串**（LLM-facing 文本），不能返回结构化 UI 指令。
- **C3**：`ToolContext.metadata({title?, metadata?})` 可设工具卡片 title/metadata；`tool.execute.after` hook 的 `output` 也可改 `title`/`metadata`/`output`（`index.d.ts:217-226`）。
- **C4**：agent markdown 仅在 OpenCode 进程启动时加载，无热重载（每次 ghs-config 后须重启）。
- **C5**：opencode 内置 `Config.agent.plan` 存在（`types.gen.d.ts:1273`），与 build/general/explore 并列。

### §1.3 目标

- **G1**（需求 1）：提供 opt-in 通道复用内置 plan agent，默认仍走 ghs 自建 dispatcher，不破坏现有字节级等价契约。
- **G2**（需求 2/6）：通过 best-effort nudge + 可观测的断线检测，显著降低 plan/code 阶段主 AI「跳出流程自己接手」的概率。**明确声明：本机制非程序级保证，无法 100% 防止跳出。**
- **G3**（需求 5/6）：在 ghs 多步流程中，右侧面板显示阶段 checklist。**依赖主 AI 主动调 todowrite（C1），属 best-effort；工具卡片阶段标注作为可视化补充，不驱动面板。**
- **G4**（需求 3 / 原 4）：将 ghs 编排能力封装为 skill，使其可被 /skill-creator eval/回归。

### §1.4 范围

- **in-scope**：SYSTEM_HINT 增强；新增 workflow-chrome.ts；tool.execute.after hook（带门禁）；planner_backend 配置（含 loadGhsConfig 合并逻辑改造 + plan-review.ts 读取入口）；SKILL.md + ghs-init 复制；相关单测；E2E_CHECKLIST 手动项。
- **out-of-scope**：不改 plan-review 三模式状态机的流转逻辑；不改 features.json schema；不引入构建步骤；不破坏 equivalence 套件（机器相关，本机外失败属预期）。

---

## §2 现状分析

### §2.1 连贯性弱点
工具间无程序级编排，主 AI 一旦不遵循返回文本「Next step」即跳出。`SYSTEM_HINT_TEXT`（src/plugin.ts:55-60）当前只列工具名 + 流程顺序 + 模型配置入口，未要求主 AI 调 todowrite，也未对「跳出」做检测。`execute()` 无法读取会话内 todo 列表（Hooks 无 read-todo API），但 `event` hook 可监听 `todo.updated` 事件（`EventTodoUpdated.type === "todo.updated"`，types.gen.d.ts:378-379）——断线检测唯一可用的旁路信号。

### §2.2 内置 plan agent 现状
`Config.agent.plan` 存在（C5）但 ghs 未复用。ghs 当前用 `shared/agents/ghs-plan-designer.md.template`（frontmatter `mode: subagent` + 预置分隔标记契约）+ 主 AI Task 派发 + parsePlan 解析。内置 plan agent 没有预置 ghs 分隔标记契约，若直接复用需在派发指令里内嵌契约说明，且其输出是否遵循契约需 spike 验证。

### §2.3 skill / slash command 现状
8 个 /ghs-* 是 `cfg.command` 提示串（src/lib/commands.ts:37），非 skill 形态。`shared/skill/` 目录不存在。ghs-init 当前只建 `.ghs/` + `.opencode/agents/`，未建 `.opencode/skill/`。

### §2.4 planner_backend 配置读取链路现状

- `GhsConfigSchema`（src/lib/config.ts:27-33）是 `z.strictObject`，当前仅 `models: { context, designer, reviewer }`。`z.infer` → `GhsConfig` 类型仅含 `models`。
- `loadGhsConfig`（src/lib/config.ts:138-192）合并逻辑硬编码：逐字段手写 context/designer/reviewer 的「非空取用户值，否则取默认值并置 `*FellBack` 布尔」；合并产物字面量 `const merged: GhsConfig = { models: {...} }`（config.ts:188）；`defaults_used = contextFellBack || designerFellBack || reviewerFellBack`（config.ts:189）。
- 直接给 schema 加 `planner_backend: z.enum([...]).default("ghs-plan-designer")` 的连锁后果：`.default(...)` 让旧 ghs.json 缺字段不报错；但 `GhsConfig` 推断类型新增必填 `planner_backend: string`（zod `.default()` 使输入可选、输出必填），上述 `merged` 字面量直接 typecheck 失败；即便补类型，逐字段硬编码合并不会把 planner_backend 纳入合并产物 / defaults_used，用户值被静默丢弃。`SyncAgentsResult`（config.ts:230-237）与 `defaults_used` 语义当前仅覆盖三个模型字段回退。
- `plan-review.ts`（src/tools/plan-review.ts:1-759）当前完全不读 `.ghs/ghs.json`（无 loadGhsConfig/ghs.json/pluginRoot 引用）；`handleSnapshotMode`（plan-review.ts:323-375）与 `handleReviewMode` revise 分支（plan-review.ts:601-636）直接静态 import `PLAN_DESIGNER_PROMPT`（plan-review.ts:60）并拼接返回文本——机制二要新增读取路径的位置。

---

## §3 方案设计

### §3.0 机制总览与正交性

三个机制正交，可独立落地、独立回滚：机制一（Todo-Anchored Workflow，解决 2/5/6）；机制二（内置 plan agent opt-in，解决 1）；机制三（Skill 封装，解决 3/原 4）。机制三的 SKILL.md 引用机制一纪律但不依赖它；机制二与机制一完全独立。

### §3.1 机制一 —— 三注入点协同的状态/数据流

**定性**：三个注入点全部是 **best-effort nudge / 可视化补充 / 检测+提醒**，**不是程序级强制**。无法 100% 防止主 AI 跳出流程。右侧 TODO 面板**唯一驱动是内置 todowrite**（C1）；注入点①②是 nudge 主 AI 调 todowrite；注入点③只是工具卡片可视化，与右侧面板解耦。

**两个独立通道**：
- 通道 A（右侧面板，唯一驱动 = todowrite）：SYSTEM_HINT(①) 与 工具返回文本(②) nudge 主 AI 调 todowrite → 面板渲染 checklist。若主 AI 不调 → 面板为空，机制一无法补救（best-effort）。
- 通道 B（工具卡片可视化，与通道 A 解耦）：`execute()` 内 `ctx.metadata`(③主路径) 与 `tool.execute.after` hook(③兜底路径, 带门禁) 设工具卡片 title/metadata。通道 B 失败不影响通道 A。

#### 断线检测（两分支 + stage 状态机判定）

**判定信号源**：放弃 wall-clock，改用磁盘 `status.json` 的 `status` 字段作为 stage 推进信号。理由：(a) stage 状态机是 ghs 工具自身写入的权威进度，无子代理耗时耦合；(b) 不依赖进程内时钟，无「重启重置」问题；(c) status.json 已是工具间唯一耦合点，复用零新增状态。

**stage 签名函数 `getStageSignature(toolName, projectDir, args): Promise<string | null>`**（src/lib/todo-tracker.ts 内）：
- 对 plan-start / plan-review / plan-finalize：读 status.json 的 status 字段（复用 `findActivePlanStatus`）→ 签名 `"plan:${statusValue}"`。
- 对 code：签名 `"code:<feature_id-or-batch-key>"`。
- 对其它工具（init/config/sprint/status/archive/force-archive）：返回 null。
- **对 `findActivePlanStatus === null`（无活跃 plan，如已 finalize）或 `isTerminal(status)`（如 approved/rejected/aborted）的情形返回 null**（→ 判定表第 1 行，不参与断线检测），与 src/tools/plan-review.ts 已有的 `isTerminal` 判定一致——避免 plan-finalize 写 `status="approved"` 终态后误报语义错位的 staleTodoWarning。

**进程内追踪状态 `Map<sessionID, { lastTodoMs: number | undefined; lastStageSeenByTool: string | null }>`**：
- `event` hook 监听 `todo.updated`，触发时只更新 `lastTodoMs = Date.now()`，不动 `lastStageSeenByTool`。
- 每次 ghs 多步工具 execute 时，调 `getStageSignature` 得 `currentStage`，与 `lastStageSeenByTool` 比较，再更新后者。
- **时序约束（关键）**：`getStageSignature` 在各工具 handler 完成 `writePlanStatus` / 等价状态写入**之后**调用，读取 **post-advance** 的 status 字段。这是判定表「stage 已推进」语义与两条关键性质（首个调用发 todoDirective / stage 跃迁即发 staleTodoWarning）自洽的前提；pre-advance 时序会使两者之一落空：
  - (i) 首个 ghs-plan-start 调用——执行前 status.json 不存在，post-advance 读到 `"plan:designing"` 且 `lastTodoMs === undefined` → 判定表第 2 行 → 发 todoDirective（pre-advance 读 null → 第 1 行 → 无 chrome，性质落空）。
  - (ii) stage 推进（designing→reviewing）——跃迁发生在 `handlePlanMode` 的 `writePlanStatus` 内，post-advance 读到 `"plan:reviewing"` ≠ 上次 `"plan:designing"` → drift → staleTodoWarning（pre-advance 读 `"plan:designing"` = 上次 → fresh → warning 滞后一轮，性质落空）。

**判定表（显式化，实现者无须反推）**：

| 条件（按上到下首匹配） | 输出（append 到工具返回文本） | 语义 |
|------------------------|------------------------------|------|
| `currentStage === null` | 不追加任何 chrome | 单步工具 / 终态 / 读失败，不参与 |
| `lastTodoMs === undefined`（该会话从未记录 todo.updated） | `todoDirective(stages, currentIdx)` | 建设性首次/重复 nudge：列出 checklist + 标当前 in_progress。**不发** staleTodoWarning，避免倒挂与「预设上一阶段」 |
| `lastTodoMs !== undefined` 且 `lastStageSeenByTool !== currentStage` | `staleTodoWarning(currentStage)` | 漂移提醒：stage 已推进但 todo 未跟随刷新 |
| `lastTodoMs !== undefined` 且 `lastStageSeenByTool === currentStage` | 不追加 stale/todo（仅 nextActionAnchor） | 当前 stage 的 todo 已维护 |

**关键性质**：首个 ghs 工具调用恒走第 2 行发 todoDirective；始终不调 todowrite 的非合规 AI 每次走第 2 行收**建设性** todoDirective（而非倒挂的 staleTodoWarning）；合规 AI 在子代理长跑后只要 stage 推进收 staleTodoWarning，stage 未推进无提醒（消除 wall-clock 误报）。

**阈值论证**：选 stage 状态机判定而非 120s——120s 与「子代理预期耗时」耦合，子代理耗时随模型/复杂度漂移，任何固定阈值都可能变误报源；stage 判定零 wall-clock 耦合、零子代理耗时耦合、零「重启重置」问题。

**三注入点明细**：

**注入点① SYSTEM_HINT 增强 + event hook**（src/plugin.ts）
- SYSTEM_HINT 追加「Todo Discipline」：进入 ghs 多步流程时调 todowrite 建阶段 checklist 并随 stage 推进更新（每个 stage 转换 = 上一 stage 标 completed、当前标 in_progress）；`▶ NEXT ACTION` 锚点必须严格执行，不要跳过下一步工具调用自己接手。
- 新增 `event` hook 维护 Map。**Event union 判别防御**：确认 `Event` union（types.gen.d.ts:819，~46 子类型）每成员带 `type` 判别字段 + 防御性类型守卫 `("type" in input.event) && input.event.type === "todo.updated"`。

**注入点② 工具返回文本增强**（新增 src/lib/workflow-chrome.ts）
纯函数：`stageHeader(stage)` / `todoDirective(stages, currentIdx)` / `nextActionAnchor(action)` / `staleTodoWarning(expectedStage)`。各工具返回文本 prepend stageHeader，按判定表 append + nextActionAnchor。code 并行场景的 todoDirective 按 batch 展开。

**注入点③ 工具卡片阶段标注**
- 主路径：`execute` 内 `ctx.metadata({ title: "[ghs] <stage>", metadata: {...} })`。只增强工具卡片可见性，**不驱动面板**。
- 兜底路径：`tool.execute.after` hook，首行 `if (!input.tool.startsWith("ghs-")) return;` 门禁，设 `output.title`/`output.metadata`。

### §3.2 机制二 —— 内置 plan agent opt-in

#### §3.2.1 配置读取改造

**改造点 (a)：`loadGhsConfig` 合并逻辑泛化**（src/lib/config.ts:138-192）
- `GhsConfigSchema` 加 `planner_backend: z.enum(["ghs-plan-designer", "builtin-plan"]).default("ghs-plan-designer")`。
- `shared/ghs.default.json` 加 `"planner_backend": "ghs-plan-designer"`。
- `loadGhsConfig` 新增显式 `plannerBackendFellBack` 分支，并入现有 `*FellBack` 模式；`merged` 改为 `{ models: {...}, planner_backend }`；`defaults_used` 累加 `plannerBackendFellBack`。（当前 schema 下 `plannerBackendFellBack` 恒 false，保留分支为类型对称 + 前向兼容——将来若改为 `z.string().optional()` 允许缺省即生效。）

**改造点 (b)：`plan-review.ts` 读取入口**
- 复用 `loadGhsConfig(projectDir, pluginRoot())`（不新增 reader）。`pluginRoot()` 基于 `import.meta.dir`（src/lib/paths.ts:22-25），与 `syncAgents` 一致。
- 读取时机：`handleSnapshotMode` 与 `handleReviewMode` revise 分支返回派发指令前各调一次，`config.planner_backend` 传 `getDesignerPrompt(backend)`。
- **错误处理（区分两类错误 + 显式判别机制）**：两处读取点各包一层 `try { const { config } = await loadGhsConfig(...); backend = config.planner_backend; } catch (err) { ... }`。catch 块**按 `err.message` 是否含默认文件 label `ghs.default.json` 区分**：
  - 命中默认文件错误（`shared/ghs.default.json` 缺失/非法，config.ts:142-144）→ **走兜底**：置 `backend = "ghs-plan-designer"`，并将 warning 行**拼接进 `execute()` 返回字符串末尾**确保主 AI 可见（非 `console.*` 调用——`execute()` 只返回纯字符串，见 C2）。兜底命中条件：插件包损坏致 `shared/ghs.default.json` 缺失/非法（极罕见，AGENTS.md 约束 shared/ 随包发布）。
  - 否则（用户 `ghs.json` 非法：`readJsonFile` JSON 解析错 config.ts:154 或 `GhsConfigSchema.parse` ZodError config.ts:159）→ **re-throw 让错误上抛**（与 ghs-config 工具的 strict 报错上抛风格一致，避免用户字段拼写错被工具链静默吃掉）。
  - 正常路径：`loadGhsConfig` 对用户 `ghs.json` 缺失走「全默认返回 `defaults_used: true`」（config.ts:150-152）不抛，无需 try/catch。
- init 已 seed 语义对齐：老项目 ghs.json 缺 planner_backend → parse 时 `.default(...)` 填默认 → 平滑兼容，无须迁移。
- **派发 prompt 选择器**（src/prompts/plan-designer.ts）：新增 `PLAN_DESIGNER_PROMPT_BUILTIN`（内嵌分隔标记契约说明，只用名称指代起始/结束分隔标记）；导出 `getDesignerPrompt(backend)`。

#### §3.2.2 机制二其余设计
Phase 2 第一步 spike 验证内置 plan agent 能否被 Task 派发 + 是否遵循注入的分隔标记契约（见 §4 Phase 2 / §5 D3 降级）。

### §3.3 机制三 —— Skill 封装
- 新增 `shared/skill/ghs/SKILL.md`（编排规则，引用机制一纪律文本，含 stage 推进时刷新 todo / ▶ NEXT ACTION 衔接纪律 / 断线恢复）。
- `ghs-init` 复制到 `<projectDir>/.opencode/skill/ghs/SKILL.md`（复用 pluginRoot）。
- SYSTEM_HINT 瘦身为 skill 指针（保留 Todo Discipline + 工具列表）。
- Phase 3 第一步 spike 验证 `.opencode/skill/ghs/` 加载路径 + /skill-creator eval。

---

## §4 实施步骤

> 验收区分 **[自动化]**（bun test / typecheck）与 **[手动 E2E]**（真实 OpenCode 会话 + LLM，记入 E2E_CHECKLIST.md）。

### Phase 1 —— 机制一（Todo-Anchored Workflow）
**步骤**：(1) 新增 workflow-chrome.ts；(2) plugin.ts SYSTEM_HINT + event hook + tool.execute.after hook（带门禁）；(3) todo-tracker.ts（session Map + recordTodoTick + getStageSignature + classifyStaleState 返回 `never|drift|fresh|inactive`）；(4) 改五工具返回文本；(5) Event union 判别完备性核对；(6) 写测试。

**验收 [自动化]**：
- `test/workflow-chrome.test.ts`：四纯函数快照。
- `test/plugin-hook.test.ts`（新增）：`tool.execute.after` 对非 ghs 工具（todowrite/read/bash）**no-op**（落实门禁）；对 ghs 工具设 title/metadata。
- `test/todo-tracker.test.ts`：recordTodoTick/getStageSignature/classifyStaleState 覆盖判定表四行；getStageSignature 对 plan-review 读 status 字段、对 code 读 feature_id/batch、对单步工具返回 null、**对终态 status（approved/rejected/aborted）或无活跃 plan 返回 null**；不依赖 wall-clock。
- `test/event-discriminator.test.ts`：Event union 每成员 `type` 字面量字符串（compile-time + 运行时样本）。
- 现有 test/plan-review.test.ts / plan-start / code：断言返回文本含 stageHeader + ▶ NEXT ACTION；**首个 ghs 工具调用场景含 todoDirective（而非 staleTodoWarning）**。
- **post-advance 时序断言**：`test/plan-start.test.ts` 断言返回文本含 todoDirective 且 stageHeader 标 `plan:designing`（post-advance 读到刚 writePlanStatus 写入的 designing，而非 pre-advance 的 null）；`test/plan-review.test.ts` plan 模式成功路径断言返回文本含 `staleTodoWarning` 且期望 stage 为 `plan:reviewing`（post-advance 读到 handlePlanMode 刚写入的 reviewing）——**该断言的前置 setup（须显式）**：(a) 测试先注入一次 todo.updated 事件设 `lastTodoMs`（否则 `lastTodoMs === undefined` → 走 todoDirective 分支）；(b) 测试先跑一次 snapshot 模式（或直接注入）设 `lastStageSeenByTool = "plan:designing"` 作为 drift 基线（否则无 drift 基线不会触发 staleTodoWarning）。
- `bun run typecheck && bun test`（非 equivalence 子集）全绿。

**验收 [手动 E2E]**：右侧面板出现 plan 阶段 checklist；工具卡片显示 `[ghs] Phase` 标题；故意不调 todowrite → 下一个 ghs 工具返回 todoDirective（非 staleTodoWarning）；stage 推进但未刷新 todo → 返回 staleTodoWarning。

**回滚**：删 workflow-chrome.ts/todo-tracker.ts；plugin.ts 还原；五工具返回文本还原。纯增量，无数据迁移。

### Phase 2 —— 机制二（内置 plan agent opt-in）
**步骤**：(1) Spike（spikes/builtin-plan-probe.ts）验证内置 plan agent Task 派发 + 分隔标记遵循；(2) 据 spike 实现或降级文档引导；(3) 配置读取改造（§3.2.1）；(4) plan-designer.ts 双 prompt + getDesignerPrompt。

**验收 [自动化]**：
- `test/config.test.ts`：planner_backend 默认（无 ghs.json）/ 自定义 builtin-plan / 非法值 enum 报错；typecheck 不破坏（`config.planner_backend` 类型 string）；合并产物含字段（`merged.planner_backend === userValue` 当指定 / `=== "ghs-plan-designer"` 当缺省）；`defaults_used` 语义（planner_backend 走默认时不单独置 true）——**当前 schema 下 `.default()`+enum 使 plannerBackendFellBack 恒 false，此断言 trivially true，保留为前向兼容锚点，将来改为 optional 才生效**；ghs.json 缺失回退不抛。
- `test/plan-review.test.ts`：planner_backend=builtin-plan 返回 builtin 派发指令（含内嵌契约说明）；默认时回归现有指令；**读取兜底（区分两类错误）**：mock 抛「默认文件缺失/非法」（`shared/ghs.default.json`）→ 落回 ghs-plan-designer + 返回字符串末尾含 warning 行（拼接，非 console.*）；mock 抛「用户 ghs.json 非法（config.ts:154 readJsonFile JSON 解析错 / config.ts:159 ZodError）」→ 断言该错误**上抛**（不被 catch 吞掉）。
- **equivalence 措辞**：equivalence 仅覆盖 `src/lib/scripts/*` 移植，本 phase 承诺 planner_backend 默认值保持现有 ghs-plan-designer 路径，不改变任何被 equivalence 覆盖的脚本输出。

**验收 [手动 E2E]**：planner_backend=builtin-plan 全流程（Task 派发内置 plan agent + 输出带分隔标记 + 落盘）；非法 planner_backend → ghs-config strict 报错。

**回滚**：planner_backend 默认 ghs-plan-designer 删除即回退；loadGhsConfig 分支删除后类型回归。

### Phase 3 —— 机制三（Skill 封装）
**步骤**：(1) Spike 验证 skill 加载路径 + /skill-creator eval；(2) 新增 shared/skill/ghs/SKILL.md；(3) init.ts 复制；(4) SYSTEM_HINT 瘦身。
**验收 [自动化]**：test/init.test.ts（SKILL.md 字节一致）；test/commands.test.ts（SYSTEM_HINT 仍含工具列表）。
**验收 [手动 E2E]**：/skill-creator eval。
**回滚**：删 shared/skill/ + init 复制 + SYSTEM_HINT 还原。

### Phase 4 —— 集成验证 + 文档
全量 `bun run typecheck && bun test`；更新 AGENTS.md + E2E_CHECKLIST.md（含断线检测两分支验证项）；更新 `shared/references/plan-designer.md` 补「可选：复用内置 plan agent」一节。

---

## §5 风险与缓解

| ID | 风险 | 概率 | 影响 | 缓解 / 降级预案 |
|----|------|------|------|----------------|
| R1 | 主 AI 仍不调 todowrite | 中 | 面板为空 | best-effort。降级 D1：通道 B 仍工作；never 分支恒发 todoDirective；不阻断流程 |
| R2 | tool.execute.after 签名变化/不触发 | 低 | 通道 B 兜底失效 | 已有 ctx.metadata() 主路径。降级 D2：event hook 不可用时 lastTodoMs 恒 undefined → 恒走 never 分支 |
| R3 | 内置 plan agent 输出不带分隔标记 | 中 | builtin 路径 parsePlan 失败 | 降级 D3：parsePlan empty/malformed 分支返回重试；planner_backend 默认 ghs-plan-designer；最坏 builtin 仅作文档引导 |
| R4 | tool.execute.after 对非 ghs 工具误触 | 中 | 污染其它工具卡片 | `if (!input.tool.startsWith("ghs-")) return;` 门禁 + 专项单测 |
| R5 | SKILL.md 编排型 skill 不被 /skill-creator 支持 | 中 | 机制三 eval 不可用 | SKILL.md 作人类可读参考保留 |
| R6 | equivalence 套件失配 | 低 | 本机外失败（预期） | equivalence 仅覆盖 `src/lib/scripts/*` 移植；workflow-chrome 与 planner_backend 均不在对照范围 |
| R7 | stage 判定依赖磁盘 status.json 读取 | 低 | getStageSignature 读失败退化 | 降级：try/catch 读失败返回 null → **该次调用跳过 chrome 注入（视为本次无法判定 stage）**，不归类为单步工具；与 findActivePlanStatus 容错一致 |
| R8 | Event union 某成员缺 type 判别字段 | 低 | event hook 抛 undefined.type | Phase 1 完备性核对 + 防御性类型守卫 + event-discriminator.test.ts |
| R9 | loadGhsConfig 改造破坏现有 config.test.ts | 低 | config 单测红 | 显式扩展保留现有三分支不动，仅追加 planner_backend 分支 |

---

## §6 测试策略

**自动化**：workflow-chrome.ts 四函数快照；plugin-hook.ts 门禁；todo-tracker.ts（stage 状态机判定，覆盖判定表四行）；event-discriminator.ts（Event union 判别完备性）；config.test.ts（planner_backend 7 类断言——默认/自定义/非法值/合并产物含字段/typecheck/defaults_used/ghs.json 缺失回退）；plan-review.test.ts（builtin 派发指令 + 读取兜底两类错误）；init SKILL.md 字节一致；现有测试回归（含首个 ghs 工具调用含 todoDirective）。

**手动 E2E**：右侧面板 checklist；工具卡片 `[ghs] Phase`；故意跳过 todowrite → todoDirective；stage 推进未刷新 → staleTodoWarning；planner_backend=builtin-plan 全流程；/skill-creator eval。

**验证命令**：`bun run typecheck && bun test`（本机）；其它机器跑非 equivalence 子集（见 AGENTS.md equivalence 警告）。
