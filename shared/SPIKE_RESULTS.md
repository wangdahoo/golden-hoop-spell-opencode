# Phase 0 Spike Results

**Date**: 2026-06-20
**Environment**: opencode 1.17.8, bun 1.3.11, darwin 25.5.0
**Provider used for verification**: `zai-coding-plan` + `zhipuai-coding-plan` (GLM series — Anthropic not configured locally; plan's `anthropic/claude-haiku-4-20250514` ID was substituted with `zai-coding-plan/glm-4.5-air` for the dispatch-mechanism spikes. The substitution mechanism is model-agnostic — see spike 004).
**Codegraph CLI**: globally installed at `/Users/tom/.nvm/versions/node/v22.20.0/bin/codegraph` (not `bun x codegraph-mcp` as plan §3.3 speculated; see spike 003).

---

## Summary

| Spike | Title | Status | Critical? |
|---|---|---|---|
| s1-feat-001 | hyphenated tool key + system.transform | ✅ PASS | hard requirement (D1) |
| s1-feat-002 | subagent + Task tool dispatch | ✅ PASS | load-bearing (R2) |
| s1-feat-003 | codegraph MCP server + tool exposure | ✅ PASS | load-bearing (R1) |
| s1-feat-004 | markdown agent template substitution + reload | ✅ PASS | load-bearing (R3) |

**All 5 architectural assumptions de-risked.** No fallback paths required. Proceed to Phase 1 (s1-feat-005 scaffold).

---

## s1-feat-001: hyphenated tool key + system.transform hook

**Status**: ✅ PASS

### Verified

1. **Hyphenated tool key loads**: A tool registered under `ghs-spike-test` (with the hyphen) appears in the AI's available tool list and round-trips JSON args/result correctly.
2. **`experimental.chat.system.transform` hook injects marker**: A string pushed via `output.system.push("...")` lands in the AI's system prompt and the AI can verbatim echo it back.
3. **Local plugin loading works**: `opencode.jsonc` field `plugin: ["./plugin.ts"]` resolves a relative TS file (no npm publish needed for dev).

### Minimal repro

`spikes/spike-01-tool-key-and-transform/plugin.ts` — 25-line plugin:

```typescript
import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";

const plugin: Plugin = async () => ({
  tool: {
    "ghs-spike-test": tool({
      description: "Spike 001 verification tool.",
      args: { echo: tool.schema.string() },
      async execute(args) {
        return JSON.stringify({ ok: true, received: args.echo });
      },
    }),
  },
  "experimental.chat.system.transform": async (_input, output) => {
    output.system.push("SPIKE MARKER 001 — ghs-spike-test tool is registered");
  },
});

export default plugin;
```

`spikes/spike-01-tool-key-and-transform/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["./plugin.ts"]
}
```

### Evidence

Tool invocation captured from `opencode run --format json`:

```json
{
  "type": "tool_use",
  "part": {
    "tool": "ghs-spike-test",
    "state": {
      "status": "completed",
      "input": { "echo": "ping-from-spike-001" },
      "output": "{\"ok\":true,\"received\":\"ping-from-spike-001\",\"echoed_at\":\"2026-06-19T22:38:47.869Z\"}"
    }
  }
}
```

Marker verification (separate run, focused prompt):

```json
{
  "type": "text",
  "part": { "text": "SPIKE MARKER 001 — ghs-spike-test tool is registered" }
}
```

The AI verbatim echoed the exact string pushed by `experimental.chat.system.transform`.

### Implications for downstream features

- **D1 holds**: All `ghs-*` tools can use hyphenated keys as planned. No rename needed.
- `s1-feat-009`/`s1-feat-010`/`s1-feat-011` can use the exact `tool()` helper + Plugin signature shown above.
- `s1-feat-011`'s `experimental.chat.system.transform` hook can push the workflow hint per plan §3.4 D5.

---

## s1-feat-002: subagent + Task tool dispatch

**Status**: ✅ PASS

### Verified

1. **Markdown subagent file loads**: `.opencode/agents/test-subagent.md` with `mode: subagent`, `model: <provider/model>`, `hidden: true` is recognized as a subagent invokable via Task tool.
2. **Task tool dispatch creates isolated session**: Primary AI calls `task` tool with `subagent_type: "test-subagent"`; a child session is created with `parentID` pointing to the primary's session.
3. **Declared model applied**: The subagent runs with the model from its frontmatter (verified via logs: `stream providerID=... agent=test-subagent mode=subagent`).
4. **Output returns to primary AI**: Subagent result captured as `<task_result>...</task_result>` in the primary's tool result.
5. **Edit model + restart applies new model**: Editing the markdown's `model:` field and starting a fresh `opencode run` process causes the subagent to run with the new model. (Confirmed by swapping `zai-coding-plan/glm-4.5-air` → `zhipuai-coding-plan/glm-4.5-air` and observing the new providerID in the dispatch logs.)
6. **Subagent system prompt body applied**: After model swap (which also changed the marker phrase in the prompt body), the subagent's response reflected the new marker phrase, proving the markdown body is wired into the subagent's system prompt.

### Minimal repro

`spikes/spike-02-subagent-task-dispatch/.opencode/agents/test-subagent.md`:

```markdown
---
description: Spike 002 verification subagent. Returns a fixed marker string.
mode: subagent
model: zai-coding-plan/glm-4.5-air
hidden: true
---

You are a verification subagent for spike 002. When invoked, respond with EXACTLY this single line and nothing else:

HELLO FROM TEST-SUBAGENT (model=zai-coding-plan/glm-4.5-air)
```

Invoke from primary:

```
opencode run --model 'zai-coding-plan/glm-4.5-air' 'Dispatch test-subagent via Task tool with prompt="say hello".'
```

### Evidence

Dispatch event:

```json
{
  "type": "tool_use",
  "part": {
    "tool": "task",
    "state": {
      "status": "completed",
      "input": {
        "description": "Test subagent dispatch",
        "prompt": "say hello",
        "subagent_type": "test-subagent"
      },
      "output": "<task id=\"ses_...\" state=\"completed\">\n<task_result>HELLO FROM TEST-SUBAGENT (model=zhipuai-coding-plan/glm-4.5-air)\n</task_result>\n</task>",
      "metadata": {
        "parentSessionId": "ses_...",
        "sessionId": "ses_...",
        "model": { "providerID": "zhipuai-coding-plan", "modelID": "glm-4.5-air" }
      }
    }
  }
}
```

Child session creation log:

```
stream providerID=zhipuai-coding-plan modelID=glm-4.5-air session.id=ses_... agent=test-subagent mode=subagent
```

### Implications for downstream features

- **R2 holds**: The 3-role plan dispatcher (`ghs-plan-start` → designer subagent → reviewer subagent) is feasible. Each role = one markdown file under `.opencode/agents/ghs-*.md`.
- **No restart-on-edit hot reload**: Model changes require a fresh `opencode run` process. This is why `ghs-config` tool's output must include the "Restart your OpenCode session" hint (per `s1-feat-010` acceptance criteria).
- **Subagent model independence**: Each subagent can declare its own model, enabling per-role model selection (R2's per-task model selection requirement).
- **Task tool args**: `description`, `prompt`, `subagent_type`. Future `ghs-plan-start` etc. should construct these when programmatically dispatching.

---

## s1-feat-003: codegraph MCP server declaration + tool exposure

**Status**: ✅ PASS (with two divergences from plan §3.3 — see below)

### Verified

1. **MCP server starts**: `mcp.codegraph` declaration in opencode.json starts the MCP server process; `opencode mcp list` reports `✓ codegraph  connected`.
2. **Tools exposed to primary AI**: 8 codegraph tools appear in primary AI's tool list.
3. **AI can invoke tools**: Primary AI calling `codegraph_codegraph_status` returns a real status object (files/nodes/edges/backend).
4. **Subagent `tools` frontmatter restricts MCP access**: A subagent with `tools: { codegraph_codegraph_*: false }` cannot invoke codegraph tools — it reports "BLOCKED: codegraph tools not available" when prompted to try.

### Divergences from plan §3.3 (IMPORTANT)

**Divergence 1 — command**:
- **Plan says**: `command: ["bun", "x", "codegraph-mcp"]`
- **Actually works**: `command: ["codegraph", "serve", "--mcp"]` (codegraph CLI's `serve` subcommand)
- **Impact**: `s1-feat-005`'s `shared/opencode.json.example` and `s1-feat-008`/`s1-feat-009`'s MCP-related defaults must use `["codegraph", "serve", "--mcp"]` to match the user's environment.
- **Mitigation for other users**: The plan's `bun x codegraph-mcp` may work in environments where `codegraph` CLI isn't globally installed — both commands ultimately start the same MCP server. Document both options in `shared/opencode.json.example` with comments.

**Divergence 2 — tool naming**:
- **Plan implies**: tools named `codegraph_status`, `codegraph_explore`, etc.
- **Actually exposed**: tools named `codegraph_codegraph_status`, `codegraph_codegraph_explore`, etc. — i.e., `<server_name>_<original_tool_name>`.
- **Impact**: The `experimental.chat.system.transform` hint text in `s1-feat-011` should NOT hardcode `codegraph_status` etc.; instead it should say "codegraph MCP tools" or use the double-prefix form. Plan §3.4 D5's hint text needs revising.
- **Subagent permission patterns**: When restricting MCP tools via `tools: { ... }`, the glob pattern must use the double-prefixed name: `codegraph_codegraph_*` (a single-prefix `codegraph_*` pattern also matched in testing, possibly because both layers are checked — but the double-prefix form is the safer canonical form).

**Divergence 3 — permission field**:
- **Plan implies**: modern `permission` frontmatter key restricts MCP tools.
- **Actually works**: only the deprecated `tools: { <pattern>: false }` form successfully restricts MCP tools. The modern `permission:` field has keys for built-in tools (bash, edit, etc.) but no key for arbitrary MCP tool patterns.
- **Impact**: Future `ghs-context-haiku`, `ghs-plan-designer`, `ghs-plan-reviewer` agent markdowns that need to restrict MCP access must use the `tools:` form, not `permission:`.

### Minimal repro

`spikes/spike-03-codegraph-mcp/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "codegraph": {
      "type": "local",
      "command": ["codegraph", "serve", "--mcp"],
      "enabled": true
    }
  }
}
```

`spikes/spike-03-codegraph-mcp/.opencode/agents/codegraph-probe.md`:

```markdown
---
description: Spike 003 probe subagent.
mode: subagent
model: zai-coding-plan/glm-4.5-air
hidden: true
tools:
  codegraph_codegraph_*: false
  codegraph_*: false
---
... (prompts AI to try invoking codegraph_codegraph_status)
```

### Evidence

Tool list visible to primary AI (from `/tmp` test dir, using global config):

```
codegraph_codegraph_callees
codegraph_codegraph_callers
codegraph_codegraph_explore
codegraph_codegraph_files
codegraph_codegraph_impact
codegraph_codegraph_node
codegraph_codegraph_search
codegraph_codegraph_status
```

Successful invocation result:

```
## CodeGraph Status
**Files indexed:** 1
**Total nodes:** 4
**Total edges:** 5
**Database size:** 0.14 MB
**Backend:** node:sqlite (Node built-in) — full WAL + FTS5
**Journal mode:** wal (concurrent reads safe)
### Nodes by Kind:
- file: 1
- function: 1
- import: 2
### Languages:
- typescript: 1
```

Restricted subagent response:

```
<task_result>BLOCKED: codegraph tools not available</task_result>
```

### Implications for downstream features

- **R1 holds**: codegraph MCP is the primary context-extraction mechanism. Grep fallback is not needed for users with `codegraph` CLI installed.
- **s1-feat-005** `shared/opencode.json.example` must declare `mcp.codegraph` with `["codegraph", "serve", "--mcp"]` (and document the `bun x codegraph-mcp` alternative in a comment).
- **s1-feat-011** system.transform hint must reference MCP tools via descriptive text ("codegraph MCP tools") rather than hardcoding bare tool names.

---

## s1-feat-004: markdown agent template substitution + reload

**Status**: ✅ PASS (load-bearing R3 spike — fully de-risked)

### Verified

1. **Template substitution**: A TypeScript script reading a `.md.template` file with `__GHS_MODEL_TEST__` placeholder, substituting it with a real model ID string, and writing to `.opencode/agents/ghs-test.md` produces a valid agent file.
2. **Substituted file loads as agent**: After a fresh `opencode run` process, the `ghs-test` subagent dispatches successfully with the substituted model.
3. **Frontmatter `model:` field substituted**: The substituted model ID appears in the running subagent's stream log (`stream providerID=... modelID=...`).
4. **Body placeholder substituted**: The subagent's prompt body containing `__GHS_MODEL_TEST__` was also substituted; the subagent's response reflected the substituted value verbatim.
5. **Change substitution value + re-render + restart → new model applies**: Re-rendering with a different model ID and starting a new opencode process caused the subagent to run with the new model.

### Minimal repro

`spikes/spike-04-template-substitution/ghs-test.md.template`:

```markdown
---
description: Spike 04 verification subagent.
mode: subagent
model: __GHS_MODEL_TEST__
hidden: true
---

You are a verification subagent for spike 004. When invoked, respond with EXACTLY:

HELLO FROM GHS-TEST (model=__GHS_MODEL_TEST__)
```

`spikes/spike-04-template-substitution/render.ts` (Bun script):

```typescript
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const PLACEHOLDER = "__GHS_MODEL_TEST__";
const modelId = process.env.GHS_MODEL_ID; // required
const templatePath = resolve(import.meta.dirname, "ghs-test.md.template");
const outPath = resolve(import.meta.dirname, ".opencode/agents/ghs-test.md");

const template = await readFile(templatePath, "utf8");
const rendered = template.replaceAll(PLACEHOLDER, modelId);
await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, rendered, "utf8");
```

Run + dispatch:

```bash
GHS_MODEL_ID='zai-coding-plan/glm-4.5-air' bun run render.ts
opencode run 'Dispatch ghs-test via Task tool with prompt="go".'

# Then re-render with different model + new opencode process:
GHS_MODEL_ID='zhipuai-coding-plan/glm-5.1' bun run render.ts
opencode run 'Dispatch ghs-test via Task tool with prompt="go".'
```

### Evidence

First dispatch (model = `zai-coding-plan/glm-4.5-air`):

```
stream providerID=zai-coding-plan modelID=glm-4.5-air session.id=ses_... agent=ghs-test mode=subagent
"model": { "providerID": "zai-coding-plan", "modelID": "glm-4.5-air" }
<task_result>HELLO FROM GHS-TEST (model=zai-coding-plan/glm-4.5-air)</task_result>
```

Second dispatch (model = `zhipuai-coding-plan/glm-5.1`):

```
stream providerID=zhipuai-coding-plan modelID=glm-5.1 session.id=ses_... agent=ghs-test mode=subagent
"model": { "providerID": "zhipuai-coding-plan", "modelID": "glm-5.1" }
<task_result>HELLO FROM GHS-TEST (model=zhipuai-coding-plan/glm-5.1)</task_result>
```

### Implications for downstream features

- **R3 holds**: User-configurable model IDs via `.ghs/ghs.json` is feasible. `s1-feat-007` (config.ts) can implement `renderAgentTemplate()` using `String.replaceAll()` over the template body.
- **`s1-feat-007` design confirmed**: Three placeholders (`__GHS_MODEL_CONTEXT__`, `__GHS_MODEL_DESIGNER__`, `__GHS_MODEL_REVIEWER__`) can all be substituted in one pass over each template file.
- **`s1-feat-010` (ghs-config tool) restart hint is required**: Substituted agent files don't hot-reload — users must restart opencode for changes to take effect.
- **No template engine needed**: `String.replaceAll()` is sufficient. No need for Handlebars/Mustache/etc.

---

## Cross-cutting findings

### Provider/model ID format

Confirmed: `provider/model-id` (e.g., `zai-coding-plan/glm-4.5-air`). The provider is everything before the first `/`; the model ID is everything after (and may itself contain slashes for some providers, though not for the GLM series tested here).

### Cost observations

All 4 spikes combined used the user's free-plan `zai-coding-plan` and `zhipuai-coding-plan` credentials. `opencode run` reported `cost: 0` for every session. The `glm-4.5-air` model is sufficient for verification prompts (though it sometimes truncates output after a tool call — a known small-model behavior, not a mechanism issue).

### OpenCode process lifecycle

Each `opencode run` invocation starts a fresh opencode server process that reads configs and agent files at startup. There is no in-process reload. This is why:
- Editing agent markdown requires a new `opencode run` to take effect.
- Editing `opencode.json` requires a new `opencode run`.
- Editing MCP server config requires a new `opencode run`.

Implication: `ghs-config` tool cannot "apply" changes by writing files alone — it must instruct the user to restart.

### Hidden subagents

`hidden: true` in frontmatter removes the subagent from `@` autocomplete but does NOT prevent Task tool dispatch (verified in spike 002 + spike 003 + spike 004 — all subagents had `hidden: true` and were successfully dispatched). This matches the documented behavior. All future `ghs-*` subagents should set `hidden: true` since they're internal orchestrator-roles, not user-facing.

---

## Follow-up: equivalence test harness divergences (s1-feat-012)

While building the equivalence tests (`test/equivalence/*.test.ts`) two **test-harness-only** divergences between Bun's test runner and CPython were found. Neither indicates a real bug in the TS ports; both are worked around in `test/equivalence/_helpers.ts`.

1. **Timezone forcing**: `bun test` runs every test with the JS locale pinned to UTC, regardless of the host system's actual TZ (verified: `Intl.DateTimeFormat().resolvedOptions().timeZone === "UTC"` inside tests, while `bun -e` reports `Asia/Shanghai`). This makes `new Date().getHours()` return UTC hours under test, but local hours in production. The Python oracle (`datetime.now()`) honours the host TZ by default, so the two would diverge by the TZ offset.
   - **Workaround**: `runPython()` in `_helpers.ts` explicitly sets `TZ=UTC` on the spawned Python's env, so both sides run in UTC inside tests. In production (non-test runtime) both honour the actual process TZ — no fix needed in the TS port itself.

2. **`Bun.mkdtemp` does not exist**: the feature spec referenced `Bun.mkdtemp` as the canonical temp-dir primitive. The installed Bun 1.3.11 exposes no such API.
   - **Workaround**: `makeTempDir()` in `_helpers.ts` uses Node's `fs.promises.mkdtemp(join(tmpdir(), prefix))` and then `realpathSync()`-resolves the result so the path matches Python's `Path.resolve()` semantics (matters on macOS where `/tmp` and `/var` are symlinks into `/private/...`).

3. **Python `re` vs JS `RegExp` for the H2 splitter**: not encountered as a divergence. Python's `re.split(r"^## ", content, flags=re.MULTILINE)` and JS's `content.split(/^## /m)` produce identical arrays for all fixture inputs exercised by the status/archive tests (verified empirically). No assertion relaxation needed.

4. **Archive dry-run still creates `.ghs/archived/`**: both the Python source and the TS port call `create_archive_structure` before checking `dry_run`. This is faithful port behaviour, not a bug — the equivalence test asserts the directory exists (but is empty) in dry-run mode for both impls.

---

## Sprint 1 E2E Verification (s1-feat-014)

**日期**: 2026-06-20
**方法**: 直接通过 Bun 脚本调用 plugin 的 tool.execute 函数（模拟 ToolContext），不重启完整 OpenCode 会话。与派发真实 AI 相比，这条路径更确定性、更快、覆盖面也更全（每个场景都能拿到结构化的 pass/fail 证据）。
**环境**: bun 1.3.11, darwin 25.5.0；验证用的 plugin 代码为 s1-feat-011 提交版本（`src/plugin.ts` + `src/index.ts`）。
**Agent 模板来源**: 由于生产模板 `shared/agents/ghs-*.md.template` 属于 Phase 3 / Sprint 3 范畴，本验证按 feature 文档「Option A」的指引，临时把 `test/fixtures/agents/*.md.template` 的 3 个 stub 复制到 `shared/agents/`，跑完测试后删除该目录（验证脚本运行前后 `git status` 干净）。

### 验证矩阵

| 场景 | 描述 | 结果 |
|---|---|---|
| 1 | `ghs-init` 在 temp dir 中创建全部期望文件 | ✅ PASS |
| 2 | 生成的 `.ghs/ghs.json` 与 `shared/ghs.default.json` 字节级一致 | ✅ PASS |
| 3 | 3 个生成的 agent markdown frontmatter `model:` 字段被默认 model ID 填充 | ✅ PASS |
| 4 | 编辑 `.ghs/ghs.json` 把 `models.context` 改为 `openai/gpt-5` 后调 `ghs-config({})` → context-haiku 的 model 被替换，另两个保持不变 | ✅ PASS（**修复后重跑通过**；初次执行时因 s1-feat-010 的目录 gate bug 失败，根因 + 修复见下方） |
| 4b | 直接调 `syncAgents()`（绕开 ghs-config 的前置 gate）→ context-haiku 被替换，另两个保持不变 | ✅ PASS（控制组，证明渲染机制本身没问题） |
| 5 | `ghs-status({})` 返回格式化的状态字符串 | ✅ PASS |
| 6 | 在没有 `.ghs/` 的空目录调 `ghs-config({})` → 返回 "Run ghs-init first." 且不写任何文件 | ✅ PASS |

### 场景 1：`ghs-init` 创建全部期望文件

- **Setup**: 用 `fs.mkdtemp` 在 `os.tmpdir()` 下建 temp project dir，模拟 ToolContext 指向它（`worktree` + `directory` 都设为该目录）。
- **Action**: `hooks.tool["ghs-init"].execute({ project_name: "temp-test" }, mockCtx)`。
- **Result**: PASS。
- **Evidence**: `ghs-init` 返回 1400 字符的成功摘要，以下 6 个文件全部存在且非空：
  - `.ghs/features.json` — 2369 字节；解析后 `project.name === "temp-test"`。
  - `.ghs/progress.md` — 636 字节。
  - `.ghs/ghs.json` — 161 字节。
  - `.opencode/agents/ghs-context-haiku.md` — 474 字节。
  - `.opencode/agents/ghs-plan-designer.md` — 475 字节。
  - `.opencode/agents/ghs-plan-reviewer.md` — 475 字节。

### 场景 2：生成的 `.ghs/ghs.json` 与 `shared/ghs.default.json` 字节级一致

- **Action**: 把场景 1 生成的 `.ghs/ghs.json` 内容与 `shared/ghs.default.json` 字节级比较。
- **Result**: PASS。两文件完全相同（包括缩进、换行）。

### 场景 3：3 个 agent markdown frontmatter `model:` 字段被默认 model ID 填充

- **Action**: 解析 3 个生成的 `.opencode/agents/ghs-*.md`，提取首行 `model:` 字段。
- **Result**: PASS。三个 agent 的 model 与 `shared/ghs.default.json` 一一对应：
  - `ghs-context-haiku.md` → `zai-coding-plan/glm-4.5-air`
  - `ghs-plan-designer.md` → `zhipuai-coding-plan/glm-4.6`
  - `ghs-plan-reviewer.md` → `zhipuai-coding-plan/glm-4.6`

### 场景 4：`ghs-config` 应在 `.ghs/ghs.json` 修改后重新生成（初 FAIL，已修复后 PASS）

- **Setup**: 在场景 1 生成的基础上，编辑 `.ghs/ghs.json`，把 `models.context` 改为 `openai/gpt-5`（其余两个字段保留）。
- **Action**: `hooks.tool["ghs-config"].execute({}, mockCtx)`。
- **Result（初次执行）**: **FAIL**。`ghs-config` 返回 19 字符的字符串 `"Run ghs-init first."`，3 个 agent markdown 文件未被重新渲染（`ghs-context-haiku.md` 的 model 仍是默认的 `zai-coding-plan/glm-4.5-air`）。
- **Root cause**: `src/tools/config.ts` 第 138 行的前置 gate 写的是 `await fileExists(resolve(projectDir, ".ghs"))`，而 `fileExists()` 的实现是 `Bun.file(path).exists()`。Bun 的 `Bun.file()` 语义只识别常规文件——**对目录路径始终返回 `false`**（独立验证：`Bun.file("/some/dir").exists() === false`，而 `Bun.file("/some/dir/file").exists() === true`）。
- **Impact**: 任何已通过 `ghs-init` 初始化的项目调 `ghs-config({})` 都会被错误拒绝。也就是说，**s1-feat-010 的验收标准 #2/#3 在运行时无法满足**（单测 `test/config.test.ts` 没有覆盖 tool 层，只测了 `config.ts` 的纯函数，所以没发现）。
- **Fix applied**: 把 gate 改成 `await fileExists(resolve(projectDir, ".ghs", "ghs.json"))`（检查文件而非目录），与 ghs-init 实际写入的文件集合对齐。
- **Result（修复后重跑）**: **PASS**。`ghs-config` 正常返回 3 个写入路径 + 解析的 model ID + 重启提示；`ghs-context-haiku.md` 的 model 字段变成 `openai/gpt-5`，另两个 agent 文件保持不变；`defaults_used: false`。
- **Test coverage gap**: tool 层 gate 缺集成测试。`test/config.test.ts` 只测了 `config.ts` 的纯函数，没触达 `src/tools/config.ts` 的 gate 分支——Sprint 2 应补一个 tool-layer 集成测试。

### 场景 4b（控制组）：直接调 `syncAgents()` 验证渲染机制本身

- **Motivation**: 场景 4 失败是 tool 层 gate 的问题，不是渲染管线的问题。这个场景把 ghs-config tool 绕开，直接调 `src/lib/config.ts` 的 `syncAgents(tempProjectDir, pluginRoot())`，证明 s1-feat-007 的核心机制（load config → per-field fallback → renderAgentTemplate → Bun.write）行为正确。
- **Action**: 在场景 4 已经把 `.ghs/ghs.json` 改好后，直接 `await syncAgents(tempProjectDir, root)`。
- **Result**: PASS。
- **Evidence**:
  - `syncAgents` 返回 `{ written: [3 paths], models: { context: "openai/gpt-5", designer: "zhipuai-coding-plan/glm-4.6", reviewer: "zhipuai-coding-plan/glm-4.6" }, defaults_used: false }`。
  - `ghs-context-haiku.md` 的 model 字段已被替换为 `openai/gpt-5`。
  - `ghs-plan-designer.md` 和 `ghs-plan-reviewer.md` 的 model 字段保持不变（都是默认值）。
  - `defaults_used: false` 表示用户配置完全接管了三个字段——这符合 s1-feat-007 的 per-field fallback 设计。
- **Conclusion**: 渲染机制 + 配置合并逻辑是健全的；Sprint 2 修掉 ghs-config 的目录 gate bug 后，s1-feat-010 的 AC #2/#3 应当自动满足。

### 场景 5：`ghs-status({})` 返回格式化的状态字符串

- **Action**: 在场景 1-4b 留下的项目状态下调 `hooks.tool["ghs-status"].execute({}, mockCtx)`。
- **Result**: PASS。
- **Evidence**: 返回 167 字符的格式化字符串，前 4 行：
  ```
  === Project Status ===

  📦 Project: temp-test
  📝 Description: temp-test project
  ```

### 场景 6：`ghs-config` 在 `.ghs/` 缺失时拒绝执行（gate 的正向用例）

- **Action**: 在一个新的空 temp dir 上调 `ghs-config({})`。
- **Result**: PASS。返回 `"Run ghs-init first."`，且 `.opencode/agents/` 未被创建。说明 gate 在「真的需要拒绝」的路径上工作正常——这恰好是因为空目录下 `Bun.file(".ghs").exists()` 也是 `false`，与「目录存在但 `Bun.file` 不识别」的失败路径在代码层面是同一条分支。

### 已知限制 / Sprint 2+ 后续事项

1. **~~ghs-config 的 `.ghs/` 目录 gate bug~~（已修复）**: 见场景 4 根因 + fix。修复 commit 把 gate 从检查 `.ghs/` 目录改为检查 `.ghs/ghs.json` 文件，场景 4 重跑通过。**遗留**：tool-layer 集成测试仍待补，覆盖「初始化后的项目再调 ghs-config」这条路径——目前 `test/config.test.ts` 只测了 `config.ts` 的纯函数。
2. **生产 agent 模板仍是 stub**: Phase 3 / Sprint 3 才会交付 `shared/agents/ghs-{context-haiku,plan-designer,plan-reviewer}.md.template` 的生产版本。本验证用 `test/fixtures/agents/*.md.template`（s1-feat-007 创建的 stub）临时顶替。stub 里每个模板只有该角色对应的一个 placeholder，所以场景 3/4 的「另两个 model 保持不变」断言在 stub 上天然成立——生产模板上线后需要重跑本场景，确认三 placeholder 互不串扰。
3. **未在真实 OpenCode 进程内验证**: 本测试用 Bun 脚本直接调 `tool.execute()`，绕开了 OpenCode 的 plugin loader / system.transform hook 注入。s1-feat-001 的 spike 已经独立验证过 hyphenated tool key 加载 + system.transform marker 注入，所以这部分是有 prior evidence 的；但「在真实 OpenCode 会话里让 AI 主动调用 ghs-init」这条完整路径未走通。建议 Sprint 2 在接入第一个真实 plan/sprint workflow 时顺带做一次 smoke test。
4. **ghs-sprint / ghs-code / ghs-plan-* 尚未实现**: Sprint 1 只交付了 5 个基础工具（init/status/archive/force-archive/config）。Plan 派发链和工作流循环要等 Sprint 2-4。
5. **ghs-archive / ghs-force-archive 未在本 E2E 中覆盖**: 这两个工具的等价性已经在 `test/equivalence/archive.test.ts` 里和 Python 源码做过字节级比对（s1-feat-012），所以本场景聚焦在 init/config/status 这条 R3（用户可配置 model）的关键链路上，避免与已有等价性测试重复。

### 结论

Sprint 1 的核心交付物（plugin 加载 + 5 个基础工具 + R3 模型配置链路）整体可用。验证过程中发现的 ghs-config 目录 gate bug 已在同一 commit 内修复并通过 e2e 重跑确认。所有 7 个场景（含修复后的场景 4）全部 PASS，渲染机制在直接调用路径下表现完全符合设计预期。

---

## Next steps

All 5 architectural assumptions de-risked. Proceed with:

1. **s1-feat-005** (project scaffold) — `shared/opencode.json.example` must use `["codegraph", "serve", "--mcp"]` per spike 003 finding.
2. **s1-feat-006** through **s1-feat-014** — proceed per existing plan, with the divergences noted above baked into the relevant features.
