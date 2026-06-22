# E2E 验证清单 (E2E_CHECKLIST.md)

> Feature s5-feat-006 交付物 A。本清单把 plugin 的验证拆成两类：
> **已自动化覆盖**（`bun test` 跑得到，指向具体测试文件）与
> **须人工在真实 OpenCode 会话执行**（需要真实 runtime / GUI / 真实 LLM，无法在 CI/agent 内自动化）。
>
> 真实 OpenCode 会话无法在 CI/agent 内自动化（需 GUI / 真实 runtime / 真实 LLM），
> 故这部分落为本清单。每项都给出：勾选框 + 简明步骤 + 预期结果。
> 对应 plan §Phase 5（验证）+ §6（端到端手动测试 / 兼容性测试）。

---

## ✅ 已自动化覆盖

下列项均由 `bun test` 全套覆盖（基线 283 + 本 feature 新增 fresh-install 测试 = 286 pass），
`bunx tsc --noEmit` 同时通过。每项指向其测试文件，改动后在 CI/本地即可即时发现回归。

- [x] **Plan dispatcher 循环（R2 核心）** —— `test/integration/plan-dispatch.test.ts`
  - 端到端跑 3-tool plan 循环（plan-start → plan-review → plan-finalize），断言 3 个 subagent
    都经 Task tool 派发、模型 ID 从 `.ghs/ghs.json` 正确解析、`.ghs/plans/` 产物 schema 正确。
- [x] **codegraph 路径（可用 / 不可用）** —— `test/integration/codegraph-paths.test.ts`
  - R1 路径：有 `.codegraph/` 时走 MCP 工具；无 `.codegraph/` 时走 grep 兜底。两条分支均覆盖。
- [x] **config-sync（R3 模型配置同步）** —— `test/integration/config-sync.test.ts`
  - `ghs-config` 从 `.ghs/ghs.json` 读取模型 ID，生成 / 更新 `.opencode/agents/ghs-*.md` 三份
    Markdown agent 文件（含 `model` frontmatter）。
- [x] **多模型编排（multi-model orchestration）** —— `test/integration/multi-model-orchestration.test.ts`
  - 3 个 subagent 用各自配置的模型；改 `ghs.json` 后 `ghs-config` 能同步新模型到 agent 文件。
- [x] **ghs-code 派发** —— `test/integration/code-dispatch.test.ts`
  - `ghs-code` 返回 feature-impl prompt 后，由主 AI 经 Task tool 派发 coding subagent。
- [x] **全流程串联（init → … → archive）** —— `test/e2e/full-workflow.test.ts`
  - 在 temp 项目中链完整 11 步生命周期，断言每步产物（`.ghs/features.json`、`.ghs/plans/`、
    `.ghs/ghs.json`、`.opencode/agents/`、archive 迁移），含模型切换 smoke。
- [x] **npm pack 产物（55 文件、无 .py 泄漏）** —— 见 `package.json` 的 `//packVerified` 标记
  （s5-feat-004 / commit 522f51a）。tarball 含 `src/` + `shared/`，排除 `test/`、`.ghs/`、
    `spikes/`，入口 `main → src/index.ts → ghsPlugin`。
- [x] **fresh-install 模拟（本 feature 新增）** —— `test/e2e/fresh-install.test.ts`
  - 导入 `ghsPlugin` 调用后断言 `tool` registry 恰好暴露 10 个 `ghs-*` 工具（连字符 key）；
    解析 `shared/opencode.json.example` 断言 `plugin` + `mcp.codegraph` 段引用了插件入口与
    codegraph MCP（模拟用户把示例配置合并进新项目 `opencode.json`）；镜像 s5-feat-004 校验
    `package.json` `files` 白名单 + 入口一致性。

---

## 👤 须人工在真实 OpenCode 会话执行

以下项无法在 CI/agent 内自动化，须在真实 OpenCode 会话中按步骤手验。每项执行后在
`[ ]` 中打勾并附日期/观察。

### 1. 本地 `file:..` 安装路径
- [ ] **步骤**：在一个全新空项目中创建 `opencode.json`，写入
  `"plugin": ["file:../<path-to-ghs-opencode>"]`；把 `shared/opencode.json.example` 的
  `mcp.codegraph` 段一并合并进去；重启 OpenCode 会话。
- [ ] **预期**：会话启动后可看到 10 个 `ghs-*` 工具（ghs-init / ghs-config /
  ghs-plan-start / ghs-plan-review / ghs-plan-finalize / ghs-sprint / ghs-code /
  ghs-status / ghs-archive / ghs-force-archive）。

### 2. npm 安装路径
- [ ] **步骤**：在另一个全新空项目中 `bun add golden-hoop-spell-opencode`；在 `opencode.json`
  的 `plugin` 数组中加入 `"golden-hoop-spell-opencode"`；合并 `mcp.codegraph` 段；重启会话。
