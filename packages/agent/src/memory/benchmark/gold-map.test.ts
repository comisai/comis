// SPDX-License-Identifier: Apache-2.0
/**
 * UNGATED unit tests for the pure gold-map builder.
 *
 * TIER: default CI / fast unit tier (no model, no store).
 *
 * The invariant proven here: a dataset ref (e.g. "s1" or "5") is the
 * side-map KEY only — it is NEVER a value in the resolved gold set. Only the
 * ingested `MemoryEntry.id` (a UUID) ever appears as a Set value. Unresolved
 * refs (no side-map entry) are silently skipped (no `undefined` leaks in).
 */

import { describe, it, expect } from "vitest";
import { buildGoldMap } from "./gold-map.js";

describe("buildGoldMap (LongMemEval session-level: ref -> ingested uuid)", () => {
  it("resolves answer session refs through the side-map to UUIDs", () => {
    const goldRefs = new Map([["q1", new Set(["s1"])]]);
    const sideMap = new Map([["s1", "uuid-A"]]);
    const result = buildGoldMap(goldRefs, sideMap);
    expect(result.get("q1")).toEqual(new Set(["uuid-A"]));
    // the dataset ref "s1" is NEVER a value in the result — only the UUID is.
    expect(result.get("q1")?.has("s1")).toBe(false);
    expect([...(result.get("q1") ?? [])]).not.toContain("s1");
  });
});

describe("buildGoldMap (LoCoMo dia-level: dia_id -> session doc uuid)", () => {
  it("resolves a gold dia_id through the side-map to the session document uuid", () => {
    const goldRefs = new Map([["conv1:0", new Set(["5"])]]);
    const sideMap = new Map([["5", "uuid-B"]]);
    const result = buildGoldMap(goldRefs, sideMap);
    expect(result.get("conv1:0")).toEqual(new Set(["uuid-B"]));
    expect(result.get("conv1:0")?.has("5")).toBe(false);
  });
});

describe("buildGoldMap (unresolved refs contribute nothing)", () => {
  it("skips a gold ref with no side-map entry (no undefined in the set)", () => {
    const goldRefs = new Map([["q1", new Set(["s1", "s2"])]]);
    const sideMap = new Map([["s1", "uuid-A"]]); // s2 never ingested
    const result = buildGoldMap(goldRefs, sideMap);
    expect(result.get("q1")).toEqual(new Set(["uuid-A"]));
    expect(result.get("q1")?.has(undefined as unknown as string)).toBe(false);
    expect(result.get("q1")?.size).toBe(1);
  });

  it("yields an empty set for a question whose every ref is unresolved", () => {
    const goldRefs = new Map([["q1", new Set(["missing"])]]);
    const result = buildGoldMap(goldRefs, new Map());
    expect(result.get("q1")).toEqual(new Set());
  });
});

describe("buildGoldMap (multiple refs union into one Set)", () => {
  it("unions resolved uuids per question with no duplicates", () => {
    const goldRefs = new Map([["q1", new Set(["s1", "s2", "s3"])]]);
    const sideMap = new Map([
      ["s1", "uuid-A"],
      ["s2", "uuid-B"],
      ["s3", "uuid-A"], // collides with s1's uuid -> deduped by the Set
    ]);
    const result = buildGoldMap(goldRefs, sideMap);
    expect(result.get("q1")).toEqual(new Set(["uuid-A", "uuid-B"]));
    expect(result.get("q1")?.size).toBe(2);
  });
});

describe("buildGoldMap (session-qualified refs resolve to distinct docs)", () => {
  it("resolves two questions whose gold refs share a dia index to DISTINCT uuids", () => {
    // Gold refs carry the session prefix ("D1:1" vs "D2:1") and the side-map is
    // keyed by that SAME full form. The two refs are distinct keys, so the
    // resolver returns distinct session uuids. Keyed by the bare dia index
    // alone, both refs would collapse to "1" -> a single uuid (the
    // last-ingested session), silently zeroing one session's lane.
    const goldRefs = new Map([
      ["collide:0", new Set(["D1:1"])],
      ["collide:1", new Set(["D2:1"])],
    ]);
    const sideMap = new Map([
      ["D1:1", "uuid-session-1"],
      ["D2:1", "uuid-session-2"],
    ]);
    const result = buildGoldMap(goldRefs, sideMap);
    expect(result.get("collide:0")).toEqual(new Set(["uuid-session-1"]));
    expect(result.get("collide:1")).toEqual(new Set(["uuid-session-2"]));
  });
});

describe("buildGoldMap (empty input)", () => {
  it("returns an empty map for empty inputs (never throws)", () => {
    expect(buildGoldMap(new Map(), new Map()).size).toBe(0);
  });
});
