# Spike: .opencode/skill/ghs/ 加载路径 + /skill-creator eval 可行性探查

- **Feature**: s1-feat-010(机制三 Phase 3 第一步,对应方案 §3.3 + §5 R5)
- **Sprint**: s1 workflow-planagent-skill
- **Plan ref**: `docs/ghs/plans/2026-06-22-ghs-plan-agent-skill-v41.md` §3.3 / §5 R5
- **日期**: 2026-06-22
- **性质**: 静态/文档探查(隔离 subagent 环境无法做真实会话 E2E,见下文「验证边界」)
- **结论(一句话)**:**需手动 E2E 确认** —— 加载路径经二进制反编译已有高置信静态结论(确认会加载),/skill-creator eval 对编排型 skill 可跑但定位偏 awkward,核心验证仍需真实 OpenCode 会话。

---

## 1. 探查方法

| # | 动作 | 来源 | 置信度 |
|---|------|------|--------|
| 1 | 反编译/抽取 opencode 二进制内嵌的 Skill discovery 模块 | `~/.nvm/.../opencode-ai/bin/opencode.exe`(Mach-O,v1.17.9)的 `strings` 输出 | **高**(运行时本体) |
| 2 | 读 opencode SDK 类型定义 | `~/.config/opencode/node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts` | **高** |
| 3 | 读 skill-creator SKILL.md + grader/analyzer agent md | `~/.agents/skills/skill-creator/` | **高**(skill-creator 是 OpenCode 内置 skill,见系统 `available_skills`) |
| 4 | 检查本机既有 skill 配置形态 | `~/.agents/skills/<name>/SKILL.md`(20 个),`~/.config/opencode/opencode.jsonc` | **高** |
| 5 | 读 plan §3.3 + §5 R5 | `docs/ghs/plans/2026-06-22-ghs-plan-agent-skill-v41.md:142-146,201` | n/a(对照目标) |

> 说明:opencode 是 Bun 打包的 Mach-O 二进制,内嵌全部 JS 源(`/$bunfs/root/chunk-*.js`)。Skill discovery 与 Skill 模块的源码完整可见,可作「运行时本体」证据,而非仅文档承诺。

---

## 2. 发现 A —— Skill 加载路径(高置信)

### 2.1 默认搜索目录(`ConfigPaths.directories()`)

从二进制抽取的源(`q` 模块 / `ConfigPaths.directories`):

```js
l = s("ConfigPaths.directories")(function*(g,S){
  let r = yield* U.Service;
  return X([
    I.Path.config,                                                          // ① ~/.config/opencode(全局)
    ...!G.OPENCODE_DISABLE_PROJECT_CONFIG
      ? yield* r.up({targets:[".opencode"], start:g, stop:S})               // ② <cwd>/.opencode 自底向上(项目,默认开)
      : [],
    ...yield* r.up({targets:[".opencode"], start:I.Path.home, stop:I.Path.home}),  // ③ $HOME/.opencode
    ...G.OPENCODE_CONFIG_DIR ? [G.OPENCODE_CONFIG_DIR] : []                  // ④ $OPENCODE_CONFIG_DIR 环境变量(可选)
  ])
})
```

即默认搜索四个来源的全局/项目配置目录,且 ② 受 `OPENCODE_DISABLE_PROJECT_CONFIG` 关闭。

### 2.2 各目录下的 SKILL.md glob

从二进制抽取的 `p` 模块(Skill discovery 常量):

```js
const Zj = ".claude",
      Tj = ".agents",
      l  = "skills/**/SKILL.md",                  // 用于 .claude / .agents(legacy / Claude Code 兼容)
      _j = "{skill,skills}/**/SKILL.md",          // 用于上述 ConfigPaths.directories() —— 单复数都吃
      a  = "**/SKILL.md";                         // 用于用户显式 skills.paths / skills.urls
```

主 discovery 函数 `Lj` 顺序:

