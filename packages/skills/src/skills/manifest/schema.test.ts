// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  ComisCapabilityBlockSchema,
  ComisNamespaceSchema,
  SkillManifestSchema,
} from "./schema.js";
import { parseSkillManifest } from "./parser.js";

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

// ---------------------------------------------------------------------------
// Phase 68 BUNDLE-01: SkillManifestSchema.mcpServers preprocess
// Normalizer accepts BOTH array (Comis-native) and Claude-Desktop nested-object
// forms. Each entry validates against the canonical McpServerEntrySchema, so
// bundle entries inherit name-regex, transport-inference, and other guards.
// ---------------------------------------------------------------------------

describe("SkillManifestSchema.mcpServers (BUNDLE-01 preprocess)", () => {
  it("parses the Comis-native array form and preserves entry name", () => {
    const result = SkillManifestSchema.safeParse({
      name: "test",
      description: "x",
      mcpServers: [
        { name: "yfinance", transport: "stdio", command: "npx" },
      ],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(Array.isArray(result.data.mcpServers)).toBe(true);
    expect(result.data.mcpServers).toHaveLength(1);
    expect(result.data.mcpServers?.[0]?.name).toBe("yfinance");
    expect(result.data.mcpServers?.[0]?.transport).toBe("stdio");
    expect(result.data.mcpServers?.[0]?.command).toBe("npx");
  });

  it("normalizes the Claude-Desktop nested-object form to the array form", () => {
    const result = SkillManifestSchema.safeParse({
      name: "test",
      description: "x",
      mcpServers: {
        yfinance: { transport: "stdio", command: "npx" },
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(Array.isArray(result.data.mcpServers)).toBe(true);
    expect(result.data.mcpServers).toHaveLength(1);
    const entry = result.data.mcpServers?.find((e) => e.name === "yfinance");
    expect(entry).toBeDefined();
    expect(entry?.transport).toBe("stdio");
    expect(entry?.command).toBe("npx");
  });

  it("parses an empty array as an empty array (no-op bundle)", () => {
    const result = SkillManifestSchema.safeParse({
      name: "test",
      description: "x",
      mcpServers: [],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.mcpServers).toEqual([]);
  });

  it("parses an empty object as an empty array (nested-form no-op bundle)", () => {
    const result = SkillManifestSchema.safeParse({
      name: "test",
      description: "x",
      mcpServers: {},
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.mcpServers).toEqual([]);
  });

  it("leaves mcpServers undefined when absent from the manifest", () => {
    const result = SkillManifestSchema.safeParse({
      name: "test",
      description: "x",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.mcpServers).toBeUndefined();
  });

  it("nested-form key wins when entry also carries a conflicting `name`", () => {
    // Preprocess spreads the entry first then assigns `name` from the outer key,
    // so the key wins -- matches Claude-Desktop semantics. Tests Pattern 1 edge #2.
    const result = SkillManifestSchema.safeParse({
      name: "test",
      description: "x",
      mcpServers: {
        yfinance: { name: "different", transport: "stdio", command: "npx" },
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const entry = result.data.mcpServers?.[0];
    expect(entry?.name).toBe("yfinance");
  });

  it("rejects an adversarial nested key that violates the per-entry name regex (path-traversal defence)", () => {
    // T-68-02-01: McpServerEntrySchema.name.regex(/^[a-zA-Z0-9_-]+$/) rejects
    // path-traversal/control-char keys at parse time. Defence-in-depth on top of
    // the Object.entries own-enumerable iteration (no prototype-pollution leak).
    const result = SkillManifestSchema.safeParse({
      name: "test",
      description: "x",
      mcpServers: {
        "../etc/passwd": { transport: "stdio", command: "npx" },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects mcpServers: null with a Zod 'expected array' error", () => {
    // Preprocess returns the value as-is for any non-array/non-object input;
    // the inner z.array(...).optional() then surfaces the expected-array error.
    const result = SkillManifestSchema.safeParse({
      name: "test",
      description: "x",
      mcpServers: null,
    });
    expect(result.success).toBe(false);
  });

  it("parseSkillManifest end-to-end: full SKILL.md round-trip with bundled MCP", () => {
    const skillMd = `---
name: bundle-test
description: A skill that bundles an MCP server
mcpServers:
  - name: foo
    transport: stdio
    command: npx
---

# bundle-test

Body content.
`;
    const result = parseSkillManifest(skillMd);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mcpServers).toHaveLength(1);
    expect(result.value.mcpServers?.[0]?.name).toBe("foo");
    expect(result.value.mcpServers?.[0]?.transport).toBe("stdio");
    expect(result.value.mcpServers?.[0]?.command).toBe("npx");
  });
});
