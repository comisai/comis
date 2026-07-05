// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { isSpecPureFrontmatter, SPEC_PURE_TOP_LEVEL_FIELDS } from "./spec-purity.js";
import { SkillManifestSchema } from "./schema.js";

describe("isSpecPureFrontmatter", () => {
  it("returns true for a manifest carrying only name and description", () => {
    expect(isSpecPureFrontmatter({ name: "x", description: "d" })).toBe(true);
  });

  it("returns true when every one of the six spec top-level fields is present", () => {
    expect(
      isSpecPureFrontmatter({
        name: "x",
        description: "d",
        license: "MIT",
        compatibility: "needs node 22",
        "allowed-tools": "read write",
        metadata: {},
      }),
    ).toBe(true);
  });

  it("returns false when a top-level type field is present", () => {
    expect(isSpecPureFrontmatter({ name: "x", description: "d", type: "prompt" })).toBe(false);
  });

  it("returns false when a top-level version field is present", () => {
    expect(isSpecPureFrontmatter({ name: "x", description: "d", version: "1.0.0" })).toBe(false);
  });

  it("returns false when a top-level comis namespace block is present", () => {
    expect(isSpecPureFrontmatter({ name: "x", description: "d", comis: {} })).toBe(false);
  });

  it("returns false for any unrecognized top-level key", () => {
    expect(isSpecPureFrontmatter({ name: "x", description: "d", unknownKey: 1 })).toBe(false);
  });

  it("iterates own-enumerable keys only and ignores inherited members", () => {
    const base = { inherited: "value" };
    const raw = Object.create(base) as Record<string, unknown>;
    raw["name"] = "x";
    raw["description"] = "d";
    expect(isSpecPureFrontmatter(raw)).toBe(true);
  });
});

describe("SPEC_PURE_TOP_LEVEL_FIELDS", () => {
  it("enumerates exactly the six spec top-level fields in alphabetical order", () => {
    expect([...SPEC_PURE_TOP_LEVEL_FIELDS]).toEqual([
      "allowed-tools",
      "compatibility",
      "description",
      "license",
      "metadata",
      "name",
    ]);
  });

  it("is frozen so callers share one immutable source of the rule", () => {
    expect(Object.isFrozen(SPEC_PURE_TOP_LEVEL_FIELDS)).toBe(true);
  });
});

describe("SkillManifestSchema compatibility field", () => {
  it("accepts a compatibility string as a validated but unread internal field", () => {
    const result = SkillManifestSchema.safeParse({
      name: "x",
      description: "d",
      compatibility: "needs node 22",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.compatibility).toBe("needs node 22");
    }
  });
});
