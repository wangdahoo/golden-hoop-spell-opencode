# 多流水线并发支持（multi-pipeline concurrency）— 修订版 round 2

> 面向 reviewer 的执行型技术方案（round 2）。本版依据 round-1 评审报告（FAIL：7 Medium + 7 Optimization）逐条修订。设计仍遵守需求给定的结论 A/B/C 与横切约束，保留 round-1 已被认可的隔离选型（O_EXCL 创建 + 写前 validate 校验 + 同 session 幂等覆盖写），仅针对评审项调整。守约不变：A（plan_id 隔离放开 plan 并发）/ B（sprint/code 运行期锁序列化 + 用户决策陈旧检测）/ C（finalize 不动、文案续接、无 stop 边界）。

## 修订说明（round 2）

> 逐条对应 round-1 评审的 M1–M7 / O1–O7，说明本版如何闭合。reviewer 复核时可直接据此对照下文章节。

### Medium（7 条，全部闭合）

| # | 评审要点 | 本版处置 | 落点章节 |
|---|----------|----------|----------|
| **M1** | Phase 4「写前校验锁」是 conclusion B「接管防双写」的承重墙，不可标「推荐执行」 | **合并为单一 Phase 3 并显式标注 mandatory**：stage-owner 接锁 + leaf-writer 写前校验同批实施、同批回滚。删除「推荐执行」「可跳过」措辞；Q3 决策与 phase 标签一致化 | §4 Phase 3（合并）、§7 Q3 |
| **M2** | `takeover` 当作工具入参但 schema 未落地 | Phase 3 符号清单显式补：`codeTool.args` / `sprintTool.args` / `archiveTool.args` / `forceArchiveTool.args` 各加 `takeover: tool.schema.boolean().optional().describe(...)`；冲突文案 `▶ NEXT ACTION` 指明「重调 `ghs-code` 带 `takeover=true`」（工具名 stem 已带 `ghs-` 前缀，守 prose-contract） | §3.3 schema、§4 Phase 3 |
| **M3** | `acquireLock` 置 execute 顶端会在早返回路径（`code.ts` features.json 缺失 / JSON parse 失败；`sprint.ts` features.json 缺失）泄漏锁 | **`acquireLock` 置前置校验之后**：`code.ts` 在 JSON parse 通过后（`code.ts:236` 之后）、`getReadyFeatures`（`code.ts:243`）之前；`sprint.ts` 在 features.json 存在性通过后（`sprint.ts:148` 之后）、`archiveSprints`（`sprint.ts:156`）之前。错误路径根本不获取锁，唯一释放点仍是「no ready」终态。AC 补「features.json 缺失时 `code.execute` 不产生锁文件（`readLock(dir) === null`）」 | §3.4 流程 2、§4 Phase 3 |
| **M4** | takeover 覆盖写的「读回校验归属」是自证写（TOCTOU 未闭合） | 采推荐(a)：**删除「读回校验归属」措辞**，**文档化承认** takeover 覆盖写存在残留 TOCTOU 窗口（威胁模型=协作式人工流水线、takeover 罕见、可接受）；由 Phase 3 leaf-writer `validateLockHeld` 在后续写入处兜底（即便锁被踩，下个 leaf writer 写前 validate 会发现归属不符而拒绝写） | §3.3 acquireLock 语义、§3.5 错误表、§5 风险表 |
| **M5** | `releaseLock` 的 unlink 存在 TOCTOU 可误删接管者锁 | unlink 前**复读一次**确认仍归属本 session（缩小窗口，非消除）；SKILL.md 注明残留窗口由 Phase 3 validate 兜底（再次印证 M1：validate 不可选） | §3.3 releaseLock 语义、§4 Phase 5 |
| **M6** | plan-start 同 slug 竞态与「plan 阶段放开并发」宣称不符 | plan-start 的 status.json 创建换 **O_EXCL**：新增 `writePlanStatusExclusive`（`fs.open(path,"wx")`），EEXIST 则 slug 后追加 `-2`/`-3` 重试至唯一（上限 99）；`writePlanStatus`（覆盖写）保持不变供 plan-review/finalize 使用。并在 §1.2/§3.4 显式声明「并发安全前提：各窗口用互异 slug（同 slug 由 O_EXCL 自动加后缀去重）」 | §1.2、§3.4 流程 1、§4 Phase 1 |
| **M7** | 测试 helper 硬编码 sessionID 无法模拟两窗口 | Phase 3 改文件清单**显式加入 `test/integration/_helpers.ts`**；签名改 `mockToolContext(projectDir, sessionID = "integration-test-session")`；AC 补「两 ctx 的 `sessionID` 不同」断言 | §4 Phase 3、§6.2 |

### Optimization（7 条，全部收口）

| # | 评审要点 | 本版处置 | 落点章节 |
|---|----------|----------|----------|
| **O1** | `holderLabel` / `buildLabel(ctx)` 取值未定义 | 明确 `buildLabel(ctx) = `${ctx.agent}@${ctx.sessionID.slice(-6)}``（agent 名 + sessionID 末 6 位，人类可读，进冲突文案辅助辨认） | §3.3 buildLabel |
| **O2** | leaf writer 降级短锁硬编码 `stage:"sprint"` 误导 | `LockHolderSchema.stage` 枚举扩为 `["sprint","code","leaf"]`；standalone 降级短锁用 `stage:"leaf"` 占位（功能无害，仅作标签，避免误导） | §3.2 schema、§4 Phase 3 |
| **O3** | `progress.md` 写入须纳入 `performWrite` | `writeFeaturesSerialized(performWrite)` 明确：`performWrite` 封装**该工具的全部磁盘写**（`update-feature-status` = features.json + progress.md 两处；`append-feature` = features.json 一处），validate/锁只挡一处则另一处仍裸写 | §4 Phase 3 |
| **O4** | 「plan 阶段不可交织」须澄清 per-pipeline | SKILL.md 并发章节明确：「不可交织」是**单流水线内**不交织 plan 与 sprint/code，与「plan 可跨窗口并发」正交 | §4 Phase 5 |
| **O5** | worktree 场景锁路径分立致互斥失效 | SKILL.md 注明「并发流水线须指向**同一 projectDir**（worktree 共享主 `.ghs/` 或显式传 `project_dir`）」 | §4 Phase 5 |
| **O6** | `.ghs/active.lock` 已被 `.gitignore:224` 的 `.ghs` 整体忽略 | **无需改 .gitignore**（记正）；审查清单移除「锁文件未纳入 .gitignore」误报项 | §6.3 |
| **O7** | plan_id 透传须有测试钉死 | Phase 1 补回归断言：snapshot/plan/review 三 mode 的 `composeChrome` 收到的 `toolArgs["plan_id"]` 非空；并验证 `getStageSignature` 带/不带 plan_id 返回一致签名 | §4 Phase 1 AC、§6.3 |

---

## 1. 背景与目标

### 1.1 背景

ghs 套件当前隐含「单一宿主项目 = 单一活跃流水线」假设：所有工具对 `.ghs/` 下共享文件（`features.json` / `progress.md` / 源码树）做无锁 read-modify-write。一旦用户在两个 terminal session 同时推进 plan / sprint / code，会出现三类冲突：

1. **plan 阶段交叉污染**：`ghs-plan-review` 的 `findActivePlanStatus`（`src/tools/plan-review.ts:198`）做全局扫描，两 plan 并发时 A 窗口的 review 可能读到 B 窗口的 active status 并把产物写错对象。
2. **features.json lost update**：`ghs-sprint` / `ghs-append-feature` / `ghs-update-feature-status` / `ghs-archive` 全是无锁 RMW（`sprint.ts:156-185` 等），并发写后写覆盖前写。
3. **源码树冲突 + 数据模型串行**：`ghs-code` 派发的 coding subagent 编辑真实 `src/`，跨流水线无文件冲突检测；`nextSprintId`（`sprint.ts:90`）扫 active+archived 假设全局唯一线性时间线，跨 sprint feature dependencies（`locateFeature` 扫所有 sprint）同理。

### 1.2 目标

