// Pure-function tests for `src/lib/scripts/append-feature.ts` (Feature s1-feat-005).
//
// Exercises the `appendFeature` writer with no disk IO — the function takes an
// in-memory featuresData object and returns a NEW one. Covers the six AC
// scenarios the feature gates on:
//   1. Normal append: empty sprint → append → feature present, status "pending"
//   2. Sprint not found → throws Error
//   3. feature_id duplicate → throws Error
//   4. Missing required field → ZodError
//   5. Illegal enum value (category="foo") → ZodError
//   6. Immutable: input object not modified
//
// The tool-layer cascade is covered in test/tools/append-feature.test.ts.

import { expect, test, describe } from "bun:test";
import { ZodError } from "zod";

import {
  appendFeature,
  type AppendFeatureSpec,
  type FeaturesData,
} from "../src/lib/scripts/append-feature";

/** A minimal featuresData with one empty sprint (s1). */
function seedEmptySprint(): FeaturesData {
  return {
    project: { name: "test" },
    sprints: [
      { id: "s1", name: "Sprint 1", status: "planning", features: [] },
    ],
    metadata: {},
  };
}

/** A valid feature spec (complete, all required fields, proper literal types). */
function validSpec(): AppendFeatureSpec {
  return {
    sprint_id: "s1",
    feature: {
      id: "s1-feat-001",
      category: "core",
      priority: "high",
      title: "测试 feature",
      description: "这是一个测试 feature",
      acceptance_criteria: ["Given x, when y, then z"],
      dependencies: [],
      files_affected: [],
      estimated_complexity: "small",
    },
  };
}

describe("appendFeature pure function (s1-feat-005)", () => {
  // AC #1: Normal append ----------------------------------------------------
  test("AC#1 appends a feature with status 'pending' to an empty sprint", () => {
    const data = seedEmptySprint();

    const updated = appendFeature(data, validSpec());

    const sprint = (updated.sprints as Array<Record<string, unknown>>)[0];
    const features = sprint.features as Array<Record<string, unknown>>;
    expect(features).toHaveLength(1);
    expect(features[0].id).toBe("s1-feat-001");
    expect(features[0].status).toBe("pending");
    expect(features[0].category).toBe("core");
    expect(features[0].priority).toBe("high");
  });

  // AC #2: Sprint not found -------------------------------------------------
  test("AC#2 throws when the target sprint does not exist", () => {
    const data = seedEmptySprint();
    const spec = validSpec();
    spec.sprint_id = "s99";
    expect(() => appendFeature(data, spec)).toThrow(/Sprint 's99' not found/);
  });

  // AC #3: feature_id duplicate ---------------------------------------------
  test("AC#3 throws when the feature_id already exists in the sprint", () => {
    const data = appendFeature(seedEmptySprint(), validSpec());
    expect(() => appendFeature(data, validSpec())).toThrow(/already exists/);
  });

  // AC #4: Missing required field → ZodError --------------------------------
  test("AC#4 throws ZodError when a required field is missing", () => {
    const data = seedEmptySprint();
    // Omit description.
    const badSpec = {
      sprint_id: "s1",
      feature: {
        id: "s1-feat-001",
        category: "core" as const,
        priority: "high" as const,
        title: "测试",
        acceptance_criteria: ["ac1"],
        dependencies: [],
        files_affected: [],
        estimated_complexity: "small" as const,
      },
    };
    expect(() => appendFeature(data, badSpec as never)).toThrow(ZodError);
  });

  // AC #5: Illegal enum value → ZodError ------------------------------------
  test("AC#5 throws ZodError for an illegal category value", () => {
    const data = seedEmptySprint();
    const spec = validSpec();
    (spec.feature as Record<string, unknown>).category = "foo";
    expect(() => appendFeature(data, spec as never)).toThrow(ZodError);
  });

  // AC #6: Immutable — input not modified -----------------------------------
  test("AC#6 does not modify the input featuresData object", () => {
    const data = seedEmptySprint();
    const dataSnapshot = JSON.parse(JSON.stringify(data));

    appendFeature(data, validSpec());

    // The original object's sprint must still have an empty features array.
    const sprint = (data.sprints as Array<Record<string, unknown>>)[0];
    expect(sprint.features).toEqual([]);
    // And the whole object is structurally unchanged.
    expect(data).toEqual(dataSnapshot);
  });

  // Extra: optional fields default correctly ---------------------------------
  test("optional fields (dependencies/files_affected) default to empty arrays when omitted", () => {
    // Omit dependencies/files_affected — the Zod .default([]) fills them in.
    const spec = {
      sprint_id: "s1",
      feature: {
        id: "s1-feat-001",
        category: "core" as const,
        priority: "high" as const,
        title: "测试 feature",
        description: "这是一个测试 feature",
        acceptance_criteria: ["Given x, when y, then z"],
        estimated_complexity: "small" as const,
      },
    };
    const updated = appendFeature(seedEmptySprint(), spec as never);
    const feat = (
      (updated.sprints as Array<Record<string, unknown>>)[0]
        .features as Array<Record<string, unknown>>
    )[0];
    expect(feat.dependencies).toEqual([]);
    expect(feat.files_affected).toEqual([]);
  });

  // Extra: technical_notes is passed through when provided ------------------
  test("technical_notes is included when provided", () => {
    const spec = validSpec();
    spec.feature.technical_notes = "实现提示";
    const updated = appendFeature(seedEmptySprint(), spec);
    const feat = (
      (updated.sprints as Array<Record<string, unknown>>)[0]
        .features as Array<Record<string, unknown>>
    )[0];
    expect(feat.technical_notes).toBe("实现提示");
  });

  // Extra: acceptance_criteria min(1) ----------------------------------------
  test("throws ZodError when acceptance_criteria is empty", () => {
    const spec = validSpec();
    spec.feature.acceptance_criteria = [];
    expect(() => appendFeature(seedEmptySprint(), spec)).toThrow(ZodError);
  });
});
