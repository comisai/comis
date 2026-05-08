// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  ToolingConfigSchema,
  DEFAULT_CLUSTER_CONFIG,
  DEFAULT_BUILTIN_ASSIGNMENTS,
} from "./schema-tooling.js";

const here = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// ToolingConfigSchema -- parse semantics + strict-rejection
// ---------------------------------------------------------------------------

describe("ToolingConfigSchema", () => {
  it("Test 1: empty parse populates all defaults", () => {
    const result = ToolingConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.capabilityIndex.enabled).toBe(true);
      expect(result.data.installDetours.mode).toBe("advise");
      expect(result.data.mcp.capabilityHints).toEqual({});
      expect(result.data.skills.capabilityHints).toEqual({});
      expect(result.data.capabilityClusters.clusters).toEqual({});
      expect(result.data.capabilityClusters.builtinAssignments).toEqual({});
    }
  });

  it("Test 2: rejects unknown top-level key (z.strictObject)", () => {
    const result = ToolingConfigSchema.safeParse({ unknownTopLevel: 1 });
    expect(result.success).toBe(false);
  });

  it("Test 3: rejects unknown nested key inside cluster entry (z.strictObject)", () => {
    const result = ToolingConfigSchema.safeParse({
      capabilityClusters: {
        clusters: { foo: { unknownKey: 1, label: "Foo" } },
      },
    });
    expect(result.success).toBe(false);
  });

  it("Test 4: MCP capabilityHints requires both cluster AND description", () => {
    // Missing description -- should fail
    const missingDesc = ToolingConfigSchema.safeParse({
      mcp: { capabilityHints: { srv: { cluster: "x" } } },
    });
    expect(missingDesc.success).toBe(false);

    // Missing cluster -- should fail
    const missingCluster = ToolingConfigSchema.safeParse({
      mcp: { capabilityHints: { srv: { description: "y" } } },
    });
    expect(missingCluster.success).toBe(false);

    // Both present -- should succeed
    const both = ToolingConfigSchema.safeParse({
      mcp: {
        capabilityHints: {
          srv: { cluster: "x", description: "y" },
        },
      },
    });
    expect(both.success).toBe(true);
  });

  it("Test 5: skills capabilityHints requires only cluster (description optional)", () => {
    const result = ToolingConfigSchema.safeParse({
      skills: { capabilityHints: { foo: { cluster: "x" } } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.skills.capabilityHints["foo"]?.cluster).toBe("x");
      expect(result.data.skills.capabilityHints["foo"]?.description).toBeUndefined();
    }
  });

  it("Test 6: installDetours.mode enum accepts all three values; rejects others", () => {
    for (const mode of ["observe", "advise", "soft-stop"] as const) {
      const result = ToolingConfigSchema.safeParse({ installDetours: { mode } });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.installDetours.mode).toBe(mode);
      }
    }
    const bad = ToolingConfigSchema.safeParse({ installDetours: { mode: "bogus" } });
    expect(bad.success).toBe(false);
  });

  it("Test 7: replacesPackages defaults to [] and rejects empty-string entries", () => {
    // Default case -- skill hint with no replacesPackages
    const defaultCase = ToolingConfigSchema.safeParse({
      skills: { capabilityHints: { foo: { cluster: "x" } } },
    });
    expect(defaultCase.success).toBe(true);
    if (defaultCase.success) {
      expect(defaultCase.data.skills.capabilityHints["foo"]?.replacesPackages).toEqual([]);
    }

    // Empty-string entry -- should fail (z.string().min(1))
    const emptyEntry = ToolingConfigSchema.safeParse({
      skills: {
        capabilityHints: { foo: { cluster: "x", replacesPackages: [""] } },
      },
    });
    expect(emptyEntry.success).toBe(false);
  });

  it("Test 8: DEFAULT_CLUSTER_CONFIG exposes the three reserved IDs with documented defaults", () => {
    const ids = Object.keys(DEFAULT_CLUSTER_CONFIG).sort();
    expect(ids).toEqual(["external-integrations", "other-tools", "prompt-skills"]);

    expect(DEFAULT_CLUSTER_CONFIG["external-integrations"]).toEqual({
      label: "External integrations",
      priority: 9999,
      preferOverInstalls: true,
    });
    expect(DEFAULT_CLUSTER_CONFIG["prompt-skills"]).toEqual({
      label: "Prompt skills",
      priority: 9999,
      preferOverInstalls: true,
    });
    expect(DEFAULT_CLUSTER_CONFIG["other-tools"]).toEqual({
      label: "Other tools",
      priority: 9999,
      preferOverInstalls: false,
    });
  });

  it("Test 9: DEFAULT_BUILTIN_ASSIGNMENTS is empty (operators populate via config)", () => {
    expect(DEFAULT_BUILTIN_ASSIGNMENTS).toEqual({});
  });

  it("Test 10: DEFAULT_CLUSTER_CONFIG and inner objects are frozen", () => {
    expect(Object.isFrozen(DEFAULT_CLUSTER_CONFIG)).toBe(true);
    for (const id of Object.keys(DEFAULT_CLUSTER_CONFIG)) {
      expect(Object.isFrozen(DEFAULT_CLUSTER_CONFIG[id])).toBe(true);
    }
    expect(Object.isFrozen(DEFAULT_BUILTIN_ASSIGNMENTS)).toBe(true);
  });

  it("Test 11: Phase 16 fixture YAML round-trip parses cleanly", () => {
    // packages/core/src/config/ -> packages/agent/src/__tests__/fixtures/...
    // here = packages/core/src/config; ../../../agent/src/__tests__/fixtures/...
    const fixturePath = resolve(
      here,
      "../../../agent/src/__tests__/fixtures/tool-first-replay/tooling-config.yaml",
    );
    const yamlText = readFileSync(fixturePath, "utf8");
    const parsed = parseYaml(yamlText) as { tooling?: unknown };
    expect(parsed.tooling).toBeDefined();

    const result = ToolingConfigSchema.safeParse(parsed.tooling);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(
        result.data.mcp.capabilityHints["finance-data"]?.replacesPackages,
      ).toContain("market-data-lib");
      expect(
        result.data.capabilityClusters.clusters["data-fetching-financial"]?.priority,
      ).toBe(10);
    }
  });

  it("Test 12: partial operator override of clusters does NOT key-merge with defaults at parse time (Pitfall 2)", () => {
    // Pitfall 2: z.record(...).default({}) does NOT merge with DEFAULT_CLUSTER_CONFIG.
    // Operator-supplied clusters replace the empty default record entirely.
    // The defaults-merge contract is ADAPTER-CONSTRUCTION-TIME (Phase 23), not parse-time.
    const result = ToolingConfigSchema.safeParse({
      capabilityClusters: {
        clusters: {
          foo: { label: "Foo" },
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // Only the operator-supplied entry is present; reserved IDs are NOT injected by the parser.
      expect(Object.keys(result.data.capabilityClusters.clusters).sort()).toEqual(["foo"]);
      expect(
        result.data.capabilityClusters.clusters["foo"]?.label,
      ).toBe("Foo");
      // Defaults applied to scalar fields within the entry:
      expect(
        result.data.capabilityClusters.clusters["foo"]?.priority,
      ).toBe(100);
      expect(
        result.data.capabilityClusters.clusters["foo"]?.preferOverInstalls,
      ).toBe(true);
    }
  });
});