1. **legacy / Claude Code 兼容**(可被 `disableExternalSkills` 整体关闭;`.claude` 另可被 `disableClaudeCodeSkills` 单独关):
   - `~/.claude/skills/<name>/SKILL.md`(glob `skills/**/SKILL.md`,下同)
   - `~/.agents/skills/<name>/SKILL.md`
   - 自底向上找 `.claude/skills/` 与 `.agents/skills/`(`<cwd>` 向上到 home)
2. **§2.1 的四个 `.opencode*` 目录**,每个用 glob `{skill,skills}/**/SKILL.md` —— **即 `.opencode/skill/<name>/SKILL.md` 与 `.opencode/skills/<name>/SKILL.md` 等价都加载**
3. **用户显式 `skills.paths`**(config 字段,见 `types.gen.d.ts:1200-1208`):支持 `~` 展开 + 相对 cwd 解析,glob `**/SKILL.md`(任意嵌套结构)
4. **用户显式 `skills.urls`**:远程 fetch 到 `<cache>/skills/`,glob `**/SKILL.md`

**文档佐证**(二进制内嵌 help 字面量):

```
| Global skills  | `~/.config/opencode/skill(s)/<name>/SKILL.md` |
| Project skills | `.opencode/skill(s)/<name>/SKILL.md`          |
```

### 2.3 直接结论(对应 plan §3.3)

> **`.opencode/skill/ghs/SKILL.md` 会被 OpenCode 加载。** 路径形态、目录位置、glob 模式三者全部匹配。

feat-011 计划用 `ghs-init` 把 `shared/skill/ghs/SKILL.md` 复制到 `<projectDir>/.opencode/skill/ghs/SKILL.md`,落点正确。亦可用 `skills`(复数),效果一致。

### 2.4 SKILL.md frontmatter 要求(重要)

从 `p` 模块的 `Pj` 守卫 + `fmt` 函数:

```js
function Pj(Q){
  return jj(Q)                                          // 是对象
    && typeof Q.name === "string"                       // name 必须是字符串(必需)
    && (Q.description === void 0
        || typeof Q.description === "string")           // description 可选但若必须是字符串
}
// fmt:
const X = Q.filter((A) => A.description !== void 0);    // 【关键】缺 description 的 skill 不进 available_skills 系统提示!
```

- **`name`**:必需,字符串。缺失 → skill 被静默丢弃(`Hj` 函数 `if(!Pj(A.data))return`)。
- **`description`**:可选,但**若缺失,该 skill 不出现在系统提示 `available_skills` 列表里**,等于模型看不见、不会被自动 consult。仍可通过 `Skill.get(name)` / `GET /skill` 端点查到(对 SDK 显式查询可见)。
- **目录名 vs YAML name**:二进制有 `SkillNameMismatchError` 类型(`path/expected/actual`),但 `Hj` 仅以 YAML `name` 为 skills Map 的 key(`Q.skills[A.data.name] = ...`),目录名不强制一致 —— 但 feat-011 应保持 `ghs/` 目录名 == YAML `name: ghs`,避免下游工具困惑。

**给 feat-011 的硬约束**:`shared/skill/ghs/SKILL.md` 的 YAML frontmatter **必须**含 `name: ghs` 与一段「pushy」的 `description`(否则不进系统提示,等于白写)。

### 2.5 加载时机 —— 仅启动一次(C4 兑现)

从 `p` 模块 `h`(Skill layer):

```js
Z = yield* _.make(j.fn("Skill.state")(function*(){
  let J = {skills:{}, dirs:new Set};
  J.skills[t] = {...};                                  // 内置 customize-opencode skill 硬编码注入
  yield* Rj(J, yield* _.get(G), X);                     // 调用 Hj 把每个 match 解析进 J.skills
  return J;
}))
```

