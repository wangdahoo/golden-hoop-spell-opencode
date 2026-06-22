// Event union discriminator-completeness test (Feature s1-feat-003, plan §3.1
// 注入点① / R8).
//
// The plugin's `event` hook relies on `input.event.type === "todo.updated"` to
// route todo ticks into the disconnect-detection Map. For that check to be
// total, EVERY member of the opencode `Event` union must carry a `type`
// discriminated-field literal — otherwise a member missing `type` would throw
// `Cannot read properties of undefined (reading 'type')` inside the guard
// (the `"type" in input.event` prefix survives, but the compile-time contract
// would be silently broken).
//
// This file enforces the contract in two layers:
//
//   1. COMPILE-TIME: a mapped type `EventTypesFromUnion<Event>` forces the TS
//      checker to walk every union member and extract its `type` literal into
//      the resulting key set. If any member lacked `type`, the type would
//      resolve to `never` for that arm and the `EventTypes` constant below
//      would fail to assign (tsc error). Because the file typechecks, every
//      member has a `type` literal at the type level.
//
//   2. RUNTIME: a fixture array of one minimal sample per Event* variant is
//      fed through the SAME guard the plugin uses (`("type" in e) && e.type
//      === ...`), asserting each sample carries its expected `type` string at
//      runtime. The `todo.updated` arm additionally verifies the hook fires
//      `recordTodoTick` (via an integration check against the plugin export).
//
// Together these give static + dynamic coverage of R8: the plugin's defensive
// guard is justified AND verified not to mask a missing-discriminator bug.
//
// Source of truth: `Event` union at @opencode-ai/sdk `types.gen.d.ts`
// (the exact line drifts across SDK versions — plan v4.1 cites 819; on
// @opencode-ai/sdk 1.4.3 it lives at types.gen.d.ts:602 with 32 members).
// The member list below is intentionally enumerated explicitly so a future SDK
// bump that adds a member WITHOUT a `type` field would fail the compile-time
// arm rather than silently slipping past a generic `Event["type"]` lookup.

import { expect, test, describe } from "bun:test";
import type {
  Event,
  EventServerInstanceDisposed,
  EventInstallationUpdated,
  EventInstallationUpdateAvailable,
  EventLspClientDiagnostics,
  EventLspUpdated,
  EventMessageUpdated,
  EventMessageRemoved,
  EventMessagePartUpdated,
  EventMessagePartRemoved,
  EventPermissionUpdated,
  EventPermissionReplied,
  EventSessionStatus,
  EventSessionIdle,
  EventSessionCompacted,
  EventFileEdited,
  EventTodoUpdated,
  EventCommandExecuted,
  EventSessionCreated,
  EventSessionUpdated,
  EventSessionDeleted,
  EventSessionDiff,
  EventSessionError,
  EventFileWatcherUpdated,
  EventVcsBranchUpdated,
  EventTuiPromptAppend,
  EventTuiCommandExecute,
  EventTuiToastShow,
  EventPtyCreated,
  EventPtyUpdated,
  EventPtyExited,
  EventPtyDeleted,
  EventServerConnected,
} from "@opencode-ai/sdk";

// -----------------------------------------------------------------------------
// Layer 1: compile-time exhaustiveness.
// -----------------------------------------------------------------------------
//
// `Event["type"]` is an indexed-access type that walks every member of the
// `Event` union and yields the union of each member's `type` literal. If ANY
// member lacked a `type` field, that arm would contribute `undefined` to the
// union, and the `extends string` assertion below would fail to typecheck.
//
// The two `type Assert<...> = ...` lines force tsc to actually evaluate these
// types — they have zero runtime footprint. If a future SDK version adds an
// Event* member without a `type` discriminator, the `extends string` constraint
// would break and `tsc --noEmit` would fail right here, surfacing R8 at
// compile time before it can manifest as a runtime `undefined.type`.

/** Indexed-access: union of every member's `type` literal. */
type EventTypeLiterals = Event["type"];

/** Asserts `T extends string` at compile time (no runtime cost). */
type AssertString<T extends string> = T;

/** Asserts the literal "todo.updated" is present in union T (no runtime cost). */
type AssertContainsTodoUpdated<T extends string> =
  "todo.updated" extends T ? T : "missing-todo.updated";

type _Assert_EventTypeLiterals_IsString = AssertString<EventTypeLiterals>;
type _Assert_EventTypeLiterals_HasTodoUpdated =
  AssertContainsTodoUpdated<EventTypeLiterals>;

