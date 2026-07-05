---
name: ghs
description: Golden Hoop Spell (ghs) orchestration discipline. Use when the ghs plugin is active (any ghs-* tool has been or should be called). Enforces the init → plan → sprint → code → status → archive workflow order, drives the right-side TODO panel via todowrite at every stage transition, and mandates executing the ▶ NEXT ACTION anchor at the end of each ghs tool response rather than skipping ahead.
---

# ghs Orchestration Skill

This skill guides the main AI through the Golden Hoop Spell (ghs) structured
delivery workflow. It is loaded into the system prompt so the discipline
below is always in effect once ghs is active in a session.

## Canonical Workflow Order

Drive the project through these tools **in this order**; do not invoke a later
stage's tool before the earlier one has completed:

1. `ghs-init` — bootstrap `.ghs/features.json`, `.ghs/progress.md`,
   `.ghs/ghs.json`, and the plan-dispatcher subagent markdowns.
2. `ghs-config` — re-render the 3 subagent markdowns after editing model IDs
   in `.ghs/ghs.json`.
3. `ghs-plan-start` → `ghs-plan-review` → `ghs-plan-finalize` — the 3-role
   plan dispatcher (context snapshot → design → review → finalize). These
   three are a single logical phase; do not interleave other ghs stages
   while a plan is mid-flight. This no-interleave rule is **per pipeline**:
   within one pipeline you must not mix plan with sprint/code. It is
   orthogonal to cross-window plan concurrency (any number of windows may
   each run their own plan at once) — see § Multi-Pipeline Concurrency.
4. `ghs-sprint` — decompose the finalized plan into atomic features
   (appended to `.ghs/features.json`).
5. `ghs-code` — implement features **batch-by-batch by default** (conflict-
   free parallel batches); pass `parallel: false` for a single feature, or pin
   one with `feature_id`.
6. `ghs-status` — read-only progress check at any time.
7. `ghs-archive` / `ghs-force-archive` — archive completed sprints.

`ghs-status` is safe to call at any point; every other tool belongs to a
specific stage and its output names the next tool to call.

## Multi-Pipeline Concurrency

ghs supports multiple terminal sessions (windows) advancing ghs pipelines
against the **same** project directory concurrently. Two isolation
mechanisms keep them from corrupting each other's state.

### Isolation ① — plan stage: cross-window concurrency (plan_id)

The plan dispatcher (`ghs-plan-start` → `ghs-plan-review` →
`ghs-plan-finalize`) is safe to run in **any number of windows at once**:

- `ghs-plan-start` creates its `<plan_id>-status.json` with `O_EXCL`
  semantics, so two windows that happen to pick the same slug do not
  overwrite each other — the collision is auto-resolved by suffixing the
  later one (`-2`, `-3`, …).
- **`plan_id` transparency contract (mandatory)**: the `plan_id` returned
  by `ghs-plan-start` MUST be passed to **every** subsequent
  `ghs-plan-review` call (as the `plan_id` argument). This pins
  `findActivePlanStatus` to that one status file and skips the legacy
  global scan, so two parallel plans never read each other's status.
  `ghs-plan-finalize` already accepts `plan_id`; no change is needed there.

### Isolation ② — sprint/code stage: single-window exclusive (runtime lock)

`ghs-sprint` / `ghs-code` / `ghs-append-feature` /
`ghs-update-feature-status` / `ghs-archive` / `ghs-force-archive` all mutate
the shared `.ghs/features.json` (and `progress.md`). They are serialized by
a single on-disk runtime lock:

- **Lock file**: `.ghs/active.lock` (JSON). Primary key = `session_id`;
  `pid` + `acquired_at` are surfaced to the user for diagnosis but are
  **never** used for automatic staleness judgement.
- **Stage owners hold the lock across multiple calls**: `ghs-sprint`
  acquires the lock and keeps it across the subsequent `ghs-append-feature`
  calls (the whole sprint-planning session is one critical section).
  `ghs-code` acquires the lock and releases it only at a terminal state
  (the "no ready features" banner, or once the active sprint is archived).
