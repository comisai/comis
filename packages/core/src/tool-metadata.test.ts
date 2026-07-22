// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  registerToolMetadata,
  getToolMetadata,
  getAllToolMetadata,
  truncateContentBlocks,
  _clearRegistryForTest,
} from "./tool-metadata.js";
import type { ToolCapabilityMetadata, ComisToolMetadata } from "./tool-metadata.js";
import type {
  ToolInvocationSideEffects,
  TrackedInvocationSideEffect,
} from "./tool-metadata.js";

// ---------------------------------------------------------------------------
// Registry tests
// ---------------------------------------------------------------------------

describe("tool metadata registry", () => {
  it("getToolMetadata returns undefined for unregistered tool", () => {
    expect(getToolMetadata("nonexistent_tool_xyz")).toBeUndefined();
  });

  it("registerToolMetadata stores and retrieves metadata", () => {
    registerToolMetadata("reg_test_store", {
      maxResultSizeChars: 5000,
      isReadOnly: true,
    });

    const meta = getToolMetadata("reg_test_store");
    expect(meta).toBeDefined();
    expect(meta!.maxResultSizeChars).toBe(5000);
    expect(meta!.isReadOnly).toBe(true);
  });

  it("registerToolMetadata merges metadata incrementally", () => {
    registerToolMetadata("reg_test_merge", { isReadOnly: true });
    registerToolMetadata("reg_test_merge", { maxResultSizeChars: 10000 });

    const meta = getToolMetadata("reg_test_merge");
    expect(meta).toEqual({ isReadOnly: true, maxResultSizeChars: 10000 });
  });

  it("registerToolMetadata overwrites fields on re-register", () => {
    registerToolMetadata("reg_test_overwrite", { maxResultSizeChars: 5000 });
    registerToolMetadata("reg_test_overwrite", { maxResultSizeChars: 10000 });

    const meta = getToolMetadata("reg_test_overwrite");
    expect(meta!.maxResultSizeChars).toBe(10000);
  });

  it("getAllToolMetadata returns ReadonlyMap", () => {
    registerToolMetadata("reg_test_all_a", { isReadOnly: true });
    registerToolMetadata("reg_test_all_b", { maxResultSizeChars: 2000 });

    const all = getAllToolMetadata();
    expect(all.has("reg_test_all_a")).toBe(true);
    expect(all.has("reg_test_all_b")).toBe(true);
  });

  it("_clearRegistryForTest clears all entries", () => {
    registerToolMetadata("reg_test_clear", { isReadOnly: true });
    expect(getToolMetadata("reg_test_clear")).toBeDefined();

    _clearRegistryForTest();
    expect(getToolMetadata("reg_test_clear")).toBeUndefined();

    // Clean up (registry already clear, but be explicit)
    _clearRegistryForTest();
  });
});

describe("tool metadata invocation side-effect contract", () => {
  it("stores an explicit always declaration including a reviewed empty capability set", () => {
    const capabilities: readonly TrackedInvocationSideEffect[] = [];
    const declaration: ToolInvocationSideEffects = {
      kind: "always",
      capabilities,
    };

    registerToolMetadata("reg_test_effects_empty", {
      invocationSideEffects: declaration,
    });

    expect(getToolMetadata("reg_test_effects_empty")?.invocationSideEffects).toEqual({
      kind: "always",
      capabilities: [],
    });
  });

  it("stores a closed action declaration without losing prior metadata", () => {
    registerToolMetadata("reg_test_effects_action", { isReadOnly: false });
    registerToolMetadata("reg_test_effects_action", {
      invocationSideEffects: {
        kind: "by_action",
        parameter: "action",
        actions: {
          inspect: [],
          publish: ["outbound_delivery"],
          defer: ["deferred_work"],
          schedule: ["scheduling"],
        },
      },
    });

    expect(getToolMetadata("reg_test_effects_action")).toMatchObject({
      isReadOnly: false,
      invocationSideEffects: {
        kind: "by_action",
        parameter: "action",
        actions: {
          inspect: [],
          publish: ["outbound_delivery"],
          defer: ["deferred_work"],
          schedule: ["scheduling"],
        },
      },
    });
  });
});