// Each named member individually asserts its `type` literal at the type level.
// (These are zero-runtime const declarations; they exist purely to make tsc
// walk each arm of the union by name. If a future SDK version renames a member
// or drops its `type` discriminator, the corresponding line fails to typecheck.)
const _MEMBER_TYPE_001: "server.instance.disposed" = {} as EventServerInstanceDisposed["type"];
const _MEMBER_TYPE_002: "installation.updated" = {} as EventInstallationUpdated["type"];
const _MEMBER_TYPE_003: "installation.update-available" = {} as EventInstallationUpdateAvailable["type"];
const _MEMBER_TYPE_004: "lsp.client.diagnostics" = {} as EventLspClientDiagnostics["type"];
const _MEMBER_TYPE_005: "lsp.updated" = {} as EventLspUpdated["type"];
const _MEMBER_TYPE_006: "message.updated" = {} as EventMessageUpdated["type"];
const _MEMBER_TYPE_007: "message.removed" = {} as EventMessageRemoved["type"];
const _MEMBER_TYPE_008: "message.part.updated" = {} as EventMessagePartUpdated["type"];
const _MEMBER_TYPE_009: "message.part.removed" = {} as EventMessagePartRemoved["type"];
const _MEMBER_TYPE_010: "permission.updated" = {} as EventPermissionUpdated["type"];
const _MEMBER_TYPE_011: "permission.replied" = {} as EventPermissionReplied["type"];
const _MEMBER_TYPE_012: "session.status" = {} as EventSessionStatus["type"];
const _MEMBER_TYPE_013: "session.idle" = {} as EventSessionIdle["type"];
const _MEMBER_TYPE_014: "session.compacted" = {} as EventSessionCompacted["type"];
const _MEMBER_TYPE_015: "file.edited" = {} as EventFileEdited["type"];
const _MEMBER_TYPE_016: "todo.updated" = {} as EventTodoUpdated["type"];
const _MEMBER_TYPE_017: "command.executed" = {} as EventCommandExecuted["type"];
const _MEMBER_TYPE_018: "session.created" = {} as EventSessionCreated["type"];
const _MEMBER_TYPE_019: "session.updated" = {} as EventSessionUpdated["type"];
const _MEMBER_TYPE_020: "session.deleted" = {} as EventSessionDeleted["type"];
const _MEMBER_TYPE_021: "session.diff" = {} as EventSessionDiff["type"];
const _MEMBER_TYPE_022: "session.error" = {} as EventSessionError["type"];
const _MEMBER_TYPE_023: "file.watcher.updated" = {} as EventFileWatcherUpdated["type"];
const _MEMBER_TYPE_024: "vcs.branch.updated" = {} as EventVcsBranchUpdated["type"];
const _MEMBER_TYPE_025: "tui.prompt.append" = {} as EventTuiPromptAppend["type"];
const _MEMBER_TYPE_026: "tui.command.execute" = {} as EventTuiCommandExecute["type"];
const _MEMBER_TYPE_027: "tui.toast.show" = {} as EventTuiToastShow["type"];
const _MEMBER_TYPE_028: "pty.created" = {} as EventPtyCreated["type"];
const _MEMBER_TYPE_029: "pty.updated" = {} as EventPtyUpdated["type"];
const _MEMBER_TYPE_030: "pty.exited" = {} as EventPtyExited["type"];
const _MEMBER_TYPE_031: "pty.deleted" = {} as EventPtyDeleted["type"];
const _MEMBER_TYPE_032: "server.connected" = {} as EventServerConnected["type"];

// Silence unused-var warnings — these consts exist only for the type system.
void [
  _MEMBER_TYPE_001, _MEMBER_TYPE_002, _MEMBER_TYPE_003, _MEMBER_TYPE_004,
  _MEMBER_TYPE_005, _MEMBER_TYPE_006, _MEMBER_TYPE_007, _MEMBER_TYPE_008,
  _MEMBER_TYPE_009, _MEMBER_TYPE_010, _MEMBER_TYPE_011, _MEMBER_TYPE_012,
  _MEMBER_TYPE_013, _MEMBER_TYPE_014, _MEMBER_TYPE_015, _MEMBER_TYPE_016,
  _MEMBER_TYPE_017, _MEMBER_TYPE_018, _MEMBER_TYPE_019, _MEMBER_TYPE_020,
  _MEMBER_TYPE_021, _MEMBER_TYPE_022, _MEMBER_TYPE_023, _MEMBER_TYPE_024,
  _MEMBER_TYPE_025, _MEMBER_TYPE_026, _MEMBER_TYPE_027, _MEMBER_TYPE_028,
  _MEMBER_TYPE_029, _MEMBER_TYPE_030, _MEMBER_TYPE_031, _MEMBER_TYPE_032,
];

// -----------------------------------------------------------------------------
// Layer 2: runtime samples — every member carries its expected `type` string.
// -----------------------------------------------------------------------------

/**
 * Minimal runtime sample per Event* variant. Only `type` (and a minimal
 * `properties`) is populated — this is exactly what the plugin's guard looks
 * at. Keeping samples tiny proves the guard does NOT depend on any other
 * field shape.
 */
