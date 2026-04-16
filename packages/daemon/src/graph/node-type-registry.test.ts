import { describe, it, expect } from "vitest";
import { createNodeTypeRegistry } from "./node-type-registry.js";

// ---------------------------------------------------------------------------
// createNodeTypeRegistry
// ---------------------------------------------------------------------------

describe("createNodeTypeRegistry", () => {
  const registry = createNodeTypeRegistry();

  const ALL_TYPE_IDS = [
    "agent", "debate", "vote", "refine",
    "collaborate", "approval-gate", "map-reduce",
  ];

  // -- get -----------------------------------------------------------------

  it("get returns a defined driver for all 7 typeIds", () => {
    for (const typeId of ALL_TYPE_IDS) {
      expect(registry.get(typeId)).toBeDefined();
    }
  });

  it("each returned driver has typeId matching the lookup key", () => {
    for (const typeId of ALL_TYPE_IDS) {
      expect(registry.get(typeId)!.typeId).toBe(typeId);
    }
  });

  it('get("nonexistent") returns undefined', () => {
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  // -- list ----------------------------------------------------------------

  it("list returns array of length 7", () => {
    expect(registry.list()).toHaveLength(7);
  });

  it("list includes all 7 typeIds", () => {
    const typeIds = registry.list().map((d) => d.typeId);
    for (const typeId of ALL_TYPE_IDS) {
      expect(typeIds).toContain(typeId);
    }
  });

  // -- validateConfig ------------------------------------------------------

  it('validateConfig("agent", {agent: "a"}) returns empty array (valid)', () => {
    expect(registry.validateConfig("agent", { agent: "a" })).toEqual([]);
  });

  it('validateConfig("debate", {agents: ["a","b"]}) returns empty array (valid, rounds defaults)', () => {
    expect(registry.validateConfig("debate", { agents: ["a", "b"] })).toEqual([]);
  });

  it('validateConfig("agent", {}) returns array with 1+ error about "agent"', () => {
    const errors = registry.validateConfig("agent", {});
    expect(errors.length).toBeGreaterThanOrEqual(1);
    const joined = errors.join(" ");
    expect(joined.toLowerCase()).toContain("agent");
  });

  it('validateConfig("debate", {agents: "not-array"}) returns errors', () => {
    const errors = registry.validateConfig("debate", { agents: "not-array" });
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  it('validateConfig("nonexistent", {}) returns unknown type error', () => {
    expect(registry.validateConfig("nonexistent", {})).toEqual([
      "Unknown node type: nonexistent",
    ]);
  });

  it("validateConfig error strings include the field path", () => {
    // agent requires "agent" field; error path should reference it
    const errors = registry.validateConfig("agent", {});
    expect(errors.some((e) => e.includes("agent"))).toBe(true);
  });
});
