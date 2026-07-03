// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  CANONICAL_DAG_TEMPLATES,
  fillDagTemplate,
  seedDefaultDagTemplates,
} from "./dag-templates.js";
import type { NamedGraphStoreLike } from "./dag-templates.js";
import { parseExecutionGraph, validateAndSortGraph } from "@comis/core";

// ---------------------------------------------------------------------------
// fillDagTemplate
// ---------------------------------------------------------------------------

describe("fillDagTemplate", () => {
  it("replaces ${TOPIC} slots in research-fanout template with the provided value", () => {
    const result = fillDagTemplate(CANONICAL_DAG_TEMPLATES["research-fanout"], {
      TOPIC: "climate",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // All ${TOPIC} occurrences must be replaced with "climate"
    const filledJson = JSON.stringify(result.value);
    expect(filledJson).not.toContain("${TOPIC}");
    expect(filledJson).toContain("climate");
  });

  it("missing TOPIC var returns err naming the unresolved slot", () => {
    const result = fillDagTemplate(CANONICAL_DAG_TEMPLATES["research-fanout"], {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/Unresolved template slots remain/i);
      expect(result.error).toContain("TOPIC");
    }
  });

  it("slot value with double-quote and backslash returns ok with value intact, never throws", () => {
    // Weak models can supply values containing JSON metacharacters. Raw
    // substitution into the serialized JSON string would corrupt structure and
    // throw a SyntaxError out of this Result-returning function.
    const topic = 'the "best" plan \\ with a backslash';

    // Must NOT throw — the function returns a Result.
    const result = fillDagTemplate(CANONICAL_DAG_TEMPLATES["research-fanout"], {
      TOPIC: topic,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The value must be placed verbatim into the task strings (no corruption).
    const synthesize = result.value.find((n) => n.nodeId === "synthesize");
    expect(synthesize).toBeDefined();
    expect(synthesize!.task).toContain(topic);

    // No ${VAR} placeholder should remain.
    expect(JSON.stringify(result.value)).not.toContain("${TOPIC}");
  });

  it("multi-line quoted slot value parses cleanly without throwing", () => {
    const value = 'line1\n"quoted" line2';
    const result = fillDagTemplate(CANONICAL_DAG_TEMPLATES.debate, {
      TOPIC: value,
      PRO_AGENT: "agent-a",
      CON_AGENT: "agent-b",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const pro = result.value.find((n) => n.nodeId === "pro-advocate");
    expect(pro).toBeDefined();
    expect(pro!.task).toContain(value);
  });

  it("all 4 canonical templates fill with minimal vars and produce valid graphs", () => {
    const minimalVars: Record<string, Record<string, string>> = {
      "research-fanout": { TOPIC: "test-topic" },
      debate: { TOPIC: "test-topic", PRO_AGENT: "agent-a", CON_AGENT: "agent-b" },
      vote: { TOPIC: "test-topic", VOTERS: "voter-1,voter-2" },
      "map-reduce": { TASK: "test-task", MAPPERS: "mapper-1,mapper-2" },
    };

    for (const [key, vars] of Object.entries(minimalVars)) {
      const template = CANONICAL_DAG_TEMPLATES[key];
      expect(template).toBeDefined();

      const fillResult = fillDagTemplate(template, vars);
      expect(fillResult.ok).toBe(true);
      if (!fillResult.ok) continue;

      const graphRaw = { nodes: fillResult.value };
      const parseResult = parseExecutionGraph(graphRaw);
      expect(parseResult.ok).toBe(true);
      if (!parseResult.ok) continue;

      const validateResult = validateAndSortGraph(parseResult.value);
      expect(validateResult.ok).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// seedDefaultDagTemplates — wired into daemon boot (idempotent)
// ---------------------------------------------------------------------------

describe("seedDefaultDagTemplates", () => {
  /** Minimal in-memory NamedGraphStore double recording save() calls. */
  function makeFakeStore(opts: { throwOnDuplicate?: boolean } = {}): {
    store: NamedGraphStoreLike;
    saved: Array<{ id: string; label: string }>;
  } {
    const saved: Array<{ id: string; label: string }> = [];
    const seenIds = new Set<string>();
    const store: NamedGraphStoreLike = {
      save(entry) {
        if (opts.throwOnDuplicate && seenIds.has(entry.id)) {
          // Mimic a UNIQUE-constraint failure on duplicate id (INSERT-OR-IGNORE).
          throw new Error(`UNIQUE constraint failed: ${entry.id}`);
        }
        seenIds.add(entry.id);
        saved.push({ id: entry.id, label: entry.label });
        return entry.id;
      },
    };
    return { store, saved };
  }

  it("seeds all four canonical templates with system-template- ids and isTemplate settings", () => {
    const { store, saved } = makeFakeStore();
    seedDefaultDagTemplates(store);

    const expectedKeys = Object.keys(CANONICAL_DAG_TEMPLATES);
    expect(saved.length).toBe(expectedKeys.length);
    for (const key of expectedKeys) {
      expect(saved.some((s) => s.id === `system-template-${key}`)).toBe(true);
    }
  });

  it("is idempotent: a duplicate-key throw on re-seed is swallowed (INSERT-OR-IGNORE)", () => {
    const { store, saved } = makeFakeStore({ throwOnDuplicate: true });

    seedDefaultDagTemplates(store);
    const afterFirst = saved.length;
    expect(afterFirst).toBe(Object.keys(CANONICAL_DAG_TEMPLATES).length);

    // Second seed: every save() now throws on duplicate id — must not propagate.
    expect(() => seedDefaultDagTemplates(store)).not.toThrow();
    // No new rows recorded (all duplicates were ignored).
    expect(saved.length).toBe(afterFirst);
  });
});
