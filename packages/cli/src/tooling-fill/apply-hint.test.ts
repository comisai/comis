// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for tooling-fill/apply-hint.ts — leaf-key AST mutator.
 *
 * Validates TOOLFILL-6 (strict scope: only description + replacesPackages
 * are touched), TOOLFILL-9 (atomic / idempotent — same input twice produces
 * byte-identical output), and TOOLFILL-11 (skill hints are first-class,
 * symmetrical with mcp).
 *
 * Snapshots use `doc.toString()` (AST stringification) — same convention as
 * Phase 25's generate.test.ts.
 */

import { describe, it, expect } from "vitest";
import { parseDocument } from "yaml";
import { setHintFields, type FillKind } from "./apply-hint.js";

// ---------------------------------------------------------------------------
// Inline fixture — self-contained per the plan's test contract. Mirrors the
// shape of Phase 25's config-with-tooling.yaml fixture but stripped to the
// keys this mutator touches plus comments + sibling sections we must NOT
// touch.
// ---------------------------------------------------------------------------

const FIXTURE_YAML = `integrations:
  mcp:
    servers:
      - name: yfinance
        transport: stdio
        command: uvx
        args: ["yfinance-mcp@latest"]
tooling:
  mcp:
    capabilityHints:
      placeholder-mcp:
        cluster: external-integrations
        description: TODO
        replacesPackages: []
      # operator note above yfinance — must survive
      yfinance:
        cluster: data-fetching-financial
        description: TODO
        # TODO: list packages this MCP/skill replaces
        replacesPackages: []
  skills:
    capabilityHints:
      stub-skill:
        cluster: prompt-skills
        description: TODO
        replacesPackages: []
`;

// ---------------------------------------------------------------------------
// Test 1: happy path — mcp hint
// ---------------------------------------------------------------------------

describe("setHintFields — happy path", () => {
  it("Test 1: mcp hint — updates description + replacesPackages", () => {
    const doc = parseDocument(FIXTURE_YAML);
    const result = setHintFields(doc, "mcp", "yfinance", {
      description: "Yahoo Finance MCP",
      replacesPackages: ["yfinance", "yahoo-finance2"],
    });
    expect(result.ok).toBe(true);
    const out = doc.toString();
    expect(out).toContain("description: Yahoo Finance MCP");
    // Block-style is yaml@2.8.4's default for non-empty arrays.
    expect(out).toContain("- yfinance");
    expect(out).toContain("- yahoo-finance2");
  });

  it("Test 2: skill hint — TOOLFILL-11 symmetry with mcp", () => {
    const doc = parseDocument(FIXTURE_YAML);
    const result = setHintFields(doc, "skills", "stub-skill", {
      description: "Stub skill description",
      replacesPackages: ["prettier", "markdownlint"],
    });
    expect(result.ok).toBe(true);
    const out = doc.toString();
    expect(out).toContain("description: Stub skill description");
    expect(out).toContain("- prettier");
    expect(out).toContain("- markdownlint");
  });
});

// ---------------------------------------------------------------------------
// Tests 3-5: TOOLFILL-6 strict scope — sibling preservation
// ---------------------------------------------------------------------------

describe("setHintFields — TOOLFILL-6 strict scope (siblings preserved)", () => {
  it("Test 3: cluster on the targeted hint is preserved verbatim", () => {
    const doc = parseDocument(FIXTURE_YAML);
    setHintFields(doc, "mcp", "yfinance", {
      description: "Yahoo Finance MCP",
      replacesPackages: ["yfinance"],
    });
    const out = doc.toString();
    expect(out).toContain("cluster: data-fetching-financial");
  });

  it("Test 4: sibling hint (placeholder-mcp) is byte-identical pre/post", () => {
    const doc = parseDocument(FIXTURE_YAML);
    // Capture the placeholder-mcp block from the original.
    const placeholderBlockBefore = extractBlock(
      FIXTURE_YAML,
      "      placeholder-mcp:",
      "      # operator note above yfinance — must survive",
    );
    setHintFields(doc, "mcp", "yfinance", {
      description: "Yahoo Finance MCP",
      replacesPackages: ["yfinance", "yahoo-finance2"],
    });
    const out = doc.toString();
    const placeholderBlockAfter = extractBlock(
      out,
      "      placeholder-mcp:",
      "      # operator note above yfinance — must survive",
    );
    expect(placeholderBlockAfter).toBe(placeholderBlockBefore);
    expect(placeholderBlockAfter).toContain("cluster: external-integrations");
    expect(placeholderBlockAfter).toContain("description: TODO");
    expect(placeholderBlockAfter).toContain("replacesPackages: []");
  });

  it("Test 5: non-tooling section (integrations:) is byte-identical pre/post", () => {
    const doc = parseDocument(FIXTURE_YAML);
    const integrationsBefore = extractBlock(FIXTURE_YAML, "integrations:", "tooling:");
    setHintFields(doc, "mcp", "yfinance", {
      description: "Yahoo Finance MCP",
      replacesPackages: ["yfinance"],
    });
    const out = doc.toString();
    const integrationsAfter = extractBlock(out, "integrations:", "tooling:");
    expect(integrationsAfter).toBe(integrationsBefore);
  });
});

