# AGENTS.md

Guidance for OpenCode agents working in this repo. This is an OpenCode plugin
port of the Claude Code `golden-hoop-spell` plugin — pure TypeScript, loaded by
OpenCode as a plugin (no build step, no Python runtime dep).

## Commands

- `bun test` — full suite (286 tests). **See the equivalence caveat below.**
- `bun test test/equivalence/` — only the Python-oracle equivalence tests.
- `bun run typecheck` (`tsc --noEmit`) — typecheck; `tsconfig.json` sets `noEmit`.
- To run everything *except* the machine-specific equivalence suite: run the
  other test dirs explicitly, e.g. `bun test test/integration test/e2e test/codegraph.test.ts`.
- There is **no lint / format / biome / eslint config** and **no CI** — do not
  invent `npm run lint`. Verification = `bun run typecheck && bun test`.

## Critical gotcha: the equivalence suite is machine-specific

`test/equivalence/*.test.ts` assert byte-identical output against the **source
Python plugin**, invoked as a subprocess. Two hard requirements (see
`test/equivalence/_helpers.ts`):

1. `python3` must be on PATH.
2. The original Claude Code plugin repo must be checked out at the **hardcoded
   absolute path** `/Users/tom/github/golden-hoop-spell/plugin` (the
   `PYTHON_SCRIPTS_DIR` / `GHS_SOURCE_ROOT` constants).

On any other machine these tests fail/error; this is expected and dev-only. Do
not "fix" the hardcoded path by relativising it — it is the intentional oracle.
If you can't run the oracle, run the non-equivalence subset instead.

## Architecture

- **Entrypoint**: `src/index.ts` default-exports `ghsPlugin` (defined in
  `src/plugin.ts`), which registers all 10 `ghs-*` tools and pushes a workflow
  hint into the system prompt. `package.json` `main` → `src/index.ts`.
- `src/tools/*.ts` — one module per `ghs-*` tool (thin orchestration).
- `src/lib/scripts/*.ts` — TypeScript ports of the source plugin's Python
  scripts (`init_project.py` → `init-project.ts`, etc.). These are the
  behavior source-of-truth; each file names its Python counterpart in a header
  comment. Keep ports byte-equivalent to the Python original (the equivalence
  suite enforces this).
- `src/prompts/*.ts` — LLM prompt templates (English — see language policy).
- `shared/` — shipped assets (agent `*.md.template` ×3, `ghs.default.json`,
  references). **Included in `npm pack`**; treat as public surface.
- `opencode.json` uses `"plugin": ["./src/index.ts"]` for local dev.

### Layout that is NOT shipped

- `spikes/` — one-off validation experiments; excluded from `tsconfig.json`
  and `package.json` `files`. Do not import from `src/`.
- `test/`, `docs/`, `.ghs/`, `bun.lock`, `tsconfig.json` — excluded from the
  tarball (see `package.json` `//packVerified`).
- `E2E_CHECKLIST.md` — manual verification checklist; some items cannot be
  automated (need a real OpenCode session + real LLM).

## Key constraints

- **Plugin root resolves via `import.meta.dir`**, never `process.cwd()` or
  `__dirname` (package is ESM). See `src/lib/paths.ts`. Changing this breaks
  asset resolution under `npm` cache / `file:` installs.
- **`.ghs/` is gitignored** except `test/fixtures/.ghs/` (the canonical test
  fixtures). Do not commit other `.ghs/` state.
- **codegraph MCP is optional**: detected by `.codegraph/` dir presence, else
  grep fallback. Don't hardcode `codegraph_codegraph_*` tool names in prompts
  (they depend on the MCP server name) — use descriptive phrasing.

## Conventions

- **Language policy** (from `CLAUDE.md`, applies to all agents/subagents):
  Chinese for human-readable output — conversation, docs, commit messages,
  TODO/FIXME, task/plan descriptions. English for code identifiers, log/error
  strings, and LLM-facing prompts. When spawning subagents, include the
  instruction: `使用中文回复和撰写所有文档/commit message。代码标识符、日志、错误信息用英文。`
- **Commit style**: Conventional Commits with a Chinese description and a
  `(Feature: sX-feat-YYY)` trailer tying back to the ghs sprint tracker,
  e.g. `feat(tools): 实现 ghs-code tool —— feature 实现工作流入口 (Feature: s4-feat-004)`.
- New `src/lib/scripts/*.ts` ports must keep a header comment pointing at the
  Python behavior source-of-truth path, and stay byte-equivalent (add/extend
  the matching `test/equivalence/*.test.ts`).
