// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the leaf-pass store-read helpers extracted from
 * lcd-compaction-trigger.ts (file-size extraction). These pin the
 * relocated behavior is byte-identical: previousSummaryContent returns the last
 * summary of ANY kind (or undefined), and chunkOrdinalWindow maps first/last ids
 * to the [start,end] window with the defensive divergence guards.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import type { ContextStorePort, ContextStoreScope, LcdSummary } from "@comis/core";
import { previousSummaryContent, chunkOrdinalWindow } from "./lcd-compaction-helpers.js";

const SCOPE: ContextStoreScope = {
  conversationId: "conv-a",
  tenantId: "tenant_a",
  agentId: "agent_a",
  sessionKey: "sess-a",
};

function summary(id: string, content: string, kind: LcdSummary["kind"] = "leaf"): LcdSummary {
  return {
    summaryId: id,
    conversationId: "conv-a",
    kind,
    depth: 0,
    earliestAt: 1,
    latestAt: 2,
    descendantCount: 1,
    tokenCount: 5,
    content,
    fileIds: [],
    taint: false,
    fallback: false,
    createdAt: 3,
  };
}

/** A store stub exposing only getSummaries (the method the helper calls). */
function storeWith(summaries: LcdSummary[]): ContextStorePort {
  return { getSummaries: () => summaries } as unknown as ContextStorePort;
}

describe("previousSummaryContent", () => {
  it("returns undefined when there are no summaries", () => {
    expect(previousSummaryContent(storeWith([]), SCOPE)).toBeUndefined();
  });

  it("returns the LAST summary's content (most recent — store returns oldest-first)", () => {
    const store = storeWith([summary("s1", "oldest"), summary("s2", "newest")]);
    expect(previousSummaryContent(store, SCOPE)).toBe("newest");
  });

  it("returns the last summary of ANY kind (condensed counts too)", () => {
    const store = storeWith([summary("s1", "leaf-body", "leaf"), summary("s2", "condensed-body", "condensed")]);
    expect(previousSummaryContent(store, SCOPE)).toBe("condensed-body");
  });
});

describe("chunkOrdinalWindow", () => {
  const ordinalById = new Map<string, number>([
    ["m-first", 3],
    ["m-last", 7],
    ["m-reversed-first", 9],
    ["m-reversed-last", 4],
  ]);

  it("maps first/last ids to the [startOrdinal, endOrdinal] window", () => {
    expect(chunkOrdinalWindow(ordinalById, "m-first", "m-last")).toEqual({
      startOrdinal: 3,
      endOrdinal: 7,
    });
  });

  it("returns undefined when an id is missing from the map (the divergence guard)", () => {
    expect(chunkOrdinalWindow(ordinalById, "m-first", "m-absent")).toBeUndefined();
    expect(chunkOrdinalWindow(ordinalById, "m-absent", "m-last")).toBeUndefined();
  });

  it("returns undefined when end < start (the non-1:1 mapping guard)", () => {
    expect(chunkOrdinalWindow(ordinalById, "m-reversed-first", "m-reversed-last")).toBeUndefined();
  });

  it("accepts a single-message window (start === end)", () => {
    expect(chunkOrdinalWindow(ordinalById, "m-first", "m-first")).toEqual({
      startOrdinal: 3,
      endOrdinal: 3,
    });
  });
});
