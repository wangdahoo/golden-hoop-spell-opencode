// Tests for the ghs-init skill copy (mechanism three, plan §3.3).
//
// Covers Feature s1-feat-011 acceptance criteria:
//   - Given ghs-init, when it initialises a project, then
//     `<projectDir>/.opencode/skill/ghs/SKILL.md` is byte-identical to
//     `shared/skill/ghs/SKILL.md`.
//
// Temp-dir policy: mirrors `test/config.test.ts` — Bun 1.3.11 has no
// `Bun.mkdtemp`, so we use `fs.mkdtemp` under `os.tmpdir()` and
// `realpathSync` the result to avoid macOS `/tmp` → `/private/tmp` symlink
// surprises (matches the equivalence suite convention).

import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { initProject } from "../src/lib/scripts/init-project";

/** Absolute path to the repo root (where `shared/` lives). */
const REPO_ROOT = resolve(import.meta.dir, "..");

/** Absolute path to the canonical skill asset shipped with the plugin. */
const SKILL_SRC = join(REPO_ROOT, "shared", "skill", "ghs", "SKILL.md");

/**
 * Create a fresh temp directory under the OS tmp dir, resolved via
 * `realpathSync` (see header comment for the symlink rationale).
 */
async function makeTempDir(prefix: string): Promise<string> {
  const raw = await mkdtemp(join(tmpdir(), prefix));
  return realpathSync(raw);
}

describe("ghs-init skill copy (mechanism three §3.3)", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await makeTempDir("ghs-init-skill-");
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test("initProject copies shared/skill/ghs/SKILL.md byte-identically", async () => {
    const result = await initProject({
      projectName: "SkillCopyFixture",
      projectDir: tmp,
    });

    const dest = join(tmp, ".opencode", "skill", "ghs", "SKILL.md");
    expect(existsSync(dest)).toBe(true);

    const copied = await readFile(dest, "utf8");
    const source = await readFile(SKILL_SRC, "utf8");
    // Byte-identical: the copy must not transform, template-substitute, or
    // re-encode the asset.
    expect(copied).toBe(source);

    // The returned skillFile path points at the destination we just verified.
    expect(result.skillFile).toBe(dest);
  });

  test("copied SKILL.md byte length matches the source exactly", async () => {
    await initProject({
      projectName: "SkillByteLength",
      projectDir: tmp,
    });

    const dest = join(tmp, ".opencode", "skill", "ghs", "SKILL.md");
    const destBytes = await readFile(dest);
    const srcBytes = await readFile(SKILL_SRC);
    expect(destBytes.byteLength).toBe(srcBytes.byteLength);
  });
});
