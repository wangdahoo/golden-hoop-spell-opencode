// Append a new sprint to a features.json object (in-memory; no I/O).
//
// This is one of the three "writer" modules introduced in s2-feat-001. The
// source plugin had no equivalent Python script — its `ghs-sprint` skill
// instructed the AI to edit features.json directly with the Edit tool. This
// module refactors that into "AI provides a spec, a pure function returns the
// updated object" so the tool layer (s2-feat-003) controls disk persistence.
//
// Design principles (from s2-feat-001 technical_notes + s1-feat-008 style):
//   - Pure function: no Bun.write / fs.writeFileSync. Persistence is the
//     caller's responsibility.
//   - No stdout / console.log.
//   - No process.exit.
//   - Zod-validated input spec.
//   - Immutable: returns a NEW object; the input is not modified.
//
// Style mirrors archive-sprint.ts / init-project.ts.

import { z } from "zod";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;
export type FeaturesData = JsonObject;
export type Sprint = JsonObject;

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------

/**
 * Zod schema for the "append a sprint" spec.
 *
 * - `id`: matches the sprint ID format enforced by validate-structure.ts
 *   (`^s\d{1,4}$`). We re-declare the pattern here rather than importing a
 *   shared constant, to keep this module self-contained (consistent with the
 *   no-cross-module-dependency style of the s1-feat-008 ports).
 * - `name`, `goal`: non-empty strings.
 * - `created_at`: `YYYY-MM-DD` (the same format init-project.ts emits via
 *   `formatLocalDate`).
 */
const SPRINT_ID_PATTERN = /^s\d{1,4}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const AppendSprintSpecSchema = z.object({
  id: z
    .string()
    .regex(
      SPRINT_ID_PATTERN,
      "sprint id must match ^s\\d{1,4}$ (e.g. s1, s12, s1234)",
    ),
  name: z.string().min(1, "name is required"),
  goal: z.string().min(1, "goal is required"),
  created_at: z
    .string()
    .regex(DATE_PATTERN, "created_at must be YYYY-MM-DD"),
});

export type AppendSprintSpec = z.infer<typeof AppendSprintSpecSchema>;

// -----------------------------------------------------------------------------
// Writer
// -----------------------------------------------------------------------------

/**
 * Append a new (empty) sprint to `featuresData.sprints` and return a NEW
 * featuresData object. The input is not modified.
 *
 * Behavior:
 *   1. Validate `spec` against {@link AppendSprintSpecSchema} (throws ZodError
 *      on invalid input).
 *   2. Scan existing `sprints[].id` (treats a missing/empty array as "no
 *      sprints") and throw a descriptive Error if `spec.id` already exists.
 *   3. Return a shallow-cloned featuresData with a shallow-cloned `sprints`
 *      array that has the new sprint appended. The new sprint carries an empty
 *      `features: []` array and `status: "planning"` (matches the source
 *      plugin's convention — a freshly created sprint starts in planning until
 *      the AI finishes decomposing it into features).
 *
 * The clone strategy is intentionally shallow at the top level: existing
 * sprint/feature objects are shared by reference (they are not mutated), while
 * the container arrays and the new sprint object are fresh. This satisfies the
 * "do not modify the input object" acceptance criterion without paying for a
 * deep clone of potentially large feature trees.
 */
export function appendSprint(
  featuresData: FeaturesData,
  spec: AppendSprintSpec,
): FeaturesData {
  const validated = AppendSprintSpecSchema.parse(spec);

  const sprints = Array.isArray(featuresData.sprints)
    ? (featuresData.sprints as Sprint[])
    : [];

  // Uniqueness check — cross all existing sprints.
  const clash = sprints.find((s) => s.id === validated.id);
  if (clash !== undefined) {
    throw new Error(
      `Sprint id '${validated.id}' already exists ` +
        `(name: ${JSON.stringify(clash.name ?? "<unnamed>")})`,
    );
  }

  const newSprint: Sprint = {
    id: validated.id,
    name: validated.name,
    goal: validated.goal,
    status: "planning",
    created_at: validated.created_at,
    features: [],
  };

  // Shallow-clone the container so callers can safely keep using the original.
  return {
    ...featuresData,
    sprints: [...sprints, newSprint],
  };
}