- `_.make(...)` 是 Effect 的 `SubscriptionRef` / 单次 memoized state cell 模式 —— **首次访问时跑 discovery,之后会话内不再重扫**。
- 全二进制无 `watch.*skill` / `reload.*skill` 字面量(grep 命中的「hot-reloading」全部来自前端 dev server,与 skill 无关)。
- **兑现 C4**(agent md / skill 仅启动加载):新增 / 改动 SKILL.md 后必须重启 OpenCode 才生效。这点与现有 `ghs-config`(改 `.ghs/ghs.json` → 重写 agent md → 提示重启)的约束完全一致,无新风险。

### 2.6 潜在冲突点(feat-011/feat-012 注意)

- **环境变量旁路**:若用户设了 `OPENCODE_DISABLE_PROJECT_CONFIG=1`,则 `<cwd>/.opencode/skill/` 不被扫 —— 项目级 skill 失效。这是用户显式选择,不属于 ghs 能管的事,但 **E2E_CHECKLIST 应列一条「确认未设该 env」**(见 §5)。
- **`disableExternalSkills` / `disableClaudeCodeSkills`**:不影响 `.opencode/skill/`(那两个 flag 只关 legacy `.claude` / `.agents`)。
- **重名**:若有其它来源也叫 `ghs`(如 `~/.agents/skills/ghs`),二进制会 `logWarning("duplicate skill name", ...)`,先注册者胜。全局用户目录先于项目 `.opencode`,即**用户全局 `ghs` 会遮蔽项目 `ghs`**。低概率,记入 R5 旁注。

---

## 3. 发现 B —— /skill-creator eval 对编排型 skill 的适配性

### 3.1 skill-creator eval 框架是什么

读 `~/.agents/skills/skill-creator/SKILL.md` + `agents/grader.md` + `scripts/`:

- **量化 benchmark**(`scripts/run_eval.py` / `aggregate_benchmark.py`):每个 eval 用例**并行跑两个 subagent** —— 一个带 skill(with_skill),一个不带(baseline / old_skill)。grader subagent 读 transcript + 输出文件,对每条 assertion 出 PASS/FAIL + evidence。聚合出 pass_rate / time / tokens 的 mean±stddev,展示 with vs without 的 delta。
- **描述优化器**(`scripts/run_loop.py`):不用 subagent,改用 `claude -p` 子进程跑 20 条触发查询(should-trigger / should-not-trigger 各半),每条跑 3 次估触发率,60% train / 40% test,迭代最多 5 轮调 `description`。产物是 `best_description`。
- **断言**(`SKILL.md:201-205`):「Good assertions are objectively verifiable」;**「Subjective skills (writing style, design quality) are better evaluated qualitatively — don't force assertions onto things that need human judgment.」**

### 3.2 ghs skill 是哪一类

ghs SKILL.md 是**编排型 / workflow skill** —— 它告诉模型「调 ghs 工具按序推进 stage,随 stage 刷新 todo,执行 ▶ NEXT ACTION 锚点」,产物不是文件而是**一串工具调用**。

对照 skill-creator 自分类:
- ✅ 客观可验:`did the AI call ghs-init first?` / `did it follow plan-start → plan-review → plan-finalize order?` / `did it honor ▶ NEXT ACTION?`(均可从 transcript 检索工具调用序列)
- ❌ 不适合量化 benchmark 的:long-horizon 真实交付质量(是否真把 feature 写对了)—— 这类需要 grader 主观判,skill-creator 明确说不该强加 assertion。

### 3.3 适配性结论

