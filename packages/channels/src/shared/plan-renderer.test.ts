// SPDX-License-Identifier: Apache-2.0
/**
 * plan-renderer tests (plan-state checkboxes).
 *
 * `renderPlan(snapshot)` is a pure function that maps a PlanSnapshot's steps to
 * deterministic checkbox text. An empty plan renders the empty string.
 */
import { describe, it, expect } from "vitest";
import type { PlanSnapshot } from "@comis/core";
import { renderPlan } from "./plan-renderer.js";

describe("renderPlan", () => {
  it("renders one checkbox line per step mapping each status to a glyph", () => {
    const snapshot: PlanSnapshot = {
      entries: [
        { id: "1", label: "Fetch logs", status: "done" },
        { id: "2", label: "Identify failing test", status: "in_progress" },
        { id: "3", label: "Read source", status: "pending" },
        { id: "4", label: "Propose fix", status: "skipped" },
      ],
    };
    const out = renderPlan(snapshot);
    const lines = out.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe("[x] Fetch logs");
    expect(lines[1]).toBe("[~] Identify failing test");
    expect(lines[2]).toBe("[ ] Read source");
    expect(lines[3]).toBe("[-] Propose fix");
  });

  it("is deterministic — the same snapshot renders identical output", () => {
    const snapshot: PlanSnapshot = {
      entries: [
        { id: "a", label: "Step A", status: "done" },
        { id: "b", label: "Step B", status: "pending" },
      ],
    };
    expect(renderPlan(snapshot)).toBe(renderPlan(snapshot));
  });

  it("renders an empty string for a plan with no entries", () => {
    const snapshot: PlanSnapshot = { entries: [] };
    expect(renderPlan(snapshot)).toBe("");
  });

  it("preserves entry order", () => {
    const snapshot: PlanSnapshot = {
      entries: [
        { id: "z", label: "Last-ish", status: "pending" },
        { id: "a", label: "First-ish", status: "done" },
      ],
    };
    const lines = renderPlan(snapshot).split("\n");
    expect(lines[0]).toBe("[ ] Last-ish");
    expect(lines[1]).toBe("[x] First-ish");
  });

  it("falls back to an empty checkbox for an out-of-union status (exhaustive default)", () => {
    // The typed union forbids this; the `never` default is the AGENTS.md §2.8
    // safety arm. Cast through `unknown` (the house pattern) to exercise it.
    const snapshot = {
      entries: [{ id: "1", label: "Bogus", status: "__bogus__" }],
    } as unknown as PlanSnapshot;
    expect(renderPlan(snapshot)).toBe("[ ] Bogus");
  });
});
