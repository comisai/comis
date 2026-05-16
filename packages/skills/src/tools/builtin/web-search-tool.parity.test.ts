// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { stableStringify } from "../../../../../test/support/stable-stringify.js";
import {
  createWebSearchTool,
  __clearSearchCache,
  __testing,
  type WebSearchConfig,
} from "./web-search-tool.js";

/**
 * Phase 43 parity protection (FILE-SPLIT-11).
 *
 * Locks the byte-identical output of `web-search-tool.ts`'s public-API
 * functions BEFORE the Phase 43 split refactor lands. Post-refactor
 * behavior MUST match these snapshots exactly. Any byte change fails
 * the per-commit gate.
 *
 * Per FILE-SPLIT-17 + OQ-5 (progressive deletion), this file is DELETED
 * in the same commit as the source-file split, once each new module has
 * ≥1 independent behavior test per leaf.
 */

describe("web-search-tool parity (FILE-SPLIT-11)", () => {
  describe("public API surface", () => {
    it("exports the expected named symbols", () => {
      const exports = {
        createWebSearchTool,
        __clearSearchCache,
        __testing,
      };
      expect(stableStringify(Object.keys(exports).sort())).toMatchSnapshot();
    });

    it("__testing: exports the expected helper names", () => {
      expect(stableStringify(Object.keys(__testing).sort())).toMatchSnapshot();
    });
  });

  describe("behavior matrix: representative inputs", () => {
    it("createWebSearchTool: factory returns object with execute method", () => {
      const handle = createWebSearchTool();
      const shape = {
        keys: Object.keys(handle).sort(),
        name: handle.name,
        label: handle.label,
        descriptionType: typeof handle.description,
        executeType: typeof handle.execute,
        hasParameters: handle.parameters !== undefined,
      };
      expect(stableStringify(shape)).toMatchSnapshot();
    });

    it("createWebSearchTool: factory accepts brave provider config", () => {
      const config: WebSearchConfig = { provider: "brave", apiKey: "test-key" };
      const handle = createWebSearchTool(config);
      const shape = {
        keys: Object.keys(handle).sort(),
        name: handle.name,
        label: handle.label,
      };
      expect(stableStringify(shape)).toMatchSnapshot();
    });

    it("createWebSearchTool: factory accepts tavily provider config", () => {
      const config: WebSearchConfig = {
        provider: "tavily",
        tavily: { apiKey: "test-tavily-key" },
      };
      const handle = createWebSearchTool(config);
      const shape = {
        keys: Object.keys(handle).sort(),
        name: handle.name,
        label: handle.label,
      };
      expect(stableStringify(shape)).toMatchSnapshot();
    });

    it("__testing: parseProvider normalizes provider aliases", () => {
      const cases = [
        __testing.parseProvider("brave"),
        __testing.parseProvider("BRAVE"),
        __testing.parseProvider("perplexity"),
        __testing.parseProvider("grok"),
        __testing.parseProvider("ddg"),
        __testing.parseProvider("duckduckgo"),
        __testing.parseProvider("searxng"),
        __testing.parseProvider("tavily"),
        __testing.parseProvider("exa"),
        __testing.parseProvider("jina"),
        __testing.parseProvider("invalid-provider"),
        __testing.parseProvider(undefined),
        __testing.parseProvider(""),
      ];
      expect(stableStringify(cases)).toMatchSnapshot();
    });

    it("__testing: __clearSearchCache hook returns void", () => {
      // Exercise the cache-clear export so we capture its callability.
      const before = typeof __clearSearchCache;
      const result = __clearSearchCache();
      const after = typeof __clearSearchCache;
      expect(
        stableStringify({ before, after, returnValue: result }),
      ).toMatchSnapshot();
    });

    it("__testing: buildProviderChain dedupes and orders correctly", () => {
      const cases = [
        __testing.buildProviderChain("brave", undefined),
        __testing.buildProviderChain("brave", []),
        __testing.buildProviderChain("brave", ["tavily"]),
        __testing.buildProviderChain("brave", ["brave", "tavily", "tavily"]),
        __testing.buildProviderChain("duckduckgo", ["duckduckgo"]),
      ];
      expect(stableStringify(cases)).toMatchSnapshot();
    });

    it("__testing: mapFreshnessToProvider maps shortcuts per provider", () => {
      const cases = {
        brave_pd: __testing.mapFreshnessToProvider("brave", "pd"),
        brave_pw: __testing.mapFreshnessToProvider("brave", "pw"),
        ddg_pm: __testing.mapFreshnessToProvider("duckduckgo", "pm"),
        ddg_py: __testing.mapFreshnessToProvider("duckduckgo", "py"),
        tavily_pd: __testing.mapFreshnessToProvider("tavily", "pd"),
        tavily_py: __testing.mapFreshnessToProvider("tavily", "py"),
        searxng_pd: __testing.mapFreshnessToProvider("searxng", "pd"),
        searxng_pw: __testing.mapFreshnessToProvider("searxng", "pw"),
        searxng_pm: __testing.mapFreshnessToProvider("searxng", "pm"),
        searxng_py: __testing.mapFreshnessToProvider("searxng", "py"),
        perplexity_pd: __testing.mapFreshnessToProvider("perplexity", "pd"),
        grok_pw: __testing.mapFreshnessToProvider("grok", "pw"),
        jina_pm: __testing.mapFreshnessToProvider("jina", "pm"),
      };
      expect(stableStringify(cases)).toMatchSnapshot();
    });

    it("__testing: capSearchResults respects budget and never truncates mid-result", () => {
      const results = [
        { title: "A", url: "https://a.test", description: "AAA" },
        { title: "B", url: "https://b.test", description: "BBB" },
        { title: "C", url: "https://c.test", description: "CCC" },
      ];
      const cases = {
        budget_unlimited: __testing.capSearchResults(results, 1_000_000),
        budget_tight: __testing.capSearchResults(results, 30),
        budget_one: __testing.capSearchResults(results, 1),
        empty: __testing.capSearchResults([], 1_000_000),
      };
      expect(stableStringify(cases)).toMatchSnapshot();
    });
  });
});