- **plan 阶段**：放开并发——任意数量窗口可同时跑 plan，互不污染（结论 A）。**并发安全前提**：各窗口用互异 slug（默认各窗口传不同 `slug_seed`；若 slug 巧合相同，plan-start 用 O_EXCL 自动加 `-2`/`-3` 后缀去重，见 M6 / §3.4 流程 1）。
- **sprint/code 阶段**：运行期锁序列化——同一时刻只有一个窗口能推进 sprint/code，其余窗口收到结构化冲突文案并由用户决策（结论 B）。
- **finalize 自动续接**：行为不变，锁保证续接只在持锁流水线内部发生（结论 C）。
- 零编译、零新依赖、纯 file-I/O、execute 只返回 string（横切约束）。

### 1.3 范围

- **In scope**：plan-review 增加 `plan_id` 参数；plan-start status.json O_EXCL 创建防同 slug 覆盖；新增 runtime-lock lib 模块（行为源真 + 工具层 helper）；sprint/code/append-feature/update-feature-status/archive 接入锁 + leaf-writer 写前 validate；SKILL.md / dispatch prompt 更新；测试 helper 参数化 sessionID。
- **Out of scope**：不重写 features.json 为多文件/分片；不引入真数据库或 CAS 版本号字段；不改变 `nextSprintId` 全局唯一性语义（而是用锁保护它）；不引入进程间通信以外的协调机制；不改 `.gitignore`（O6：`.ghs/active.lock` 已被现有 `.ghs` 整体忽略）。

---

## 2. 现状分析

### 2.1 既有架构（与并发相关）

- **分层**：工具层 `src/tools/*.ts`（薄编排，execute 只 file I/O + 返回 dispatch 文本）→ 行为源真 `src/lib/scripts/*.ts`（Python 移植纯函数，测试钉死）→ prompt `src/prompts/*.ts` → `shared/` 随包资产。改行为改 scripts，不改 tools。
- **状态文件**：`.ghs/plans/<plan_id>-status.json`（per-plan 隔离，`state.ts:108-175`）、`.ghs/features.json`（单一文件）、`.ghs/progress.md`（单一文件）、`.ghs/archived/`。
- **进程模型**：OpenCode 工具调用在宿主进程内同步执行 execute；不同 terminal session 可能同进程（共享内存，如 `todo-tracker.ts` 的 in-process Map）也可能跨进程（多实例）。**故锁必须落磁盘**，不能依赖 in-process Map。
- **先例**：`todo-tracker.ts` 的陈旧检测用「on-disk 信号源，非 wall-clock」（`todo-tracker.ts:11-16`）——锁的陈旧检测复用此原则。

### 2.2 约束与不变量（设计须尊重）

| 编号 | 不变量 | 来源 |
|------|--------|------|
| C1 | execute 只返回纯文本 dispatch 指令，不调 LLM、不 `console.*` | AGENTS.md / snapshot §3 |
| C2 | `▶ NEXT ACTION` anchor 强制；工具名 stem（`parse-completion-signal`/`update-feature-status`/`append-feature`）必须带 `ghs-` 前缀（prose-contract 规则，`test/prose-contract.test.ts` 钉死） | AGENTS.md |
| C3 | 测试：temp dir 用 `fs.mkdtemp` + `realpathSync`；无真实 subagent/无真实 OpenCode（喂 canned blob）；`mockToolContext` 须支持参数化 sessionID（M7） | `_helpers.ts` |
| C4 | 插件根经 `import.meta.dir`（`pluginRoot()`），禁 `process.cwd()`/`__dirname` | AGENTS.md |
| C5 | `package.json` `files` 白名单仅 `src` + `shared`；新增顶层目录需更新 | AGENTS.md |
| C6 | 语言：中文正文 + 英文标识符/日志/错误/prompt | CLAUDE.md |

### 2.3 冲突面（snapshot §5 已确认，此处复述要点）

- plan-review 缺 `plan_id`（`planReviewArgsSchema` `plan-review.ts:125`），finalize 已有（`plan-finalize.ts:299`）——不对称是 plan 阶段冲突点的修法入口。
- plan-start 同日同 slug 会覆盖 status.json（`plan-start.ts:196` 注释承认；`writePlanStatus` `state.ts:304` 非原子整文件覆盖）——需 O_EXCL 创建（M6）。
- sprint/code 共享单一 features.json + 源码树 + 单一线性时间线假设 → 必须运行期锁序列化（结论 B，不可用目录隔离解掉）。
- 全仓无任何 lock/mutex/CAS/原子写原语（snapshot §5 结论 1）。

---

## 3. 方案设计

### 3.1 总体架构：两道隔离

```
┌─────────────────────────────────────────────────────────────────┐
│  多个 terminal session（同进程或跨进程）                          │
└─────────────────────────────────────────────────────────────────┘
        │                           │
        ▼                           ▼
┌───────────────────┐   ┌────────────────────────────────────────┐
│ plan 流水线        │   │ sprint / code 流水线                    │
│ (plan-start/       │   │ (sprint / append-feature / code /       │
│  review/finalize)  │   │  update-feature-status / archive)       │
└─────────┬─────────┘   └───────────────────┬────────────────────┘
          │                                  │
          ▼                                  ▼
┌─────────────────────┐         ┌──────────────────────────────────┐
│ 隔离 ① plan_id 钉死  │         │ 隔离 ② 运行期锁 .ghs/active.lock   │
│ + plan-start O_EXCL │         │ acquire / release / validate       │
│ findActivePlanStatus│         │ 幂等(同 session) / 冲突(跨 session) │
│ (projectDir, planId)│         │ 写前 validate（mandatory，M1）     │
└─────────────────────┘         └──────────────────────────────────┘
          │                                  │
          ▼                                  ▼
   只读仓库 + 写各自            共享 features.json + src/ 串行化
   <plan_id>-* 文件             （持锁者独占，余者冲突文案 + 用户决策）
   （O_EXCL 防 slug 覆盖）       （被踢窗口写前 validate 拒绝，防双写）
```

- **隔离 ①（plan 阶段）**：给 `ghs-plan-review` 增加可选 `plan_id` 参数，`findActivePlanStatus` 接受 `planId` 时只读那一个 status 文件、跳过全局扫描；plan-start 用 O_EXCL 创建 status.json 防同 slug 覆盖（M6）。目录隔离 + 创建互斥，plan 可任意并发。
- **隔离 ②（sprint/code 阶段）**：新增磁盘锁 `.ghs/active.lock`。stage owner（`ghs-sprint`/`ghs-code`）进入时获取锁并跨多调用持有，到终态释放；leaf writer（`append-feature`/`update-feature-status`/`archive`）写前 `validateLockHeld`（**mandatory，M1**）。跨 session 冲突 → 返回冲突文案让用户在 chat 中选择（接管 `takeover` / 等待 / 取消），不自动判陈旧。

### 3.2 数据模型

#### 锁文件：`.ghs/active.lock`（单一文件，JSON）

```ts
// src/lib/scripts/runtime-lock.ts（行为源真）
export const LockHolderSchema = z.strictObject({
  session_id: z.string(),              // ctx.sessionID，跨进程唯一标识本流水线
  acquired_at: z.string(),             // ISO8601，人类可读
  acquired_at_ms: z.number().int(),    // Date.now()，辅助陈旧判断呈现
  pid: z.number().int(),               // process.pid，呈现给用户辅助判断进程是否还在
  stage: z.enum(["sprint", "code", "leaf"]),  // 当前阶段；leaf=standalone 降级短锁（O2）
  sprint_id: z.string().nullable(),    // 持锁 sprint（code 阶段必填，sprint 阶段写完骨架后回填）
  holder_label: z.string(),            // 人类可读标签，进冲突文案
});
export type LockHolder = z.infer<typeof LockHolderSchema>;
```

**设计要点**：
- **载体选独立文件而非 features.json 字段**：锁是运行期协调元数据，与 features.json 的语义数据（sprint/feature status）正交（结论横切：不可混用）。独立文件还能用 `O_EXCL` 做无竞态获取，且崩溃残留不污染语义数据。
- **`session_id` 为主键**：幂等判定（同 session 再获取 = no-op 成功）与归属校验（跨 session = 冲突）都基于它。`pid` + 时间戳仅作辅助信息呈现给用户，**不参与自动陈旧判定**（结论 B：陈旧检测以用户决策为主）。
- **`stage` 扩为三态（O2）**：`sprint`/`code` 为 stage owner；`leaf` 为 standalone 手动调用降级短锁的占位标签，避免误标 sprint/code 误导诊断。
- **不写 wall-clock 超时字段**：复用 `todo-tracker.ts` 的「on-disk 信号源，非 wall-clock」原则——陈旧与否由用户看 PID/时间戳后决策，工具不自动判。

