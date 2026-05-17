// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { findStronglyConnectedComponents, findCycles } from "./tarjan-scc.js";

describe("findCycles -- Tarjan SCC", () => {
  it("non-cyclic DAG: A → B → C returns no cycles", () => {
    const nodes = new Set(["A", "B", "C"]);
    const edges = new Map<string, ReadonlySet<string>>([
      ["A", new Set(["B"])],
      ["B", new Set(["C"])],
      ["C", new Set()],
    ]);
    expect(findCycles(nodes, edges), "DAG must have zero cycles").toEqual([]);
  });

  it("simple two-node cycle: A → B → A returns the cycle", () => {
    const nodes = new Set(["A", "B"]);
    const edges = new Map<string, ReadonlySet<string>>([
      ["A", new Set(["B"])],
      ["B", new Set(["A"])],
    ]);
    const cycles = findCycles(nodes, edges);
    expect(cycles.length).toBe(1);
    expect(new Set(cycles[0])).toEqual(new Set(["A", "B"]));
  });

  it("three-node cycle: A → B → C → A returns the cycle", () => {
    const nodes = new Set(["A", "B", "C"]);
    const edges = new Map<string, ReadonlySet<string>>([
      ["A", new Set(["B"])],
      ["B", new Set(["C"])],
      ["C", new Set(["A"])],
    ]);
    const cycles = findCycles(nodes, edges);
    expect(cycles.length).toBe(1);
    expect(new Set(cycles[0])).toEqual(new Set(["A", "B", "C"]));
  });

  it("self-loop: A → A is detected as a cycle", () => {
    const nodes = new Set(["A"]);
    const edges = new Map<string, ReadonlySet<string>>([
      ["A", new Set(["A"])],
    ]);
    const cycles = findCycles(nodes, edges);
    expect(cycles.length, "self-loop must be reported").toBe(1);
    expect(cycles[0]).toEqual(["A"]);
  });

  it("non-self-loop singleton: A → (none) is NOT a cycle", () => {
    const nodes = new Set(["A"]);
    const edges = new Map<string, ReadonlySet<string>>([
      ["A", new Set()],
    ]);
    expect(findCycles(nodes, edges)).toEqual([]);
  });

  it("disconnected components: cycle in one + DAG in another", () => {
    const nodes = new Set(["A", "B", "C", "D"]);
    const edges = new Map<string, ReadonlySet<string>>([
      ["A", new Set(["B"])],
      ["B", new Set(["A"])],
      ["C", new Set(["D"])],
      ["D", new Set()],
    ]);
    const cycles = findCycles(nodes, edges);
    expect(cycles.length).toBe(1);
    expect(new Set(cycles[0])).toEqual(new Set(["A", "B"]));
  });

  it("findStronglyConnectedComponents includes single-node SCCs (without self-loop)", () => {
    const nodes = new Set(["A", "B"]);
    const edges = new Map<string, ReadonlySet<string>>([
      ["A", new Set(["B"])],
      ["B", new Set()],
    ]);
    const sccs = findStronglyConnectedComponents(nodes, edges);
    expect(sccs.length, "every node belongs to at least one SCC (singleton or larger)").toBe(2);
  });
});