// ---------------------------------------------------------------------------
// Tool-entry schema tests: validActions, validKeys, requiredByAction support
// the generic schema-validator wired into wrapWithMetadataEnforcement before
// the per-tool validateInput hook.
// ---------------------------------------------------------------------------

describe("tool metadata -- tool-entry schema (validActions/validKeys/requiredByAction)", () => {
  it("stores and retrieves validActions", () => {
    registerToolMetadata("reg_test_valid_actions", { validActions: ["a", "b"] });
    const meta = getToolMetadata("reg_test_valid_actions");
    expect(meta).toBeDefined();
    expect(meta!.validActions).toEqual(["a", "b"]);
  });

  it("stores and retrieves validKeys + requiredByAction together", () => {
    registerToolMetadata("reg_test_keys_required", {
      validKeys: ["k1", "k2"],
      requiredByAction: { a: ["k1"] },
    });
    const meta = getToolMetadata("reg_test_keys_required");
    expect(meta).toBeDefined();
    expect(meta!.validKeys).toEqual(["k1", "k2"]);
    expect(meta!.requiredByAction).toEqual({ a: ["k1"] });
  });

  it("spread-merge preserves earlier fields when adding entry-shape metadata later", () => {
    registerToolMetadata("reg_test_schema_merge", { isReadOnly: true });
    registerToolMetadata("reg_test_schema_merge", { validActions: ["x"] });
    const meta = getToolMetadata("reg_test_schema_merge");
    expect(meta!.isReadOnly).toBe(true);
    expect(meta!.validActions).toEqual(["x"]);
  });
});

// ---------------------------------------------------------------------------
// coDiscoverWith tests
// ---------------------------------------------------------------------------

describe("tool metadata -- coDiscoverWith", () => {
  it("stores and retrieves coDiscoverWith field", () => {
    registerToolMetadata("co_disc_test_a", { coDiscoverWith: ["co_disc_test_b"] });
    const meta = getToolMetadata("co_disc_test_a");
    expect(meta).toBeDefined();
    expect(meta!.coDiscoverWith).toEqual(["co_disc_test_b"]);
  });

  it("merges coDiscoverWith with existing metadata", () => {
    registerToolMetadata("co_disc_merge", { isReadOnly: true });
    registerToolMetadata("co_disc_merge", { coDiscoverWith: ["other_tool"] });
    const meta = getToolMetadata("co_disc_merge");
    expect(meta!.isReadOnly).toBe(true);
    expect(meta!.coDiscoverWith).toEqual(["other_tool"]);
  });
});

// ---------------------------------------------------------------------------
// ToolCapabilityMetadata tests (capability layer)
// ---------------------------------------------------------------------------

describe("tool metadata -- ToolCapabilityMetadata", () => {
  it("stores and retrieves a capability block", () => {
    registerToolMetadata("cap_test_basic", {
      capability: { cluster: "data-fetching-financial", summary: "X" },
    });
    const meta = getToolMetadata("cap_test_basic");
    expect(meta).toBeDefined();
    expect(meta!.capability).toEqual({
      cluster: "data-fetching-financial",
      summary: "X",
    });
  });

  it("spread-merge keeps capability + later non-capability fields", () => {
    registerToolMetadata("cap_test_merge", { capability: { cluster: "c1" } });
    registerToolMetadata("cap_test_merge", { isReadOnly: true });
    const meta = getToolMetadata("cap_test_merge");
    expect(meta!.capability).toEqual({ cluster: "c1" });
    expect(meta!.isReadOnly).toBe(true);
  });

  it("re-registering capability replaces wholesale (no deep-merge)", () => {
    registerToolMetadata("cap_test_replace", { capability: { cluster: "c1" } });
    registerToolMetadata("cap_test_replace", {
      capability: { cluster: "c2", summary: "S" },
    });
    const meta = getToolMetadata("cap_test_replace");
    expect(meta!.capability).toEqual({ cluster: "c2", summary: "S" });
  });

  it("replacesPackages accepts readonly string array; round-trips", () => {
    const cap: ToolCapabilityMetadata = {
      replacesPackages: ["pkg-a", "pkg-b"] as const,
    };
    registerToolMetadata("cap_test_pkgs", { capability: cap });
    const meta = getToolMetadata("cap_test_pkgs");
    expect(meta!.capability?.replacesPackages).toEqual(["pkg-a", "pkg-b"]);
  });
});