### 3.3 接口设计（函数签名）

#### 行为源真层 `src/lib/scripts/runtime-lock.ts`（纯函数 + schema，测试钉死）

```ts
// 构造持锁者信息（纯函数，不 IO）
export function buildLockHolder(args: {
  sessionId: string;
  stage: "sprint" | "code" | "leaf";
  sprintId: string | null;
  holderLabel: string;
  now?: Date;
}): LockHolder;
// now 默认 new Date()；pid 取 process.pid。

// 解析磁盘锁文件内容（纯函数；文件缺失/JSON 畸形 → null）
export function parseLockContent(raw: string | null): LockHolder | null;

// 冲突分类（纯函数，供工具层组冲突文案）
export type ConflictKind = "none" | "held_by_self" | "held_by_other";
export function classifyHolder(current: LockHolder | null, sessionId: string): ConflictKind;

// 渲染冲突提示文案（纯函数；中英混合：中文说明 + 英文标识符）
export function renderConflictMessage(other: LockHolder, attemptedAction: string, toolName: string): string;
// 返回多行文本：列出 other.holder_label / pid / acquired_at / stage / sprint_id，
// 并给出用户三选一指引（takeover / wait / cancel）。
// toolName 用于 ▶ NEXT ACTION 指明「重调 <toolName> 带 takeover=true」（守 prose-contract：传入完整 ghs-* 名）。
```

#### 工具层 helper `src/lib/runtime-lock.ts`（file I/O 包装，可被多 tool 复用）

```ts
// holderLabel 构造（O1）：agent 名 + sessionID 末 6 位
export function buildLabel(ctx: ToolContext): string;
// = `${ctx.agent}@${ctx.sessionID.slice(-6)}`

export function lockFilePath(projectDir: string): string;
// = resolve(projectDir, ".ghs", "active.lock")

export type AcquireResult =
  | { acquired: true; holder: LockHolder }
  | { acquired: false; reason: "held_by_other"; holder: LockHolder };

export async function acquireLock(args: {
  projectDir: string;
  sessionId: string;
  stage: "sprint" | "code" | "leaf";
  sprintId?: string | null;
  holderLabel?: string;
  takeover?: boolean;   // 用户已选接管时为 true（M2：经工具入参喂入）
}): Promise<AcquireResult>;
// 语义（M4 修订：删除「读回校验归属」自证写措辞，文档化残留窗口）：
//   1. 读现有锁 → classifyHolder：
//      - none / held_by_self → 写入（O_EXCL 写新 或 覆盖写更新 stage/sprint_id）；acquired:true
//      - held_by_other + takeover:true → 覆盖写（无条件），acquired:true
//          ⚠ 残留 TOCTOU 窗口（M4）：read 与 write 之间原持有者可能已变化，
//            本覆盖写可能踩掉一个刚合法获取的新持有者。威胁模型=协作式人工流水线、
//            takeover 罕见、可接受；由 Phase 3 leaf-writer validateLockHeld 在后续写入处兜底
//            （即便锁被踩，下个 leaf writer 写前 validate 会发现归属不符而拒绝写）。
//      - held_by_other + takeover:false → acquired:false, reason:"held_by_other", 返回 other
//   2. 写机制：
//      - 新建（无现有锁）：Node fs.open(path, "wx")（O_EXCL），EEXIST → 重读归类（竞态兜底）
//      - 更新（同 session 或 takeover）：Bun.write 覆盖（不读回校验——自证无意义）
//   O_EXCL 保证跨进程无竞态获取；同 session 幂等更新用覆盖写（单进程内顺序执行，无竞态）。

export type ReleaseResult =
  | { released: true }
  | { released: false; reason: "not_held" | "held_by_other"; holder: LockHolder | null };

export async function releaseLock(args: {
  projectDir: string;
  sessionId: string;
}): Promise<ReleaseResult>;
// 语义（M5 修订：unlink 前复读一次缩小窗口）：
//   - none → released:false, reason:"not_held"
//   - held_by_self → 复读一次确认仍归属 self，再 unlink；released:true
//       ⚠ 残留窗口（M5）：复读与 unlink 之间另一 session 可能 takeover。
//         此窗口非消除，但由 Phase 3 leaf-writer validateLockHeld 兜底（接管者下次写前 validate 自愈）。
//         SKILL.md 注明该窗口由 Phase 3 validate 兜底——再次印证 M1：validate 不可选。
//   - held_by_other（复读发现已被接管）→ 不删（防误删接管者锁）；released:false, reason:"held_by_other"

export async function readLock(projectDir: string): Promise<LockHolder | null>;
// 读 + parseLockContent；文件缺失/畸形 → null。

export type ValidateResult =
  | { ok: true; holder: LockHolder }
  | { ok: false; reason: "not_held" | "held_by_other"; holder: LockHolder | null };

export async function validateLockHeld(args: {
  projectDir: string;
  sessionId: string;
}): Promise<ValidateResult>;
// 供 leaf writer 写前校验（Phase 3，mandatory）：ok:true 仅当锁存在且归属本 session。
// 这是 conclusion B「接管防双写」的承重墙（M1）。
```

#### plan-review `plan_id` 隔离（Phase 1）

```ts
// src/tools/plan-review.ts
export const planReviewArgsSchema = z.object({
  snapshot: z.string().optional(),
  plan: z.string().optional(),
  review: z.string().optional(),
  project_dir: z.string().optional(),
  plan_id: z.string().optional(),   // ★新增
}).superRefine(/* 不变：snapshot/plan/review 恰一非空；plan_id 与 project_dir 一样排除在「恰一」规则外 */);

export async function findActivePlanStatus(
  projectDir: string,
  planId?: string,            // ★新增可选参数
): Promise<PlanStatus | null>;
// planId 给定 → readPlanStatus(projectDir, planId) 精确读；null/terminal → 返回 null。
// planId 缺省 → 现有全局扫描行为（向后兼容单 plan 流）。

// execute 入口（plan-review.ts:1088）：
const status = await findActivePlanStatus(projectDir, validated.plan_id);
// getStageSignature（todo-tracker.ts:145）同步传 args["plan_id"]。
```

#### 工具入参 `takeover` schema（Phase 3，M2）

```ts
// 给以下四个 stage-owner 工具的 args schema 各加（守 prose-contract 不涉，prose-contract 只管 NEXT ACTION 文案）：
//   codeTool.args / sprintTool.args / archiveTool.args / forceArchiveTool.args
takeover: tool.schema
  .boolean()
  .optional()
  .describe(
    "Set true to forcibly take over the ghs runtime lock (.ghs/active.lock) " +
    "when another session holds it. Use only after seeing a conflict message " +
    "and consciously deciding to接管 (the other session's subsequent writes " +
    "will be rejected by the leaf-writer pre-write validate)."
  );
// execute 入参类型同步加 takeover?: boolean，透传给 acquireLock({ takeover: args.takeover ?? false })。
```

#### plan-start O_EXCL 创建（Phase 1，M6）

```ts
// src/lib/state.ts（新增，不动现有 writePlanStatus）
export type WriteExclusiveResult =
  | { created: true; path: string }
  | { created: false; reason: "exists" };

export async function writePlanStatusExclusive(
  projectDir: string,
  status: PlanStatus,
): Promise<WriteExclusiveResult>;
// 用 fs.open(statusFilePath(projectDir, status.plan_id), "wx")；EEXIST → created:false, reason:"exists"。
// 现有 writePlanStatus（覆盖写）保持不变，供 plan-review round 推进 / finalize markApproved 使用。

// src/tools/plan-start.ts execute 循环去重：
//   for (suffix of ["", "-2", "-3", ..., "-99"]) {
//     const candidateSlug = base + suffix;
//     const planId = `${date}-${candidateSlug}`;
//     const status = createInitialPlanStatus({ planId, ... });
//     const r = await writePlanStatusExclusive(projectDir, status);
//     if (r.created) { statusPath = r.path; break; }
//   }
//   若 99 次仍冲突 → 返回冲突文案让用户换 slug（极端兜底）。
```

