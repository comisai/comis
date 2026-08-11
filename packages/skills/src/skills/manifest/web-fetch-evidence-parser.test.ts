import { describe, expect, it, vi } from "vitest";
import {
  parseMinDistinctWebFetchUrlsDefensively,
  parseMinDistinctWebSearchQueriesDefensively,
} from "./web-fetch-evidence-parser.js";

describe("prompt skill web-fetch evidence parsing", () => {
  it("preserves a bounded distinct URL receipt minimum", () => {
    const warn = vi.fn();

    expect(parseMinDistinctWebFetchUrlsDefensively(3, "research-skill", { warn }))
      .toBe(3);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns and drops an invalid distinct URL receipt minimum", () => {
    const warn = vi.fn();

    expect(parseMinDistinctWebFetchUrlsDefensively(0, "research-skill", { warn }))
      .toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        skillName: "research-skill",
        errorKind: "validation",
        hint: expect.stringContaining("comis.min-distinct-web-fetch-urls"),
      }),
      "Ignoring malformed prompt skill web-fetch evidence metadata",
    );
  });
});

describe("prompt skill web-search evidence parsing", () => {
  it("preserves a bounded distinct query receipt minimum", () => {
    const warn = vi.fn();

    expect(parseMinDistinctWebSearchQueriesDefensively(3, "research-skill", { warn }))
      .toBe(3);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns and drops an invalid distinct query receipt minimum", () => {
    const warn = vi.fn();

    expect(parseMinDistinctWebSearchQueriesDefensively(0, "research-skill", { warn }))
      .toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        skillName: "research-skill",
        errorKind: "validation",
        hint: expect.stringContaining("comis.min-distinct-web-search-queries"),
      }),
      "Ignoring malformed prompt skill web-search evidence metadata",
    );
  });
});