- **Leaf writers validate before every write (mandatory)**:
  `ghs-append-feature` / `ghs-update-feature-status` call `validateLockHeld`
  before touching disk. Held by the current session → write proceeds. Held
  by **another** session → the write is refused with a conflict message
  (this is the load-bearing defence against a taken-over window silently
  double-writing). Not held at all (standalone call) → the writer briefly
  takes a `leaf` short-lock around the single write, then releases it.

### Conflict resolution — the three-way user choice

When a tool sees the lock held by another session it does **not** silently
declare that lock stale. It returns a conflict message listing the holder's
`holder_label`, `pid`, `acquired_at`, `stage`, and `sprint_id`, and asks the
user in chat to pick one of three:

- **takeover** — re-invoke the same tool with `takeover: true` to overwrite
  the lock. The displaced window's *next* write is then rejected by the leaf
  writer's `validateLockHeld`, so it cannot silently corrupt state.
- **wait** — let the other window finish and release, then retry.
- **cancel** — abandon this attempt.

`takeover` is accepted as a schema argument by `ghs-code`, `ghs-sprint`,
`ghs-archive`, and `ghs-force-archive`.

### Residual TOCTOU windows (documented, accepted)

The threat model is **cooperative human-driven pipelines** (a developer
running a few terminals), not adversarial concurrency. Two narrow TOCTOU
windows remain by design and both are backstopped by the mandatory
leaf-writer `validateLockHeld`:

- **takeover overwrite**: between the read and the overwrite the original
  holder may legitimately change, so the overwrite could stomp a freshly-
  acquired lock. Backstop: the next leaf-writer write validates ownership
  and refuses if it no longer matches.
- **release unlink**: between the re-read and the `unlink` another session
  may take over; the re-read-before-unlink narrows (does not eliminate)
  this window, and any mistake self-heals on the next validated write.

`O_EXCL` semantics are weak on some network filesystems (e.g. old NFS);
keep `.ghs/` on a local volume — ghs guarantees mutual exclusion only on
local filesystems.

### Concurrent pipelines MUST share one projectDir (worktree note)

The lock lives at `<projectDir>/.ghs/active.lock`. Two windows only mutex
each other if they resolve to the **same** `projectDir`. In a git worktree
setup, either share the main checkout's `.ghs/` or explicitly pass the same
`project_dir` to every ghs tool — otherwise each worktree gets its own lock
file and mutual exclusion silently fails.

### Lock release boundaries & broken-flow recovery

- `ghs-code` releases the lock at terminal states: the "no ready features"
  banner, or when the active sprint is archived via `ghs-archive`.
- `ghs-sprint` does **not** release after writing the skeleton (it holds
  across `ghs-append-feature`); release happens as the flow advances to
  `ghs-code` (which re-acquires idempotently under the same session).
- If a pipeline is stuck (a session died holding the lock, or you are
  unsure who holds it): call `ghs-status` (it surfaces the current
  `.ghs/active.lock` holder), then consciously `takeover` from the window
  you want to resume. Do not hand-edit or delete `.ghs/active.lock`.

## Plan-Start: Derive `slug_seed` from the Requirement

`ghs-plan-start` takes an optional `slug_seed` that becomes the `<slug>` half
of the plan_id (`{YYYY-MM-DD}-{slug}`) and therefore of every sibling file name
under `.ghs/plans/`. A semantic slug makes the directory self-describing
(`2026-06-23-todo-app-status.json` vs the legacy opaque `*-plan-status.json`).

**Before calling `ghs-plan-start`, you MUST derive the slug yourself:**

- Read the user's requirement description (the text after `/ghs-plan-start`).
- Distil it into a short **English ASCII kebab-case** slug that captures the
  core semantic: only `[a-z0-9-]`, hyphen-separated, lower-case.
  - 「帮我设计一个 TODO APP」→ `todo-app`
  - "add OAuth login" → `oauth-login`
  - "重构认证模块" → `auth-refactor`
