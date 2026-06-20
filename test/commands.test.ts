// Unit tests for the ghs-* slash command definitions.
//
// These tests verify that GHS_COMMANDS in src/lib/commands.ts:
//   (a) Defines exactly the 8 user-facing commands (no internal tools).
//   (b) Each command has a non-empty template and description.
//   (c) Argument-passing commands include `$ARGUMENTS` in their template.
//   (d) The config hook in plugin.ts injects all commands into a mock cfg.
//   (e) Existing commands in cfg are preserved (not overwritten unless same key).

import { expect, test, describe } from "bun:test";
import { GHS_COMMANDS } from "../src/lib/commands";
import { ghsPlugin } from "../src/plugin";

/** The 8 expected user-facing command names (excludes ghs-plan-review + ghs-plan-finalize). */
const EXPECTED_NAMES = [
  "ghs-init",
  "ghs-config",
  "ghs-plan-start",
  "ghs-sprint",
  "ghs-code",
  "ghs-status",
  "ghs-archive",
  "ghs-force-archive",
] as const;

/** Commands that should reference `$ARGUMENTS` in their template. */
const ARGUMENT_COMMANDS = [
  "ghs-init",
  "ghs-sprint",
  "ghs-code",
  "ghs-archive",
  "ghs-force-archive",
] as const;

describe("GHS_COMMANDS definitions", () => {
  test("defines exactly the 8 user-facing commands", () => {
    const keys = Object.keys(GHS_COMMANDS).sort();
    expect(keys).toEqual([...EXPECTED_NAMES].sort());
  });

  test("does NOT include internal dispatcher commands", () => {
    expect(GHS_COMMANDS).not.toHaveProperty("ghs-plan-review");
    expect(GHS_COMMANDS).not.toHaveProperty("ghs-plan-finalize");
  });

  test("every command has non-empty template and description", () => {
    for (const [name, cmd] of Object.entries(GHS_COMMANDS)) {
      expect(cmd.template.length).toBeGreaterThan(0);
      expect(cmd.description.length).toBeGreaterThan(0);
    }
  });

  test("argument-passing commands include $ARGUMENTS", () => {
    for (const name of ARGUMENT_COMMANDS) {
      expect(GHS_COMMANDS[name].template).toContain("$ARGUMENTS");
    }
  });

  test("non-argument commands do NOT include $ARGUMENTS", () => {
    const noArgCommands = EXPECTED_NAMES.filter(
      (n) => !ARGUMENT_COMMANDS.includes(n as (typeof ARGUMENT_COMMANDS)[number]),
    );
    for (const name of noArgCommands) {
      expect(GHS_COMMANDS[name].template).not.toContain("$ARGUMENTS");
    }
  });

  test("every template references its corresponding tool name", () => {
    for (const name of EXPECTED_NAMES) {
      // Template should mention the tool in backticks, e.g. `ghs-status`.
      expect(GHS_COMMANDS[name].template).toContain(`\`${name}\``);
    }
  });
});

describe("plugin config hook injects commands", () => {
  test("config hook adds all 8 ghs-* commands into cfg.command", async () => {
    const hooks = await ghsPlugin({} as never);
    expect(hooks.config).toBeDefined();

    const cfg: { command?: Record<string, unknown> } = {};
    await hooks.config!(cfg as never);

    expect(cfg.command).toBeDefined();
    for (const name of EXPECTED_NAMES) {
      expect(cfg.command).toHaveProperty(name);
    }
  });

  test("config hook preserves pre-existing commands in cfg", async () => {
    const hooks = await ghsPlugin({} as never);
    const cfg: { command?: Record<string, unknown> } = {
      command: { "my-custom-cmd": { template: "hello", description: "custom" } },
    };
    await hooks.config!(cfg as never);

    expect(cfg.command).toHaveProperty("my-custom-cmd");
    expect(cfg.command).toHaveProperty("ghs-status");
  });

  test("config hook is idempotent (running twice yields same result)", async () => {
    const hooks = await ghsPlugin({} as never);
    const cfg: { command?: Record<string, unknown> } = {};
    await hooks.config!(cfg as never);
    const afterFirst = { ...cfg.command! };
    await hooks.config!(cfg as never);
    expect(cfg.command).toEqual(afterFirst);
  });
});