### 3.4 关键流程

#### 流程 1：plan 阶段并发（隔离 ①，含 M6 O_EXCL 去重）

```
窗口 A: ghs-plan-start(slug_seed="alpha") → plan_id="2026-07-02-alpha"（O_EXCL 创建成功）
         → context-explorer → ghs-plan-review(snapshot, plan_id="2026-07-02-alpha")
         → designer → ghs-plan-review(plan, plan_id="2026-07-02-alpha") ...
窗口 B: ghs-plan-start(slug_seed="beta")  → plan_id="2026-07-02-beta"（O_EXCL 创建成功）
         → ... ghs-plan-review(*, plan_id="2026-07-02-beta") ...

# M6 同 slug 去重场景：
窗口 C: ghs-plan-start(slug_seed="alpha")（与 A 同 slug）
         → writePlanStatusExclusive EEXIST → 重试 "2026-07-02-alpha-2" → 成功
         → 后续 review/finalize 全程带 plan_id="2026-07-02-alpha-2"
```
- 每次调用都带 `plan_id`，`findActivePlanStatus` 只读自己的 status 文件，两窗口产物写入各自 `<plan_id>-*` sibling 文件，零交叉。
- **并发安全前提**（M6，显式声明）：各窗口用互异 slug（默认各窗口传不同 `slug_seed`）；slug 巧合相同时 plan-start 用 O_EXCL + 后缀去重自动保证 status.json 不互踩。
- `ghs-plan-finalize` 已有 `plan_id` 参数（`plan-finalize.ts:299`），无需改。
- 向后兼容：`plan_id` 缺省时退回全局扫描，老的单 plan 流与既有测试不受影响。

#### 流程 2：sprint/code 阶段持锁（隔离 ②，含 M3 放置点 + M4/M5 残留窗口）

锁的归属以 `session_id` 为准，**同 session 再获取 = 幂等 no-op**，跨 session = 冲突。

**`acquireLock` 放置点（M3，钉死）**：置前置校验**之后**，错误路径根本不获取锁——
- `code.ts`：`projectDir` 解析 → features.json 存在性（`code.ts:216`）→ JSON parse（`code.ts:228`）通过后，在 `getReadyFeatures`（`code.ts:243`）**之前** `acquireLock`。
- `sprint.ts`：`projectDir` 解析 → features.json 存在性（`sprint.ts:148`）通过后，在 `archiveSprints`（`sprint.ts:156`）**之前** `acquireLock`。

| 工具 | acquire 放置点 | 写前 | 退出/终态 |
|------|----------------|------|-----------|
| `ghs-sprint` | features.json 存在性校验**之后**、archiveSprints **之前**（M3） | — | 写完骨架后**不释放**（持锁跨后续 append-feature） |
| `ghs-append-feature` | 不获取；`validateLockHeld`（mandatory）。无锁时降级 leaf 短锁 | `validateLockHeld` 通过才写（features.json + 该工具全部写包进 performWrite，O3） | — |
| `ghs-code` | JSON parse 通过**之后**、getReadyFeatures **之前**（M3） | — | **终态释放**：「no ready features」banner 路径（`code.ts:264`）或 sprint 已 completed |
| `ghs-update-feature-status` | 不获取；`validateLockHeld`。无锁时降级 leaf 短锁 | `validateLockHeld` 通过才写（features.json + progress.md 都包进 performWrite，O3） | — |
| `ghs-archive` / `ghs-force-archive` | `acquireLock`（同 session 幂等）；放置点参照各自前置校验之后 | — | 归档完成（含 active sprint）后**释放** |

**冲突路径（跨 session，含 M2 takeover 入参）**：
```
窗口 A 持锁（stage=code, sprint=s5）。
窗口 B 调 ghs-code（takeover 缺省=false）→ acquireLock → acquired:false, reason:"held_by_other"。
ghs-code 返回冲突文案（renderConflictMessage）：
  ❌ 另一流水线正持有 ghs 运行期锁。
     持有者: claude-code@ab12cd        ← buildLabel(ctx)：agent + sessionID 末 6 位（O1）
     阶段: code（sprint s5）
     进程 PID: 12345，获取于 2026-07-02T14:30:00（已持有 8 分钟）
  请在 chat 中选择：
    - 接管（takeover）：重调 ghs-code 并带 takeover=true，覆盖该锁
        （原窗口的后续写入将被 leaf-writer 写前 validate 拒绝）
    - 等待：等对方释放后再调 ghs-code
    - 取消：放弃本次
  ▶ NEXT ACTION: 由用户在 chat 中决策后，重调 ghs-code（takeover=true）或等待。
窗口 B 不执行任何写，安全返回。
```
- **不自动判陈旧**（结论 B）：即便 PID 已死/时间很久，工具也不主动清锁，而是把 PID + 时间戳呈现给用户辅助判断。
- **takeover 后的防双写（M4 + M1）**：用户选接管后 `acquireLock(takeover=true)` 覆盖锁（⚠ 承认 M4 残留 TOCTOU 窗口，文档化）；被踢窗口（A）后续调 `update-feature-status` 时 `validateLockHeld` 失败（holder.session_id !== A.session_id）→ 返回冲突错误、拒绝写。**这是 Phase 3 写前校验锁的核心价值，故 Phase 3 mandatory（M1）。**

#### 流程 3：finalize 自动续接（结论 C，行为不变）

`ghs-plan-finalize` 不持锁（plan 阶段隔离 ① 已保证不跨窗口打架），其 success 路径返回「Next: invoke ghs-sprint」文案（`plan-finalize.ts:477`）。主 AI 据此调 `ghs-sprint` 时才进入隔离 ② 获取锁。续接只在持锁流水线内部发生。

### 3.5 错误处理

| 场景 | 处理 |
|------|------|
| `acquireLock` 时 O_EXCL 遇 EEXIST（竞态：另一进程刚获取） | 重读锁内容归类，返回 `acquired:false, held_by_other`（不抛异常） |
| 锁文件 JSON 畸形（手工编辑损坏） | `parseLockContent` → null → 视为「无锁」可获取（畸形锁不阻塞，但记录 warning 进返回文本） |
| `releaseLock` 复读发现锁已属他 session（被接管，M5） | 不删除，返回 `released:false, held_by_other`（防误删接管者锁） |
| takeover 覆盖写踩掉刚合法获取的新持有者（M4 残留窗口） | 文档化承认，不抛异常；由 Phase 3 leaf-writer `validateLockHeld` 在后续写入处兜底（被踩者下次写前 validate 发现归属不符而拒绝写） |
| `validateLockHeld` 失败（Phase 3，被踢窗口残留写） | 返回冲突错误文案，**不执行 Bun.write**，`▶ NEXT ACTION` 指引用户 takeover |
| 锁目录 `.ghs/` 不存在 | `acquireLock` 先 `mkdir -p`（与 `writePlanStatus` 一致） |
| PID 字段跨平台 | `process.pid` 在 win32/posix 均可用；仅作呈现，不用于 kill |
| plan-start O_EXCL 99 次仍冲突（M6 极端兜底） | 返回冲突文案让用户换 slug_seed |

---

## 4. 实施步骤

> 分 4 阶段，每阶段独立可回滚、可测试。Phase 1 与 Phase 2 互相独立可并行；Phase 3 依赖 Phase 2（且为 mandatory，含旧 Phase 3+4 合并，M1）；Phase 4 随各阶段增量更新。

### Phase 1：plan-stage plan_id 隔离 + plan-start O_EXCL 防覆盖（小、隔离、低风险）

**改哪些文件**：
- `src/tools/plan-review.ts`
- `src/lib/todo-tracker.ts`
- `src/lib/state.ts`（新增 `writePlanStatusExclusive`，不动现有 `writePlanStatus`）
- `src/tools/plan-start.ts`（execute 改用 O_EXCL 去重循环）
- `shared/skill/ghs/SKILL.md`
- `src/prompts/context-codegraph.ts`、`src/prompts/context-grep.ts`、`src/prompts/plan-designer.ts`、`src/prompts/plan-reviewer.ts`（dispatch directive 透传 plan_id）
- `shared/references/plan-designer.md`（可选：说明 plan_id 透传）

