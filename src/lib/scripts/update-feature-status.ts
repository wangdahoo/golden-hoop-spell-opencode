// Update a feature's status inside a features.json object (in-memory; no I/O).
//
// This is one of the three "writer" modules introduced in s2-feat-001. Like
// append-sprint.ts, it has no source-plugin Python equivalent — the source
// `ghs-sprint` / `ghs-code` skills had the AI edit features.json directly.
// This module refactors that into a pure, Zod-validated function.
//
// Design principles match append-sprint.ts: pure function, no I/O, no stdout,
// no process.exit, immutable return, Zod-validated spec.

import { z } from "zod";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;
export type FeaturesData = JsonObject;
export type Feature = JsonObject;
export type Sprint = JsonObject;

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------

/**
 * Allowed feature statuses. Kept in sync with validate-structure.ts
 * `VALID_FEATURE_STATUSES`. Re-declared locally to avoid a cross-module
 * dependency (see the rationale in append-sprint.ts).
 */
export const VALID_FEATURE_STATUSES = [
  "pending",
  "in_progress",
  "completed",
  "blocked",
] as const;

/**
 * Zod schema for the "update feature status" spec.
 *
 * - `feature_id`: matches the feature ID format enforced by
 *   validate-structure.ts (`^s\d{1,4}-feat-\d{3}$`).
 * - `status`: one of {@link VALID_FEATURE_STATUSES}.
 * - `blocked_reason`: required when `status === "blocked"` (matches the
 *   optional-field convention documented in features.json's `_schema_docs`).
 */
const FEATURE_ID_PATTERN = /^s\d{1,4}-feat-\d{3}$/;

export const UpdateFeatureStatusSpecSchema = z
  .object({
    feature_id: z
      .string()
      .regex(
        FEATURE_ID_PATTERN,
        "feature_id must match ^s\\d{1,4}-feat-\\d{3}$ (e.g. s1-feat-001)",
      ),
    status: z.enum(VALID_FEATURE_STATUSES),
    blocked_reason: z.string().min(1).optional(),
  })
  .refine(
    (spec) => spec.status !== "blocked" || (spec.blocked_reason ?? "") !== "",
    {
      message:
        "blocked_reason is required when status is 'blocked'",
      path: ["blocked_reason"],
    },
  );

export type UpdateFeatureStatusSpec = z.infer<
  typeof UpdateFeatureStatusSpecSchema
>;

// -----------------------------------------------------------------------------
// Writer
// -----------------------------------------------------------------------------

/** Result of locating a feature: the sprint it lives in and the feature itself. */
interface LocatedFeature {
  sprintIndex: number;
  featureIndex: number;
}

/**
 * Find a feature by ID across all sprints. Returns the sprint/feature indices
 * or `null` when not found.
 */
function locateFeature(
  featuresData: FeaturesData,
  featureId: string,
): LocatedFeature | null {
  const sprints = Array.isArray(featuresData.sprints)
    ? (featuresData.sprints as Sprint[])
    : [];
  for (let si = 0; si < sprints.length; si++) {
    const features = Array.isArray(sprints[si].features)
      ? (sprints[si].features as Feature[])
      : [];
    for (let fi = 0; fi < features.length; fi++) {
      if (features[fi].id === featureId) {
        return { sprintIndex: si, featureIndex: fi };
      }
    }
  }
  return null;
}

/**
 * Update the status of a single feature (located by ID, searched across ALL
 * sprints) and return a NEW featuresData object. The input is not modified.
 *
 * Behavior:
 *   1. Validate `spec` against {@link UpdateFeatureStatusSpecSchema}. This
 *      enforces the feature_id format, the status enum, and the rule that
 *      `status === "blocked"` requires a non-empty `blocked_reason`. A ZodError
 *      is thrown on invalid input.
 *   2. Locate the feature by `spec.feature_id`. Throw a descriptive Error if no
 *      sprint contains it.
 *   3. Return a shallow-cloned featuresData where the located sprint and its
 *      `features` array are shallow-cloned, and the target feature is replaced
 *      with a cloned object carrying the new `status` (and `blocked_reason`
 *      when applicable). Other features/sprints are shared by reference.
 *
 * When transitioning OUT of "blocked", any pre-existing `blocked_reason` field
 * is removed from the updated feature (so the file does not carry a stale
 * reason for a non-blocked feature).
 */
export function updateFeatureStatus(
  featuresData: FeaturesData,
  spec: UpdateFeatureStatusSpec,
): FeaturesData {
  const validated = UpdateFeatureStatusSpecSchema.parse(spec);

  const located = locateFeature(featuresData, validated.feature_id);
  if (located === null) {
    throw new Error(
      `Feature '${validated.feature_id}' not found in any sprint`,
    );
  }

  const sprints = Array.isArray(featuresData.sprints)
    ? (featuresData.sprints as Sprint[])
    : [];

  const { sprintIndex, featureIndex } = located;
  const targetSprint = sprints[sprintIndex];
  const features = (targetSprint.features as Feature[]) ?? [];
  const targetFeature = features[featureIndex];

  // Build the updated feature. Start from a shallow clone of the original so
  // unrelated fields are preserved.
  const updatedFeature: Feature = { ...targetFeature };
  updatedFeature.status = validated.status;
  if (validated.status === "blocked") {
    updatedFeature.blocked_reason = validated.blocked_reason;
  } else if ("blocked_reason" in updatedFeature) {
    delete updatedFeature.blocked_reason;
  }

  // Rebuild the path from the root to the updated feature with shallow clones
  // at each container level. Everything else is shared by reference.
  const updatedFeatures = features.slice();
  updatedFeatures[featureIndex] = updatedFeature;

  // Sprint-completion promotion: when the updated feature makes EVERY feature
  // in its owning sprint `completed` (sprint non-empty), flip the sprint's own
  // `status` to `completed`. This is the ONLY place a sprint transitions to
  // completed — without it the sprint lingers in `in_progress` after the last
  // feature ships, and `ghs-archive` (which keys on `status === "completed"`)
  // can never pick it up. Promotion is one-way: a sprint that is not fully
  // completed keeps whatever status it already had (never demoted here — same
  // no-transition-guard stance as feature statuses). `every` includes the
  // just-updated feature, so this branch can only fire when the new status is
  // `completed`.
  const allCompleted =
    updatedFeatures.length > 0 &&
    updatedFeatures.every((f) => f.status === "completed");

  const updatedSprint: Sprint = {
    ...targetSprint,
    features: updatedFeatures,
    ...(allCompleted ? { status: "completed" } : {}),
  };
  const updatedSprints = sprints.slice();
  updatedSprints[sprintIndex] = updatedSprint;

  return { ...featuresData, sprints: updatedSprints };
}
