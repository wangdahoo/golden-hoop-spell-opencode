# AGENTS.md

Guidance for AI agents working in this repo. Read `CLAUDE.md` first — the
language policy there is mandatory and cross-cutting.

## Language policy (mandatory)

From `CLAUDE.md` — applies to ALL agents including subagents:

- **Chinese**: human-readable output — conversation, docs, commit messages,
  TODO/FIXME, branch descriptive parts, PR descriptions.
- **English**: code identifiers, log/error strings, and LLM-facing prompts
  (skill definitions, agent prompts, everything under `src/prompts/`).
- When spawning any subagent, its prompt MUST include:
  "使用中文回复和撰写所有文档/commit message。代码标识符、日志、错误信息用英文。"

## Commands

```bash
bun run typecheck   # tsc --noEmit (the only static check; noEmit is set)
bun test            # full suite
bun test test/plan-review.test.ts          # one file
bun test test/plan-review.test.ts -t "PASS"  # by test-name regex
bun test --only                           # only test.only/describe.only
```

There is **no lint, formatter, build, or codegen step**. No CI, no pre-commit
hooks. The only verification loop is `typecheck` then `test`.

## Zero-build plugin — entry & path resolution

- No compile step. OpenCode loads `src/index.ts` directly (`package.json`
  `main` → `src/index.ts` → default-exports `ghsPlugin` from `src/plugin.ts`).
- `@opencode-ai/plugin` 1.4.3 is a **peerDependency**; the repo self-dogfoods
  (`opencode.json` loads the plugin via `"./src/index.ts"`).
- **Plugin root MUST be resolved via `import.meta.dir`** (`src/lib/paths.ts`
  `pluginRoot()`). Never use `process.cwd()` (that is the host project dir, not
  the plugin install location) or `__dirname` (package is `"type": "module"`).
  All asset reads go through `shared/` relative to the resolved root.

## Architecture in one pass

- `src/tools/*.ts` — one thin orchestration module per ghs tool. Tools return
  text; the `▶ NEXT ACTION` anchor at the end names the next tool.
- `src/lib/scripts/` — **the behavioral source of truth**. These are faithful
  ports of the Python original; tests pin their behavior. When changing
  behavior, edit here, not in the tool layer.
- `src/prompts/` — LLM prompt templates (English).
- `shared/` — assets shipped in the tarball: `agents/*.md.template` (×3),
  `skill/ghs/SKILL.md`, `references/`, `ghs.default.json`, examples.
- `src/plugin.ts` — the canonical tool/command registry (imports every tool).

## Test conventions (follow these for new tests)

- **Temp dirs**: Bun 1.3.11 has no `Bun.mkdtemp`. Use `fs.mkdtemp` under
  `os.tmpdir()` then `realpathSync` it (defeats the macOS `/tmp` →
  `/private/tmp` symlink that breaks path assertions). See
  `test/integration/_helpers.ts` `makeTempDir()` for the canonical helper.
- **No real subagents / no real OpenCode**: plan/code dispatch tests feed
  canned delimited blobs (helpers: `snapshotBlob` / `planBlob` / `reviewBlob`).
- `test/e2e/` chains the full init→archive lifecycle in one temp project;
  `test/integration/` exercises single tools against seeded fixtures.

## Prose-contract rule (enforced by a test)

In LLM-facing prose files — `src/tools/code.ts`, `src/tools/sprint.ts`,
`src/prompts/feature-impl.ts`, `src/prompts/sprint-planning.ts` — the tool-name
stems `parse-completion-signal`, `update-feature-status`, `append-feature` MUST
always carry the `ghs-` prefix (e.g. `ghs-append-feature`). A bare reference is
a "dead" instruction naming a tool key that doesn't exist.
`test/prose-contract.test.ts` fails the build on violations. Comments and
import lines are exempt.

## Publish surface

`package.json` `files` whitelists **only `src` and `shared`**. `test/`,
`docs/`, `.ghs/`, `tsconfig.json`, `bun.lock`, and the demo `opencode.json` are
excluded from the tarball and contain no `.py` files. Adding a new top-level
dir to the shipped plugin means updating `files`.

## State & gitignore

- `.ghs/` is gitignored (per-user project state) **except**
  `test/fixtures/.ghs/` — those canonical fixtures are committed and are the
  input for init/status/archive tests. Do not commit other `.ghs/` state.
- `.opencode/`, `.codegraph/`, `screenshots/`, `cases/` are gitignored.
