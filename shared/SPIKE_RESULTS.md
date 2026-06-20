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

## Next steps

All 5 architectural assumptions de-risked. Proceed with:

1. **s1-feat-005** (project scaffold) — `shared/opencode.json.example` must use `["codegraph", "serve", "--mcp"]` per spike 003 finding.
2. **s1-feat-006** through **s1-feat-014** — proceed per existing plan, with the divergences noted above baked into the relevant features.
