// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { resolveImageProvider } from "./resolve-image-provider.js";

/**
 * resolveImageProvider is a PURE priority resolver (no I/O) for image-generation
 * provider selection. Purity is preserved by injecting a `credsAvailable`
 * predicate (a boolean closure the daemon supplies) and an
 * optional `onSkip` callback — the resolver never touches SecretManager,
 * OAuthTokenManager, process.env, or the network.
 *
 * Covers auto follow-main + explicit override + model override,
 * honest-unavailable with errorKind + a knob-naming hint, and the
 * fallbackChain (consulted only after follow-main, each skip reported).
 */
describe("resolveImageProvider", () => {
  const ALL_CREDS = (): boolean => true;
  const NO_CREDS = (): boolean => false;

  it("follows the main provider when provider is auto and creds are available", () => {
    const sel = resolveImageProvider({ provider: "auto" }, "openrouter", ALL_CREDS);
    expect(sel).toEqual({
      ok: true,
      imagesApi: "openrouter-images",
      defaultModel: "black-forest-labs/flux.2-pro",
      model: undefined,
      source: "follow-main",
    });
  });

  it("lets an explicit non-auto provider override an image-incapable main", () => {
    const sel = resolveImageProvider({ provider: "openrouter" }, "anthropic", ALL_CREDS);
    expect(sel.ok).toBe(true);
    if (sel.ok) {
      expect(sel.imagesApi).toBe("openrouter-images");
      expect(sel.source).toBe("explicit");
    }
  });

  it("lets a config model override the per-provider default model", () => {
    const sel = resolveImageProvider(
      { provider: "auto", model: "custom/model" },
      "openrouter",
      ALL_CREDS,
    );
    expect(sel.ok).toBe(true);
    if (sel.ok) {
      expect(sel.model).toBe("custom/model");
    }
  });

  it("returns unsupported_provider with a knob-naming hint for an incapable main", () => {
    const sel = resolveImageProvider({ provider: "auto" }, "anthropic", ALL_CREDS);
    expect(sel.ok).toBe(false);
    if (!sel.ok) {
      expect(sel.errorKind).toBe("unsupported_provider");
      expect(sel.hint).toContain("integrations.media.imageGeneration.provider");
    }
  });

  it("returns auth_required with a hint naming the knob when creds are absent", () => {
    const sel = resolveImageProvider({ provider: "auto" }, "openrouter", NO_CREDS);
    expect(sel.ok).toBe(false);
    if (!sel.ok) {
      expect(sel.errorKind).toBe("auth_required");
      expect(sel.hint).toContain("integrations.media.imageGeneration.provider");
    }
  });

  it("consults the fallback chain only after follow-main fails, reporting the skip", () => {
    const onSkip = vi.fn();
    const sel = resolveImageProvider(
      { provider: "auto", fallbackChain: ["openrouter"] },
      "anthropic",
      (api) => api === "openrouter-images",
      onSkip,
    );
    expect(sel).toMatchObject({
      ok: true,
      imagesApi: "openrouter-images",
      source: "fallback",
    });
    // follow-main (anthropic, incapable) must have been tried + reported FIRST.
    expect(onSkip).toHaveBeenCalled();
    expect(onSkip.mock.calls[0]?.[0]).toContain("anthropic");
  });

  it("reports each skipped fallback entry with a reason before succeeding", () => {
    const onSkip = vi.fn();
    const sel = resolveImageProvider(
      { provider: "auto", fallbackChain: ["anthropic", "openrouter"] },
      "anthropic",
      (api) => api === "openrouter-images",
      onSkip,
    );
    expect(sel).toMatchObject({
      ok: true,
      imagesApi: "openrouter-images",
      source: "fallback",
    });
    // The anthropic fallback entry (incapable) is reported with a reason naming it.
    const reasons = onSkip.mock.calls.map((c) => String(c[0]));
    expect(reasons.some((r) => r.includes("anthropic"))).toBe(true);
  });

  it("returns ok false when the default empty fallback chain is exhausted", () => {
    const sel = resolveImageProvider({ provider: "auto" }, "anthropic", NO_CREDS);
    expect(sel.ok).toBe(false);
  });
});
