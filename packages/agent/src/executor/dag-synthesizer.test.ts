// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for dag-synthesizer.ts — the deterministic intent → ExecutionGraph
 * synthesizer.
 *
 * Contract: synthesizeFromIntent({ pattern, agents|tasks, budget? })
 * deterministically expands one of the CANONICAL_DAG_TEMPLATES (research-fanout
 * / debate / vote / map-reduce) into a VALIDATED ExecutionGraph via
 * fillDagTemplate + parseExecutionGraph + validateAndSortGraph. It RETURNS a
 * graph — it NEVER executes one (the caller dispatches it through graph.execute
 * so governance applies). It returns err on an unknown pattern or a missing
 * required slot input (e.g. debate without 2 agents) — never a partial/invalid
 * graph.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { parseExecutionGraph, validateAndSortGraph } from "@comis/core";
import { synthesizeFromIntent } from "./dag-synthesizer.js";

// ---------------------------------------------------------------------------
// Helper — assert a synthesized graph is governance-clean (the SAME parse+sort
// a hand-authored graph takes).
// ---------------------------------------------------------------------------

function assertGovernanceClean(nodes: unknown[], label?: string): void {
  const parsed = parseExecutionGraph({ nodes, ...(label !== undefined && { label }) });
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  const validated = validateAndSortGraph(parsed.value);
  expect(validated.ok).toBe(true);
}

