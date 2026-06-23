# ghs-code 闭环断裂：编排靠散文导致慢、费 token、跑不完 sprint

> 触发场景：`/ghs-code` 单 feature 实现 + `/ghs-code --parallel 完成所有功能`
> 对照基线：原 golden-hoop-spell Claude 版插件（快、省 token、一句话跑到底）
> 诊断日期：2026-06-23
> 性质：问题梳理 + 根因分析 + 架构洞察（不含代码改动）

## 一、现象

| 现象 | 描述 |
|---|---|
| 慢 + 费 token | 每次 `/ghs-code` 执行速度慢、token 消耗大，单 feature 亦然，非并行专属 |
| 并行跑不完 | `/ghs-code --parallel 完成所有功能` 每个 feature/batch 完成后停下，无法连续推进到整个 sprint 结束 |
| 体验落差 | 与 Claude 原版差距明显——原版 sprint 拆分后基本一句话执行到底 |

## 二、根因（一句话）

> **ghs 的 code/sprint 阶段把「编排逻辑」写进了工具返回的散文里，而不是写进可调用的 tool 里。散文命令主 AI 去执行一批状态变更操作，但这些操作要么没接成 tool、要么根本不存在——于是闭环变成「主 AI 即兴判读 + 手改 JSON」，非确定、依赖模型、且烧 token。**

换言之：**它把工具调用当成了文档来写，而不是当成代码来实现。**

## 三、证据链（tool 根本没注册）

1. **`plugin.ts:111-123` 只注册 10 个 tool**，无 `ghs-parse-completion-signal`、无 `ghs-update-feature-status`。
2. **两个脚本只被 test 引用**，无任何 `src/tools/*.ts` import：
   - `test/writer.test.ts:27` → `updateFeatureStatus`
   - `test/e2e/full-workflow.test.ts:54` → `updateFeatureStatus`
   - `parseCompletionSignal` 甚至连 test 都没覆盖（codegraph 标注 "no covering tests found"）
3. **但 ghs-code 输出文本把它们当真实 tool 反复引用**：
   - `code.ts:62` `NEXT_ACTION_CODE`："parse the completion signal and update feature status"
   - `code.ts:152` `codeTool.description`："(parse-completion-signal) and updates the feature status"
   - `code.ts:412 / 510 / 548` 三处 dispatch 文本："用 parse-completion-signal 解析… 再调 update-feature-status 更新"
   - `feature-impl.ts:48 / 78`：派发 prompt 正文 "完成信号由 parse-completion-signal 解析… 据此更新 features.json"
4. **作者注释自相矛盾**：`code.ts:19-21` 写「the main AI invokes the parser… via `ghs-status` / the `update-feature-status` writer」——但 `ghs-status` 是只读的（`status.ts` 整文件无写操作），`update-feature-status writer` 是库函数不是 tool。这是移植漏接的铁证。
5. **全仓无任何循环指令**：grep `re-call|re-invoke|再次调用|loop|until|直到.*no ready` 在 tools/prompts/workflow-chrome 中**零命中**——没有任何文字告诉主 AI「update 后再调 ghs-code 取下一批」。

## 四、缺口分类法：三类「编排靠散文」漏洞

对 code/sprint 阶段每一条「主 AI 应当执行 X」的散文指令做审计，X 落进三类漏洞。三类的共同特征是：**散文承诺了一个动作，但该动作在 runtime 上不可调用。**

### Cat 1：有函数、无 tool（「死函数」型）

| 散文里命令调用的 | 现实 | 散文出处 |
|---|---|---|
| `parse-completion-signal` | 纯函数 `parse-completion-signal.ts` 存在，只被 test 引用，**不是 tool** | `code.ts:62,152,412,510,548`、`feature-impl.ts:48,78` |
| `update-feature-status` | 纯函数 `update-feature-status.ts` 存在，只被 test 引用，**不是 tool** | 同上 + `sprint.ts:109,206`、`sprint-planning.ts:27` |

特征：**逻辑移植了，tool 注册这一层漏了**。散文仍按原名引用，制造出「闭环存在」的错觉，但 runtime 上是断的。

### Cat 2：函数和 tool 都不存在（「纯手写」型）

