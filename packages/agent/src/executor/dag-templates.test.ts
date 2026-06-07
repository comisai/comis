// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  CANONICAL_DAG_TEMPLATES,
  fillDagTemplate,
} from "./dag-templates.js";
import { parseExecutionGraph, validateAndSortGraph } from "@comis/core";

// ---------------------------------------------------------------------------
// O2: fillDagTemplate
// ---------------------------------------------------------------------------

describe("fillDagTemplate", () => {
  it("Case 1 (fill): replaces ${TOPIC} slots in research-fanout template with provided value", () => {
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

  it("Case 2 (unresolved slot): missing TOPIC var returns err with slot name", () => {
    const result = fillDagTemplate(CANONICAL_DAG_TEMPLATES["research-fanout"], {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/Unresolved template slots remain/i);
      expect(result.error).toContain("TOPIC");
    }
  });

  it("Case 3 (validation): all 4 canonical templates fill with minimal vars and produce valid graphs", () => {
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