- Pass it as `slug_seed`. Do **not** pass the raw requirement description —
  CJK / mixed-script text collapses to an empty slug under the tool's
  filesystem-safety sanitiser and silently falls back to `plan`.

The **original requirement description stays in chat context** — it is fed
verbatim to the `ghs-context-explorer` / `ghs-plan-designer` / `ghs-plan-reviewer`
subagents in subsequent steps. `slug_seed` only names files; it does not carry
the requirement.

If `slug_seed` is empty or omitted, the tool falls back to the `plan` stem
(backward-compatible, but loses the semantic benefit).

## Todo Discipline (mechanism one)

The right-side TODO panel is the only durable view of workflow progress, and
the built-in `todowrite` tool is the **only** thing that can render to it.

- **On entering any ghs multi-step workflow** (plan / sprint / code), call
  `todowrite` to build a stage checklist with the current stage marked
  `in_progress`.
- **On every stage transition**, call `todowrite` again: mark the prior stage
  `completed` and the new current stage `in_progress`. A stage transition is
  signalled by a new `ghs stage:` banner in the tool response.
- If a ghs tool response contains a `TODO:` directive, follow it — the
  disconnect-detection state machine observed that the panel was never seeded.
- If a ghs tool response contains a `STALE TODO:` warning, the stage advanced
  but the panel was not refreshed. Call `todowrite` immediately to realign.

Keeping the panel accurate is what lets the disconnect-detection state machine
observe progress; skipping `todowrite` makes mechanism one blind.

## ▶ NEXT ACTION Anchoring

Every ghs multi-step tool response ends with a `▶ NEXT ACTION: <tool call>`
anchor. This anchor is **mandatory**: execute the named tool call exactly as
written. Do NOT:

- skip past it and take over the next step yourself,
- substitute a different tool,
- batch multiple stages into one turn.

If the anchor names a subagent dispatch (e.g. a Task tool call to
`ghs-context-explorer`), perform that dispatch and feed its output back into the
named next ghs tool.

## Broken-Flow Recovery

If you are unsure where the workflow stands (interrupted session, lost
context, or a tool response you cannot reconcile):

1. Call `ghs-status` — it reports the per-sprint feature counts, the
   in-progress feature, the next ready feature, and recent `progress.md`
   entries. This is the single source of truth for "what is the current
   stage".
2. Read `.ghs/progress.md` (most recent session first) for the prior
   session's explicit next-step note.
3. Read `.ghs/features.json` to confirm feature statuses and dependency
   readiness before resuming `ghs-code`.
4. Resume from the stage `ghs-status` indicates — re-seed the `todowrite`
   checklist for that stage before continuing.

Never guess the stage; never restart the workflow from `ghs-init` on an
already-initialised project (it will refuse without `force: true`).

## File Transport (staging files)

The `ghs-plan-*` dispatch directives instruct each subagent (context-explorer
/ plan-designer / plan-reviewer) to **Write its full delimited output to a
deterministic staging file** under `.ghs/plans/` and return only a short
completion signal. This bypasses the Task tool's return channel, which
truncates long output and corrupts the plan loop (missing `<<<PLAN_END>>>` /
verdict line → wasted rounds). `ghs-plan-review` reads the staging file as
the primary parse source; the inline payload (full text pasted into the
`snapshot`/`plan`/`review` arg) is a byte-stable fallback.

Staging paths: `.ghs/plans/<plan_id>.{snapshot,plan,review}.raw.md`. When you
dispatch a subagent, pass the staging path the directive gives you; when you
call `ghs-plan-review`, a short mode-indicator payload (e.g. the completion
signal) is sufficient. See the per-role "File Transport" sections in the
reference docs.

## Reading List (when a stage is unfamiliar)

- `shared/references/coding-agent.md` — the single-feature and parallel-mode
  implementation protocol that `ghs-code` dispatches against.
- `shared/references/plan-designer.md` — how the plan dispatcher's designer
  role should structure a plan, including the optional built-in-plan-agent
  backend.
- `.ghs/features.json` — feature ids, acceptance criteria, dependencies, and
  `files_affected` for every sprint.