| 散文里命令执行的动作 | 现实 | 散文出处 |
|---|---|---|
| 「把 goal 拆成 atomic features 并 append 进 sprint」 | **全仓无 `append-feature` 函数或 tool**（`append-sprint.ts` 只追加 sprint 外壳，features 恒为 `[]`） | `sprint.ts:205-206`、`sprint-planning.ts:27` |

特征：**连底层的纯函数都没写**。整个 sprint 拆分是主 AI 手写 JSON 对象塞进 features.json，零 schema 校验、零工具支撑。这是比 Cat 1 更彻底的「编排靠散文」。

> 附带：`update-feature-status` 还被误用来表达「append」语义（`sprint.ts:206`），但它只翻 status、不能追加 feature——散文连「该调哪个操作」都指错了。

### Cat 3：动作存在，但缺「循环」指令（「单周期」型）

| 缺失的指令 | 后果 | 证据 |
|---|---|---|
| 「状态更新后再次调 ghs-code，直到 no ready features」 | 每个 feature/batch 后停下，跑不完 sprint | grep 全仓**零命中**（见第三节第 5 条） |

特征：**单步动作齐全，但没有把单步串成自动循环的胶水指令**。`NEXT_ACTION_CODE`（`code.ts:62`）只描述 dispatch→parse→update 一个周期，无 repeat。

## 五、机理：为什么同时造成「停下」与「慢/费 token」

**停下（并行跑不完）：**
- 主 AI 派发 Task subagent → subagent 返回 `FEATURE COMPLETE: <id>` → 主 AI 找不到 `parse-completion-signal` tool，也找不到 `update-feature-status` tool → 只能靠手写 Read/Edit/Write 改 `features.json` → 改完即停。
- 即便手改成功，**没有任何循环指令**（Cat 3）驱动它再调 `ghs-code` 取下一批 ready feature，所以一个周期就结束。
- Claude 原版快，正是因为这些是真实 tool，闭环极紧：`ghs-code → Task → parse → update → ghs-code → …` 全是小 tool call，模型只需遵循确定性工具序列。

**慢 + 费 token：**
- 缺 `ghs-update-feature-status` tool（Cat 1）→ 每个 feature 都要 Read 整个 `features.json` + Write 整文件回盘，全在主上下文里往返（features.json 随项目膨胀，可达数 KB~数十 KB）。
- 缺 `ghs-parse-completion-signal` tool（Cat 1）→ 主 AI 不得不在上下文里对 subagent 的完整输出（常上千 token）人工判读，而非拿到几十字节的 `{status, feature_id}`。
- subagent 完整输出长期留在主上下文（无法 offload 给返回小结果的 tool）。
- 雪上加霜：`dispatchParallelPlan`（`code.ts:501`）对每个 ready feature 都**整段渲染** ~1.7KB 的 `FEATURE_IMPL_PROMPT`，N 个 feature = N 份重复 prompt 塞进同一 tool result。

三类缺口对应三种劣化方式：

| 缺口类型 | 闭环的非确定性来源 | 用户可观测症状 |
|---|---|---|
| Cat 1 死函数 | 主 AI 找不到 tool → 即兴选替代（手改 JSON / 自己判读信号） | 慢、费 token、行为不稳定 |
| Cat 2 纯手写 | 主 AI 凭散文理解构造 JSON，无 schema 约束 | 拆分质量随机、易写错字段 |
| Cat 3 单周期 | 主 AI 做完一个周期就停（没人告诉它继续） | 跑不完、需人工反复 `/ghs-code` |

## 六、回归定性：移植重构做了一半

证据强烈指向：**Claude 原版里这些是真实 tool，opencode 移植时把逻辑搬成了 TS 纯函数，却停在「注册成 tool」前一步。**

- `append-sprint.ts:1-7` 的注释自述：「*The source plugin had no equivalent Python script — its ghs-sprint skill instructed the AI to edit features.json directly with the Edit tool. This module refactors that into 'AI provides a spec, a pure function returns the updated object' so the tool layer controls disk persistence.*」——作者**有意**把「主 AI 直接 Edit JSON」重构为「纯函数 + tool 层持久化」。
- 但重构只做了一半：`appendSprint` 接进了 `sprintTool`（sprint 外壳能确定性写入），而 `updateFeatureStatus` / `parseCompletionSignal` 写成了纯函数却**没接进任何 tool**，`appendFeature` 则**压根没写**。
- 结果：工具返回文本里的散文还在用老名字发号施令，像是在调用一个其实没注册的 tool——典型的「接口承诺了，实现没跟上」。

