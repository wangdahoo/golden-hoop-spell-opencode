// LLM-facing dispatch instruction for the `ghs-context-explorer` subagent —
// CODEGRAPH path.
//
// `ghs-plan-start` (s3-feat-006) probes `detectCodegraph(projectDir)`
// (s3-feat-002). When `.codegraph/` is present, the dispatcher selects THIS
// prompt: it tells the main AI to dispatch `ghs-context-explorer` via the Task
// tool with codegraph-first instructions. The subagent prefers the
// `codegraph_*` MCP tools (sub-second symbol/edge/flow queries) over manual
// `grep`+`read` crawling, falling back to file reads only for specific
// implementation details the graph doesn't surface.
//
// This constant is the dispatch directive the main chat AI reads from the
// `ghs-plan-start` tool result (plan §3.5 / §3.7 step: Task:
// ghs-context-explorer). It is NOT the verbatim prompt body baked into the
// subagent template (that lives in `shared/agents/ghs-context-explorer.md.template`,
// s3-feat-001) — it is the tighter, command-style steering text consumed in
// the tool result.
//
// The snapshot output is wrapped in the
// `<<<CONTEXT_SNAPSHOT_START>>>` / `<<<CONTEXT_SNAPSHOT_END>>>` delimiters
// (plan §3.3) so `parse-delimited-output.ts` (s3-feat-003) can extract it in
// the subsequent `ghs-plan-review(snapshot)` call.
//
// Language policy (per CLAUDE.md): human-readable prose is 中文, code
// identifiers / field names / delimiter tokens stay English.

/**
 * Dispatch instruction for the context-explorer subagent when codegraph is
 * available.
 *
 * Returned by `ghs-plan-start` when `detectCodegraph()` returns `true`. It
 * steers the subagent to prefer graph queries (`codegraph_explore`,
 * `codegraph_callers`, ...) over brute-force grep, and to emit the snapshot
 * inside the snapshot delimiters.
 *
 * Kept to ~600-1200 chars. For the human-readable snapshot format reference,
 * see `shared/references/context-snapshot-guide.md`.
 */
export const CONTEXT_CODEGRAPH_PROMPT = `检测到 \`.codegraph/\` 已初始化 —— 本轮 plan 走 codegraph 路径。请用 Task tool 派发 \`ghs-context-explorer\` subagent 收集项目上下文快照。subagent 应优先用 codegraph MCP 工具查询符号/调用图/数据流，仅在 graph 未覆盖具体实现细节时才补读源文件。详见 shared/references/context-snapshot-guide.md。

输入给 subagent（拼在 Task 派发的 prompt 里）：
- 需求描述（用于做 relevance filter —— 只收录与需求可能相关的代码）
- project_dir（若与当前工作目录不同）

推荐的 codegraph 查询顺序（subagent 应遵循）：
1. \`codegraph_status\` —— 确认索引健康（文件数/节点数/边数），判断是否值得信赖
2. \`codegraph_explore "<需求关键词 + 模块名>"\` —— 一次性取回相关符号的源码（PRIMARY，多数情况这一个调用就够）
3. \`codegraph_callers\` / \`codegraph_callees\` / \`codegraph_impact\` —— 查调用路径 / 影响面（用于关键流程与重构边界）
4. 仅当 graph 未覆盖某个具体实现时，才用 \`read\` / \`glob\` / \`grep\` 补读个别文件

快照内容（subagent 须产出，压缩到原始源码的 50-70%）：
- 技术栈（语言/版本、运行时/框架、关键依赖、构建系统、测试框架）
- 目录结构（关键文件一行注释）
- 架构摘要（入口点、模块职责、数据模型、关键模式）
- 与需求相关的代码摘录（函数签名、schema、路由、类型定义 —— 不要整文件粘贴）

大体量输入处理：若需求指向超大文件（如 >100KB 的会话日志/数据 dump），只采样头部 + grep 定位关键段并摘要，绝不逐字转述进快照（会膨胀下游每个 prompt）。详见 shared/references/context-snapshot-guide.md「Large-Input Handling」。

分隔标记契约（硬性，parser 据此提取 snapshot）：
- snapshot 全文必须放在 \`<<<CONTEXT_SNAPSHOT_START>>>\` 与 \`<<<CONTEXT_SNAPSHOT_END>>>\` 之间，两个标记各占独立一行
- 不要把标记或内容包进 markdown 代码围栏（不要用三反引号包裹）
- 不要翻译/改写标记：禁止 \`《《CONTEXT_SNAPSHOT_START》》\`、\`<<CONTEXT_SNAPSHOT_START>>\`、\`<<< CONTEXT_SNAPSHOT_START >>>\` 等变体
- 使用字面 ASCII 字符 \`<\`、\`>\`、\`_\`

输出语言策略（与 CLAUDE.md 一致）：快照正文/模块描述/注释用中文；代码标识符、字段名、文件路径、类型名用英文。

收到 subagent 的分隔标记输出后，请把整段（含标记）原样作为 \`snapshot\` 参数调用 \`ghs-plan-review\` 进入 snapshot 模式，parser 会提取快照并派发下一步 designer。`;