describe("synthesizeFromIntent (deterministic intent synthesizer)", () => {
  // -------------------------------------------------------------------------
  // research-fanout from a one-line task — the TOPIC slot is filled and
  // the graph parses + sorts clean.
  // -------------------------------------------------------------------------
  it("research-fanout from a one-line task → a valid graph with the TOPIC slot filled", () => {
    const r = synthesizeFromIntent({ pattern: "research-fanout", tasks: ["AI safety"] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.nodes.length).toBe(4); // 3 research + 1 synthesize
    // The TOPIC slot was filled from the task (no raw ${VAR} survives).
    expect(JSON.stringify(r.value.nodes)).not.toMatch(/\$\{[A-Z_]+\}/);
    expect(JSON.stringify(r.value.nodes)).toContain("AI safety");
    assertGovernanceClean(r.value.nodes, r.value.label);
  });

  // -------------------------------------------------------------------------
  // The canonical bull-vs-bear debate demo authored from a
  // ONE-LINE intent → a valid 3-node debate graph with PRO_AGENT=bull,
  // CON_AGENT=bear (pro-advocate, con-advocate, moderator fan-in).
  // -------------------------------------------------------------------------
  it("bull-vs-bear: { pattern:'debate', agents:['bull','bear'] } → a valid 3-node debate graph with the advocate agents filled", () => {
    const r = synthesizeFromIntent({ pattern: "debate", agents: ["bull", "bear"] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The canonical debate TEMPLATE shape: 3 plain nodes (no typed driver).
    expect(r.value.nodes.length).toBe(3);
    const ids = r.value.nodes.map((n) => n.nodeId).sort();
    expect(ids).toEqual(["con-advocate", "moderator", "pro-advocate"]);
    // The moderator is the fan-in over both advocates.
    const moderator = r.value.nodes.find((n) => n.nodeId === "moderator")!;
    expect(moderator.dependsOn.sort()).toEqual(["con-advocate", "pro-advocate"]);
    // The advocate agents were filled from agents[0]/agents[1].
    const text = JSON.stringify(r.value.nodes);
    expect(text).toContain("bull");
    expect(text).toContain("bear");
    expect(text).not.toMatch(/\$\{[A-Z_]+\}/);
    assertGovernanceClean(r.value.nodes, r.value.label);
  });

  // -------------------------------------------------------------------------
  // vote + map-reduce each synthesize a valid graph from a minimal
  // intent.
  // -------------------------------------------------------------------------
  it("vote (from agents) and map-reduce (from a task) each synthesize a valid graph", () => {
    const vote = synthesizeFromIntent({ pattern: "vote", agents: ["a1", "a2", "a3"] });
    expect(vote.ok).toBe(true);
    if (vote.ok) {
      expect(vote.value.nodes.length).toBe(4); // 3 voters + 1 aggregator
      expect(JSON.stringify(vote.value.nodes)).not.toMatch(/\$\{[A-Z_]+\}/);
      assertGovernanceClean(vote.value.nodes, vote.value.label);
    }

    const mr = synthesizeFromIntent({ pattern: "map-reduce", tasks: ["big job"] });
    expect(mr.ok).toBe(true);
    if (mr.ok) {
      expect(mr.value.nodes.length).toBe(4); // 3 mappers + 1 reducer
      expect(JSON.stringify(mr.value.nodes)).not.toMatch(/\$\{[A-Z_]+\}/);
      expect(JSON.stringify(mr.value.nodes)).toContain("big job");
      assertGovernanceClean(mr.value.nodes, mr.value.label);
    }
  });

  // -------------------------------------------------------------------------
  // err on a missing required slot input — debate needs 2 agents.
  // Never return a partial graph.
  // -------------------------------------------------------------------------
  it("debate with only one agent → err (needs 2 advocate agents), never a partial graph", () => {
    const r = synthesizeFromIntent({ pattern: "debate", agents: ["only-one"] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.toLowerCase()).toContain("debate");
  });

  // -------------------------------------------------------------------------
  // err on an unknown pattern (never throws — pure Result fn).
  // -------------------------------------------------------------------------
  it("an unknown pattern → err (not a throw)", () => {
    const r = synthesizeFromIntent({ pattern: "bogus" as never, tasks: ["x"] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Escaping: an agent name with JSON metacharacters still yields a
  // parseable graph (delegated to fillDagTemplate's slot-value escaping).
  // -------------------------------------------------------------------------
  it("agent names with JSON metacharacters → the synthesized graph still parses (escaping carried through)", () => {
    const r = synthesizeFromIntent({
      pattern: "debate",
      agents: ['ta-"bull"\\x', "ta-bear\nnow"],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    assertGovernanceClean(r.value.nodes, r.value.label);
  });

  // -------------------------------------------------------------------------
  // Blank agent names are garbage-in. A length-only check (`agents.length < 2`)
  // would let `["", ""]` pass the gate and fill PRO_AGENT="" / CON_AGENT="",
  // producing tasks ending "...Agent: " (blank role). The synthesizer
  // trims+filters empties BEFORE the count check, so blank agents trip the same
  // "debate requires 2 agents" err as `[]` — never a malformed graph.
  // -------------------------------------------------------------------------
  it("debate with two EMPTY-string agents → err (blank names fail the 2-agent guard), never a blank-role graph", () => {
    const r = synthesizeFromIntent({ pattern: "debate", agents: ["", ""] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.toLowerCase()).toContain("debate");
  });

  it("debate with whitespace-only agents → err (trimmed to empty, fails the guard)", () => {
    const r = synthesizeFromIntent({ pattern: "debate", agents: ["   ", "\t\n"] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.toLowerCase()).toContain("debate");
  });

  it("debate with one real + one blank agent → err (only one non-empty name)", () => {
    const r = synthesizeFromIntent({ pattern: "debate", agents: ["bull", "  "] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.toLowerCase()).toContain("debate");
  });

  // -------------------------------------------------------------------------
  // The synthesizer is PURE — it returns a graph object and never
  // executes one. The returned value is a plain ExecutionGraph (nodes array),
  // not a run handle / coordinator result.
  // -------------------------------------------------------------------------
  it("returns a plain ExecutionGraph (nodes/label), never a run handle — it does not execute", () => {
    const r = synthesizeFromIntent({ pattern: "research-fanout", tasks: ["topic"] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The shape is an ExecutionGraph: a nodes array, no graphId / no execution state.
    expect(Array.isArray(r.value.nodes)).toBe(true);
    expect((r.value as Record<string, unknown>).graphId).toBeUndefined();
    expect((r.value as Record<string, unknown>).executionOrder).toBeUndefined();
  });
});
