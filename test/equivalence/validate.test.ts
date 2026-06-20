// Equivalence test for validate-structure.ts vs validate_structure.py.
//
// Strategy: build several features.json variants (valid, broken, warning-only)
// in fresh temp dirs, run BOTH validators on each, and assert that the
// rendered report text is byte-identical.
//
// The TS port exposes `formatValidationReport(result)` that mirrors what the
// Python `main()` would print to stdout. We compare the report text directly.

import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  validateProjectStructure,
  formatValidationReport,
} from "../../src/lib/scripts/validate-structure";
import {
  runPython,
  makeTempDir,
  cleanupTemp,
  normalizeTempDirs,
} from "./_helpers";

/** Write `obj` as features.json under `<dir>/.ghs/`. Uses the same JSON
 *  formatting as Python's json.dump(obj, f, indent=2) — indent=2, no trailing
 *  newline. */
async function writeFeaturesJson(dir: string, obj: unknown): Promise<void> {
  await mkdir(join(dir, ".ghs"), { recursive: true });
  await writeFile(
    join(dir, ".ghs", "features.json"),
    JSON.stringify(obj, null, 2),
  );
}

describe("validate equivalence", () => {
  const cases: Array<{
    name: string;
    data: unknown;
  }> = [
    {
      name: "valid structure",
      data: {
        project: {
          name: "Valid",
          description: "x",
          created_at: "2026-01-01",
        },
        sprints: [
          {
            id: "s1",
            name: "Sprint 1",
            status: "in_progress",
            features: [
              {
                id: "s1-feat-001",
                title: "F1",
                description: "d",
                status: "pending",
              },
            ],
          },
        ],
      },
    },
    {
      name: "missing project fields",
      data: {
        project: { name: "OnlyName" },
        sprints: [],
      },
    },
    {
      name: "invalid sprint id format",
      data: {
        project: {
          name: "X",
          description: "x",
          created_at: "2026-01-01",
        },
        sprints: [
          {
            id: "invalid",
            name: "Bad",
            status: "in_progress",
            features: [],
          },
        ],
      },
    },
    {
      name: "feature id prefix mismatch",
      data: {
        project: {
          name: "X",
          description: "x",
          created_at: "2026-01-01",
        },
        sprints: [
          {
            id: "s1",
            name: "Sprint 1",
            status: "in_progress",
            features: [
              {
                id: "s2-feat-001",
                title: "F",
                description: "d",
                status: "pending",
              },
            ],
          },
        ],
      },
    },
    {
      name: "blocked feature warning",
      data: {
        project: {
          name: "X",
          description: "x",
          created_at: "2026-01-01",
        },
        sprints: [
          {
            id: "s1",
            name: "Sprint 1",
            status: "completed",
            features: [
              {
                id: "s1-feat-001",
                title: "Blocked",
                description: "d",
                status: "blocked",
              },
            ],
          },
        ],
      },
    },
    {
      name: "invalid feature status",
      data: {
        project: {
          name: "X",
          description: "x",
          created_at: "2026-01-01",
        },
        sprints: [
          {
            id: "s1",
            name: "Sprint 1",
            status: "in_progress",
            features: [
              {
                id: "s1-feat-001",
                title: "F",
                description: "d",
                status: "invalid_status",
              },
            ],
          },
        ],
      },
    },
    {
      name: "missing feature fields",
      data: {
        project: {
          name: "X",
          description: "x",
          created_at: "2026-01-01",
        },
        sprints: [
          {
            id: "s1",
            name: "Sprint 1",
            status: "in_progress",
            features: [
              {
                id: "s1-feat-001",
                // missing title, description, status
              },
            ],
          },
        ],
      },
    },
  ];

  for (const tc of cases) {
    test(`both produce identical report for: ${tc.name}`, async () => {
      const tsDir = await makeTempDir("ghs-eq-validate-ts-");
      const pyDir = await makeTempDir("ghs-eq-validate-py-");
      try {
        await writeFeaturesJson(tsDir, tc.data);
        await writeFeaturesJson(pyDir, tc.data);

        // TS port
        const tsResult = await validateProjectStructure(tsDir);
        const tsReport = formatValidationReport(tsResult);

        // Python oracle
        const pyResult = await runPython("validate_structure.py", [
          "--project-dir",
          pyDir,
        ], pyDir, true);
        // Python prints with print() — trailing newline.
        // Compare reports; the formatValidationReport() docstring promises
        // byte-identical output modulo the trailing newline.
        expect(tsReport + "\n").toBe(pyResult.stdout);
      } finally {
        await cleanupTemp(tsDir);
        await cleanupTemp(pyDir);
      }
    });
  }

  test("both produce identical 'file not found' error", async () => {
    const tsDir = await makeTempDir("ghs-eq-validate-missing-ts-");
    const pyDir = await makeTempDir("ghs-eq-validate-missing-py-");
    try {
      // Don't create .ghs/ — file is missing
      const tsResult = await validateProjectStructure(tsDir);
      const tsReport = formatValidationReport(tsResult);

      const pyResult = await runPython("validate_structure.py", [
        "--project-dir",
        pyDir,
      ], pyDir, true);
      expect(pyResult.exitCode).toBe(1);
      // Normalise the differing temp-dir paths before comparing.
      expect(
        normalizeTempDirs(tsReport + "\n", [{ path: tsDir, label: "DIR" }]),
      ).toBe(
        normalizeTempDirs(pyResult.stdout, [{ path: pyDir, label: "DIR" }]),
      );
    } finally {
      await cleanupTemp(tsDir);
      await cleanupTemp(pyDir);
    }
  });
});

// Suppress unused-import warning for `rm` (kept for parity with other tests
// in case future tests need recursive removal inline).
void rm;
