// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for builtin-provider-guard.ts (260501-gyy FIX 2).
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { getProviders, getModels, type KnownProvider } from "@mariozechner/pi-ai";
import { checkBuiltInProviderRedundancy } from "./builtin-provider-guard.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Pick a catalog provider name dynamically — any entry works. Reading from
 * getProviders() at test time keeps the test catalog-agnostic and resilient
 * to pi-ai upgrades that add/remove built-in providers.
 */
function pickCatalogProvider(): { providerId: string; baseUrl: string | undefined } {
  const providers = getProviders();
  const providerId = providers[0]!;
  const baseUrl = getModels(providerId as KnownProvider)[0]?.baseUrl;
  return { providerId, baseUrl };
}

describe("checkBuiltInProviderRedundancy (260501-gyy)", () => {
  // A1
  it("rejects when providerId is in pi-ai catalog AND baseUrl matches catalog", () => {
    const { providerId, baseUrl } = pickCatalogProvider();
    const result = checkBuiltInProviderRedundancy(providerId, {
      baseUrl,
      apiKeyName: "TEST_API_KEY",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Cannot create custom provider entry for");
      expect(result.reason).toContain(providerId);
    }
  });

  // A2
  it("rejects when providerId is in pi-ai catalog AND baseUrl is undefined", () => {
    const { providerId } = pickCatalogProvider();
    const result = checkBuiltInProviderRedundancy(providerId, {
      apiKeyName: "TEST_API_KEY",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Cannot create custom provider entry for");
    }
  });

  // A3
  it("rejects when providerId is in pi-ai catalog AND baseUrl is empty string", () => {
    const { providerId } = pickCatalogProvider();
    const result = checkBuiltInProviderRedundancy(providerId, {
      baseUrl: "",
      apiKeyName: "TEST_API_KEY",
    });
    expect(result.ok).toBe(false);
  });

  // A4 — proves .trim() is applied
  it("rejects when providerId is in pi-ai catalog AND baseUrl is whitespace-only", () => {
    const { providerId } = pickCatalogProvider();
    const result = checkBuiltInProviderRedundancy(providerId, {
      baseUrl: "   ",
      apiKeyName: "TEST_API_KEY",
    });
    expect(result.ok).toBe(false);
  });

  // A5
  it("allows when providerId is in pi-ai catalog BUT baseUrl differs from catalog (proxy use case)", () => {
    const { providerId } = pickCatalogProvider();
    const result = checkBuiltInProviderRedundancy(providerId, {
      baseUrl: "https://my-proxy.example.com/v1",
      apiKeyName: "TEST_API_KEY",
    });
    expect(result.ok).toBe(true);
  });

  // A6
  it("allows when providerId is NOT in pi-ai catalog", () => {
    const fakeProviderId = "my-custom-thing-260501-gyy";
    const r1 = checkBuiltInProviderRedundancy(fakeProviderId, {
      baseUrl: "anything",
      apiKeyName: "MY_KEY",
    });
    expect(r1.ok).toBe(true);

    // Also: no baseUrl on a non-catalog providerId is allowed.
    const r2 = checkBuiltInProviderRedundancy(fakeProviderId, {});
    expect(r2.ok).toBe(true);
  });

  // A7
  it("rejection message contains the recovery instructions and interpolates providerId + apiKeyName", () => {
    const { providerId } = pickCatalogProvider();

    // (a) With apiKeyName supplied — assert literal interpolation
    const r1 = checkBuiltInProviderRedundancy(providerId, {
      apiKeyName: "MY_PROVIDER_KEY",
    });
    expect(r1.ok).toBe(false);
    if (!r1.ok) {
      expect(r1.reason).toContain("Cannot create custom provider entry for");
      expect(r1.reason).toContain(providerId);
      expect(r1.reason).toContain("gateway env_set");
      expect(r1.reason).toContain("gateway patch agents.");
      expect(r1.reason).toContain("models_manage list provider:");
      expect(r1.reason).toContain("-proxy");
      expect(r1.reason).toContain("MY_PROVIDER_KEY");
    }

    // (b) Without apiKeyName — assert <APIKEY_NAME> placeholder
    const r2 = checkBuiltInProviderRedundancy(providerId, {});
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.reason).toContain("<APIKEY_NAME>");
    }
  });

  // A8 — source-grep regression: rejection-message TEMPLATE has no hardcoded provider names
  it("rejection message TEMPLATE in source contains NO hardcoded provider names (catalog-agnostic)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.resolve(here, "builtin-provider-guard.ts"), "utf-8");

    // Strip line-comments (// ...) and block-comment lines (lines starting with `*`)
    // so JSDoc + inline rationale that legitimately mentions provider names
    // doesn't trip the grep. The intent: NO provider-name string LITERAL in
    // the rejection-message TEMPLATE source.
    const codeOnly = src
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("//")) return false;
        if (trimmed.startsWith("*")) return false;
        if (trimmed.startsWith("/*")) return false;
        return true;
      })
      .join("\n");

    const forbidden = [
      "openrouter",
      "anthropic",
      "openai",
      "google",
      "groq",
      "deepseek",
      "cerebras",
      "mistral",
      "xai",
      "ollama",
      "lm-studio",
    ];
    for (const name of forbidden) {
      // Match double- or single-quoted string literals — would-be hardcoded names.
      expect(
        codeOnly,
        `forbidden hardcoded provider name "${name}" found in code (excluding comments)`,
      ).not.toContain(`"${name}"`);
      expect(
        codeOnly,
        `forbidden hardcoded provider name '${name}' found in code (excluding comments)`,
      ).not.toContain(`'${name}'`);
    }
  });
});
