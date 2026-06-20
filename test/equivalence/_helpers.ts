// Shared helpers for the s1-feat-012 equivalence test suite.
//
// These helpers encapsulate the "run the Python oracle + compare" pattern so
// each *.test.ts stays focused on its own assertions.
//
// python3 is expected to be on PATH in the dev environment. We do NOT bundle
// Python with the package — it is documented in the feature's acceptance
// criteria as a dev-only devDependency analog (see package.json note in the
// commit body of s1-feat-012).

import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Absolute path to the OpenCode port repo root (this repo). */
export const GHS_OPENCODE_ROOT = join(import.meta.dir, "..", "..");

/** Absolute path to the source plugin repo (the Python oracle). */
export const GHS_SOURCE_ROOT = "/Users/tom/github/golden-hoop-spell/plugin";

/** Absolute path to the Python source scripts directory (the oracle). */
export const PYTHON_SCRIPTS_DIR = join(GHS_SOURCE_ROOT, "shared", "scripts");

/**
 * Run a Python script with the given args and return stdout, stderr, and exit
 * code. Throws on non-zero exit unless `allowNonZero` is set (in which case
 * the caller can inspect the returned exit code).
 *
 * cwd is set to `cwd` so the script can resolve relative paths consistently
 * with how the TS port sees them.
 *
 * TZ pinning: Bun's test runner forces the JS locale to UTC regardless of the
 * host system timezone, so `new Date().getHours()` returns UTC hours inside
 * tests. To keep the Python oracle's `datetime.now()` in lock-step we
 * explicitly set TZ=UTC on the spawned process's env. In production both
 * impls honour the process's actual TZ — the pin is test-only.
 */
export async function runPython(
  scriptName: string,
  args: string[],
  cwd: string,
  allowNonZero = false,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const scriptPath = join(PYTHON_SCRIPTS_DIR, scriptName);
  return await new Promise((resolve, reject) => {
    const child = spawn("python3", [scriptPath, ...args], {
      cwd,
      env: { ...process.env, TZ: "UTC" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const exitCode = code ?? 0;
      if (exitCode !== 0 && !allowNonZero) {
        reject(
          new Error(
            `python3 ${scriptName} exited ${exitCode}\nstderr:\n${stderr}`,
          ),
        );
      } else {
        resolve({ stdout, stderr, exitCode });
      }
    });
  });
}

/** Resolve the Python interpreter name. Tests use `python3` from PATH. */
export const PYTHON_BIN = "python3";

/**
 * Create a fresh temp directory for a single test case. Returns the absolute
 * path with all symlinks resolved (matching what Python's
 * `Path(dir).resolve()` would produce — important on macOS where `/tmp` and
 * `/var` are symlinks into `/private/...`).
 *
 * Implementation note: Bun does not expose `Bun.mkdtemp` (the function the
 * feature spec referenced). We fall back to Node's `fs.promises.mkdtemp`
 * under the OS temp dir, then `realpathSync` the result.
 */
export async function makeTempDir(prefix = "ghs-eq-"): Promise<string> {
  const raw = await mkdtemp(join(tmpdir(), prefix));
  return realpathSync(raw);
}

/** Recursively remove a temp directory created by `makeTempDir`. */
export async function cleanupTemp(dir: string | undefined): Promise<void> {
  if (!dir) return;
  const { rm } = await import("node:fs/promises");
  await rm(dir, { recursive: true, force: true });
}

/**
 * Copy a fixture directory tree into a destination. Used to seed a temp dir
 * with the canonical .ghs/ fixture before each test.
 *
 * Uses the `cp -R` shell utility to preserve file modes/attrs the same way
 * Python's shutil.copytree does.
 */
export async function copyFixture(
  src: string,
  dest: string,
): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dest, { recursive: true });
  const proc = Bun.spawn(["cp", "-R", `${src}/.`, dest], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const err = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`cp -R ${src} ${dest} failed (${exitCode}): ${err}`);
  }
}

/** Plugin root path for the TS port (= this repo's root). */
export const TS_PLUGIN_ROOT = GHS_OPENCODE_ROOT;

/**
 * Replace every occurrence of each `<path>` in `text` with a fixed placeholder
 * so output from runs in different temp dirs can be compared byte-for-byte.
 *
 * Pass the most specific path first so we don't accidentally substitute a
 * prefix inside a longer path. (In practice these tests pass exactly two
 * distinct temp dirs — the TS dir and the Python dir — and they don't share
 * a meaningful prefix beyond `/private/var/folders/.../T/`.)
 */
export function normalizeTempDirs(
  text: string,
  paths: Array<{ path: string; label: string }>,
): string {
  // Sort by length descending so the longest path is replaced first.
  const sorted = [...paths].sort(
    (a, b) => b.path.length - a.path.length,
  );
  let out = text;
  for (const { path, label } of sorted) {
    out = out.split(path).join(`<${label}>`);
  }
  return out;
}