// ---------------------------------------------------------------------------
// mcpExportPolicy tests
// ---------------------------------------------------------------------------

describe("registerToolMetadata mcpExportPolicy merge", () => {
  it("registerToolMetadata preserves mcpExportPolicy across spread-merges from different categories", () => {
    registerToolMetadata("mcp_export_merge_a", { isReadOnly: true });
    registerToolMetadata("mcp_export_merge_a", {
      mcpExportPolicy: "permission-gated",
    });
    const meta = getToolMetadata("mcp_export_merge_a");
    expect(meta).toBeDefined();
    expect(meta).toMatchObject({
      isReadOnly: true,
      mcpExportPolicy: "permission-gated",
    });
  });

  it("re-registering mcpExportPolicy overrides the previous value wholesale", () => {
    registerToolMetadata("mcp_export_override_b", {
      mcpExportPolicy: "permission-gated",
    });
    registerToolMetadata("mcp_export_override_b", { mcpExportPolicy: "safe" });
    const meta = getToolMetadata("mcp_export_override_b");
    expect(meta!.mcpExportPolicy).toBe("safe");
  });

  it("accepts all three literal policy values from the union", () => {
    registerToolMetadata("mcp_export_safe_c", { mcpExportPolicy: "safe" });
    registerToolMetadata("mcp_export_gated_c", {
      mcpExportPolicy: "permission-gated",
    });
    registerToolMetadata("mcp_export_never_c", {
      mcpExportPolicy: "never-export",
    });
    expect(getToolMetadata("mcp_export_safe_c")!.mcpExportPolicy).toBe("safe");
    expect(getToolMetadata("mcp_export_gated_c")!.mcpExportPolicy).toBe(
      "permission-gated",
    );
    expect(getToolMetadata("mcp_export_never_c")!.mcpExportPolicy).toBe(
      "never-export",
    );
  });
});

// ---------------------------------------------------------------------------
// Truncation tests
// ---------------------------------------------------------------------------