**新增/改动符号（签名级）**：
- `planReviewArgsSchema`：新增 `plan_id: z.string().optional()`；`superRefine` 不变（plan_id 排除在「恰一」规则外，与 project_dir 同列）。
- `planReviewTool.args`：新增 `plan_id` schema 字段（`.optional().describe(...)`）；`execute` 入参类型加 `plan_id?: string`。
- `findActivePlanStatus(projectDir, planId?)`：新增可选第二参数；给定则 `readPlanStatus` 精确读 + terminal 校验，跳过全局扫描。
- `planReviewTool.execute`：`findActivePlanStatus(projectDir, validated.plan_id)`。
- `getStageSignature(toolName, projectDir, args)`（`todo-tracker.ts:133`）：plan-* 分支调用 `findActivePlanStatus(projectDir, typeof args["plan_id"] === "string" ? args["plan_id"] : undefined)`。
- `writePlanStatusExclusive(projectDir, status): Promise<WriteExclusiveResult>`（M6，state.ts 新增）：`fs.open(path, "wx")`，EEXIST → `{created:false, reason:"exists"}`。
- `planStartTool.execute`（M6）：planId 候选循环 `[base, base+"-2", ..., base+"-99"]`，每次 `createInitialPlanStatus` + `writePlanStatusExclusive`，首个 created 即用；全冲突 → 冲突文案。
- dispatch prompt 模板：在「调用 ghs-plan-review」指令处增加「带上 ghs-plan-start 返回的 plan_id」。

**关键逻辑伪码**：
```ts
export async function findActivePlanStatus(projectDir, planId?) {
  if (planId && planId.trim()) {
    const s = await readPlanStatus(projectDir, planId.trim());
    if (s === null || isTerminal(s.status)) return null;
    return s;
  }
  // ……现有全局扫描逻辑不变（向后兼容）……
}

// M6: plan-start execute 去重循环
const base = slugifyRequirement(args.slug_seed?.trim() || "plan");
let statusPath: string | null = null;
let finalPlanId: string | null = null;
for (const suffix of ["", ...range(2, 100).map(n => `-${n}`)]) {
  const planId = `${formatLocalDate(now)}-${base}${suffix}`;
  const status = createInitialPlanStatus({ planId, planFile: `${planId}.md`,
    contextFile: `${planId}-context.md`, codegraphAvailable, now, maxRounds });
  const r = await writePlanStatusExclusive(projectDir, status);
  if (r.created) { statusPath = r.path; finalPlanId = planId; break; }
}
if (!statusPath) {
  return [ `❌ plan-start: 99 个候选 slug 均已被占用（base="${base}"）。`,
           "请换一个唯一的 slug_seed 重试。" ].join("\n");
}
```

**验收标准（可测点）**：
- `test/plan-review.test.ts` 新增：seed 两个 active status（planA/planB），`findActivePlanStatus(dir, "planA")` 只返回 planA；不带 planId 时仍返回最新（兼容）。
- 新增 integration：两 mock session 各自带 plan_id 调 review，互不读错对象。
- 新增（M6）：seed `2026-07-02-alpha-status.json` 后调 `planStartTool.execute(slug_seed="alpha")` → 产物为 `2026-07-02-alpha-2`（去重成功）；O_EXCL 防覆盖（原 alpha 不被踩）。
- 新增（O7，回归钉死）：snapshot/plan/review 三 mode 的 `composeChrome` 收到的 `toolArgs["plan_id"]` 非空；`getStageSignature` 带/不带 plan_id 在单 active plan 下返回一致签名（防 prompt 模板回归丢字段）。
- 既有 plan-review / plan-start 测试全部通过（plan_id 缺省走旧路径；plan-start 默认 slug 在 fresh dir 仍 O_EXCL 成功即首个候选）。
- `test/prose-contract.test.ts` 通过。

**回滚方式**：`plan_id` 为可选参数且缺省走旧全局扫描；`writePlanStatusExclusive` 为纯新增；plan-start 回退到单次 `writePlanStatus` 即恢复原行为（同 slug 覆盖行为回归，但功能不损）。直接 revert 7 个文件改动即恢复，无数据迁移。

**风险**：低。注意点：(1) dispatch prompt 要确保主 AI 真的把 plan_id 透传——靠 SKILL.md 强约定 + O7 回归断言覆盖；(2) plan-start O_EXCL 在 fresh dir 首个候选即成功，既有测试不受影响。

---

### Phase 2：runtime-lock 原语（新 lib 模块，暂不接线）

**改哪些文件（新增）**：
- `src/lib/scripts/runtime-lock.ts`（行为源真：schema + 纯函数）
- `src/lib/runtime-lock.ts`（工具层 helper：file I/O 包装）
- `test/runtime-lock.test.ts`（unit）
- `test/scripts/runtime-lock.test.ts`（纯函数 unit）

**新增符号（签名见 §3.3）**：
- 行为源真：`LockHolderSchema`（stage 三态含 leaf，O2）、`buildLockHolder`、`parseLockContent`、`classifyHolder`、`ConflictKind`、`renderConflictMessage`。
- 工具层：`buildLabel`（O1）、`lockFilePath`、`acquireLock`（M4：无读回校验）、`releaseLock`（M5：复读再 unlink）、`readLock`、`validateLockHeld`、`AcquireResult`、`ReleaseResult`、`ValidateResult`。

**关键逻辑伪码**：
```ts
// acquireLock 核心无竞态获取（M4：删除读回校验）
async function acquireLock({ projectDir, sessionId, stage, sprintId, holderLabel, takeover }) {
  await mkdir(dirname(lockFilePath(projectDir)), { recursive: true });
  const existing = parseLockContent(await tryRead(lockFilePath(projectDir)));
  const cls = classifyHolder(existing, sessionId);
  const holder = buildLockHolder({ sessionId, stage, sprintId: sprintId ?? null, holderLabel });

  if (cls === "held_by_other" && !takeover) {
    return { acquired: false, reason: "held_by_other", holder: existing! };
  }
  if (cls === "none") {
    // O_EXCL 新建；EEXIST → 重读归类（跨进程竞态兜底）
    try { await openWriteExclusive(lockFilePath(projectDir), JSON.stringify(holder, null, 2)); }
    catch (e if e.code === "EEXIST") {
      const reread = parseLockContent(await tryRead(lockFilePath(projectDir)));
      return reread === null
        ? { acquired: true, holder }                              // 对方已释放，自愈
        : { acquired: false, reason: "held_by_other", holder: reread };
    }
  } else {
    // held_by_self 或 takeover：覆盖写（同进程顺序，无竞态）。不读回校验——自证无意义（M4）。
    await Bun.write(lockFilePath(projectDir), JSON.stringify(holder, null, 2));
  }
  return { acquired: true, holder };
}

// releaseLock（M5：unlink 前复读缩小窗口）
async function releaseLock({ projectDir, sessionId }) {
  const first = parseLockContent(await tryRead(lockFilePath(projectDir)));
  if (first === null) return { released: false, reason: "not_held", holder: null };
  if (classifyHolder(first, sessionId) !== "held_by_self") {
    return { released: false, reason: "held_by_other", holder: first };
  }
  // 复读一次：若期间被 takeover，则不删（防误删接管者锁）
  const reread = parseLockContent(await tryRead(lockFilePath(projectDir)));
  if (reread !== null && classifyHolder(reread, sessionId) !== "held_by_self") {
    return { released: false, reason: "held_by_other", holder: reread };
  }
  await unlink(lockFilePath(projectDir));
  return { released: true };
}
```
> `openWriteExclusive` = Node `fs/promises.open(path, "wx")` 封装（O_EXCL，win32/posix 均支持）。

**验收标准**：
- unit：`buildLockHolder` 字段齐全 + pid 取自 process.pid + stage 三态合法；`buildLabel` = `${agent}@${sessionID.slice(-6)}`（O1）。
- unit：`parseLockContent(null)/畸形→null`；`classifyHolder` 三态正确。
- unit：`acquireLock` 新建成功；同 session 再获取（不同 stage）幂等更新；他 session 不带 takeover → acquired:false；带 takeover → 覆盖成功（**不再断言读回归属**，M4）；O_EXCL EEXIST 兜底（模拟并发：先手工建锁再 acquire）。
- unit：`releaseLock` 归属匹配→unlink + released:true；归属不匹配→不删 + held_by_other；无锁→not_held；**复读路径**（unlink 前锁被改成他 session）→ 不删 + held_by_other（M5）。
- unit：`validateLockHeld` 三态。
- unit：`renderConflictMessage` 含 holder_label/pid/acquired_at/stage/sprint_id + 三选一 + 「重调 ghs-<tool> 带 takeover=true」（守 prose-contract）。

