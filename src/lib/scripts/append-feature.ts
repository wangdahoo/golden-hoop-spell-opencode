// Append a single feature to a sprint inside a features.json object (in-memory;
// no I/O).
//
// This module is the s1-feat-005 counterpart of append-sprint.ts. The source
// plugin had no equivalent — its `ghs-sprint` skill had the AI edit
// features.json by hand to add features during sprint planning. This pure
// function refactors that into "AI provides a spec, a pure function returns the
// updated object" so the tool layer (ghs-append-feature) controls disk
// persistence with Zod validation.
//
// Design principles match append-sprint.ts: pure function, no I/O, no stdout,
// no process.exit, immutable return, Zod-validated spec.

import { z } from "zod";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;
export type FeaturesData = JsonObject;
export type Sprint = JsonObject;
export type Feature = JsonObject;

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------

/**
 * Allowed feature categories / priorities / complexities. Kept in sync with
 * the values documented in features.json's `_schema_docs`. Exported (as const)
 * so the tool layer can `.enum()` them from the same source (Opt #3).
 */
export const VALID_CATEGORIES = [
  "core",
  "ui",
  "api",
  "auth",
  "data",
  "infra",
] as const;
export const VALID_PRIORITIES = ["high", "medium", "low"] as const;
export const VALID_COMPLEXITIES = ["small", "medium", "large"] as const;

/**
 * Zod schema for the "append a feature" spec.
 *
 * - `sprint_id`: matches the sprint ID format (`^s\d{1,4}$`).
 * - `feature.id`: matches the feature ID format (`^s\d{1,4}-feat-\d{3}$`).
 *   The id is provided by the caller (NOT auto-generated) so the caller can
 *   wire `dependencies[]` to specific feature ids.
 * - `category` / `priority` / `estimated_complexity`: enum values validated
 *   against the same-source `as const` arrays above.
 * - `acceptance_criteria`: at least one entry (a feature without AC is
 *   untestable, violating the sprint-planning prompt's testability rule).
 *
 * `status` is intentionally NOT in the spec — the writer hard-codes it to
 * "pending" (a freshly appended feature always starts pending).
 */
const SPRINT_ID_PATTERN = /^s\d{1,4}$/;
const FEATURE_ID_PATTERN = /^s\d{1,4}-feat-\d{3}$/;

export const AppendFeatureSpecSchema = z.object({
  sprint_id: z
    .string()
    .regex(SPRINT_ID_PATTERN, "sprint_id must match ^s\\d{1,4}$"),
  feature: z.object({
    id: z
      .string()
      .regex(
        FEATURE_ID_PATTERN,
        "feature id must match ^s\\d{1,4}-feat-\\d{3}$",
      ),
    category: z.enum(VALID_CATEGORIES),
    priority: z.enum(VALID_PRIORITIES),
    title: z.string().min(1),
    description: z.string().min(1),
    acceptance_criteria: z.array(z.string()).min(1),
    technical_notes: z.string().optional(),
    dependencies: z.array(z.string()).default([]),
    estimated_complexity: z.enum(VALID_COMPLEXITIES),
    files_affected: z.array(z.string()).default([]),
  }),
});

export type AppendFeatureSpec = z.infer<typeof AppendFeatureSpecSchema>;

// -----------------------------------------------------------------------------
// Writer
// -----------------------------------------------------------------------------

/**
 * Append a single feature to `featuresData.sprints[<sprint_id>].features` and
 * return a NEW featuresData object. The input is not modified.
 *
 * Behavior:
 *   1. Validate `spec` against {@link AppendFeatureSpecSchema} (throws
 *      ZodError on invalid input).
 *   2. Locate the target sprint by `spec.sprint_id`. Throw a descriptive
 *      Error if no such sprint exists.
 *   3. Uniqueness check: throw a descriptive Error if `spec.feature.id`
 *      already exists in the target sprint.
 *   4. Build the new feature with a hard-coded `status: "pending"` (a freshly
 *      appended feature always starts pending — the caller cannot override
 *      this; status transitions are the job of `updateFeatureStatus`).
 *   5. Return a shallow-cloned featuresData with the clone path from root to
 *      the new feature (sprints array, target sprint, its features array all
 *      shallow-cloned; everything else shared by reference).
 */
export function appendFeature(
  featuresData: FeaturesData,
  spec: AppendFeatureSpec,
): FeaturesData {
  const validated = AppendFeatureSpecSchema.parse(spec);

  const sprints = Array.isArray(featuresData.sprints)
    ? (featuresData.sprints as Sprint[])
    : [];

  // Locate target sprint.
  const sprintIdx = sprints.findIndex((s) => s.id === validated.sprint_id);
  if (sprintIdx === -1) {
    throw new Error(`Sprint '${validated.sprint_id}' not found`);
  }

  const targetSprint = sprints[sprintIdx];
  const features = Array.isArray(targetSprint.features)
    ? (targetSprint.features as Feature[])
    : [];

  // Uniqueness check.
  if (features.some((f) => f.id === validated.feature.id)) {
    throw new Error(
      `Feature '${validated.feature.id}' already exists in sprint '${validated.sprint_id}'`,
    );
  }

  // Build the new feature with status: "pending".
  const newFeature: Feature = {
    ...validated.feature,
    status: "pending",
  };

  // Immutable rebuild: clone path from root to the new feature.
  const updatedFeatures = [...features, newFeature];
  const updatedSprint: Sprint = { ...targetSprint, features: updatedFeatures };
  const updatedSprints = [...sprints];
  updatedSprints[sprintIdx] = updatedSprint;

  return { ...featuresData, sprints: updatedSprints };
}