| 维度 | 可行性 | 备注 |
|------|--------|------|
| **benchmark eval(with vs without)** | ⚠️ **可跑但 awkward** | grader 读 transcript + 输出文件,可对「工具调用序列」「是否调 todowrite」「是否执行 NEXT ACTION」出 PASS/FAIL。但需要真实 OpenCode 会话(ghs 插件装好 + skill 在 `.opencode/skill/ghs/`)+ 真实 LLM。隔离 subagent 跑不了。 |
| **description optimizer(触发率)** | ✅ **较合适** | 跑 `claude -p` 查「我想用 ghs 启动 sprint」是否触发 ghs skill。产出 best_description。**这才是 /skill-creator 对编排型 skill 的主用场**。同样需真实环境。 |
| ** qualitative(人工看 transcript)** | ✅ **最合适** | skill-creator 自己建议:编排/主观类 skill 优先 qualitative。等价于 E2E_CHECKLIST 的「手起一遍 ghs 流程看是否被 consult」。 |

**对应 R5 判断**:R5 原文「SKILL.md 编排型 skill 不被 /skill-creator 支持 / 影响:机制三 eval 不可用 / 缓解:SKILL.md 作人类可读参考保留」。

- **「不被支持」过悲观**:/skill-creator 仍可跑(description optimizer + 触发/序列断言都行)。
- **「降级为人类参考」是合理兜底**:若量化 benchmark 成本/收益不划算(每迭代要 2N 个真实会话),保留 SKILL.md 作人类可读编排规范 + 系统提示 nudge 已经兑现机制三核心价值(模型看得见 skill → 被 consult)。

---

## 4. 验证边界 —— 本 spike 不能做什么

> 隔离 subagent 环境(C4):无运行中的 OpenCode 主进程、无 ghs 插件实际注册、`.opencode/skill/ghs/SKILL.md` 尚未创建(feat-011 才建)、无真实 LLM 会话。

因此本 spike 的所有结论都是**静态/文档级**:

- ✅ 已静态确认:加载路径形态、glob 模式、frontmatter 要求、加载时机、API 端点存在。
- ❌ 未动态确认:OpenCode 实际启动时是否在 `available_skills` 里看到 `ghs`;模型是否真的 consult 它;/skill-creator eval 在装好 ghs 插件的项目里是否跑通。

这三项必须**手动 E2E**。

---

## 5. 手动 E2E 验证步骤(供编排者写入 E2E_CHECKLIST.md)

> 对应 plan §4 Phase 3「验收 [手动 E2E]:/skill-creator eval」+ §6「手动 E2E」末项。

### 前置(feat-011 / feat-012 完成后)

1. `ghs-init` 已在测试项目跑过,`.opencode/skill/ghs/SKILL.md` 存在且 frontmatter 含 `name: ghs` + pushy `description`。
2. `echo $OPENCODE_DISABLE_PROJECT_CONFIG` 为空(或显式 unset)。

### Step 1 —— skill 被加载

```bash
# 启动 opencode 后,在新会话里:
curl -s http://localhost:<opencode-port>/skill | jq '.[] | select(.name=="ghs")'
# 期望:返回 {name:"ghs", description:"...", location:"<abs>/.opencode/skill/ghs/SKILL.md", content:"..."}
# 或用 SDK:import { client } from "@opencode-ai/sdk"; (await client.appSkills()).data
```

或更简单:在 opencode 对话里直接问「list available skills」/ 看 system prompt 是否含 `<skill><name>ghs</name>...`。

- **PASS**:skill 出现,location 指向项目 `.opencode/skill/ghs/SKILL.md`。
- **FAIL 可能原因**:① 没重启 OpenCode(改 SKILL.md 后必须重启,见 §2.5);② frontmatter 缺 `description`(见 §2.4,会被剔出 available_skills);③ `OPENCODE_DISABLE_PROJECT_CONFIG` 设了(见 §2.6)。

### Step 2 —— skill 被模型 consult(触发)

在 opencode 对话里说「我想用 ghs 启动一个新项目的 sprint 流程」,观察:

- **PASS**:模型在调 `ghs-init` 前先 echo 出「loading skill ghs」/ 引用 skill 内容;或对话里能看到 skill 被 consult 的痕迹(opencode TUI 有 skill 加载提示)。
- **FAIL**:模型直接凭 system hint 调 ghs-init 而 未 consult skill —— 检查 `description` 是否足够 pushy(skill-creator 自述:Claude 倾向 undertrigger)。