**回滚方式**：纯新增模块，尚未被任何 tool 引用；删除两个源文件 + 两个测试文件即回滚，零副作用。

**风险**：低。注意 `O_EXCL` 在某些网络文件系统（NFS < v3）语义弱——但 `.ghs/` 在本地仓库，非问题；文档注明「仅支持本地文件系统」。

---

### Phase 3：锁接入 stage owners + leaf writer 写前校验（★ mandatory，M1：合并旧 Phase 3+4）

> **强制实施**。本阶段是 conclusion B「接管防双写」的承重墙（M1）。不做则 takeover 后被踢窗口仍可裸写 features.json/progress.md，锁形同虚设。stage-owner 接锁（旧 Phase 3）与 leaf-writer 写前 validate（旧 Phase 4）必须**同批实施、同批回滚**。

**改哪些文件**：
- `src/tools/sprint.ts`
- `src/tools/code.ts`
- `src/tools/append-feature.ts`
- `src/tools/update-feature-status.ts`
- `src/tools/archive.ts`
- `src/tools/force-archive.ts`
- `test/integration/_helpers.ts`（M7：`mockToolContext` 参数化 sessionID）
- `test/integration/multi-pipeline.test.ts`（新建）

**新增/改动符号（接线点）**：

*stage owners（含 M2 takeover schema + M3 放置点）*：
- `codeTool.args` / `sprintTool.args` / `archiveTool.args` / `forceArchiveTool.args`：各加 `takeover: tool.schema.boolean().optional().describe(...)`（M2）。execute 入参类型加 `takeover?: boolean`。
- `sprintTool.execute`（M3）：features.json 存在性校验**之后**（`sprint.ts:148`）、`archiveSprints`（`sprint.ts:156`）**之前** `acquireLock({ stage:"sprint", sprintId:null, takeover: args.takeover ?? false, holderLabel: buildLabel(ctx) })`；冲突 → 返回 `renderConflictMessage(...,"ghs-sprint")` + NEXT ACTION。写完骨架后**不释放**（持锁跨 append-feature）。
- `codeTool.execute`（M3）：JSON parse（`code.ts:228`）**之后**、`getReadyFeatures`（`code.ts:243`）**之前** `acquireLock({ stage:"code", sprintId: activeSprintId, takeover: args.takeover ?? false, holderLabel: buildLabel(ctx) })`；冲突 → 冲突文案。在「no ready features」banner 路径（`code.ts:264`）调 `releaseLock`。
- `archiveTool.execute` / `forceArchiveTool.execute`：各前置校验之后 `acquireLock`（同 session 幂等，`takeover` 透传）；归档完成（含 active sprint）后 `releaseLock`。

*leaf writers（mandatory，M1）*：
- `appendFeatureTool.execute` / `updateFeatureStatusTool.execute`：**不获取锁**；改为 `writeFeaturesSerialized(ctx, projectDir, performWrite)` 统一入口（O3：performWrite 封装该工具全部磁盘写）。
  - `update-feature-status` 的 `performWrite` = features.json 写 **+ progress.md 写**（O3，两处都包进同一回调）。
  - `append-feature` 的 `performWrite` = features.json 写。
- `writeFeaturesSerialized` 逻辑：`validateLockHeld` → ok:true 直接 `performWrite`；ok:false reason:"held_by_other" → `renderConflictMessage`（拒绝写，防双写核心）；ok:false reason:"not_held" → 降级 `leaf` 短锁（O2：`acquireLock({stage:"leaf"})` → `performWrite` → `releaseLock`）。

**关键逻辑伪码**：

*code.ts（M3 放置点 + 终态释放）*：
```ts
// code.ts execute（节选）
const projectDir = ...;
const featuresFile = Bun.file(featuresPath);
if (!(await featuresFile.exists())) return [...];          // ← 早返回，不获取锁（M3）
let featuresData;
try { featuresData = JSON.parse(await featuresFile.text()); }
catch (err) { return [...]; }                              // ← 早返回，不获取锁（M3）

const lock = await acquireLock({ projectDir, sessionId: ctx.sessionID, stage: "code",
  sprintId: activeSprintId(featuresData), takeover: args.takeover ?? false,
  holderLabel: buildLabel(ctx) });                          // ★ acquire 在 parse 之后（M3）
if (!lock.acquired) {
  return composeChrome({ ..., body: renderConflictMessage(lock.holder, "ghs-code 推进") });
}
const result = getReadyFeatures(featuresData);              // ← parse 之后、ready 之前
if (result.ready.length === 0) {
  await releaseLock({ projectDir, sessionId: ctx.sessionID });   // ★ 终态释放
  return /* 「no ready features」banner */;
}
// ……派发逻辑不变……
```

*leaf writer 加固（mandatory，O3）*：
```ts
async function writeFeaturesSerialized(ctx, projectDir, performWrite: () => Promise<string>): Promise<string> {
  const v = await validateLockHeld({ projectDir, sessionId: ctx.sessionID });
  if (v.ok) { return performWrite(); }                       // 已在持锁流水线内
  if (v.reason === "held_by_other") {
    return renderConflictMessage(v.holder!, "<action>", "ghs-update-feature-status");  // 被接管，拒绝写
  }
  // not_held：standalone，降级 leaf 短锁（O2）
  const acq = await acquireLock({ projectDir, sessionId: ctx.sessionID, stage: "leaf", sprintId: null,
                                  holderLabel: buildLabel(ctx) });
  if (!acq.acquired) { return renderConflictMessage(acq.holder, "<action>", "ghs-update-feature-status"); }
  try { return await performWrite(); }                       // O3：performWrite 内含 features.json + progress.md
  finally { await releaseLock({ projectDir, sessionId: ctx.sessionID }); }
}
```

**验收标准（可测点）**：
- helper（M7）：`mockToolContext(projectDir, sessionID = "integration-test-session")`；既有调用点不传第二参即保持默认值，向后兼容。
- integration（`multi-pipeline.test.ts`，**两 ctx 的 sessionID 不同**，M7 AC）：
  - **场景 1（sprint 竞态）**：seed `.ghs/features.json`；sessionA `sprintTool.execute` 成功；sessionB（不同 sessionID）`sprintTool.execute` → 冲突文案、features.json sprint 数不变。
  - **场景 2（takeover，M2）**：sessionB 带 `takeover=true` 重调 `sprintTool.execute` → 获取成功；sessionA 再调 `codeTool.execute` → 冲突文案。
  - **场景 3（code 终态释放 + M3 不泄漏）**：seed 无 ready feature；sessionA `codeTool.execute` → 「no ready features」banner；`readLock(dir) === null`。**features.json 缺失时 `codeTool.execute`（M3 AC）**：`readLock(dir) === null`（早返回不获取锁）。**JSON parse 失败时**（M3 AC）：`readLock(dir) === null`。
  - **场景 4（写前校验防双写，mandatory）**：sessionA 持锁 code；sessionB `updateFeatureStatusTool.execute` → 冲突、features.json 不变 **且 progress.md 不变**（O3）；sessionA 被 takeover 后再 `updateFeatureStatusTool.execute` → 冲突、不写（防双写核心 AC）。
  - **场景 5（standalone leaf 短锁，O2/O3）**：无锁；`appendFeatureTool.execute` → 写成功 + `readLock(dir) === null`（leaf 短锁释放）；`updateFeatureStatusTool.execute` standalone → features.json **与 progress.md** 都更新 + `readLock === null`。
  - **场景 6（plan 并发隔离）**：seed 两个 active status；sessionA `planReviewTool.execute(plan_id=A)`、sessionB `planReviewTool.execute(plan_id=B)` → 各自只读自己的 status。
- 既有 sprint/code/archive/append-feature/update-feature-status 测试通过（fresh temp dir 无锁，首次 acquire/leaf 短锁成功；同 session 幂等不影响多调用）。

