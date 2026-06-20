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

## 备注

- 本清单为活文档：新增自动化测试时把对应人工项迁到「已自动化覆盖」段并指向新测试文件。
- 真实 OpenCode 会话的人工验证建议在每个 minor 发布前完整跑一遍。
