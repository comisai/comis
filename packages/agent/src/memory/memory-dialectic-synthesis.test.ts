// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the PURE dialectic synthesis helpers.
 *
 * These are the genuinely-new, RED-provable-at-$0 synthesis logic: trust-first
 * contradiction ordering on the `system>learned>external` ladder, the mandatory
 * abstention DECIDED IN CODE (never the prompt), and the citation→recalled-id→sourceId
 * mapping (citations validated ⊆ recalled ids; a hallucinated/bogus id is DROPPED). No
 * clock, no IO, no model — pure functions over `MemorySearchResult[]` (a core port TYPE).
 */
import { describe, it, expect } from "vitest";
import type { MemorySearchResult, TrustLevel } from "@comis/core";
import {
  orderByTrust,
  abstainIfInsufficient,
  mapCitationsToSourceIds,
  assembleSynthesis,
  citationChains,
} from "./memory-dialectic-synthesis.js";

/** Build a minimal MemorySearchResult with only the fields the synthesis reads. */
function item(
  id: string,
  trustLevel: TrustLevel,
  content: string,
  sourceIds?: string[],
): MemorySearchResult {
  return {
    entry: {
      id,
      tenantId: "default",
      agentId: "default",
      userId: "u1",
      content,
      trustLevel,
      source: { who: "u1" },
      tags: [],
      createdAt: 1,
      ...(sourceIds ? { sourceIds } : {}),
    } as MemorySearchResult["entry"],
  };
}

describe("orderByTrust", () => {
  it("orders recall items system > learned > external (TRUST_RANK DESC) regardless of input order", () => {
    const out = orderByTrust([
      item("ext", "external", "e"),
      item("sys", "system", "s"),
      item("lea", "learned", "l"),
    ]);
    expect(out.map((r) => r.entry.id)).toEqual(["sys", "lea", "ext"]);
  });

  it("is a STABLE sort — preserves recall (input) order for items at the same trust level", () => {
    const out = orderByTrust([
      item("ext-1", "external", "e1"),
      item("ext-2", "external", "e2"),
      item("sys-1", "system", "s1"),
      item("ext-3", "external", "e3"),
    ]);
    // system first; the three externals keep their recall order (1, 2, 3).
    expect(out.map((r) => r.entry.id)).toEqual(["sys-1", "ext-1", "ext-2", "ext-3"]);
  });

  it("on a system/external contradiction places the HIGHER-trust system item at rank 0 (HARD, never blended)", () => {
    // The answer-builder grounds from the ordered list, so the higher-trust claim is
    // presented first and the lower-trust contradiction does not outrank it.
    const out = orderByTrust([
      item("ext", "external", "the timezone is PST"),
      item("sys", "system", "the timezone is UTC"),
    ]);
    expect(out[0].entry.id).toBe("sys");
    expect(out[0].entry.trustLevel).toBe("system");
    expect(out[0].entry.content).toContain("UTC");
  });

  it("reads trust from entry.trustLevel ONLY — a smuggled top-level field never changes the order", () => {
    const sneaky = item("ext", "external", "e") as MemorySearchResult & { trustLevel?: string };
    // A bogus top-level trustLevel must be ignored; the entry.trustLevel (external) wins.
    sneaky.trustLevel = "system";
    const out = orderByTrust([sneaky, item("sys", "system", "s")]);
    expect(out[0].entry.id).toBe("sys");
  });
});

describe("abstainIfInsufficient", () => {
  it("returns { abstain: true } on an EMPTY recall set without consulting the parsed result", () => {
    expect(abstainIfInsufficient([], { abstain: false, citedIds: ["anything"] })).toEqual({
      abstain: true,
    });
  });

  it("returns { abstain: true } when the parser itself abstained, even on a non-empty recall set", () => {
    expect(abstainIfInsufficient([item("a", "system", "x")], { abstain: true })).toEqual({
      abstain: true,
    });
  });

  it("returns { abstain: true } when NO cited id intersects the recalled id set (all hallucinated)", () => {
    const recalled = [item("id-a", "system", "x"), item("id-b", "learned", "y")];
    expect(
      abstainIfInsufficient(recalled, { abstain: false, citedIds: ["bogus-1", "bogus-2"] }),
    ).toEqual({ abstain: true });
  });

  it("returns { abstain: false } when a parsed result cites a REAL recalled id (grounded)", () => {
    const recalled = [item("id-a", "system", "x")];
    expect(abstainIfInsufficient(recalled, { abstain: false, citedIds: ["id-a"] })).toEqual({
      abstain: false,
    });
  });
});

describe("mapCitationsToSourceIds", () => {
  it("validates citations ⊆ recalled ids — a bogus/hallucinated id is DROPPED (citations-are-ids)", () => {
    const recalled = [item("id-a", "system", "x"), item("id-b", "learned", "y")];
    const chains = mapCitationsToSourceIds(recalled, ["id-a", "id-BOGUS"]);
    expect(chains.map((c) => c.citationId)).toEqual(["id-a"]);
  });

  it("traverses a cited entry's sourceIds into the reasoning-tree chain", () => {
    const recalled = [item("id-a", "system", "x", ["src-1", "src-2"])];
    expect(mapCitationsToSourceIds(recalled, ["id-a"])).toEqual([
      { citationId: "id-a", sourceIds: ["src-1", "src-2"] },
    ]);
  });

  it("yields an empty sourceIds chain for a cited entry that has no sourceIds", () => {
    const recalled = [item("id-a", "system", "x")];
    expect(mapCitationsToSourceIds(recalled, ["id-a"])).toEqual([
      { citationId: "id-a", sourceIds: [] },
    ]);
  });
});

describe("assembleSynthesis", () => {
  it("returns the abstain sentinel { answer:'', citations:[], abstained:true } when insufficient", () => {
    expect(assembleSynthesis([], { abstain: false, answer: "x", citedIds: ["a"] })).toEqual({
      answer: "",
      citations: [],
      abstained: true,
    });
  });

  it("returns the grounded answer + validated citation ids (bogus dropped) when grounded", () => {
    const recalled = [item("id-a", "system", "UTC", ["src-1"]), item("id-b", "external", "PST")];
    expect(
      assembleSynthesis(recalled, {
        abstain: false,
        answer: "The timezone is UTC.",
        citedIds: ["id-a", "id-BOGUS"],
      }),
    ).toEqual({ answer: "The timezone is UTC.", citations: ["id-a"], abstained: false });
  });
});

describe("citationChains", () => {
  it("exposes the full { citationId, sourceIds }[] chain for the recall-trace without re-deriving", () => {
    const recalled = [item("id-a", "system", "x", ["src-1", "src-2"])];
    expect(citationChains(recalled, ["id-a", "id-BOGUS"])).toEqual([
      { citationId: "id-a", sourceIds: ["src-1", "src-2"] },
    ]);
  });
});
