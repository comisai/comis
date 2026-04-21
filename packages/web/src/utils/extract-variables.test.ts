// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { extractVariables, substituteVariables } from "./extract-variables.js";

describe("extractVariables", () => {
  it("extracts a single variable", () => {
    expect(extractVariables(["Analyze ${TICKER}"])).toEqual(["TICKER"]);
  });

  it("extracts multiple variables sorted alphabetically", () => {
    expect(
      extractVariables(["Compare ${TICKER} vs ${COMPETITOR}"]),
    ).toEqual(["COMPETITOR", "TICKER"]);
  });

  it("deduplicates repeated variables", () => {
    expect(
      extractVariables(["${TICKER} and ${TICKER}"]),
    ).toEqual(["TICKER"]);
  });

  it("ignores {{node.result}} patterns", () => {
    expect(
      extractVariables(["Use {{research.result}} for ${BRAND}"]),
    ).toEqual(["BRAND"]);
  });

  it("returns empty array for no variables", () => {
    expect(extractVariables(["Plain text"])).toEqual([]);
  });

  it("handles mixed variables across multiple strings", () => {
    expect(
      extractVariables(["Do ${A}", "Do ${B} and ${A}"]),
    ).toEqual(["A", "B"]);
  });

  it("handles empty input", () => {
    expect(extractVariables([])).toEqual([]);
  });

  it("handles empty strings", () => {
    expect(extractVariables(["", ""])).toEqual([]);
  });

  it("handles underscore-prefixed variable names", () => {
    expect(extractVariables(["${_PRIVATE}"])).toEqual(["_PRIVATE"]);
  });

  it("handles variables with numbers", () => {
    expect(extractVariables(["${VAR_1} ${VAR_2}"])).toEqual(["VAR_1", "VAR_2"]);
  });

  it("includes all ${VAR} patterns without exclusion", () => {
    const tasks = [
      "Analyze ${TICKER} fundamentals",
      "Review ${fundamental_report} and ${sentiment_report} for ${TICKER}",
    ];
    expect(extractVariables(tasks)).toEqual(["TICKER", "fundamental_report", "sentiment_report"]);
  });
});

describe("substituteVariables", () => {
  it("replaces a single variable", () => {
    expect(
      substituteVariables("Buy ${TICKER}", { TICKER: "AAPL" }),
    ).toBe("Buy AAPL");
  });

  it("replaces multiple occurrences of the same variable", () => {
    expect(
      substituteVariables("${TICKER} is ${TICKER}", { TICKER: "AAPL" }),
    ).toBe("AAPL is AAPL");
  });

  it("replaces multiple different variables", () => {
    expect(
      substituteVariables("${TICKER} vs ${COMPETITOR}", {
        TICKER: "AAPL",
        COMPETITOR: "MSFT",
      }),
    ).toBe("AAPL vs MSFT");
  });

  it("leaves unmatched variables as-is", () => {
    expect(
      substituteVariables("${X} and ${Y}", { X: "hello" }),
    ).toBe("hello and ${Y}");
  });

  it("does not touch {{...}} patterns", () => {
    expect(
      substituteVariables("{{research.result}} for ${BRAND}", {
        BRAND: "Acme",
      }),
    ).toBe("{{research.result}} for Acme");
  });

  it("handles text with no variables", () => {
    expect(
      substituteVariables("Plain text", { TICKER: "AAPL" }),
    ).toBe("Plain text");
  });

  it("handles empty values map", () => {
    expect(
      substituteVariables("${TICKER}", {}),
    ).toBe("${TICKER}");
  });
});
