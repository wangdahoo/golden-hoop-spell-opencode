// Port of golden-hoop-spell/plugin/shared/scripts/validate_structure.py.
//
// Behavior source-of-truth:
//   /Users/tom/github/golden-hoop-spell/plugin/shared/scripts/validate_structure.py
//
// Faithful port notes:
//   - ID-format patterns are anchored regexes ported verbatim:
//       SPRINT_ID_PATTERN  = /^s\d{1,4}$/
//       FEATURE_ID_PATTERN = /^s\d{1,4}-feat-\d{3}$/
//     JS regexes are anchored the same way Python's re.compile with ^...$ is.
//   - Validation produces two parallel arrays: `errors` and `warnings`.
//     The order of items matches Python's append/extend order.
//   - This module exports pure functions — no stdout writes. The CLI layer
//     (s1-feat-009) renders the warnings/errors to text using formatReport.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const SPRINT_ID_PATTERN = /^s\d{1,4}$/;
const FEATURE_ID_PATTERN = /^s\d{1,4}-feat-\d{3}$/;

// Shared shape for the parsed JSON.
type JsonObject = Record<string, unknown>;
type Feature = JsonObject;
type Sprint = JsonObject;
type FeaturesData = JsonObject;

/** Validation result: a tuple of error strings and warning strings. */
export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

const VALID_FEATURE_STATUSES = ["pending", "in_progress", "completed", "blocked"];
const VALID_FEATURE_PRIORITIES = ["high", "medium", "low"];
const VALID_FEATURE_CATEGORIES = ["core", "ui", "api", "auth", "data", "infra"];
const VALID_SPRINT_STATUSES = ["planning", "in_progress", "completed", "on_hold"];

/** Validate the `project` section of features.json. */
export function validateProjectSection(data: FeaturesData): string[] {
  const errors: string[] = [];
  const project = (data.project ?? {}) as JsonObject;
  const requiredFields = ["name", "description", "created_at"];
  for (const field of requiredFields) {
    if (!(field in project)) {
      errors.push(`Missing project.${field}`);
    }
  }
  return errors;
}

/** Validate that a sprint ID matches `^s\d{1,4}$`. */
export function validateSprintIdFormat(
  sprintId: string,
  sprintIdx: number,
): string[] {
  const errors: string[] = [];
  if (!SPRINT_ID_PATTERN.test(sprintId)) {
    errors.push(
      `Sprint ${sprintIdx}: invalid sprint ID format '${sprintId}' ` +
        `(must match ^s\\d{1,4}$, e.g. s1, s12, s1234)`,
    );
  }
  return errors;
}

/** Validate that a feature ID matches `^s\d{1,4}-feat-\d{3}$`. */
export function validateFeatureIdFormat(
  featureId: string,
  featureIdx: number,
): string[] {
  const errors: string[] = [];
  if (!FEATURE_ID_PATTERN.test(featureId)) {
    errors.push(
      `Feature ${featureIdx}: invalid feature ID format '${featureId}' ` +
        `(must match ^s\\d{1,4}-feat-\\d{3}$, e.g. s1-feat-001)`,
    );
  }
  return errors;
}

/** Validate that the sprint number prefix in a feature ID matches its parent sprint. */
export function validateFeaturePrefixConsistency(
  featureId: string,
  sprintId: string,
  featureIdx: number,
): string[] {
  const errors: string[] = [];
  if (SPRINT_ID_PATTERN.test(sprintId) && FEATURE_ID_PATTERN.test(featureId)) {
    const sprintNum = sprintId.slice(1); // strip leading 's'
    const featurePrefix = featureId.split("-feat-")[0].slice(1);
    if (sprintNum !== featurePrefix) {
      errors.push(
        `Feature ${featureIdx}: feature ID '${featureId}' prefix ` +
          `does not match parent sprint '${sprintId}' ` +
          `(sprint number ${sprintNum} vs feature prefix ${featurePrefix})`,
      );
    }
  }
  return errors;
}

