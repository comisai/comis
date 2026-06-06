// SPDX-License-Identifier: Apache-2.0
/**
 * WEB-01 — search-provider certification.
 *
 * Drives the REAL public tool factory `createWebSearchTool` (from `@comis/skills`) and the
 * credential registry. The deterministic, sandbox-honest Stage-B coverage is:
 *   Stage-A (always): the provider / keyless / category constants.
 *   Stage-B (always, no daemon/key/network):
 *     - createWebSearchTool(buildWebSearchConfig(p)) returns a valid web_search tool for ALL 8
 *       providers (config-shape valid for every provider, no throw);
 *     - per-provider key-gating is honestly resolved via the credential registry (keyed providers
 *       are SKIPPED(no-creds) in the sandbox, null when present; keyless providers are null);
 *     - the freshness filter is exposed on the PUBLIC tool parameter schema (WebSearchParams) and
 *       its description names the providers that honor it (Brave/DuckDuckGo/Tavily/Exa/SearXNG).
 *   Stage-C (it.skip — COMIS_LIVE + key/network): a real per-provider query → judged grounded answer.
 *
 * Assertions are on the tool object + the registry verdicts — there are NO search/web event-bus
 * events for results. The module-internal helpers (parseProvider, mapFreshnessToProvider,
 * FRESHNESS_PROVIDERS, resolveApiKey, buildProviderChain) are NOT imported — freshness/key-gating
 * is asserted via the public surface only. The judge-qa-harness-wiring fix-forward keeps the judged
 * Stage-C cell skipped-with-reason (deferred to PROVE/148).
 *
 * @module
 */

import { describe, it, expect, afterEach } from "vitest";
import { createWebSearchTool, __clearSearchCache } from "@comis/skills";
import {
  buildWebSearchConfig,
  WEB_SEARCH_PROVIDERS,
  SEARCH_KEYLESS,
  SEARCH_KEY_CATEGORY,
  type WebSearchProvider,
} from "../../harness/web-config.js";
import { buildCredentialRegistry } from "../../credentials.js";

const isLive = !!process.env["COMIS_LIVE"];

/** The keyed providers (all 8 minus the keyless duckduckgo + searxng). */
const KEYED = WEB_SEARCH_PROVIDERS.filter(
  (p): p is Exclude<WebSearchProvider, "duckduckgo" | "searxng"> =>
    !(SEARCH_KEYLESS as readonly string[]).includes(p),
);

/** Env var backing each keyed provider's key (matches credentials.ts KEY_TO_CATEGORIES). */
const ENV_FOR: Record<Exclude<WebSearchProvider, "duckduckgo" | "searxng">, string> = {
  brave: "SEARCH_API_KEY",
  tavily: "TAVILY_API_KEY",
  exa: "EXA_API_KEY",
  perplexity: "PERPLEXITY_API_KEY",
  grok: "XAI_API_KEY",
  jina: "JINA_API_KEY",
};

afterEach(() => __clearSearchCache());

// ---------------------------------------------------------------------------
// Stage-A — provider / keyless / category constants
// ---------------------------------------------------------------------------

describe("WEB-01 Stage-A — provider / keyless / category constants", () => {
  it("WEB_SEARCH_PROVIDERS has 8 entries", () => {
    expect(WEB_SEARCH_PROVIDERS.length).toBe(8);
  });

  it("lists exactly [duckduckgo, searxng] as the keyless providers (SEARCH_KEYLESS)", () => {
    expect([...SEARCH_KEYLESS]).toEqual(["duckduckgo", "searxng"]);
  });

  it("SEARCH_KEY_CATEGORY maps each keyed provider to search(<provider>)", () => {
    for (const p of KEYED) {
      expect(SEARCH_KEY_CATEGORY[p]).toBe(`search(${p})`);
    }
  });
});

// ---------------------------------------------------------------------------
// Stage-B — config-shape (×8) + key-gating + freshness via the public schema
// ---------------------------------------------------------------------------

describe("WEB-01 Stage-B — config-shape, key-gating, freshness (PUBLIC createWebSearchTool/WebSearchParams)", () => {
  it("createWebSearchTool returns a valid web_search tool for ALL 8 providers (no throw)", () => {
    for (const p of WEB_SEARCH_PROVIDERS) {
      const tool = createWebSearchTool(buildWebSearchConfig(p));
      expect(tool.name).toBe("web_search");
      expect(typeof tool.execute).toBe("function");
    }
  });

  it("freshness is exposed on the public WebSearchParams schema, naming the providers that honor it", () => {
    const tool = createWebSearchTool(buildWebSearchConfig("brave"));
    // WebSearchParams is a TypeBox JSON schema — inspect its properties.
    const params = tool.parameters as unknown as {
      properties?: { freshness?: { description?: string } };
    };
    const freshness = params.properties?.freshness;
    expect(freshness).toBeDefined();
    expect(freshness?.description ?? "").toContain("Supported by: Brave, DuckDuckGo, Tavily, Exa, SearXNG");
  });

  it("per-provider key-gating is honestly resolved via the credential registry", () => {
    const creds = buildCredentialRegistry();
    // Keyed providers: exact verdict computed from env presence (correct whether or not an operator has the key).
    for (const p of KEYED) {
      const expected = process.env[ENV_FOR[p]] ? null : "SKIPPED(no-creds)";
      expect(creds.getSkipVerdict(SEARCH_KEY_CATEGORY[p])).toBe(expected);
    }
    // Keyless providers: always null (no creds required).
    expect(creds.getSkipVerdict("search(duckduckgo)")).toBeNull();
    expect(creds.getSkipVerdict("search(searxng)")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Stage-C — real per-provider query → judged grounded answer (COMIS_LIVE + key/network)
// ---------------------------------------------------------------------------

describe.skipIf(!isLive)("WEB-01 Stage-C — real query → judged grounded answer per available provider (COMIS_LIVE)", () => {
  for (const p of WEB_SEARCH_PROVIDERS) {
    it.skip(
      `real ${p} query → results → judged grounded answer (freshness honored) ` +
        `(deferred to COMIS_LIVE operator; ${(SEARCH_KEYLESS as readonly string[]).includes(p) ? "keyless + network" : `gated via getSkipVerdict(search(${p}))`}; ` +
        `SKIPPED(no-creds)/SKIPPED(no-network) honestly; judge-qa-harness-wiring fix-forward keeps the judged cell skipped-with-reason, deferred to PROVE/148)`,
      () => {
        // Stage-C (operator): const tool = createWebSearchTool(buildWebSearchConfig(p, { apiKey: process.env[ENV_FOR[p]] }));
        //   const res = await tool.execute("call-1", { query: "...", freshness: "pd" });
        //   then judgeAnswer({ ... }) for a grounded-answer rubric; DuckDuckGo runs keyless with network.
      },
    );
  }
});