describe("truncateContentBlocks", () => {
  it("returns original array when total chars under budget", () => {
    const content = [{ type: "text", text: "x".repeat(100) }];
    const result = truncateContentBlocks(content, 200);
    expect(result).toBe(content); // Same reference
  });

  it("returns original array when total chars equal to budget", () => {
    const content = [{ type: "text", text: "x".repeat(100) }];
    const result = truncateContentBlocks(content, 100);
    expect(result).toBe(content); // Same reference
  });

  it("truncates text blocks proportionally with 60/40 split", () => {
    const content = [{ type: "text", text: "x".repeat(10000) }];
    const result = truncateContentBlocks(content, 2000);

    expect(result[0].text).toContain("chars truncated");

    // Verify the truncated text has head (60%) + marker + tail (40%) structure
    const text = result[0].text!;
    const markerIdx = text.indexOf("\n[...");
    expect(markerIdx).toBeGreaterThan(0);

    // Head should be roughly 60% of budget (2000 * 0.6 = 1200)
    expect(markerIdx).toBeGreaterThanOrEqual(1100);
    expect(markerIdx).toBeLessThanOrEqual(1300);
  });

  it("preserves non-text blocks unchanged", () => {
    const imageBlock = { type: "image", url: "https://example.com/img.png" };
    const textBlock = { type: "text", text: "x".repeat(5000) };
    const content = [imageBlock, textBlock];
    const result = truncateContentBlocks(content, 1000);

    // Image block should be the exact same object reference
    expect(result[0]).toBe(imageBlock);
    // Text block should be truncated
    expect(result[1].text).toContain("chars truncated");
  });

  it("enforces 500-char minimum per block", () => {
    const content = [
      { type: "text", text: "x".repeat(8000) },
      { type: "text", text: "y".repeat(200) },
    ];
    const result = truncateContentBlocks(content, 100);

    // The small block (200 chars) gets minimum budget of 500, which is > its length
    // so it should NOT be truncated (200 < 500 min budget)
    expect(result[1].text).toBe("y".repeat(200));
  });

  it("marker text includes char count and guidance", () => {
    const content = [{ type: "text", text: "x".repeat(10000) }];
    const result = truncateContentBlocks(content, 2000);
    const text = result[0].text!;

    expect(text).toContain("chars truncated");
    expect(text).toContain("Reduce output scope");
  });

  it("handles empty content array", () => {
    const content: Array<{ type: string; text?: string }> = [];
    const result = truncateContentBlocks(content, 1000);
    expect(result).toBe(content); // Same reference
  });

  it("handles blocks with no text field", () => {
    const content = [{ type: "text" }]; // no text property
    const result = truncateContentBlocks(content, 100);
    // Total chars is 0 (no text), 0 <= 100, returns original
    expect(result).toBe(content);
  });
});

// ---------------------------------------------------------------------------
// Agent Transparency — ComisToolMetadata activity fields
//
// ComisToolMetadata carries `suppressActivity?: boolean` and
// `failureDetector?: (result, isError) => boolean | { errorKind: ErrorKind }`.
// The literals below compile only because the interface declares these fields
// (a type-contract pin). Both are optional, so every metadata object that
// omits them still validates.
// ---------------------------------------------------------------------------

describe("ComisToolMetadata activity fields", () => {
  it("accepts suppressActivity flag", () => {
    const meta: ComisToolMetadata = { suppressActivity: true };
    expect(meta.suppressActivity).toBe(true);
  });

  it("accepts a boolean-returning failureDetector", () => {
    const meta: ComisToolMetadata = {
      failureDetector: (result, isError) => isError || result === null,
    };
    expect(meta.failureDetector?.({ ok: true }, false)).toBe(false);
    expect(meta.failureDetector?.(null, false)).toBe(true);
  });

  it("accepts a failureDetector returning a closed-union errorKind", () => {
    const meta: ComisToolMetadata = {
      failureDetector: (result) =>
        (result as { exitCode?: number }).exitCode === 0
          ? false
          : { errorKind: "dependency" },
    };
    const verdict = meta.failureDetector?.({ exitCode: 1 }, false);
    expect(verdict).toEqual({ errorKind: "dependency" });
  });

  it("rejects a failureDetector errorKind outside the closed union", () => {
    const meta: ComisToolMetadata = {
      // @ts-expect-error - "boom" is not a member of the ErrorKind closed union
      failureDetector: () => ({ errorKind: "boom" }),
    };
    void meta;
  });

  it("an unrelated existing metadata object still validates (additive/optional)", () => {
    registerToolMetadata("activity_fields_additive", {
      maxResultSizeChars: 4000,
      isReadOnly: true,
    });
    const m = getToolMetadata("activity_fields_additive");
    expect(m?.maxResultSizeChars).toBe(4000);
    expect(m?.suppressActivity).toBeUndefined();
    expect(m?.failureDetector).toBeUndefined();
  });

  it("registers and round-trips the activity fields through the registry", () => {
    const detector = (_r: unknown, isError: boolean): boolean => isError;
    registerToolMetadata("activity_fields_roundtrip", {
      suppressActivity: true,
      failureDetector: detector,
    });
    const m = getToolMetadata("activity_fields_roundtrip");
    expect(m?.suppressActivity).toBe(true);
    expect(m?.failureDetector).toBe(detector);
  });
});