/** Validate a single feature. Returns `{ errors, warnings }`. */
export function validateFeature(
  feature: Feature,
  featureIdx: number,
  sprintId = "",
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const requiredFields = ["id", "title", "description", "status"];
  for (const field of requiredFields) {
    if (!(field in feature)) {
      errors.push(`Feature ${featureIdx}: missing '${field}'`);
    }
  }

  const featureId = (feature.id as string | undefined) ?? "";
  if (featureId) {
    errors.push(...validateFeatureIdFormat(featureId, featureIdx));
  }

  if (featureId && sprintId) {
    errors.push(
      ...validateFeaturePrefixConsistency(featureId, sprintId, featureIdx),
    );
  }

  const status = (feature.status as string | undefined) ?? "";
  if (status && !VALID_FEATURE_STATUSES.includes(status)) {
    errors.push(`Feature ${featureIdx}: invalid status '${status}'`);
  }

  if (status === "blocked" && !("blocked_reason" in feature)) {
    warnings.push(
      `Feature ${featureIdx}: status is 'blocked' but no 'blocked_reason' field ` +
        "(recommended but not required)",
    );
  }

  const priority = (feature.priority as string | undefined) ?? "";
  if (priority && !VALID_FEATURE_PRIORITIES.includes(priority)) {
    errors.push(`Feature ${featureIdx}: invalid priority '${priority}'`);
  }

  const category = (feature.category as string | undefined) ?? "";
  if (category && !VALID_FEATURE_CATEGORIES.includes(category)) {
    errors.push(`Feature ${featureIdx}: invalid category '${category}'`);
  }

  return { errors, warnings };
}

/** Validate a single sprint. Returns `{ errors, warnings }`. */
export function validateSprint(
  sprint: Sprint,
  sprintIdx: number,
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const requiredFields = ["id", "name", "status"];
  for (const field of requiredFields) {
    if (!(field in sprint)) {
      errors.push(`Sprint ${sprintIdx}: missing '${field}'`);
    }
  }

  const sprintId = (sprint.id as string | undefined) ?? "";
  if (sprintId) {
    errors.push(...validateSprintIdFormat(sprintId, sprintIdx));
  }

  const status = (sprint.status as string | undefined) ?? "";
  if (status && !VALID_SPRINT_STATUSES.includes(status)) {
    errors.push(`Sprint ${sprintIdx}: invalid status '${status}'`);
  }

  const features = sprint.features;
  if (!Array.isArray(features)) {
    errors.push(`Sprint ${sprintIdx}: 'features' must be an array`);
  } else {
    features.forEach((feature, idx) => {
      const r = validateFeature(feature as Feature, idx, sprintId);
      errors.push(...r.errors);
      warnings.push(...r.warnings);
    });
  }

  return { errors, warnings };
}

/**
 * Validate an entire features.json structure on disk.
 *
 * Mirrors Python `validate_features_json(Path)`: returns `{ errors, warnings }`.
 * The first error is `"File not found: <path>"` when the file is missing, or
 * `"Invalid JSON: <message>"` when parsing fails.
 */
export async function validateFeaturesJson(
  filepath: string,
): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!existsSync(filepath)) {
    return { errors: [`File not found: ${filepath}`], warnings: [] };
  }

  let data: FeaturesData;
  try {
    const text = await readFile(filepath, "utf8");
    data = JSON.parse(text) as FeaturesData;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { errors: [`Invalid JSON: ${msg}`], warnings: [] };
  }

  errors.push(...validateProjectSection(data));

  const sprints = data.sprints;
  if (!Array.isArray(sprints)) {
    errors.push("'sprints' must be an array");
  } else {
    sprints.forEach((sprint, idx) => {
      const r = validateSprint(sprint as Sprint, idx);
      errors.push(...r.errors);
      warnings.push(...r.warnings);
    });
  }

  return { errors, warnings };
}

/**
 * Validate features.json for the project at `projectDir`.
 *
 * Convenience wrapper that resolves `<projectDir>/.ghs/features.json` and
 * invokes `validateFeaturesJson`.
 */
export async function validateProjectStructure(
  projectDir: string,
): Promise<ValidationResult> {
  const featuresPath = join(resolve(projectDir), ".ghs", "features.json");
  return validateFeaturesJson(featuresPath);
}

/**
 * Render a validation report as `main()` would print to stdout.
 *
 * This is exported so the CLI wrapper in s1-feat-009 can produce byte-identical
 * output without re-implementing the format. The text matches:
 *
 *     === Validating features.json ===\n\n
 *     [<warnings block if any>]
 *     [<errors block if any> | <success block>]
 */
export function formatValidationReport(result: ValidationResult): string {
  const lines: string[] = [];
  lines.push("=== Validating features.json ===");
  lines.push("");

  if (result.warnings.length > 0) {
    lines.push("⚠️  Warnings:");
    lines.push("");
    for (const warning of result.warnings) {
      lines.push(`  • ${warning}`);
    }
    lines.push("");
  }

  if (result.errors.length > 0) {
    lines.push("❌ Validation failed:");
    lines.push("");
    for (const error of result.errors) {
      lines.push(`  • ${error}`);
    }
  } else {
    lines.push("✅ Validation passed!");
    lines.push("   All required fields present");
    lines.push("   All status values valid");
    lines.push("   All ID formats valid");
    lines.push("   Feature ID prefixes consistent");
    lines.push("   Structure is correct");
  }

  return lines.join("\n");
}
