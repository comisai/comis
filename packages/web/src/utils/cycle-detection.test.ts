import { describe, it, expect } from "vitest";
import { wouldCreateCycle } from "./cycle-detection.js";

describe("wouldCreateCycle", () => {
  it("detects self-loop", () => {
    expect(wouldCreateCycle([], "A", "A")).toBe(true);
  });

  it("returns false on empty graph with distinct nodes", () => {
    expect(wouldCreateCycle([], "A", "B")).toBe(false);
  });

  it("detects direct cycle (A->B, adding B->A)", () => {
    const edges = [{ source: "A", target: "B" }];
    expect(wouldCreateCycle(edges, "B", "A")).toBe(true);
  });

  it("detects transitive cycle (A->B->C, adding C->A)", () => {
    const edges = [
      { source: "A", target: "B" },
      { source: "B", target: "C" },
    ];
    expect(wouldCreateCycle(edges, "C", "A")).toBe(true);
  });

  it("returns false for redundant edge that does not create cycle (A->B->C, adding A->C)", () => {
    const edges = [
      { source: "A", target: "B" },
      { source: "B", target: "C" },
    ];
    expect(wouldCreateCycle(edges, "A", "C")).toBe(false);
  });

  it("returns false for disconnected components (A->B, adding C->D)", () => {
    const edges = [{ source: "A", target: "B" }];
    expect(wouldCreateCycle(edges, "C", "D")).toBe(false);
  });

  it("returns false for diamond shape (not a cycle)", () => {
    const edges = [
      { source: "A", target: "B" },
      { source: "A", target: "C" },
      { source: "B", target: "D" },
    ];
    expect(wouldCreateCycle(edges, "C", "D")).toBe(false);
  });
});
