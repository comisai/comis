// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for dag-template-match.ts — the deterministic, conservative matcher that
 * maps a weak-model raw graph to a canonical DAG template by SHAPE (node count +
 * dependency topology) + slot inference.
 *
 * Contract: the matcher returns "matched"
 * ONLY when exactly one canonical template fits unambiguously; otherwise
 * "ambiguous" (>=2 plausible) or "no-match". It NEVER calls a model — it is a
 * pure function. On "matched" the slot values are filled via fillDagTemplate
 * (which JSON-escapes weak-model slot values), so the matched graph parses as a
 * governance-clean ExecutionGraph.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { parseExecutionGraph, validateAndSortGraph } from "@comis/core";
import { matchRawGraphToTemplate } from "./dag-template-match.js";

// ---------------------------------------------------------------------------
// Helpers — assert a matched template's filledNodes are governance-clean.
// ---------------------------------------------------------------------------

function assertGovernanceClean(filledNodes: unknown[], label: string): void {
  const parsed = parseExecutionGraph({ nodes: filledNodes, label });
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  const validated = validateAndSortGraph(parsed.value);
  expect(validated.ok).toBe(true);
}

describe("matchRawGraphToTemplate (conservative matcher)", () => {
  // -------------------------------------------------------------------------
  // Unambiguous debate (3 nodes: two independent advocates + a fan-in
  // moderator). The 3-node 2+1 shape is unique to debate among the canon.
  // -------------------------------------------------------------------------
  it("a raw graph shaped like `debate` (2 independent + 1 fan-in) → matched debate, filledNodes parse clean", () => {
    const rawGraph = {
      label: "should we ship",
      nodes: [
        { nodeId: "pro", task: "Argue the case FOR shipping. Agent: bull", dependsOn: [] },
        { nodeId: "con", task: "Argue the case AGAINST shipping. Agent: bear", dependsOn: [] },
        { nodeId: "judge", task: "Moderate and give a verdict", dependsOn: ["pro", "con"] },
      ],
    };

    const m = matchRawGraphToTemplate(rawGraph);
    expect(m.kind).toBe("matched");
    if (m.kind !== "matched") return;
    expect(m.pattern).toBe("debate");
    expect(Array.isArray(m.filledNodes)).toBe(true);
    // The matched graph must be governance-clean (the SAME path a hand-authored
    // graph takes — no unresolved ${VAR} slots, no cycle, no dup).
    assertGovernanceClean(m.filledNodes, "debate");
    // No raw ${VAR} placeholder survived the fill.
    expect(JSON.stringify(m.filledNodes)).not.toMatch(/\$\{[A-Z_]+\}/);
  });

  // -------------------------------------------------------------------------
  // Unambiguous research-fanout (N independent + one fan-in synthesize).
  // research-fanout / vote / map-reduce all share the 4-node 3+1 shape, so the
  // disambiguator is slot/keyword inference (research/synthesize keywords).
  // -------------------------------------------------------------------------
  it("a raw graph shaped+worded like `research-fanout` (N independent + fan-in synthesize) → matched research-fanout", () => {
    const rawGraph = {
      label: "ai safety",
      nodes: [
        { nodeId: "r1", task: "Research perspective 1 on AI safety", dependsOn: [] },
        { nodeId: "r2", task: "Research perspective 2 on AI safety", dependsOn: [] },
        { nodeId: "r3", task: "Research perspective 3 on AI safety", dependsOn: [] },
        { nodeId: "synth", task: "Synthesize all research findings into a summary", dependsOn: ["r1", "r2", "r3"] },
      ],
    };

    const m = matchRawGraphToTemplate(rawGraph);
    expect(m.kind).toBe("matched");
    if (m.kind !== "matched") return;
    expect(m.pattern).toBe("research-fanout");
    assertGovernanceClean(m.filledNodes, "research-fanout");
  });

  // -------------------------------------------------------------------------
  // Ambiguous — a bare 4-node 3+1 shape with NO disambiguating
  // keywords plausibly fits research-fanout / vote / map-reduce. The
  // conservative contract demands "ambiguous" (no false synthesis), NOT a guess.
  // -------------------------------------------------------------------------
  it("a 4-node 3+1 graph with NO distinguishing keywords → ambiguous (candidates listed, no false synthesis)", () => {
    const rawGraph = {
      label: "do stuff",
      nodes: [
        { nodeId: "a", task: "Do part 1 of the thing", dependsOn: [] },
        { nodeId: "b", task: "Do part 2 of the thing", dependsOn: [] },
        { nodeId: "c", task: "Do part 3 of the thing", dependsOn: [] },
        { nodeId: "d", task: "Combine the parts", dependsOn: ["a", "b", "c"] },
      ],
    };

    const m = matchRawGraphToTemplate(rawGraph);
    expect(m.kind).toBe("ambiguous");
    if (m.kind !== "ambiguous") return;
    expect(m.candidates.length).toBeGreaterThanOrEqual(2);
    // The candidates are canonical template names.
    for (const c of m.candidates) {
      expect(["research-fanout", "vote", "map-reduce", "debate"]).toContain(c);
    }
  });

  // -------------------------------------------------------------------------
  // A graph fitting no canonical shape (e.g. a deep linear chain) →
  // no-match (falls through to the existing throw downstream).
  // -------------------------------------------------------------------------
  it("a graph fitting no canonical fan-in shape (linear chain) → no-match", () => {
    const rawGraph = {
      label: "pipeline",
      nodes: [
        { nodeId: "s1", task: "Step one", dependsOn: [] },
        { nodeId: "s2", task: "Step two", dependsOn: ["s1"] },
        { nodeId: "s3", task: "Step three", dependsOn: ["s2"] },
        { nodeId: "s4", task: "Step four", dependsOn: ["s3"] },
        { nodeId: "s5", task: "Step five", dependsOn: ["s4"] },
      ],
    };

    const m = matchRawGraphToTemplate(rawGraph);
    expect(m.kind).toBe("no-match");
  });

  // -------------------------------------------------------------------------
  // Slot values with JSON metacharacters are JSON-escaped (delegated to
  // fillDagTemplate) — the matched graph still parses.
  // -------------------------------------------------------------------------
  it("slot values containing JSON metacharacters are escaped → the matched graph still parses", () => {
    const rawGraph = {
      // A debate topic carrying a double-quote + backslash + newline.
      label: 'ship "v2"\\beta\nnow',
      nodes: [
        { nodeId: "pro", task: 'Argue FOR shipping "v2"\\beta\nnow. Agent: bull', dependsOn: [] },
        { nodeId: "con", task: 'Argue AGAINST shipping "v2"\\beta\nnow. Agent: bear', dependsOn: [] },
        { nodeId: "judge", task: "Moderate and give a verdict", dependsOn: ["pro", "con"] },
      ],
    };

    const m = matchRawGraphToTemplate(rawGraph);
    expect(m.kind).toBe("matched");
    if (m.kind !== "matched") return;
    expect(m.pattern).toBe("debate");
    // Despite the metacharacters in the inferred slot value, the filled graph is
    // valid JSON and parses clean (fillDagTemplate's escaping).
    assertGovernanceClean(m.filledNodes, "debate");
  });

  // -------------------------------------------------------------------------
  // Non-object / malformed input → no-match (never throws — pure fn).
  // -------------------------------------------------------------------------
  it("malformed input (null / no nodes array) → no-match, never throws", () => {
    expect(matchRawGraphToTemplate(null).kind).toBe("no-match");
    expect(matchRawGraphToTemplate({}).kind).toBe("no-match");
    expect(matchRawGraphToTemplate({ nodes: "not-an-array" }).kind).toBe("no-match");
    expect(matchRawGraphToTemplate({ nodes: [] }).kind).toBe("no-match");
  });

  // -------------------------------------------------------------------------
  // The shape-unique `debate` branch must NOT match on shape alone. `debate`
  // is the only 3-node 2+1 template, so a shape-only match would repair ANY
  // 3-node fan-in graph to debate — and fillDagTemplate REPLACES the user's
  // tasks with "Argue FOR/AGAINST..." canonical strings, silently rewriting a
  // genuine 2-way analysis/aggregate intent (not adversarial at all) into a
  // pro/con debate it never asked for. The matcher therefore gates the
  // shape-unique match on a debate keyword hit (corroborating the intent),
  // returning the structured did-you-mean instead of a false synthesis.
  // -------------------------------------------------------------------------
  it("a 3-node fan-in graph whose content is NOT a debate → did-you-mean (NOT a silent debate rewrite)", () => {
    const rawGraph = {
      label: "quarterly revenue analysis",
      nodes: [
        // Two INDEPENDENT analysis tasks feeding an aggregator — a research/
        // aggregate intent, with zero debate/argue/advocate/verdict vocabulary.
        { nodeId: "north", task: "Analyze the North region sales figures", dependsOn: [] },
        { nodeId: "south", task: "Analyze the South region sales figures", dependsOn: [] },
        { nodeId: "rollup", task: "Combine both regional analyses into a single report", dependsOn: ["north", "south"] },
      ],
    };

    const m = matchRawGraphToTemplate(rawGraph);
    // A shape-only matcher would return kind "matched" / pattern "debate" (the
    // false synthesis). The shape is debate-unique but the content does not
    // corroborate, so the matcher returns did-you-mean rather than rewriting
    // the tasks.
    expect(m.kind).toBe("ambiguous");
    if (m.kind !== "ambiguous") return;
    expect(m.candidates).toContain("debate");
  });

  it("a 3-node fan-in graph WITH debate vocabulary still matches debate (no false negative)", () => {
    // The conservatism must not over-correct: a genuinely debate-worded graph
    // (the 2-advocate + fan-in shape) still matches — the keyword corroborates the intent.
    const rawGraph = {
      label: "should we adopt the new framework",
      nodes: [
        { nodeId: "pro", task: "Advocate FOR adopting the framework", dependsOn: [] },
        { nodeId: "con", task: "Advocate AGAINST adopting the framework", dependsOn: [] },
        { nodeId: "mod", task: "Moderate and deliver a balanced verdict", dependsOn: ["pro", "con"] },
      ],
    };

    const m = matchRawGraphToTemplate(rawGraph);
    expect(m.kind).toBe("matched");
    if (m.kind !== "matched") return;
    expect(m.pattern).toBe("debate");
    assertGovernanceClean(m.filledNodes, "debate");
  });
});
