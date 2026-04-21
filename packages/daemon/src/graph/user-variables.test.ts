// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  extractUserVariables,
  substituteUserVariables,
  escapeTemplatePatterns,
} from "./user-variables.js";

// ---------------------------------------------------------------------------
// extractUserVariables
// ---------------------------------------------------------------------------

describe("extractUserVariables", () => {
  it("extracts a single variable", () => {
    expect(extractUserVariables([{ task: "Analyze ${TICKER}" }])).toEqual([
      "TICKER",
    ]);
  });

  it("extracts multiple variables sorted alphabetically", () => {
    expect(
      extractUserVariables([
        { task: "Compare ${TICKER} vs ${COMPETITOR}" },
      ]),
    ).toEqual(["COMPETITOR", "TICKER"]);
  });

  it("deduplicates repeated variables", () => {
    expect(
      extractUserVariables([{ task: "${TICKER} and ${TICKER}" }]),
    ).toEqual(["TICKER"]);
  });

  it("ignores {{nodeId.result}} patterns", () => {
    expect(
      extractUserVariables([
        { task: "Use {{research.result}} for ${BRAND}" },
      ]),
    ).toEqual(["BRAND"]);
  });

  it("returns empty array when no variables found", () => {
    expect(extractUserVariables([{ task: "Plain text" }])).toEqual([]);
  });

  it("returns empty array for empty input", () => {
    expect(extractUserVariables([])).toEqual([]);
  });

  it("handles underscore-prefixed variable names", () => {
    expect(extractUserVariables([{ task: "${_PRIVATE}" }])).toEqual([
      "_PRIVATE",
    ]);
  });

  it("handles variables with numbers", () => {
    expect(
      extractUserVariables([{ task: "${VAR_1} ${VAR_2}" }]),
    ).toEqual(["VAR_1", "VAR_2"]);
  });

  it("collects variables across multiple nodes", () => {
    expect(
      extractUserVariables([
        { task: "Do ${A}" },
        { task: "Do ${B} and ${A}" },
      ]),
    ).toEqual(["A", "B"]);
  });
});

// ---------------------------------------------------------------------------
// substituteUserVariables
// ---------------------------------------------------------------------------

describe("substituteUserVariables", () => {
  it("replaces a single variable", () => {
    expect(
      substituteUserVariables("Buy ${TICKER}", { TICKER: "AAPL" }),
    ).toBe("Buy AAPL");
  });

  it("replaces multiple occurrences of the same variable", () => {
    expect(
      substituteUserVariables("${TICKER} is ${TICKER}", { TICKER: "AAPL" }),
    ).toBe("AAPL is AAPL");
  });

  it("replaces multiple different variables", () => {
    expect(
      substituteUserVariables("${TICKER} vs ${COMPETITOR}", {
        TICKER: "AAPL",
        COMPETITOR: "MSFT",
      }),
    ).toBe("AAPL vs MSFT");
  });

  it("leaves unmatched variables as-is", () => {
    expect(
      substituteUserVariables("${X} and ${Y}", { X: "hello" }),
    ).toBe("hello and ${Y}");
  });

  it("does not touch {{...}} patterns", () => {
    expect(
      substituteUserVariables("{{research.result}} for ${BRAND}", {
        BRAND: "Acme",
      }),
    ).toBe("{{research.result}} for Acme");
  });

  it("handles empty variables map", () => {
    expect(substituteUserVariables("${TICKER}", {})).toBe("${TICKER}");
  });
});

// ---------------------------------------------------------------------------
// escapeTemplatePatterns
// ---------------------------------------------------------------------------

describe("escapeTemplatePatterns", () => {
  it("replaces {{ with {\\u200B{", () => {
    expect(escapeTemplatePatterns("{{analyzer.result}}")).toBe(
      "{\u200B{analyzer.result}}",
    );
  });

  it("leaves ${...} untouched", () => {
    expect(escapeTemplatePatterns("${TICKER}")).toBe("${TICKER}");
  });

  it("handles empty string", () => {
    expect(escapeTemplatePatterns("")).toBe("");
  });

  it("handles multiple {{ occurrences", () => {
    expect(
      escapeTemplatePatterns("{{a.result}} and {{b.result}}"),
    ).toBe("{\u200B{a.result}} and {\u200B{b.result}}");
  });
});

// ---------------------------------------------------------------------------
// Integration: substitution + escaping prevents template injection
// ---------------------------------------------------------------------------

describe("template injection prevention", () => {
  it("substituted value containing {{nodeId.result}} does NOT match template regex", () => {
    const text = substituteUserVariables("Input: ${INPUT}", {
      INPUT: "{{analyzer.result}}",
    });

    // The template interpolation regex from template-interpolation.ts
    const templateRe = /\{\{([\w-]+)\.result\}\}/g;
    expect(templateRe.test(text)).toBe(false);
  });

  it("substituted value is visually intact but regex-safe", () => {
    const text = substituteUserVariables("Use ${DATA}", {
      DATA: "See {{secret.result}} for details",
    });

    // Contains the zero-width space escape
    expect(text).toContain("{\u200B{secret.result}}");
    // Does NOT match the template regex
    const templateRe = /\{\{([\w-]+)\.result\}\}/g;
    expect(templateRe.test(text)).toBe(false);
  });
});