// ---------------------------------------------------------------------------
// Tests 6-7: comment preservation
// ---------------------------------------------------------------------------

describe("setHintFields — commentBefore preservation", () => {
  it("Test 6: commentBefore on the hint key (yfinance) is preserved at the same position", () => {
    const doc = parseDocument(FIXTURE_YAML);
    setHintFields(doc, "mcp", "yfinance", {
      description: "Yahoo Finance MCP",
      replacesPackages: ["yfinance"],
    });
    const out = doc.toString();
    expect(out).toContain("# operator note above yfinance — must survive");
    // Position check — comment is immediately above the yfinance: key.
    const commentIdx = out.indexOf("# operator note above yfinance");
    const yfinanceIdx = out.indexOf("      yfinance:", commentIdx);
    expect(commentIdx).toBeGreaterThan(-1);
    expect(yfinanceIdx).toBeGreaterThan(commentIdx);
    // No other key intervenes between the comment and yfinance:.
    const between = out.slice(commentIdx, yfinanceIdx);
    expect(between).not.toMatch(/^\s+\w+:/m);
  });

  it("Test 7: commentBefore on replacesPackages (# TODO: list packages this MCP/skill replaces) is preserved when the value is replaced with a non-empty array", () => {
    const doc = parseDocument(FIXTURE_YAML);
    setHintFields(doc, "mcp", "yfinance", {
      description: "Yahoo Finance MCP",
      replacesPackages: ["yfinance", "yahoo-finance2"],
    });
    const out = doc.toString();
    // Acceptance criterion: explicit grep for the literal comment string.
    expect(out).toContain("# TODO: list packages this MCP/skill replaces");
    // And the comment is immediately above the (now-populated) replacesPackages block.
    const commentIdx = out.indexOf("# TODO: list packages this MCP/skill replaces");
    const replacesIdx = out.indexOf("replacesPackages:", commentIdx);
    expect(commentIdx).toBeGreaterThan(-1);
    expect(replacesIdx).toBeGreaterThan(commentIdx);
    // After the comment + replacesPackages line, the array items follow as block-style.
    const after = out.slice(replacesIdx);
    expect(after).toMatch(/replacesPackages:\s*\n\s+- yfinance\s*\n\s+- yahoo-finance2/);
  });
});

// ---------------------------------------------------------------------------
// Tests 8-9: hint-not-found
// ---------------------------------------------------------------------------