所以这不是「设计上故意让主 AI 手动」——是**重构到一半的中间态**，散文指令还停留在旧契约。

## 七、可推广教训 + 验证启发式

**原则：凡是 plugin 期望主 AI 执行的状态变更，都必须是一个真实存在的 tool。否则闭环就是非确定的——是否执行、怎么执行、执行完继不继续，全取决于主模型对散文的遵循度，而这会随模型、随上下文长度、随 token 压力漂移。**

对照基线（Claude 原版快且省）之所以成立，不是因为 Claude 更聪明，而是因为**那些动作是真实 tool，闭环是确定性的工具序列**——任何模型只要会按 tool 列表顺序调用都能跑通，不依赖长程自主遵循能力。

**验证启发式**：审查任何 plugin 的工具返回文本，对每一句「主 AI 应当执行 X」，问「X 是一个可调用的 tool 吗？」。若否，即为潜在缺口。对 ghs code/sprint 做这遍审计，dispatch 文本里几乎每一条祈使句都命中了第四节的分类表。

## 八、量化估计（per-feature 主上下文开销对比）

假设一个 sprint 8 个 feature、features.json ~8KB：

| 环节 | 现状（无 tool） | 修复后 |
|---|---|---|
| ghs-code dispatch 结果 | ~2KB（含整段 prompt） | ~0.5KB（模板只一次） |
| features.json 读写 | ~16KB 往返（Read+Write）×8 | 0（tool 内部处理） |
| 信号判读 | subagent 全文入上下文推理 | ~150 字节 tool I/O |
| 循环驱动 | 无（手动停止） | 自动 repeat |

8 feature 累计：主上下文约省 **>100KB**，且闭环从「主 AI 即兴判读+手改」变成「确定性 tool 序列」。

## 九、修复方向（按收益排序，未实施）

把「编排靠散文」收敛为「编排靠 tool」：

| # | 改动 | 对应缺口 | 收益 | 风险 |
|---|------|------|------|------|
| **A** | 把 `parseCompletionSignal` / `updateFeatureStatus` 包成 `ghs-parse-completion-signal` / `ghs-update-feature-status` 两个 tool，在 `plugin.ts` 注册 | Cat 1 | 修好 code 闭环；token 暴跌（小 tool call 替代整文件读写 + 人工判读） | 低，纯函数已存在，套薄壳即可 |
| **B** | dispatch 文本 + NEXT_ACTION 加显式循环指令：「update 后**再次**调 `ghs-code`（parallel 则 parallel=true），直到返回 no ready features」 | Cat 3 | 真正一句话跑到底 | 低，只改 prompt 文本 |
| **C** | `dispatchParallelPlan` 只渲染一次 prompt 模板 + 列 feature id，不再每 feature 嵌整段 | — | 并行 tool result 瘦身 N 倍 | 低 |
| **D** | 新增 `append-feature` 纯函数 + `ghs-append-feature` tool，修 sprint 拆分阶段的洞 | Cat 2 | sprint 拆分从手写 JSON 变成确定性 tool call | 中，需新增 writer + schema |

A 是关键，B 让它能连续跑，C 降 token，D 顺带修 sprint。

**收敛判据**：修复后，重新跑一遍第七节的启发式审计——工具返回文本里不应再有任何「命令主 AI 执行一个不存在的 tool」的祈使句。

## 十、不做什么

- **不要靠「把 prompt 写得更详细/更强调」来修**——那是在加长散文契约，治标且会随模型劣化。修法是补 tool，不是补措辞。
- **不要把循环逻辑塞进 `ghs-code` 的 `execute()` 自己派发 subagent**——opencode 的 tool 是请求/响应模型，tool 内部递归派发 Task 会破坏可观测性与可中断性。循环仍由主 AI 驱动，但每一步必须是真实 tool（这是 Cat 1/2/3 修复后的自然结果）。
