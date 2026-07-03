// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for recall-security-prefilter.ts — the pre-fusion security gate.
 *
 * Pure-helper coverage:
 *  - resolveEffectiveBaseFloor: explicit floor wins; relevanceFirst → class default; else 0.
 *  - prefilterLanes: trust + baseFloor gating, BYTE-IDENTITY (same lane reference when no
 *    drop), content-free dropped-id accounting, no double-count of a trust-excluded id.
 *  - gateLanes: accumulates dropped ids into the running accumulator.
 *  - passesBaseFloor: fail-closed on a missing breakdown.
 *
 * @module
 */

import type { MemorySearchResult, TrustLevel } from "@comis/core";
import { describe, it, expect } from "vitest";
import {
  resolveEffectiveBaseFloor,
  prefilterLanes,
  gateLanes,
  passesBaseFloor,
  RELEVANCE_FIRST_DEFAULT_BASE_FLOOR,
  type PrefilterAccumulator,
} from "./recall-security-prefilter.js";
import type { FusionLane } from "./fuse.js";
import type { ScoreBreakdown } from "./score.js";

function makeResult(id: string, trustLevel: TrustLevel, score: number): MemorySearchResult {
  return {
    entry: {
      id,
      tenantId: "default",
      agentId: "default",
      userId: "user_a",
      content: `content for ${id}`,
      trustLevel,
      source: { who: "agent" },
      tags: [],
      createdAt: 0,
    } as unknown as MemorySearchResult["entry"],
    score,
  };
}

const ALLOWED = new Set<TrustLevel>(["system", "learned"]);

describe("resolveEffectiveBaseFloor — arbiter-scoped fail-closed floor resolution", () => {
  it("explicit operator floor wins over the class default under relevanceFirst", () => {
    expect(resolveEffectiveBaseFloor(0.3, true)).toBe(0.3);
  });
  it("explicit operator floor wins when relevanceFirst is off", () => {
    expect(resolveEffectiveBaseFloor(0.25, false)).toBe(0.25);
  });
  it("unconfigured (0) + relevanceFirst → the class default 0.15 (never a silent fail-open)", () => {
    expect(resolveEffectiveBaseFloor(0, true)).toBe(RELEVANCE_FIRST_DEFAULT_BASE_FLOOR);
    expect(resolveEffectiveBaseFloor(undefined, true)).toBe(0.15);
  });
  it("unconfigured (0) + recency-first → 0 (no floor — frontier/mid byte-identical)", () => {
    expect(resolveEffectiveBaseFloor(0, false)).toBe(0);
    expect(resolveEffectiveBaseFloor(undefined, undefined)).toBe(0);
  });
});

describe("prefilterLanes — trust + baseFloor upstream of fusion", () => {
  it("BYTE-IDENTITY: a clean lane (all allowed, floor 0) is returned by the SAME reference", () => {
    const lane: FusionLane = { results: [makeResult("a", "learned", 0.9), makeResult("b", "system", 0.8)], weight: 1.0 };
    const result = prefilterLanes([lane], ALLOWED, 0);
    expect(result.lanes[0]).toBe(lane); // same reference — fuse() sees identical input
    expect(result.trustDroppedIds).toEqual([]);
    expect(result.floorDroppedIds).toEqual([]);
  });

  it("drops a trust-excluded entry and records its id under trustDroppedIds", () => {
    const lane: FusionLane = { results: [makeResult("ext", "external", 0.99), makeResult("ok", "learned", 0.5)], weight: 1.0 };
    const result = prefilterLanes([lane], ALLOWED, 0);
    expect(result.lanes[0]?.results.map((r) => r.entry.id)).toEqual(["ok"]);
    expect(result.trustDroppedIds).toEqual(["ext"]);
    expect(result.floorDroppedIds).toEqual([]);
  });

  it("drops a sub-floor entry (by its genuine pre-fusion score) when a floor is active", () => {
    const lane: FusionLane = { results: [makeResult("low", "learned", 0.1), makeResult("high", "learned", 0.5)], weight: 1.0 };
    const result = prefilterLanes([lane], ALLOWED, 0.15);
    expect(result.lanes[0]?.results.map((r) => r.entry.id)).toEqual(["high"]);
    expect(result.floorDroppedIds).toEqual(["low"]);
  });

  it("a floor of 0 disables the floor branch (no sub-floor drop — byte-identical)", () => {
    const lane: FusionLane = { results: [makeResult("low", "learned", 0.01)], weight: 1.0 };
    const result = prefilterLanes([lane], ALLOWED, 0);
    expect(result.lanes[0]).toBe(lane);
    expect(result.floorDroppedIds).toEqual([]);
  });

  it("does NOT double-count: a trust-excluded id is counted ONLY under trust, never the floor", () => {
    // external AND sub-floor — must appear once, under trust only.
    const lane: FusionLane = { results: [makeResult("evil", "external", 0.01), makeResult("ok", "system", 0.9)], weight: 1.0 };
    const result = prefilterLanes([lane], ALLOWED, 0.15);
    expect(result.trustDroppedIds).toEqual(["evil"]);
    expect(result.floorDroppedIds).toEqual([]);
    expect(result.lanes[0]?.results.map((r) => r.entry.id)).toEqual(["ok"]);
  });
});

describe("gateLanes — accumulates dropped ids across supplies", () => {
  it("pushes dropped ids into the running accumulator and returns gated lanes", () => {
    const acc: PrefilterAccumulator = { trustDroppedIds: [], floorDroppedIds: [] };
    const laneA: FusionLane = { results: [makeResult("ext", "external", 0.9)], weight: 1.0 };
    const laneB: FusionLane = { results: [makeResult("low", "learned", 0.05)], weight: 1.0 };
    gateLanes([laneA], ALLOWED, 0.15, acc);
    gateLanes([laneB], ALLOWED, 0.15, acc);
    expect(acc.trustDroppedIds).toEqual(["ext"]);
    expect(acc.floorDroppedIds).toEqual(["low"]);
  });
});

describe("passesBaseFloor — fail-closed on a missing breakdown", () => {
  const bd = (base: number): ScoreBreakdown =>
    ({ base, recency: 1, temporal: 1, proof: 1, trust: 1, usefulness: 1, forget: 1, final: base }) as ScoreBreakdown;
  it("DROPS a memory with no breakdown (undefined)", () => {
    expect(passesBaseFloor(undefined, 0.3)).toBe(false);
  });
  it("KEEPS a memory whose base >= floor (boundary inclusive)", () => {
    expect(passesBaseFloor(bd(0.3), 0.3)).toBe(true);
    expect(passesBaseFloor(bd(0.5), 0.3)).toBe(true);
  });
  it("DROPS a memory whose base < floor", () => {
    expect(passesBaseFloor(bd(0.12), 0.15)).toBe(false);
  });
});