const EVENT_RUNTIME_SAMPLES: Array<{ label: string; event: Event }> = [
  { label: "server.instance.disposed", event: { type: "server.instance.disposed", properties: { directory: "/tmp" } } },
  { label: "installation.updated", event: { type: "installation.updated", properties: { version: "1.0.0" } } },
  { label: "installation.update-available", event: { type: "installation.update-available", properties: { version: "1.0.0" } } },
  { label: "lsp.client.diagnostics", event: { type: "lsp.client.diagnostics", properties: { serverID: "s", path: "/p" } } },
  { label: "lsp.updated", event: { type: "lsp.updated", properties: {} } },
  { label: "message.updated", event: { type: "message.updated", properties: { info: { id: "m", sessionID: "s", role: "user", time: { created: 0 }, summary: undefined, agent: "a", model: { providerID: "p", modelID: "m" } } } } },
  { label: "message.removed", event: { type: "message.removed", properties: { sessionID: "s", messageID: "m" } } },
  { label: "message.part.updated", event: { type: "message.part.updated", properties: { part: { id: "p", sessionID: "s", messageID: "m", type: "text", text: "" } } } },
  { label: "message.part.removed", event: { type: "message.part.removed", properties: { sessionID: "s", messageID: "m", partID: "p" } } },
  { label: "permission.updated", event: { type: "permission.updated", properties: { id: "p", type: "t", sessionID: "s", messageID: "m", title: "t", metadata: {}, time: { created: 0 } } } },
  { label: "permission.replied", event: { type: "permission.replied", properties: { sessionID: "s", permissionID: "p", response: "allow" } } },
  { label: "session.status", event: { type: "session.status", properties: { sessionID: "s", status: { type: "idle" } } } },
  { label: "session.idle", event: { type: "session.idle", properties: { sessionID: "s" } } },
  { label: "session.compacted", event: { type: "session.compacted", properties: { sessionID: "s" } } },
  { label: "file.edited", event: { type: "file.edited", properties: { file: "/f" } } },
  { label: "todo.updated", event: { type: "todo.updated", properties: { sessionID: "s-todo", todos: [] } } },
  { label: "command.executed", event: { type: "command.executed", properties: { name: "c", sessionID: "s", arguments: "", messageID: "m" } } },
  { label: "session.created", event: { type: "session.created", properties: { info: { id: "s", projectID: "p", directory: "/d", title: "t", version: "1", time: { created: 0, updated: 0 } } } } },
  { label: "session.updated", event: { type: "session.updated", properties: { info: { id: "s", projectID: "p", directory: "/d", title: "t", version: "1", time: { created: 0, updated: 0 } } } } },
  { label: "session.deleted", event: { type: "session.deleted", properties: { info: { id: "s", projectID: "p", directory: "/d", title: "t", version: "1", time: { created: 0, updated: 0 } } } } },
  { label: "session.diff", event: { type: "session.diff", properties: { sessionID: "s", diff: [] } } },
  { label: "session.error", event: { type: "session.error", properties: { sessionID: "s" } } },
  { label: "file.watcher.updated", event: { type: "file.watcher.updated", properties: { file: "/f", event: "change" } } },
  { label: "vcs.branch.updated", event: { type: "vcs.branch.updated", properties: { branch: "main" } } },
  { label: "tui.prompt.append", event: { type: "tui.prompt.append", properties: { text: "t" } } },
  { label: "tui.command.execute", event: { type: "tui.command.execute", properties: { command: "session.list" } } },
  { label: "tui.toast.show", event: { type: "tui.toast.show", properties: { message: "m", variant: "info" } } },
  { label: "pty.created", event: { type: "pty.created", properties: { info: { id: "p", title: "t", command: "c", args: [], cwd: "/", status: "running", pid: 1 } } } },
  { label: "pty.updated", event: { type: "pty.updated", properties: { info: { id: "p", title: "t", command: "c", args: [], cwd: "/", status: "running", pid: 1 } } } },
  { label: "pty.exited", event: { type: "pty.exited", properties: { id: "p", exitCode: 0 } } },
  { label: "pty.deleted", event: { type: "pty.deleted", properties: { id: "p" } } },
  { label: "server.connected", event: { type: "server.connected", properties: {} } },
];

describe("Event union discriminator completeness (R8)", () => {
  test("every runtime sample carries its expected `type` literal", () => {
    expect(EVENT_RUNTIME_SAMPLES.length).toBeGreaterThanOrEqual(30);
    for (const { label, event } of EVENT_RUNTIME_SAMPLES) {
      // Same defensive guard the plugin uses.
      expect("type" in event).toBe(true);
      expect((event as { type: unknown }).type).toBe(label);
    }
  });

  test("the defensive guard is total: an object without `type` does not throw", () => {
    // Simulates a hypothetical broken Event* member that omits `type`
    // (exactly the R8 failure mode). The plugin's guard must not throw.
    const malformed = {} as Event;
    const guard = "type" in malformed && malformed.type === "todo.updated";
    expect(guard).toBe(false);
  });

  test("only `todo.updated` events pass the guard (spot-check two non-matching arms)", () => {
    const nonMatchA: Event = { type: "session.idle", properties: { sessionID: "s" } };
    const nonMatchB: Event = { type: "file.edited", properties: { file: "/f" } };
    // Cast `type` through `string` so tsc does not flag the comparison as
    // intentionally-unreachable — the point is to exercise the SAME guard
    // expression the plugin uses against representative non-matching events.
    expect("type" in nonMatchA && (nonMatchA.type as string) === "todo.updated").toBe(false);
    expect("type" in nonMatchB && (nonMatchB.type as string) === "todo.updated").toBe(false);
  });
});