**回滚方式**：revert 6 个 tool 文件的 acquire/release/validate 调用 + `_helpers.ts` 签名 + 新测试文件；Phase 2 的 lib 模块保留也无害（未被引用）。leaf writer 退回无条件写（stage-owner 锁失效，但单流水线流不受影响）。

**风险**：
- **中**。最大风险仍是「锁泄漏导致永久阻塞」——M3 已将 acquire 下移到前置校验之后，消除两条早返回泄漏路径，唯一释放点为终态；异常路径用 `try/finally` 包裹 post-acquire 区段兜底；takeover（M2）作为用户侧兜底。
- 既有测试可能因 fresh temp dir 首次 acquire 成功而意外通过，需显式断言「锁文件存在/不存在」「两 ctx sessionID 不同」（M7）。

---

### Phase 4：SKILL.md / 编排文档更新

**改哪些文件**：
- `shared/skill/ghs/SKILL.md`
- `src/prompts/context-codegraph.ts`、`context-grep.ts`、`plan-designer.ts`、`plan-reviewer.ts`（Phase 1 的 plan_id 透传指令）
- `src/prompts/feature-impl.ts`、`sprint-planning.ts`（如需提示锁语义）
- `shared/references/plan-designer.md`、`coding-agent.md`（可选补充）

**内容要点**：
- **多流水线并发章节（含 O4/O5 澄清）**：
  - plan 阶段可任意跨窗口并发（带 plan_id + plan-start O_EXCL 防 slug 覆盖）。
  - **澄清（O4）**：SKILL.md 既有「plan 阶段不可交织」（`SKILL.md:21-24`）是**单流水线内**不交织 plan 与 sprint/code，与「plan 可跨窗口并发」正交——不冲突。
  - sprint/code 阶段单窗口独占（运行期锁）。
- **锁语义说明**：`.ghs/active.lock` 的含义；stage owner（sprint/code）持锁跨多调用；leaf writer 写前 validate（mandatory）。
- **残留窗口文档化（M4/M5）**：takeover 覆盖写与 release unlink 各有残留 TOCTOU 窗口，由 leaf-writer `validateLockHeld` 兜底；威胁模型=协作式人工流水线、可接受。
- **worktree 提示（O5）**：并发流水线须指向**同一 projectDir**（worktree 共享主 `.ghs/` 或显式传 `project_dir`），否则锁文件分立、互斥失效。
- **冲突文案与用户选择流程**：遇冲突时不自动判陈旧，呈现 PID + 时间戳，用户在 chat 选 takeover/wait/cancel；takeover 后原窗口写入会被 leaf-writer validate 拒绝。
- **plan_id 透传约定**：ghs-plan-start 返回的 plan_id 必须带给后续每次 ghs-plan-review。
- **锁释放边界**：code 在「no ready features」或 sprint 归档终态释放；手动 abandon 靠 takeover（M2 入参）。
- **Broken-Flow Recovery 补充**：流水线卡住时先 `ghs-status` 看 `.ghs/active.lock` 持有者，再决定 takeover。

**验收标准**：
- `test/prose-contract.test.ts` 通过（新增 dispatch 文案中的工具名带 `ghs-` 前缀）。
- 文档审阅：锁语义、冲突文案、用户三选一流程、M4/M5 残留窗口说明、O4/O5 澄清描述完整。

**回滚方式**：revert 文档改动；不影响代码行为。

**风险**：低。纯文档。

---

## 5. 风险与缓解

| 风险 | 概率 | 影响 | 缓解策略 |
|------|------|------|----------|
| 锁泄漏致永久阻塞（终态释放点遗漏/异常路径） | 中 | 高（流水线卡死） | M3 将 acquire 下移到前置校验之后，消除早返回泄漏；异常路径 `try/finally` 兜底；takeover（M2）用户侧兜底；SKILL.md 引导用 `ghs-status` 诊断 + takeover |
| takeover 后被踢窗口仍双写 | 中 | 高（features.json/progress.md 损坏） | **Phase 3 mandatory（M1）**：leaf writer 写前 `validateLockHeld`；performWrite 封装 features.json + progress.md 两处写（O3） |
| takeover 覆盖写 TOCTOU 踩掉新持有者（M4 残留窗口） | 低 | 中 | 文档化承认；由 Phase 3 leaf-writer validate 在后续写入处兜底 |
| release unlink TOCTOU 误删接管者锁（M5 残留窗口） | 低 | 中 | unlink 前复读缩小窗口；由 Phase 3 leaf-writer validate + 接管者重入自愈兜底 |
| 主 AI 忘记透传 plan_id（并发 plan 仍污染） | 中 | 中 | dispatch prompt 强约定 + SKILL.md + O7 回归断言钉死；plan_id 缺省退回全局扫描（单 plan 安全） |
| plan-start 同 slug 覆盖（M6） | 低 | 中 | O_EXCL 创建 + 后缀去重（`-2`..`-99`）；并发安全前提显式声明 |
| O_EXCL 在网络文件系统语义弱 | 低 | 低 | 文档注明「仅支持本地仓库」；`.ghs/` 本就在本地 |
| 既有测试因 fresh temp dir 首次 acquire 意外通过（未真验锁语义） | 中 | 中 | 测试显式断言锁文件存在/不存在、跨 session 冲突文案、两 ctx sessionID 不同（M7） |
| `session_id` 跨进程不唯一（极端：两实例碰巧同 id） | 极低 | 中 | session_id 由 OpenCode 分配，碰撞概率极低；PID 字段作辅助区分呈现给用户 |
| 锁文件手工损坏阻塞获取 | 低 | 低 | `parseLockContent` 畸形→null 视为无锁可获取（不阻塞），warning 入返回文本 |
| worktree 致锁路径分立、互斥失效（O5） | 低 | 中 | SKILL.md 注明并发流水线须指向同一 projectDir |

---

## 6. 测试策略

### 6.1 Unit 测试（Phase 2，纯函数 + file I/O）

- **行为源真** `test/scripts/runtime-lock.test.ts`：
  - `buildLockHolder`：字段齐全、pid=process.pid、stage 三态合法（含 leaf，O2）、时间戳格式。
  - `buildLabel`：= `${agent}@${sessionID.slice(-6)}`（O1）。
  - `parseLockContent(null)`/畸形 JSON/缺字段 → null；合法 → LockHolder。
  - `classifyHolder`：none/held_by_self/held_by_other 三态。
  - `renderConflictMessage`：含 holder_label/pid/acquired_at/stage/sprint_id + 三选一 + 「重调 ghs-<tool> 带 takeover=true」（守 prose-contract）。
- **工具层** `test/runtime-lock.test.ts`（temp dir via `makeTempDir`）：
  - `acquireLock`：新建成功（锁文件出现）；同 session 不同 stage 幂等更新；他 session 无 takeover → acquired:false + 原 holder；他 session takeover → 覆盖成功（**不再断言读回归属**，M4）；O_EXCL EEXIST 兜底（模拟并发：先手工建锁再 acquire）。
  - `releaseLock`：归属匹配→unlink + released:true；归属不匹配→不删 + held_by_other；无锁→not_held；**复读路径**（unlink 前锁被改成他 session）→ 不删 + held_by_other（M5）。
  - `validateLockHeld`：三态。
  - `readLock`：缺失→null。

### 6.2 Integration 测试（Phase 3，模拟两窗口竞态）

