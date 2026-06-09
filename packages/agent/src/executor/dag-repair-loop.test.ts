// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { repairDagWithBoundedRetries } from "./dag-repair-loop.js";
import { fillDagTemplate, CANONICAL_DAG_TEMPLATES } from "./dag-templates.js";
import { parseExecutionGraph, validateAndSortGraph } from "@comis/core";

// ---------------------------------------------------------------------------
// Helpers — graph fixtures
// ---------------------------------------------------------------------------

/** Minimal valid raw node. */
function rawNode(nodeId: string, dependsOn: string[] = []): unknown {
  return { nodeId, task: `Do ${nodeId}`, dependsOn };
}

/** A structurally valid 2-node graph (a → b). */
const validGraphRaw: unknown = {
  nodes: [rawNode("a"), rawNode("b", ["a"])],
};

/** A 2-node graph with a cycle (a → b, b → a). */
const cycleGraphRaw: unknown = {
  nodes: [rawNode("a", ["b"]), rawNode("b", ["a"])],
};

// ---------------------------------------------------------------------------
// O1: repairDagWithBoundedRetries
// ---------------------------------------------------------------------------

describe("repairDagWithBoundedRetries", () => {
  it("Case 1 (baseline): valid graph on first attempt returns ok without calling repromptFn", async () => {
    const repromptFn = vi.fn<[string[]], Promise<unknown>>();

    const result = await repairDagWithBoundedRetries(validGraphRaw, repromptFn, 2);

    expect(result.ok).toBe(true);
    expect(repromptFn).not.toHaveBeenCalled();
    if (result.ok) {
      expect(Array.isArray(result.value.executionOrder)).toBe(true);
    }
  });

  it("Case 2 (repair): invalid graph repaired on second attempt returns ok; repromptFn called exactly once", async () => {
    // repromptFn returns the valid graph on its first (and only) call
    const repromptFn = vi.fn<[string[]], Promise<unknown>>().mockResolvedValueOnce(validGraphRaw);

    const result = await repairDagWithBoundedRetries(cycleGraphRaw, repromptFn, 2);

    expect(result.ok).toBe(true);
    expect(repromptFn).toHaveBeenCalledTimes(1);
    // The hints passed should mention the cycle error
    const hintArgs = repromptFn.mock.calls[0][0] as string[];
    expect(hintArgs.some((h) => /cycle|Graph validation error/i.test(h))).toBe(true);
    if (result.ok) {
      expect(Array.isArray(result.value.executionOrder)).toBe(true);
    }
  });

  it("Case 3 (exhausted, fail-closed): always-bad repromptFn called exactly maxAttempts=2 times, returns err", async () => {
    // Always returns the cycle graph back — never fixes it
    const repromptFn = vi.fn<[string[]], Promise<unknown>>().mockResolvedValue(cycleGraphRaw);

    const result = await repairDagWithBoundedRetries(cycleGraphRaw, repromptFn, 2);

    expect(result.ok).toBe(false);
    // Called exactly maxAttempts times (not maxAttempts+1)
    expect(repromptFn).toHaveBeenCalledTimes(2);
  });

  it("Case 4 (canonical O3 template): small-model path — fill research-fanout template then validate", async () => {
    // Simulate the small-model template path: fill the template, construct graph, validate
    const fillResult = fillDagTemplate(CANONICAL_DAG_TEMPLATES["research-fanout"], {
      TOPIC: "climate change",
    });
    expect(fillResult.ok).toBe(true);
    if (!fillResult.ok) return;

    const graphRaw = { nodes: fillResult.value };
    const parseResult = parseExecutionGraph(graphRaw);
    expect(parseResult.ok).toBe(true);
    if (!parseResult.ok) return;

    const validateResult = validateAndSortGraph(parseResult.value);
    expect(validateResult.ok).toBe(true);
    if (validateResult.ok) {
      expect(validateResult.value.executionOrder.length).toBeGreaterThan(0);
    }
  });
});
