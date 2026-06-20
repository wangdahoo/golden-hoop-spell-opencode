// LLM-facing instruction returned by the `ghs-sprint` tool after it writes a
// new sprint skeleton to features.json.
//
// This prompt is NOT a verbatim copy of shared/references/sprint-agent.md —
// that file is a human-readable reference doc. This constant is the
// command-style instruction the AI consumes to decompose requirements into
// atomic features (s2-feat-002). It distills the source's Steps 2-5
// (Create Atomic Features / Categorize and Prioritize / Define Acceptance
// Criteria / Order by Dependencies) into the tightest form that reliably
// steers feature decomposition.
//
// Language policy (per CLAUDE.md): human-readable prose is 中文, code
// identifiers / field names / enum values stay English. The AI is told to
// follow the same policy when writing features.

/**
 * The sprint-planning instruction. Returned as part of the `ghs-sprint`
 * tool's output text so the AI immediately knows how to break the sprint
 * goal into atomic features and append them via `update-feature-status`.
 *
 * Length is kept ~500-1500 chars: enough to specify the feature schema,
 * atomic-feature criteria, AC format, dependency ordering, and complexity
 * estimation; short enough to land in the tool result without crowding it.
 * For the full human-readable reference, see
 * shared/references/sprint-agent.md.
 */
export const SPRINT_PLANNING_PROMPT = `Sprint 骨架已写入 features.json。接下来请把 sprint goal 拆成 atomic features，逐个用 update-feature-status 追加（status 初始为 pending）。详见 shared/references/sprint-agent.md。

拆分原则（每个 feature 必须同时满足）：
- 原子性：单个 session 可完成（< 4 小时）
- 独立性：依赖最少，可单独验证
- 可测：有明确、可执行的验收标准
- 有价值：交付可感知的用户/系统价值

feature schema（字段名用英文）：
{ id, category, priority, title, description, acceptance_criteria[], technical_notes, status, dependencies[], estimated_complexity, files_affected[] }
- id：s{N}-feat-{NNN}（N = 当前 sprint 编号，NNN 零填充 3 位，sprint 内顺序递增）
- category：core | ui | api | auth | data | infra
- priority：high（sprint 阻塞项/核心）| medium（重要不阻塞）| low（可推迟）
- status：pending | in_progress | completed | blocked（blocked 必须带 blocked_reason）
- estimated_complexity：small（<2h）| medium（2-4h）| large（4h+，必须继续拆分）

acceptance_criteria 写法（Given/When/Then）：用可验证的条件描述，避免主观措辞。示例：Given features.json 存在，when 调 appendSprint，then 新 sprint 出现在 sprints 末尾且原对象不被修改。

依赖排序：基础设施先行 → 核心功能 → 支撑功能 → UI；有 dependencies 的 feature 必须排在被依赖项之后。在 progress.md 记录实现顺序与理由。

语言策略（与 CLAUDE.md 一致）：description / acceptance_criteria / technical_notes 等人类可读字段用中文；代码标识符、字段名、枚举值、日志/错误信息用英文。`;
