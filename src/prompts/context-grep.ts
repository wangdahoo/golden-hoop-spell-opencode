// LLM-facing dispatch instruction for the `ghs-context-explorer` subagent —
// GREP FALLBACK path.
//
// `ghs-plan-start` (s3-feat-006) probes `detectCodegraph(projectDir)`
// (s3-feat-002). When `.codegraph/` is ABSENT (or the probe fails
// defensively), the dispatcher selects THIS prompt: it tells the main AI to
// dispatch `ghs-context-explorer` via the Task tool with grep/glob/read-first
// instructions. There are no codegraph MCP tools available, so the subagent
// builds the snapshot by manual traversal — dependency manifest → directory
// tree → entry point → config → requirement-relevant files.
//
// This constant is the dispatch directive the main chat AI reads from the
// `ghs-plan-start` tool result (plan §3.5 / §3.7 step: Task:
// ghs-context-explorer). It is NOT the verbatim prompt body baked into the
// subagent template (that lives in
// `shared/agents/ghs-context-explorer.md.template`, s3-feat-001) — it is the
// tighter, command-style steering text consumed in the tool result.
//
// The snapshot output is wrapped in the
// `<<<CONTEXT_SNAPSHOT_START>>>` / `<<<CONTEXT_SNAPSHOT_END>>>` delimiters
// (plan §3.3) so `parse-delimited-output.ts` (s3-feat-003) can extract it in
// the subsequent `ghs-plan-review(snapshot)` call.
//
// Language policy (per CLAUDE.md): human-readable prose is 中文, code
// identifiers / field names / delimiter tokens stay English.

/**
 * Dispatch instruction for the context-explorer subagent when codegraph is NOT
 * available.
 *
 * Returned by `ghs-plan-start` when `detectCodegraph()` returns `false`. It
 * steers the subagent to build the snapshot via `read` / `glob` / `grep`
 * (read-only `bash`) following the extraction order in
 * `shared/references/context-snapshot-guide.md`, and to emit the snapshot
 * inside the snapshot delimiters.
 *
 * Kept to ~600-1200 chars. For the human-readable snapshot format reference,
 * see `shared/references/context-snapshot-guide.md`.
 */
export const CONTEXT_GREP_PROMPT = `未检测到 \`.codegraph/\` —— 本轮 plan 走 grep 回退路径（无 codegraph MCP 工具可用）。请用 Task tool 派发 \`ghs-context-explorer\` subagent 收集项目上下文快照。subagent 用 \`read\` / \`glob\` / \`grep\`（read-only \`bash\`）手动遍历代码库构建快照。详见 shared/references/context-snapshot-guide.md。

输入给 subagent（拼在 Task 派发的 prompt 里）：
- 需求描述（用于做 relevance filter —— 只收录与需求可能相关的代码）
- project_dir（若与当前工作目录不同）

推荐的提取顺序（subagent 应遵循，参照 context-snapshot-guide.md 的 Extraction Process）：
1. 读依赖清单：\`package.json\` / \`requirements.txt\` / \`Cargo.toml\` 等
2. 取目录结构：\`glob\` 或 \`find\`（排除 node_modules、.git、build 产物）
3. 读入口点：\`src/index.ts\` / \`main.py\` / \`src/lib.rs\` 等
4. 读配置文件：\`.env.example\`、config 模块、数据库初始化
5. 读与需求相关的文件：需求所属目录下的关键源文件
6. 汇总压缩：把发现压缩成快照格式（目标 50-70% 压缩比，不要整文件粘贴）

快照内容（subagent 须产出）：
- 技术栈（语言/版本、运行时/框架、关键依赖、构建系统、测试框架）
- 目录结构（关键文件一行注释）
- 架构摘要（入口点、模块职责、数据模型、关键模式）
- 与需求相关的代码摘录（函数签名、schema、路由、类型定义 —— 只收录可能相关的，排除无关模块）

分隔标记契约（硬性，parser 据此提取 snapshot）：
- snapshot 全文必须放在 \`<<<CONTEXT_SNAPSHOT_START>>>\` 与 \`<<<CONTEXT_SNAPSHOT_END>>>\` 之间，两个标记各占独立一行
- 不要把标记或内容包进 markdown 代码围栏（不要用三反引号包裹）
- 不要翻译/改写标记：禁止 \`《《CONTEXT_SNAPSHOT_START》》\`、\`<<CONTEXT_SNAPSHOT_START>>\`、\`<<< CONTEXT_SNAPSHOT_START >>>\` 等变体
- 使用字面 ASCII 字符 \`<\`、\`>\`、\`_\`

输出语言策略（与 CLAUDE.md 一致）：快照正文/模块描述/注释用中文；代码标识符、字段名、文件路径、类型名用英文。

收到 subagent 的分隔标记输出后，请把整段（含标记）原样作为 \`snapshot\` 参数调用 \`ghs-plan-review\` 进入 snapshot 模式，parser 会提取快照并派发下一步 designer。`;
