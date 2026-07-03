// SPDX-License-Identifier: Apache-2.0
/**
 * Stage-A unit tests for the WEB config builders.
 *
 * These are pure object builders — no daemon, no key, no network — so the whole
 * file runs unconditionally (no COMIS_LIVE gate). They assert that:
 *   - buildWebSearchConfig emits a real WebSearchConfig with the per-provider
 *     API-key field placed correctly (apiKey for brave; <provider>.apiKey for
 *     tavily/exa/perplexity/grok/jina; searxng.baseUrl; duckduckgo:{});
 *   - buildLinkConfig emits a real LinkUnderstandingConfig with an overridable enabled flag;
 *   - buildDocExtractionConfig emits a real FileExtractionConfig (schema defaults) with
 *     overridable maxChars + pdfImageFallback;
 *   - the provider / keyless / credential-category constants are the single source of
 *     truth for the WEB-01 scenario's key-gating and match credentials.ts.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import {
  buildWebSearchConfig,
  buildLinkConfig,
  buildDocExtractionConfig,
  WEB_SEARCH_PROVIDERS,
  SEARCH_KEYLESS,
  SEARCH_KEY_CATEGORY,
  type WebSearchProvider,
} from "./web-config.js";

describe("WEB_SEARCH_PROVIDERS / SEARCH_KEYLESS / SEARCH_KEY_CATEGORY constants", () => {
  it("WEB_SEARCH_PROVIDERS is exactly the 8 supported providers", () => {
    expect([...WEB_SEARCH_PROVIDERS]).toEqual([
      "brave",
      "tavily",
      "duckduckgo",
      "searxng",
      "exa",
      "grok",
      "perplexity",
      "jina",
    ]);
  });

  it("SEARCH_KEYLESS is exactly {duckduckgo, searxng} and both are in WEB_SEARCH_PROVIDERS", () => {
    expect([...SEARCH_KEYLESS]).toEqual(["duckduckgo", "searxng"]);
    for (const p of SEARCH_KEYLESS) {
      expect(WEB_SEARCH_PROVIDERS).toContain(p);
    }
  });

  it("SEARCH_KEY_CATEGORY maps every keyed provider to its registry category string", () => {
    expect(SEARCH_KEY_CATEGORY.brave).toBe("search(brave)");
    expect(SEARCH_KEY_CATEGORY.tavily).toBe("search(tavily)");
    expect(SEARCH_KEY_CATEGORY.exa).toBe("search(exa)");
    expect(SEARCH_KEY_CATEGORY.perplexity).toBe("search(perplexity)");
    expect(SEARCH_KEY_CATEGORY.grok).toBe("search(grok)");
    expect(SEARCH_KEY_CATEGORY.jina).toBe("search(jina)");
    // no entry for the keyless providers
    expect((SEARCH_KEY_CATEGORY as Record<string, string>).duckduckgo).toBeUndefined();
    expect((SEARCH_KEY_CATEGORY as Record<string, string>).searxng).toBeUndefined();
  });
});

describe("buildWebSearchConfig", () => {
  it("returns a config whose provider equals the requested provider for ALL 8 providers (no throw)", () => {
    for (const p of WEB_SEARCH_PROVIDERS) {
      const cfg = buildWebSearchConfig(p);
      expect(cfg.provider).toBe(p);
    }
  });

  it("brave places the key at the top-level apiKey field", () => {
    const cfg = buildWebSearchConfig("brave", { apiKey: "bsa-test" });
    expect(cfg).toMatchObject({ provider: "brave", apiKey: "bsa-test" });
  });

  it("tavily/exa/perplexity/grok/jina place the key under their own sub-config", () => {
    expect(buildWebSearchConfig("tavily", { apiKey: "t" }).tavily).toEqual({ apiKey: "t" });
    expect(buildWebSearchConfig("exa", { apiKey: "e" }).exa).toEqual({ apiKey: "e" });
    expect(buildWebSearchConfig("perplexity", { apiKey: "p" }).perplexity).toEqual({ apiKey: "p" });
    expect(buildWebSearchConfig("grok", { apiKey: "g" }).grok).toEqual({ apiKey: "g" });
    expect(buildWebSearchConfig("jina", { apiKey: "j" }).jina).toEqual({ apiKey: "j" });
  });

  it("searxng sets searxng.baseUrl (no apiKey field)", () => {
    const cfg = buildWebSearchConfig("searxng", { baseUrl: "http://searx.local" });
    expect(cfg.searxng).toEqual({ baseUrl: "http://searx.local" });
    expect(cfg.apiKey).toBeUndefined();
  });

  it("searxng defaults baseUrl when none supplied", () => {
    const cfg = buildWebSearchConfig("searxng");
    expect(typeof cfg.searxng?.baseUrl).toBe("string");
    expect((cfg.searxng?.baseUrl ?? "").length).toBeGreaterThan(0);
  });

  it("duckduckgo sets duckduckgo:{} (keyless)", () => {
    const cfg = buildWebSearchConfig("duckduckgo");
    expect(cfg.duckduckgo).toEqual({});
    expect(cfg.apiKey).toBeUndefined();
  });
});

describe("buildLinkConfig", () => {
  it("returns a valid LinkUnderstandingConfig with enabled:true by default + all 5 fields", () => {
    const cfg = buildLinkConfig();
    expect(cfg.enabled).toBe(true);
    expect(typeof cfg.maxLinks).toBe("number");
    expect(typeof cfg.fetchTimeoutMs).toBe("number");
    expect(typeof cfg.maxContentChars).toBe("number");
    expect(typeof cfg.userAgentString).toBe("string");
  });

  it("honors the enabled:false override (the deterministic disabled-short-circuit driver)", () => {
    expect(buildLinkConfig({ enabled: false }).enabled).toBe(false);
  });
});

describe("buildDocExtractionConfig", () => {
  it("returns a valid FileExtractionConfig with the real defaults (maxChars 200000, pdfImageFallback false)", () => {
    const cfg = buildDocExtractionConfig();
    expect(cfg.maxChars).toBe(200_000);
    expect(cfg.pdfImageFallback).toBe(false);
    expect(cfg.allowedMimes).toContain("text/csv");
    expect(cfg.allowedMimes).toContain("application/pdf");
  });

  it("honors maxChars + pdfImageFallback overrides", () => {
    expect(buildDocExtractionConfig({ maxChars: 20 }).maxChars).toBe(20);
    expect(buildDocExtractionConfig({ pdfImageFallback: true }).pdfImageFallback).toBe(true);
  });
});

// Type-level sanity: WebSearchProvider is the union of the 8 providers.
const _typeCheck: WebSearchProvider = "brave";
void _typeCheck;
