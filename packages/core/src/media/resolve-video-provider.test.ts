// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveVideoProvider, isBlockedObjectKey } from "./resolve-video-provider.js";

/**
 * resolveVideoProvider is a PURE priority resolver (no I/O) for video-generation
 * provider selection. Purity is preserved by injecting a `credsAvailable`
 * predicate (a boolean closure the daemon supplies in Plan 03/04) and an
 * optional `onSkip` callback — the resolver never touches SecretManager,
 * OAuthTokenManager, process.env, or the network.
 *
 * Covers RES-02 (auto follow-main + explicit override + model override), RES-03
 * (honest-unavailable with errorKind + a knob-naming hint naming FAL_KEY), RES-04
 * (fallbackChain consulted only after follow-main, each skip reported), and the
 * NEW SEC-04 prototype-pollution guard (DIVERGENCE 4) the image resolver lacks.
 */
describe("resolveVideoProvider", () => {
  const ALL_CREDS = (): boolean => true;
  const NO_CREDS = (): boolean => false;

  it("follows the main provider when provider is auto and creds are available (RES-02)", () => {
    const sel = resolveVideoProvider({ provider: "auto" }, "google", ALL_CREDS);
    expect(sel).toEqual({
      ok: true,
      videoApi: "veo",
      defaultModel: "veo-3.0-fast-generate-001",
      model: undefined,
      source: "follow-main",
    });
  });

  it("follows an xai main to the grok backend when creds are available (RES-02)", () => {
    const sel = resolveVideoProvider({ provider: "auto" }, "xai", ALL_CREDS);
    expect(sel.ok).toBe(true);
    if (sel.ok) {
      expect(sel.videoApi).toBe("grok");
      expect(sel.source).toBe("follow-main");
    }
  });

  it("returns honest-unavailable for an openai main, hint naming the knob and FAL_KEY (RES-03)", () => {
    const sel = resolveVideoProvider({ provider: "auto" }, "openai", ALL_CREDS);
    expect(sel.ok).toBe(false);
    if (!sel.ok) {
      expect(sel.errorKind).toBe("unsupported_provider");
      expect(sel.hint).toContain("videoGeneration.provider");
      expect(sel.hint).toContain("FAL_KEY");
    }
  });

  it("returns auth_required with a knob+FAL_KEY hint when follow-main creds are absent (RES-03)", () => {
    const sel = resolveVideoProvider({ provider: "auto" }, "google", NO_CREDS);
    expect(sel.ok).toBe(false);
    if (!sel.ok) {
      expect(sel.errorKind).toBe("auth_required");
      expect(sel.hint).toContain("videoGeneration.provider");
      expect(sel.hint).toContain("FAL_KEY");
    }
  });

  it("lets a config model override the per-backend default model (RES-02)", () => {
    const sel = resolveVideoProvider({ provider: "auto", model: "veo-3.1-fast" }, "google", ALL_CREDS);
    expect(sel.ok).toBe(true);
    if (sel.ok) {
      expect(sel.model).toBe("veo-3.1-fast");
    }
  });

  it("treats explicit fal as honest-unavailable (fal is not a follow-main capability key)", () => {
    // fal's real adapter is wired in Plan 04's selector; the pure resolver
    // returns unavailable for it, exactly as the image resolver treats explicit fal.
    const sel = resolveVideoProvider({ provider: "fal" }, "google", ALL_CREDS);
    expect(sel.ok).toBe(false);
    if (!sel.ok) {
      expect(sel.errorKind).toBe("unsupported_provider");
    }
  });

  it("consults the fallback chain only after follow-main fails, reporting the skip (RES-04)", () => {
    const onSkip = vi.fn();
    const sel = resolveVideoProvider(
      { provider: "auto", fallbackChain: ["google"] },
      "openai",
      (api) => api === "veo",
      onSkip,
    );
    expect(sel).toMatchObject({ ok: true, videoApi: "veo", source: "fallback" });
    // follow-main (openai, incapable) must have been tried + reported FIRST.
    expect(onSkip).toHaveBeenCalled();
    expect(onSkip.mock.calls[0]?.[0]).toContain("openai");
  });

  it("reports each skipped fallback entry with a reason before succeeding (RES-04)", () => {
    const onSkip = vi.fn();
    const sel = resolveVideoProvider(
      { provider: "auto", fallbackChain: ["openai", "google"] },
      "openai",
      (api) => api === "veo",
      onSkip,
    );
    expect(sel).toMatchObject({ ok: true, videoApi: "veo", source: "fallback" });
    const reasons = onSkip.mock.calls.map((c) => String(c[0]));
    expect(reasons.some((r) => r.includes("openai"))).toBe(true);
  });

  // --- SEC-04: the prototype-pollution guard (DIVERGENCE 4) ---

  describe("isBlockedObjectKey (SEC-04)", () => {
    it("blocks the three prototype-pollution keys and passes a normal provider id", () => {
      expect(isBlockedObjectKey("__proto__")).toBe(true);
      expect(isBlockedObjectKey("constructor")).toBe(true);
      expect(isBlockedObjectKey("prototype")).toBe(true);
      expect(isBlockedObjectKey("google")).toBe(false);
    });
  });

  describe("SEC-04 — provider-id lookups never index a poisoned key", () => {
    // Poison Object.prototype so that a NAIVE `VIDEO_CAPABILITY[k]` lookup for a
    // blocked key would falsely "find" this entry. A guarded resolver rejects
    // the key BEFORE indexing, so it must NEVER return this planted selection.
    const POISON = { videoApi: "POISONED", defaultModel: "POISONED" };

    afterEach(() => {
      // Clean up any planted prototype props between cases.
      for (const k of ["__proto__", "constructor", "prototype"] as const) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (Object.prototype as any)[k];
      }
    });

    it("rejects an explicit __proto__ provider before any VIDEO_CAPABILITY index", () => {
      // Plant on the prototype via defineProperty (assigning __proto__ directly
      // would set the prototype, not a property).
      Object.defineProperty(Object.prototype, "__proto__-poison-marker", {
        value: POISON,
        configurable: true,
        enumerable: false,
      });
      const sel = resolveVideoProvider({ provider: "__proto__" }, "google", () => true);
      expect(sel.ok).toBe(false);
      if (!sel.ok) {
        expect(sel.errorKind).toBe("unsupported_provider");
      }
    });

    it("rejects an explicit constructor provider, never returning Object's constructor", () => {
      const sel = resolveVideoProvider({ provider: "constructor" }, "google", () => true);
      // A naive lookup would yield `Object` (the constructor function) — truthy,
      // and `credsAvailable(cap.videoApi)` would explode or misbehave. The guard
      // returns honest-unavailable instead.
      expect(sel.ok).toBe(false);
      if (!sel.ok) {
        expect(sel.errorKind).toBe("unsupported_provider");
      }
    });

    it("rejects a prototype provider on the explicit path", () => {
      const sel = resolveVideoProvider({ provider: "prototype" }, "google", () => true);
      expect(sel.ok).toBe(false);
    });

    it("rejects a poisoned mainProviderId on the auto follow-main path", () => {
      const sel = resolveVideoProvider({ provider: "auto" }, "__proto__", () => true);
      expect(sel.ok).toBe(false);
      if (!sel.ok) {
        expect(sel.errorKind).toBe("unsupported_provider");
      }
    });

    it("skips a poisoned fallback-chain entry (onSkip reason) instead of indexing it", () => {
      const onSkip = vi.fn();
      const sel = resolveVideoProvider(
        { provider: "auto", fallbackChain: ["constructor", "google"] },
        "openai",
        (api) => api === "veo",
        onSkip,
      );
      // The blocked entry is skipped; the next usable entry (google) wins.
      expect(sel).toMatchObject({ ok: true, videoApi: "veo", source: "fallback" });
      const reasons = onSkip.mock.calls.map((c) => String(c[0]));
      expect(reasons.some((r) => r.includes("constructor"))).toBe(true);
    });
  });
});
