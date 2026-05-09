// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  ComisCapabilityBlockSchema,
  ComisNamespaceSchema,
} from "./schema.js";

describe("ComisCapabilityBlockSchema", () => {
  it("accepts valid block with all fields", () => {
    const result = ComisCapabilityBlockSchema.safeParse({
      cluster: "data-fetching-financial",
      summary: "Market data integration",
      replacesPackages: ["market-data-lib", "finance-data-client"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cluster).toBe("data-fetching-financial");
      expect(result.data.summary).toBe("Market data integration");
      expect(result.data.replacesPackages).toEqual([
        "market-data-lib",
        "finance-data-client",
      ]);
    }
  });

  it("accepts empty object (defaults to replacesPackages: [])", () => {
    const result = ComisCapabilityBlockSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.replacesPackages).toEqual([]);
    }
  });

  it("accepts cluster-only", () => {
    const result = ComisCapabilityBlockSchema.safeParse({
      cluster: "data-fetching-financial",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.replacesPackages).toEqual([]);
    }
  });

  it("rejects typo'd nested key (replacePackages -- missing s)", () => {
    const result = ComisCapabilityBlockSchema.safeParse({
      replacePackages: ["x"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects type mismatch on cluster", () => {
    const result = ComisCapabilityBlockSchema.safeParse({ cluster: 42 });
    expect(result.success).toBe(false);
  });

  it("rejects empty string violating min(1)", () => {
    const result = ComisCapabilityBlockSchema.safeParse({ cluster: "" });
    expect(result.success).toBe(false);
  });
});

describe("ComisNamespaceSchema with capability key", () => {
  it("accepts comis namespace with capability sub-block", () => {
    const result = ComisNamespaceSchema.safeParse({
      "skill-key": "test-skill",
      os: ["linux"],
      capability: { cluster: "data-fetching-financial" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data?.capability?.cluster).toBe("data-fetching-financial");
    }
  });

  it("accepts comis namespace WITHOUT capability sub-block (capability is optional)", () => {
    const result = ComisNamespaceSchema.safeParse({
      "skill-key": "test-skill",
      os: ["linux"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data?.capability).toBeUndefined();
    }
  });

  it("rejects comis namespace with malformed capability sub-block (strict outer behavior -- preserved invariant)", () => {
    // The outer comis namespace is strict, so a typo in capability causes
    // the WHOLE namespace parse to fail. Recovery happens at the
    // registry-side discovery enrichment (parseComisCapabilityDefensively
    // strips the bad capability and re-parses).
    const result = ComisNamespaceSchema.safeParse({
      "skill-key": "test-skill",
      os: ["linux"],
      capability: { unknownNestedKey: "x" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects comis namespace with unknown TOP-LEVEL key (existing strict-outer invariant preserved)", () => {
    const result = ComisNamespaceSchema.safeParse({
      "skill-key": "test-skill",
      os: ["linux"],
      unknownTopLevelKey: 1,
    });
    expect(result.success).toBe(false);
  });
});