- [ ] **预期**：同上 —— 10 个 `ghs-*` 工具出现；`@ghs-*` subagent（ghs-context-haiku /
  ghs-plan-designer / ghs-plan-reviewer）在 `ghs-init` + `ghs-config` 后于 `.opencode/agents/`
  生成并可用。

### 3. 合并 `shared/opencode.json.example` 的 `plugin` + `mcp` 段
- [ ] **步骤**：把示例文件的 `plugin` 数组与 `mcp.codegraph` 对象合并到目标项目的
  `opencode.json`（注意不要覆盖该项目已有的 `plugin` / `mcp` 条目，而是追加）。
- [ ] **预期**：合并后 `opencode.json` 同时声明了 ghs 插件与 codegraph MCP；OpenCode
  能解析该配置并加载插件（无 schema 报错）。

### 4. 真实 Task-tool subagent 派发（非 mock）
- [ ] **步骤**：在真实会话中调 `ghs-plan-start`（给一个简单需求），观察主 AI 是否真的用
  Task tool 派发出 `ghs-context-haiku` subagent（非测试里的 canned blob）。
- [ ] **预期**：subagent 会话被创建并隔离；用 `.ghs/ghs.json` 中配置的 `models.context`
  模型运行；其输出（CONTEXT_SNAPSHOT 包裹）回到主 AI 并被 `ghs-plan-start` 正确解析。

### 5. 真实 codegraph MCP 连接（R1）
- [ ] **步骤**：另开终端跑 `codegraph serve --mcp`；在真实会话中确认 `codegraph_codegraph_*`
  工具可被调用（例如 `codegraph_codegraph_status`）。
- [ ] **预期（有 codegraph）**：codegraph MCP 工具可调用，plan 流程走 MCP 路径。
- [ ] **预期（无 codegraph）**：停掉 `codegraph serve --mcp` 后，plan 流程自动回退到 grep
  路径，不报错（覆盖 test/integration/codegraph-paths.test.ts 的两条分支在真实环境的表现）。

### 6. 模型变更生效
- [ ] **步骤**：编辑 `.ghs/ghs.json` 把 `models.context` 改成另一个模型 ID → 调 `ghs-config`
  → **重启** OpenCode 会话 → 再次触发 `ghs-plan-start` 派发 `ghs-context-haiku`。
- [ ] **预期**：重启后 `ghs-context-haiku` 使用新的 `models.context` 模型
  （验证 Markdown agent 是 subagent 声明的有效载体，对应 plan §Phase 0 spike #3 Round 6 新增）。

### 7. 兼容性测试（Claude Code GHS 产出的 `.ghs/`）
- [ ] **步骤**：取一个由 Claude Code 版 GHS 产出的 `.ghs/`（含 features.json / plans / archived
  但 **不含** `ghs.json`），在其项目根跑 OpenCode `ghs-status` / `ghs-archive`。
- [ ] **预期**：无需迁移即可读取 / 归档；注意 Claude Code 版 `.ghs/` 无 `ghs.json`，用户需手动
  调 `ghs-config` 用默认值（来自 `shared/ghs.default.json`）生成 `.opencode/agents/ghs-*.md`。

---

## 👤 s1 sprint（workflow-planagent-skill）三机制手动 E2E

> 以下项对应 `docs/ghs/plans/2026-06-22-ghs-plan-agent-skill-v41.md` §4 各 Phase 的 **[手动 E2E]**
> 验收，以及 progress.md Session 2 两 spike（feat-006 builtin-plan / feat-010 skill-load）遗留的
> 手动确认项。三机制均属 best-effort nudge / 可视化补充，自动化测试已覆盖判定表四行与门禁，
> 但「真实 OpenCode 会话 + 真实 LLM」下的面板渲染 / 卡片标注 / skill 加载 / 内置 plan agent
> 输出遵循度仍需人工手验。

### 8. [机制一] 断线检测 —— never 分支
- [ ] **步骤**：在真实会话中进入 ghs 多步流程（调 `ghs-plan-start`），**故意不调** `todowrite`
  （不让右侧面板建 checklist），随后继续调下一个 ghs 工具（如 `ghs-plan-review` snapshot 模式）。
- [ ] **预期**：下一个 ghs 工具返回文本中含 `todoDirective`（建设性首次/重复 nudge，列出 checklist
  + 标当前 in_progress），**不含** `staleTodoWarning`（避免倒挂与「预设上一阶段」）。对应判定表第 2 行
  （`lastTodoMs === undefined`），与 `test/plan-start.test.ts` 首个调用断言一致。

### 9. [机制一] 断线检测 —— drift 分支
- [ ] **步骤**：在真实会话中先调 `todowrite` 建 plan 阶段 checklist（触发 `todo.updated` 设
  `lastTodoMs`），跑完 `ghs-plan-start`（设 `lastStageSeenByTool = "plan:designing"` 作 drift 基线），
  然后 stage 推进到 `reviewing`（经 `ghs-plan-review` plan 模式成功路径 `writePlanStatus`）后，
  **不刷新** todo（不调 `todowrite` 把 checklist 推进到 reviewing 阶段），观察下一次 ghs 工具返回。