### Step 3 —— /skill-creator eval(可选,高成本)

```text
# 在装好 ghs 插件 + skill 的项目里,对 opencode 说:
用 /skill-creator 对 ghs skill 跑 description optimizer,验证「我要用 ghs ...」类查询的触发率。
# 或(benchmark 路径):
用 /skill-creator 对 ghs skill 跑 benchmark,3 条 eval:
  - "初始化 ghs 项目" → 断言:首个 ghs 工具调用是 ghs-init
  - "启动 sprint 拆 feature" → 断言:调 ghs-sprint
  - "看下进度" → 断言:调 ghs-status
```

- **PASS(benchmark)**:with_skill 的工具调用序列断言 pass_rate 显著高于 without_skill baseline。
- **PASS(description optimizer)**:产出 best_description,test 触发率 > train(未过拟合)。
- **可接受降级**:若 benchmark 成本过高,记入 E2E_CHECKLIST「qualitative review only」即视为 R5 兑现。

---

## 6. 给 feat-011 / feat-012 的输入

| 下游 feat | 本 spike 给的约束 / 输入 |
|-----------|--------------------------|
| **feat-011**(shared/skill/ghs/SKILL.md + ghs-init 复制) | ① 路径用 `.opencode/skill/ghs/SKILL.md`(单数,贴合 plan 字面;复数亦可);② frontmatter **必须**含 `name: ghs` + pushy `description`(否则不进 available_skills);③ 复制保持字节一致即可,无需任何路径改写;④ 兑现 C4:首次跑 ghs-init 后提示用户「重启 OpenCode 以加载 ghs skill」。 |
| **feat-012**(SYSTEM_HINT 瘦身为 skill 指针) | 指针文本应写「consult the `ghs` skill」而非硬编码路径 —— skill 由 `name` 而非路径被 consult;另需保留 Todo Discipline + 工具列表(机制一依赖)。 |
| **feat-013**(集成 + 文档) | E2E_CHECKLIST 补 §5 三步;AGENTS.md 补「`.opencode/skill/<name>/SKILL.md` 是项目级 skill 约定,重启加载」。 |

---

## 7. Spike 结论(对应 AC)

| AC | 状态 | 备注 |
|----|------|------|
| `.opencode/skill/ghs/SKILL.md` 是否被加载/识别 | **静态高置信:是**(§2.3) | 动态确认留给 §5 Step 1 E2E |
| /skill-creator 能否对 ghs skill eval | **可跑但 awkward**:description optimizer 合适,benchmark 需对工具调用序列出断言(§3.3) | 动态确认留给 §5 Step 3 E2E(可选) |
| 明确「可 eval」或「仅人类参考」 | **需手动 E2E 确认**(本 spike 主结论) | 静态证据强烈指向「可加载 + 部分可 eval」,但隔离 subagent 无法动态验证,按 spike 规范判「需手动 E2E 确认」 |

**R5 兑现状态**:风险未被消除(动态未验),但**缓解措施明确且自洽** —— 即便 E2E 发现 `/skill-creator` benchmark 不划算,SKILL.md 作为「人类可读编排规范 + 系统提示内可见 skill」已兑现机制三核心价值,降级路径有效。

---

## 附录:关键证据文件路径(供 feat-013 归档)

- opencode 二进制:`~/.nvm/versions/node/v22.20.0/lib/node_modules/opencode-ai/bin/opencode.exe`(v1.17.9,Mach-O x86_64,Bun 打包)
- SDK 类型:`~/.config/opencode/node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts:1197-1209`(skills config),`:4456-4476`(AppSkillsResponses)
- skill-creator SKILL.md:`~/.agents/skills/skill-creator/SKILL.md`
- 既有 skill 样本:`~/.agents/skills/caveman/SKILL.md`(最简 frontmatter 样本)
