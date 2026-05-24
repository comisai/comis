// SPDX-License-Identifier: Apache-2.0
/**
 * Phase 65 OPUX-08/09/10 — McpServerEntrySchema additive-field tests.
 *
 * Covers the 5 new per-server fields (toolAllowlist, toolBlocklist,
 * idleTtlMs, enableResources, enablePrompts). Combined RED+GREEN per
 * AGENTS.md §2.10: the schema-default assertions cannot compile against
 * the pre-patch inferred type, so the schema change and these tests land
 * in one commit.
 */
import { describe, it, expect } from "vitest";
import { McpServerEntrySchema } from "./schema-integrations.js";

const base = { name: "s", transport: "stdio", command: "x" } as const;

describe("McpServerEntrySchema — Phase 65 OPUX additive fields", () => {
  it("idleTtlMs defaults to 0 when omitted (opt-in eviction)", () => {
    const parsed = McpServerEntrySchema.parse({ ...base });
    expect(parsed.idleTtlMs).toBe(0);
  });

  it("accepts a toolAllowlist string array", () => {
    const parsed = McpServerEntrySchema.parse({ ...base, toolAllowlist: ["a", "b"] });
    expect(parsed.toolAllowlist).toEqual(["a", "b"]);
  });

  it("accepts a toolBlocklist string array", () => {
    const parsed = McpServerEntrySchema.parse({ ...base, toolBlocklist: ["c"] });
    expect(parsed.toolBlocklist).toEqual(["c"]);
  });

  it("accepts enableResources: false", () => {
    const parsed = McpServerEntrySchema.parse({ ...base, enableResources: false });
    expect(parsed.enableResources).toBe(false);
  });

  it("accepts enablePrompts: false", () => {
    const parsed = McpServerEntrySchema.parse({ ...base, enablePrompts: false });
    expect(parsed.enablePrompts).toBe(false);
  });

  it("rejects an empty-string tool name in toolAllowlist (.min(1))", () => {
    expect(() => McpServerEntrySchema.parse({ ...base, toolAllowlist: [""] })).toThrow();
  });

  it("rejects a negative idleTtlMs (.nonnegative())", () => {
    expect(() => McpServerEntrySchema.parse({ ...base, idleTtlMs: -1 })).toThrow();
  });

  it("parses a Phase-64-shape entry unchanged with new fields undefined", () => {
    const parsed = McpServerEntrySchema.parse({
      name: "legacy",
      transport: "stdio",
      command: "x",
      keepaliveIntervalMs: 30_000,
      circuitBreakerThreshold: 5,
      circuitBreakerCooldownMs: 60_000,
    });
    expect(parsed.toolAllowlist).toBeUndefined();
    expect(parsed.toolBlocklist).toBeUndefined();
    expect(parsed.enableResources).toBeUndefined();
    expect(parsed.enablePrompts).toBeUndefined();
  });
});

describe("McpServerEntrySchema — Phase 67 CAP-02 supportsParallelToolCalls", () => {
  it("accepts supportsParallelToolCalls: true", () => {
    const parsed = McpServerEntrySchema.parse({ ...base, supportsParallelToolCalls: true });
    expect(parsed.supportsParallelToolCalls).toBe(true);
  });

  it("leaves supportsParallelToolCalls undefined when omitted (no backward-compat break)", () => {
    const parsed = McpServerEntrySchema.parse({ ...base });
    expect(parsed.supportsParallelToolCalls).toBeUndefined();
  });

  it("rejects a non-boolean supportsParallelToolCalls", () => {
    expect(() => McpServerEntrySchema.parse({ ...base, supportsParallelToolCalls: "yes" as unknown as boolean })).toThrow();
  });
});
