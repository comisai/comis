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
import { AppConfigSchema } from "./schema.js";
import { getConfigSchema, getConfigSections } from "./schema-serializer.js";
import { getFieldMetadata } from "./field-metadata.js";

const here = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// ToolingConfigSchema -- parse semantics + strict-rejection
// ---------------------------------------------------------------------------

describe("ToolingConfigSchema", () => {
  it("empty parse populates all defaults", () => {
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

  it("rejects unknown top-level key (z.strictObject)", () => {
    const result = ToolingConfigSchema.safeParse({ unknownTopLevel: 1 });
    expect(result.success).toBe(false);
  });

  it("rejects unknown nested key inside cluster entry (z.strictObject)", () => {
    const result = ToolingConfigSchema.safeParse({
      capabilityClusters: {
        clusters: { foo: { unknownKey: 1, label: "Foo" } },
      },
    });
    expect(result.success).toBe(false);
  });

  it("MCP capabilityHints requires both cluster AND description", () => {
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

  it("skills capabilityHints requires only cluster (description optional)", () => {
    const result = ToolingConfigSchema.safeParse({
      skills: { capabilityHints: { foo: { cluster: "x" } } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.skills.capabilityHints["foo"]?.cluster).toBe("x");
      expect(result.data.skills.capabilityHints["foo"]?.description).toBeUndefined();
    }
  });

  it("installDetours.mode enum accepts all three values; rejects others", () => {
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

  it("replacesPackages defaults to [] and rejects empty-string entries", () => {
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

  it("DEFAULT_CLUSTER_CONFIG exposes the three reserved IDs with documented defaults", () => {
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

  it("DEFAULT_BUILTIN_ASSIGNMENTS is empty (operators populate via config)", () => {
    expect(DEFAULT_BUILTIN_ASSIGNMENTS).toEqual({});
  });

  it("DEFAULT_CLUSTER_CONFIG and inner objects are frozen", () => {
    expect(Object.isFrozen(DEFAULT_CLUSTER_CONFIG)).toBe(true);
    for (const id of Object.keys(DEFAULT_CLUSTER_CONFIG)) {
      expect(Object.isFrozen(DEFAULT_CLUSTER_CONFIG[id])).toBe(true);
    }
    expect(Object.isFrozen(DEFAULT_BUILTIN_ASSIGNMENTS)).toBe(true);
  });

  it("fixture YAML round-trip parses cleanly", () => {
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

  it("cross-module barrel re-exports resolve via @comis/core/config path", async () => {
    // Re-export contract: ToolingConfigSchema, DEFAULT_CLUSTER_CONFIG,
    // DEFAULT_BUILTIN_ASSIGNMENTS, and the ToolingConfig type all flow through
    // the config index barrel. Importing from "./index.js" must resolve to the
    // SAME runtime references as importing from "./schema-tooling.js".
    const barrel = await import("./index.js");
    expect(barrel.ToolingConfigSchema).toBe(ToolingConfigSchema);
    expect(barrel.DEFAULT_CLUSTER_CONFIG).toBe(DEFAULT_CLUSTER_CONFIG);
    expect(barrel.DEFAULT_BUILTIN_ASSIGNMENTS).toBe(DEFAULT_BUILTIN_ASSIGNMENTS);
  });

  it("partial operator override of clusters does NOT key-merge with defaults at parse time", () => {
    // z.record(...).default({}) does NOT merge with DEFAULT_CLUSTER_CONFIG.
    // Operator-supplied clusters replace the empty default record entirely.
    // The defaults-merge contract is enforced at adapter-construction time, not parse-time.
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

// ---------------------------------------------------------------------------
// AppConfigSchema integration -- threads tooling through the root schema
// ---------------------------------------------------------------------------

describe("AppConfigSchema with tooling section", () => {
  it("AppConfig empty parse populates tooling defaults", () => {
    const result = AppConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tooling.capabilityIndex.enabled).toBe(true);
      expect(result.data.tooling.installDetours.mode).toBe("advise");
    }
  });

  it("AppConfig rejects unknown key inside tooling (strict-rejection inherited)", () => {
    const result = AppConfigSchema.safeParse({ tooling: { unknownKey: 1 } });
    expect(result.success).toBe(false);
  });

  it("AppConfig accepts valid tooling override", () => {
    const result = AppConfigSchema.safeParse({
      tooling: { installDetours: { mode: "soft-stop" } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tooling.installDetours.mode).toBe("soft-stop");
    }
  });
});

// ---------------------------------------------------------------------------
// Serializer integration -- tooling section is JSON-Schema-discoverable
// ---------------------------------------------------------------------------

describe("schema-serializer with tooling section", () => {
  it("getConfigSections() includes 'tooling'", () => {
    expect(getConfigSections()).toContain("tooling");
  });

  it("getConfigSchema('tooling') returns a JSON Schema with capabilityIndex+installDetours", () => {
    const schema = getConfigSchema("tooling") as {
      type?: string;
      properties?: Record<string, unknown>;
    };
    expect(schema.type).toBe("object");
    expect(schema.properties).toBeDefined();
    expect(schema.properties).toHaveProperty("capabilityIndex");
    expect(schema.properties).toHaveProperty("installDetours");
    expect(schema.properties).toHaveProperty("capabilityClusters");
    expect(schema.properties).toHaveProperty("mcp");
    expect(schema.properties).toHaveProperty("skills");
  });
});

// ---------------------------------------------------------------------------
// Field metadata integration -- tooling.* fields exposed to CLI/UI
// ---------------------------------------------------------------------------

describe("field-metadata with tooling section", () => {
  it("getFieldMetadata('tooling') returns metadata for tooling.* paths with immutable=true", () => {
    const fields = getFieldMetadata("tooling");
    expect(fields.length).toBeGreaterThan(0);
    // All tooling.* fields are operator-only -- agents must not self-configure.
    // Each path lives under the "tooling" immutable prefix.
    for (const field of fields) {
      expect(field.path.startsWith("tooling.")).toBe(true);
      expect(field.immutable).toBe(true);
    }
    // Spot-check a known leaf field.
    const modeField = fields.find((f) => f.path === "tooling.installDetours.mode");
    expect(modeField).toBeDefined();
    expect(modeField?.immutable).toBe(true);
  });
});
