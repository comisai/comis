// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { buildAnnounceKey, createDeliveryDedup } from "./announce-key.js";

// ---------------------------------------------------------------------------
// buildAnnounceKey (INFO-DRY): single source of truth for the idempotency key
// `${callerSessionKey}::${runId}` that the success path (deliverAnnouncement)
// and the failure path (deliverFailureNotification) both build. Two hand-rolled
// literals risk silent divergence → dedup misses; this pins one format.
// ---------------------------------------------------------------------------

describe("buildAnnounceKey", () => {
  it("joins a formatted session key and runId with the :: delimiter", () => {
    expect(buildAnnounceKey("default:u1:c1", "r1")).toBe("default:u1:c1::r1");
  });

  it("returns undefined for a top-level spawn (no callerSessionKey)", () => {
    expect(buildAnnounceKey(undefined, "r1")).toBeUndefined();
  });

  it("returns undefined for an empty-string callerSessionKey", () => {
    expect(buildAnnounceKey("", "r1")).toBeUndefined();
  });

  it("matches the exact literal both delivery paths previously hand-built", () => {
    // Mirrors the pre-extraction literals at result-processor :514 and :641.
    const callerSessionKey = "tenantA:userB:discord:42";
    const runId = "8c1f-uuid";
    expect(buildAnnounceKey(callerSessionKey, runId)).toBe(`${callerSessionKey}::${runId}`);
  });
});

// ---------------------------------------------------------------------------
// createDeliveryDedup (WR-02 + WR-03): a small bounded delivery-dedup primitive
// shared by the batcher success path, the no-batcher success branches, the
// failure path, and DLQ recovery. WR-03: the set MUST be bounded (a long-running
// daemon spawning thousands of sub-agents must not leak one Set entry each).
// ---------------------------------------------------------------------------

describe("createDeliveryDedup", () => {
  it("reports a marked key as delivered and an unmarked key as not", () => {
    const dedup = createDeliveryDedup();
    expect(dedup.has("k1")).toBe(false);
    dedup.mark("k1");
    expect(dedup.has("k1")).toBe(true);
    expect(dedup.has("k2")).toBe(false);
  });

  it("is bounded: marking many distinct keys never grows the set past the cap (WR-03)", () => {
    const cap = 8;
    const dedup = createDeliveryDedup(cap);
    for (let i = 0; i < cap * 10; i++) dedup.mark(`key-${i}`);
    expect(dedup.size).toBe(cap);
  });

  it("evicts oldest-first (FIFO) so the most recently delivered keys are retained", () => {
    const cap = 3;
    const dedup = createDeliveryDedup(cap);
    dedup.mark("a");
    dedup.mark("b");
    dedup.mark("c");
    dedup.mark("d"); // evicts "a"
    expect(dedup.has("a")).toBe(false);
    expect(dedup.has("b")).toBe(true);
    expect(dedup.has("c")).toBe(true);
    expect(dedup.has("d")).toBe(true);
    expect(dedup.size).toBe(cap);
  });

  it("re-marking an existing key does not grow the set (idempotent mark)", () => {
    const dedup = createDeliveryDedup(5);
    dedup.mark("x");
    dedup.mark("x");
    dedup.mark("x");
    expect(dedup.size).toBe(1);
    expect(dedup.has("x")).toBe(true);
  });

  it("defaults to a generous cap well past any realistic in-flight + DLQ-retry window", () => {
    const dedup = createDeliveryDedup();
    // Default cap is large enough that ordinary operation never evicts; assert it
    // is at least the documented floor so eviction can't drop a still-in-flight key.
    for (let i = 0; i < 1000; i++) dedup.mark(`k${i}`);
    expect(dedup.size).toBe(1000);
  });
});
