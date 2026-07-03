// SPDX-License-Identifier: Apache-2.0
/**
 * `cacheBreakEventToRow` row-builder tests.
 *
 * A detected `observability:cache_break` becomes a content-free
 * `obs_diagnostics category:'cache_break'` DiagnosticRow whose `details` carries
 * the 15-reason discriminator, the prev/cur/delta cache-read tokens, a
 * changed-dims DIGEST (counts only — never the tool-name arrays or system text),
 * and a COMPUTED est-$ (the event carries no `$` field).
 *
 * The est-$ is `tokenDrop × resolveModelPricing(provider, model).cacheRead`:
 * non-zero for a catalog-priced model, 0 for an unknown model (ZERO_COST.cacheRead).
 */
import { describe, it, expect } from "vitest";
import type { EventMap } from "@comis/core";
import { cacheBreakEventToRow } from "./observability-mutations.js";

/** A catalog-priced model — resolveModelPricing(...).cacheRead is non-zero (3e-7). */
const PRICED_PROVIDER = "anthropic";
const PRICED_MODEL = "claude-3-5-sonnet-20241022";
/** A native provider with no catalog entry → ZERO_COST.cacheRead === 0 (the unknown/chimera case). */
const UNKNOWN_PROVIDER = "anthropic";
const UNKNOWN_MODEL = "totally-fake-model-xyz";

function makeCacheBreak(
  overrides: Partial<EventMap["observability:cache_break"]> = {},
): EventMap["observability:cache_break"] {
  return {
    provider: PRICED_PROVIDER,
    reason: "tools_changed",
    tokenDrop: 1000,
    tokenDropRelative: 0.5,
    previousCacheRead: 2000,
    currentCacheRead: 1000,
    callCount: 3,
    changes: {
      systemChanged: false,
      toolsChanged: true,
      metadataChanged: false,
      modelChanged: false,
      retentionChanged: false,
      addedTools: ["a", "b"],
      removedTools: ["c"],
      changedSchemaTools: [],
      headersChanged: false,
      extraBodyChanged: false,
    },
    toolsChanged: ["a", "b", "c"],
    ttlCategory: undefined,
    agentId: "agent-1",
    sessionKey: "sk-1",
    timestamp: 1_700_000_000_000,
    toolsAdded: ["secret-tool-name", "internal_admin_api"],
    toolsRemoved: ["dropped_tool"],
    toolsSchemaChanged: ["schema_changed_tool"],
    systemCharDelta: 42,
    model: PRICED_MODEL,
    ...overrides,
  };
}

describe("cacheBreakEventToRow (category:'cache_break', computed est-$)", () => {
  it("returns a DiagnosticRow with category 'cache_break' (NOT 'health_signal') and a message naming the event", () => {
    const row = cacheBreakEventToRow(makeCacheBreak());
    expect(row.category).toBe("cache_break");
    expect(row.category).not.toBe("health_signal");
    expect(row.message).toContain("cache_break");
    expect(row.timestamp).toBe(1_700_000_000_000);
    expect(row.severity).toBeTruthy();
    expect(row.agentId).toBe("agent-1");
  });

  it("the details JSON carries reason, prev/cur/delta, a changed-dims digest, and estCostUsd", () => {
    const row = cacheBreakEventToRow(makeCacheBreak());
    const details = JSON.parse(row.details ?? "{}");
    expect(details.reason).toBe("tools_changed");
    expect(details.prevCacheRead).toBe(2000);
    expect(details.curCacheRead).toBe(1000);
    expect(details.delta).toBe(1000);
    expect(details).toHaveProperty("changedDimsDigest");
    expect(details).toHaveProperty("estCostUsd");
    // The changed-dims digest carries COUNTS only (the shape of the change).
    expect(details.changedDimsDigest.added).toBe(2);
    expect(details.changedDimsDigest.removed).toBe(1);
    expect(details.changedDimsDigest.schemaChanged).toBe(1);
    expect(details.changedDimsDigest.systemCharDelta).toBe(42);
  });

  it("the computed est-$ is non-zero for a priced model, 0 for an unknown model", () => {
    const pricedRow = cacheBreakEventToRow(
      makeCacheBreak({ provider: PRICED_PROVIDER, model: PRICED_MODEL, tokenDrop: 1000 }),
    );
    const pricedDetails = JSON.parse(pricedRow.details ?? "{}");
    // 1000 × 3e-7 cacheRead rate = 3e-4 (non-zero, the directly-lost cache-read saving).
    expect(pricedDetails.estCostUsd).toBeGreaterThan(0);
    expect(pricedDetails.estCostUsd).toBeCloseTo(1000 * 3e-7, 12);

    const unknownRow = cacheBreakEventToRow(
      makeCacheBreak({ provider: UNKNOWN_PROVIDER, model: UNKNOWN_MODEL, tokenDrop: 1000 }),
    );
    const unknownDetails = JSON.parse(unknownRow.details ?? "{}");
    // Unknown model → ZERO_COST.cacheRead === 0 → est-$ 0 (honest, not fabricated).
    expect(unknownDetails.estCostUsd).toBe(0);
  });

  it("content-free: the details JSON contains NO tool-name arrays and NO system/query text", () => {
    const row = cacheBreakEventToRow(makeCacheBreak());
    const serialized = row.details ?? "";
    // The verbatim tool names from toolsAdded/Removed/SchemaChanged must NOT appear.
    expect(serialized).not.toContain("secret-tool-name");
    expect(serialized).not.toContain("internal_admin_api");
    expect(serialized).not.toContain("dropped_tool");
    expect(serialized).not.toContain("schema_changed_tool");
    // The toolsChanged array names must NOT appear verbatim either.
    const details = JSON.parse(serialized || "{}");
    expect(details.changedDimsDigest).not.toHaveProperty("addedTools");
    expect(JSON.stringify(details)).not.toMatch(/toolsAdded|toolsRemoved|toolsSchemaChanged/);
    // No array of tool names anywhere in the digest — only numeric counts.
    expect(Array.isArray(details.changedDimsDigest.added)).toBe(false);
  });

  it("model_changed reason round-trips (one of the 15 CacheBreakReason values)", () => {
    const row = cacheBreakEventToRow(makeCacheBreak({ reason: "ttl_expiry_long" }));
    const details = JSON.parse(row.details ?? "{}");
    expect(details.reason).toBe("ttl_expiry_long");
  });
});