- `test/integration/multi-pipeline.test.ts`（新建，复用 `_helpers.ts` 的 `makeTempDir` / `mockToolContext(dir, sessionID)`，M7 参数化）：
  - **场景 1（sprint 竞态）**：seed `.ghs/features.json`；sessionA `sprintTool.execute` 成功；sessionB（**不同 sessionID**）`sprintTool.execute` → 冲突文案、features.json sprint 数不变。
  - **场景 2（takeover，M2）**：sessionB `takeover=true` → 获取成功；sessionA 再 `codeTool.execute` → 冲突文案。
  - **场景 3（code 终态释放 + M3 不泄漏）**：seed 无 ready feature；sessionA `codeTool.execute` → 「no ready features」banner；`readLock(dir) === null`。**features.json 缺失** / **JSON parse 失败** 时 `codeTool.execute`：`readLock(dir) === null`（早返回不获取锁）。
  - **场景 4（写前校验防双写，mandatory）**：sessionA 持锁 code；sessionB `updateFeatureStatusTool.execute` → 冲突、features.json 不变 **且 progress.md 不变**（O3）；sessionA 被 takeover 后再 `updateFeatureStatusTool.execute` → 冲突、不写。
  - **场景 5（standalone leaf 短锁，O2/O3）**：无锁；`appendFeatureTool.execute` → 写成功 + `readLock === null`；`updateFeatureStatusTool.execute` standalone → features.json **与 progress.md** 都更新 + `readLock === null`。
  - **场景 6（plan 并发隔离）**：seed 两个 active status；sessionA `planReviewTool.execute(plan_id=A)`、sessionB `planReviewTool.execute(plan_id=B)` → 各自只读自己的 status。
  - **场景 7（M6 plan-start O_EXCL 去重）**：seed `2026-07-02-alpha-status.json` 后 `planStartTool.execute(slug_seed="alpha")` → 产物为 `2026-07-02-alpha-2`；原 alpha 不被踩。
  - **断言（M7 AC）**：两 ctx 的 `sessionID` 不同。

### 6.3 回归测试

- 既有 `test/plan-review.test.ts` / `test/plan-finalize.test.ts` / `code.test.ts` / `append-feature.test.ts` / `update-feature-status.test.ts` 全部通过（plan_id 缺省走旧路径；fresh temp dir 首次 acquire/leaf 短锁成功）。
- `test/prose-contract.test.ts` 通过（新增 dispatch 文案工具名带 `ghs-` 前缀）。
- `test/e2e/full-workflow.test.ts` 通过（单流水线全流程不因锁卡死——fresh dir 首次 acquire + 终态释放）。
- **新增（O7）**：snapshot/plan/review 三 mode 的 `composeChrome` 收到的 `toolArgs["plan_id"]` 非空；`getStageSignature` 带/不带 plan_id 在单 active plan 下返回一致签名。
- **`.gitignore` 不改（O6 记正）**：`.ghs/active.lock` 已被 `.gitignore:224` 的 `.ghs` 整体忽略（仅 `test/fixtures/.ghs/` 反向放行）；审查清单移除「锁文件未纳入 .gitignore」误报项。

### 6.4 验证命令

```bash
bun run typecheck   # 唯一静态检查
bun test            # 全量
bun test test/runtime-lock.test.ts              # Phase 2 unit
bun test test/scripts/runtime-lock.test.ts      # Phase 2 纯函数 unit
bun test test/integration/multi-pipeline.test.ts # Phase 3 integration
```

---

## 7. 开放问题（需用户拍板 + 推荐默认）

| # | 开放问题 | 我的推荐默认 | 理由 |
|---|----------|--------------|------|
| Q1 | ghs-code 锁释放时机（长循环 dispatch→subagent→parse→update-status→re-call） | **在「no ready features」banner 或 sprint 归档终态释放**；update-feature-status 中途不释放 | 锁必须跨 subagent 执行期持有（subagent 正在编辑 src/，是源码树冲突高发期）；仅终态释放既保证安全又避免中途窗口被抢 |
| Q2 | ghs-sprint 写完骨架后是否立即释放？后续 append-feature 是否也持锁？ | **sprint 写完骨架不释放**（持锁跨 append-feature 规划期）；append-feature 作 leaf writer 走 `validateLockHeld`（Phase 3 mandatory），无锁时降级 leaf 短锁 | append-feature 也 RMW features.json，并发会 lost update；持锁跨规划期最安全；standalone 短锁兜底手动调用 |
| Q3 | 是否做 leaf-writer 写前校验锁 | **做（mandatory，不再是「强烈建议」）**——已与 Phase 3 stage-owner 接锁**合并同批实施**（M1） | 不做则 takeover 后被踢窗口仍可双写 features.json/progress.md，锁形同虚设，conclusion B 不成立。Phase 标签与决策一致化，消除「可跳过」歧义 |
| Q4 | 陈旧检测策略（窗口崩溃→锁残留→永久阻塞） | **用户决策为主，不自动判陈旧**：检测到锁即返回冲突文案，呈现 PID + 时间戳，用户选 takeover/wait/cancel | 结论 B 已定；自动判陈旧（如按 wall-clock 超时清锁）会误清仍在跑的长 subagent；PID + 时间戳足以辅助用户判断；takeover（M2）已可触发 |
| Q5 | leaf writer（append-feature/update-feature-status）无锁时的行为 | **降级 leaf 短锁**（acquire stage="leaf" → write → release，O2），而非拒绝 | 兼容 standalone 手动调用（用户直接调 update-feature-status 修状态而不经 sprint/code 流），短锁保证即便 standalone 也串行化 |
| Q6 | plan_id 是否强制必填（而非可选） | **保持可选**，缺省退回全局扫描 | 向后兼容既有单 plan 流与所有既有测试；并发安全靠 dispatch prompt + SKILL.md + O7 回归断言约定主 AI 透传 |
| Q7 | takeover 覆盖写 / release unlink 的残留 TOCTOU 窗口（M4/M5） | **文档化承认 + leaf-writer validate 兜底**，不引入 CAS | 威胁模型=协作式人工流水线、takeover 罕见、可接受；plain Bun.write 不支持 CAS，引入临时文件+条件 rename 复杂度不值得；leaf-writer validate 已能在后续写入处自愈 |
| Q8 | plan-start 同 slug 竞态（M6） | **O_EXCL 创建 + 后缀去重（-2..-99）**，并显式声明并发安全前提=互异 slug | 低成本闭合 conclusion A 的字面承诺；O_EXCL 复用 Phase 2 同款原语；99 次仍冲突属极端兜底，返回冲突文案让用户换 slug |

---

## 8. 修订日志

- **Round 1**：初版方案。依据 context snapshot + 需求结论 A/B/C 设计。无 reviewer 反馈待处理。
- **Round 2（本版）**：依据 round-1 评审报告（FAIL：7 Medium + 7 Optimization）逐条修订——
  - **M1**：旧 Phase 4（写前校验锁）从「推荐执行」升为 **mandatory**，与旧 Phase 3（stage-owner 接锁）合并为单一 Phase 3，同批实施/同批回滚。
  - **M2**：`takeover` 在 `codeTool.args`/`sprintTool.args`/`archiveTool.args`/`forceArchiveTool.args` schema 落地（`tool.schema.boolean().optional()`），冲突文案 NEXT ACTION 指明「重调 ghs-<tool> 带 takeover=true」。
  - **M3**：`acquireLock` 放置点钉死为「前置校验之后」（code 在 JSON parse 后、sprint 在 features.json 存在性后），消除早返回泄漏；AC 补「features.json 缺失/parse 失败时不产生锁文件」。
  - **M4**：删除 takeover「读回校验归属」自证写措辞，文档化承认残留 TOCTOU 窗口，由 leaf-writer validate 兜底。
  - **M5**：`releaseLock` unlink 前复读一次缩小窗口，SKILL.md 注明残留窗口由 Phase 3 validate 兜底。
  - **M6**：plan-start status.json 改 O_EXCL 创建（`writePlanStatusExclusive`）+ slug 后缀去重（-2..-99），显式声明并发安全前提。
  - **M7**：`test/integration/_helpers.ts` 加入 Phase 3 改文件清单，`mockToolContext(projectDir, sessionID = ...)` 参数化，AC 补「两 ctx sessionID 不同」。
  - **O1**：`buildLabel(ctx) = ${agent}@${sessionID.slice(-6)}` 明确。
  - **O2**：`LockHolderSchema.stage` 扩三态含 `leaf`，standalone 降级用 `leaf`。
  - **O3**：`writeFeaturesSerialized(performWrite)` 明确 performWrite 封装该工具全部磁盘写（features.json + progress.md）。
  - **O4**：SKILL.md 澄清「plan 阶段不可交织」是 per-pipeline，与跨窗口并发正交。
  - **O5**：SKILL.md 注明并发流水线须指向同一 projectDir。
  - **O6**：`.gitignore` 无需改（已整体忽略 `.ghs`），审查清单移除误报项。
  - **O7**：补 plan_id 透传回归断言（composeChrome toolArgs / getStageSignature 一致签名）。
  - 守约 A/B/C 不变；隔离选型（O_EXCL 创建 + validate 写前校验 + 同 session 幂等）保留。