describe("setHintFields — hint-not-found", () => {
  it("Test 8: missing hint returns err({kind:'hint-not-found', path}); doc unmutated", () => {
    const doc = parseDocument(FIXTURE_YAML);
    const before = doc.toString();
    const result = setHintFields(doc, "mcp", "nonexistent-mcp", {
      description: "should not be written",
      replacesPackages: ["should-not-appear"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("hint-not-found");
      expect(result.error.path).toBe("tooling.mcp.capabilityHints.nonexistent-mcp");
    }
    // doc is byte-identical post-call — failure path is non-mutating.
    expect(doc.toString()).toBe(before);
  });

  it("Test 9: missing parent map (no tooling.skills.capabilityHints) → hint-not-found", () => {
    const yamlNoSkills = `tooling:
  mcp:
    capabilityHints:
      placeholder-mcp:
        cluster: external-integrations
        description: TODO
        replacesPackages: []
`;
    const doc = parseDocument(yamlNoSkills);
    const before = doc.toString();
    const result = setHintFields(doc, "skills", "anything", {
      description: "x",
      replacesPackages: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("hint-not-found");
      expect(result.error.path).toBe("tooling.skills.capabilityHints.anything");
    }
    expect(doc.toString()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Test 10: idempotency (TOOLFILL-9 atomic-edit semantics)
// ---------------------------------------------------------------------------

describe("setHintFields — TOOLFILL-9 idempotency", () => {
  it("Test 10: same input twice produces byte-identical output", () => {
    const doc1 = parseDocument(FIXTURE_YAML);
    setHintFields(doc1, "mcp", "yfinance", {
      description: "Yahoo Finance MCP",
      replacesPackages: ["yfinance", "yahoo-finance2"],
    });
    const out1 = doc1.toString();

    // Apply same fields a second time on a fresh parse.
    const doc2 = parseDocument(FIXTURE_YAML);
    setHintFields(doc2, "mcp", "yfinance", {
      description: "Yahoo Finance MCP",
      replacesPackages: ["yfinance", "yahoo-finance2"],
    });
    const out2 = doc2.toString();
    expect(out2).toBe(out1);

    // Apply same fields to an already-filled doc — byte-identical.
    setHintFields(doc1, "mcp", "yfinance", {
      description: "Yahoo Finance MCP",
      replacesPackages: ["yfinance", "yahoo-finance2"],
    });
    expect(doc1.toString()).toBe(out1);
  });
});

// ---------------------------------------------------------------------------
// Tests 11-12: runtime guards
// ---------------------------------------------------------------------------

describe("setHintFields — runtime guards", () => {
  it("Test 11: invalid kind (cast around) returns err({kind:'invalid-kind'})", () => {
    const doc = parseDocument(FIXTURE_YAML);
    const result = setHintFields(
      doc,
      "bogus" as unknown as FillKind,
      "yfinance",
      { description: "x", replacesPackages: [] },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("invalid-kind");
    }
  });

  it("Test 12: empty document (doc.contents === null) returns err({kind:'doc-corrupt'})", () => {
    const doc = parseDocument("");
    const result = setHintFields(doc, "mcp", "anything", {
      description: "x",
      replacesPackages: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("doc-corrupt");
    }
  });
});

// ---------------------------------------------------------------------------
// Tests 13-14: replacesPackages serialization + roundtrip
// ---------------------------------------------------------------------------

describe("setHintFields — replacesPackages serialization", () => {
  it("Test 13: empty replacesPackages array stays empty (yaml emits flow [])", () => {
    const doc = parseDocument(FIXTURE_YAML);
    const result = setHintFields(doc, "mcp", "yfinance", {
      description: "Yahoo Finance MCP",
      replacesPackages: [],
    });
    expect(result.ok).toBe(true);
    const out = doc.toString();
    // yaml@2.8.4 emits empty arrays as flow-style `[]` by default.
    expect(out).toMatch(/yfinance:[\s\S]*?replacesPackages: \[\]/);
  });

  it("Test 14: round-trip via parseDocument — re-parsed doc has the new values", () => {
    const doc = parseDocument(FIXTURE_YAML);
    setHintFields(doc, "mcp", "yfinance", {
      description: "Yahoo Finance market prices, history, fundamentals",
      replacesPackages: ["yfinance", "yahoo-finance2"],
    });
    const reparsed = parseDocument(doc.toString());
    const desc = reparsed.getIn(["tooling", "mcp", "capabilityHints", "yfinance", "description"]);
    const rp = reparsed.getIn(["tooling", "mcp", "capabilityHints", "yfinance", "replacesPackages"]);
    expect(desc).toBe("Yahoo Finance market prices, history, fundamentals");
    // getIn (without keepScalar=true) returns a YAMLSeq for arrays — toJSON() unwraps.
    expect((rp as { toJSON(): unknown }).toJSON()).toEqual(["yfinance", "yahoo-finance2"]);
  });
});

// ---------------------------------------------------------------------------
// Bonus: T-26-11 mitigation — description containing YAML metacharacters
// ---------------------------------------------------------------------------

describe("setHintFields — T-26-11 metacharacter quoting", () => {
  it("description containing ':' and ',' is auto-quoted by yaml@2.8.4", () => {
    const doc = parseDocument(FIXTURE_YAML);
    setHintFields(doc, "mcp", "yfinance", {
      description: "Yahoo Finance: prices, history, fundamentals",
      replacesPackages: ["yfinance"],
    });
    const out = doc.toString();
    // yaml@2.8.4 auto-quotes when colon-followed-by-space appears in the value.
    expect(out).toContain('description: "Yahoo Finance: prices, history, fundamentals"');
    // Re-parsing yields the original string (no double-escape).
    const reparsed = parseDocument(out);
    expect(reparsed.getIn(["tooling", "mcp", "capabilityHints", "yfinance", "description"])).toBe(
      "Yahoo Finance: prices, history, fundamentals",
    );
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the substring between two literal anchors, inclusive of `start` and
 * exclusive of `end`. Used to assert byte-identity of unmodified sections.
 */
function extractBlock(text: string, start: string, end: string): string {
  const startIdx = text.indexOf(start);
  const endIdx = text.indexOf(end, startIdx + start.length);
  if (startIdx < 0 || endIdx < 0) {
    throw new Error(
      `extractBlock: anchor not found (start="${start}" startIdx=${startIdx} end="${end}" endIdx=${endIdx})`,
    );
  }
  return text.slice(startIdx, endIdx);
}