- [ ] **预期**：返回文本含 `staleTodoWarning` 且期望 stage 为 `plan:reviewing`（漂移提醒：stage 已
  推进但 todo 未跟随刷新）。对应判定表第 3 行（`lastStageSeenByTool !== currentStage`），与
  `test/plan-review.test.ts` plan 模式成功路径断言一致（post-advance 读到刚写入的 reviewing）。

### 10. [机制一] 右侧面板 checklist + 工具卡片阶段标注
- [ ] **步骤**：在真实会话中按 SYSTEM_HINT「Todo Discipline」在 plan 阶段调 `todowrite` 建阶段
  checklist 并随 stage 推进刷新；同时观察每个 ghs 工具卡片的 title。
- [ ] **预期**：右侧面板出现 plan 阶段 checklist（唯一驱动是内置 `todowrite`，硬约束 C1）；每个
  ghs 工具卡片 title 显示 `[ghs] <Phase>`（如 `[ghs] plan:designing`、`[ghs] plan:reviewing`），
  来自 `ctx.metadata()` 主路径，`tool.execute.after` hook 兜底（带 `ghs-` 前缀门禁）。

### 11. [机制二] planner_backend=builtin-plan 全流程（feat-006 spike 待办）
- [ ] **步骤**：在真实 OpenCode 会话中设 `Config.agent.plan`（opencode 内置 plan agent，name 为
  `"plan"`），并在 `.ghs/ghs.json` 的 `models` 旁加 `"planner_backend": "builtin-plan"`；调
  `ghs-plan-start` → `ghs-plan-review`（snapshot 模式）观察主 AI 是否经 Task tool 派发**内置**
  plan agent（派发指令含 `PLAN_DESIGNER_PROMPT_BUILTIN` 内嵌的分隔标记契约说明）。
- [ ] **预期（成功）**：内置 plan agent 输出含 `<<<PLAN_START>>>` / `<<<PLAN_END>>>` 各占独立行
  （经 dispatch prompt 注入的契约），`parsePlan` 提取成功 → `ghs-plan-review(plan)` 进入 review
  阶段（writePlanStatus 写 `reviewing`）。
- [ ] **预期（失败 / D3 兜底）**：若内置 plan agent 输出不带分隔标记，断言 D3 降级生效 —— `parsePlan`
  empty/malformed 分支返回重试；`planner_backend` 默认 `ghs-plan-designer` 可切回；最坏
  `builtin-plan` 仅作文档引导（见 `shared/references/plan-designer.md`「可选:复用内置 plan agent」）。
  LLM 遵循度是本项核心不确定点（对应 R3）。

### 12. [机制二] 非法 planner_backend 值
- [ ] **步骤**：在 `.ghs/ghs.json` 写入非法值（如 `"planner_backend": "foo"`），调 `ghs-config`。
- [ ] **预期**：`ghs-config` strict 报错（`GhsConfigSchema` 的 `z.enum(["ghs-plan-designer",
  "builtin-plan"])` ZodError 上抛），不生成 / 不更新 `.opencode/agents/ghs-*.md`。对应
  `test/config.test.ts` 非法值 enum 报错断言在真实工具链的 surface。

### 13. [机制三] skill 加载 + /skill-creator eval（feat-010 spike 待办）
- [ ] **步骤 A（加载）**：跑过 `ghs-init` 后确认 `<projectDir>/.opencode/skill/ghs/SKILL.md` 存在；
  **重启** OpenCode 会话（agent markdown / skill 仅启动加载，无热重载，对应 C4），检查系统提示的
  `available_skills` 列表。
- [ ] **预期 A**：`.opencode/skill/ghs/SKILL.md` 出现在 `available_skills`（依赖 frontmatter
  `name: ghs` + `description` 必填，否则被剔出 —— feat-010 反编译 opencode v1.17.9 加载 glob
  `{skill,skills}/**/SKILL.md` 确认）。
- [ ] **步骤 B（eval）**：调 `/skill-creator eval` 对 ghs skill 跑 benchmark。
- [ ] **预期 B**：编排型 skill 的 benchmark 需对「工具调用序列」断言（而非纯文本输出）；即便
  benchmark 不划算，SKILL.md 作「人类可读编排规范 + 系统提示内可见 skill」已兑现机制三核心价值
  （对应 R5 缓解）。记录 eval 可行性结论供后续优化。

---

## 备注

- 本清单为活文档：新增自动化测试时把对应人工项迁到「已自动化覆盖」段并指向新测试文件。
- 真实 OpenCode 会话的人工验证建议在每个 minor 发布前完整跑一遍。
