// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the video-provider SELECTION.
 *
 * The selector selects the port ONCE at boot (a two-source firewall — the handler
 * never re-derives selection). It mirrors
 * setup-image-provider.ts:
 *   - explicit `fal` → the skills factory getter;
 *   - auto + main=google (GOOGLE_API_KEY) → the LIVE Veo adapter
 *     (`port.id === "veo"`, available);
 *   - auto + main=xai (XAI_API_KEY) → the LIVE Grok adapter (key-primary);
 *     or, with no key but an oauthManager.hasCredentials("xai"), the defensive
 *     codex-shaped OAuth branch (forward-looking; no xai OAuth provider yet);
 *     or, with neither, honest-unavailable `auth_required` (never a misroute);
 *   - auto + a video-incapable main (openai) → honest-unavailable naming
 *     provider + FAL_KEY;
 *   - !sel.ok → makeUnavailableVideoPort surfacing the resolver's errorKind+hint.
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import { makeUnavailableVideoPort, createVideoProviderSelector } from "./setup-video-provider.js";
import { VideoGenError } from "@comis/core";
import type { OAuthTokenManager, SecretManager } from "@comis/core";
import type { VideoGenerationPort } from "@comis/core";
import { ok } from "@comis/shared";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

/** A SecretManager seeded with a fixed key set. */
function makeSecretManager(keys: Record<string, string>): SecretManager {
  return {
    get: (k: string) => keys[k],
  } as unknown as SecretManager;
}

/**
 * A mock OAuthTokenManager exposing the two methods the grok key-or-OAuth seam
 * touches: `hasCredentials` (the credsAvailable + selector-branch gate) and
 * `getApiKey` (the per-call bearer the grok adapter resolves on execute). Mirrors
 * the codex precedent in setup-image-provider.test.ts. The
 * routing assertions only need `hasCredentials`; `getApiKey` is provided so a
 * downstream `execute()` would not throw on an absent method.
 */
function mockOauthManager(
  over: { hasCredentials?: ReturnType<typeof vi.fn>; getApiKey?: ReturnType<typeof vi.fn> } = {},
): OAuthTokenManager {
  return {
    hasCredentials: over.hasCredentials ?? vi.fn().mockReturnValue(true),
    getApiKey: over.getApiKey ?? vi.fn().mockResolvedValue(ok("fake.bearer.jwt")),
  } as unknown as OAuthTokenManager;
}

const baseConfig = {
  provider: "auto" as string,
  defaultDurationSecs: 8,
  defaultAspectRatio: "16:9",
  defaultResolution: "720p",
  maxPerHour: 5,
  timeoutMs: 300000,
  pollIntervalMs: 10000,
  fallbackChain: [] as string[],
};

describe("makeUnavailableVideoPort", () => {
  it("returns a port whose every method yields a classified VideoGenError err; isAvailable false", async () => {
    const port = makeUnavailableVideoPort("unsupported_provider", "no video here", createMockLogger());
    expect(port.isAvailable()).toBe(false);
    for (const method of ["submit", "poll", "fetchResult"] as const) {
      const r = await (port[method] as (arg: unknown) => Promise<{ ok: boolean; error?: Error }>)({});
      expect(r.ok).toBe(false);
      expect(r.error).toBeInstanceOf(VideoGenError);
      expect((r.error as VideoGenError).videoErrorKind).toBe("unsupported_provider");
      expect((r.error as VideoGenError).hint).toBe("no video here");
    }
    const ex = await port.execute({ prompt: "x" }, { timeoutMs: 1, pollIntervalMs: 1 });
    expect(ex.ok).toBe(false);
    expect(ex.error).toBeInstanceOf(VideoGenError);
  });
});

describe("createVideoProviderSelector", () => {
  it("returns undefined when videoGeneration is unconfigured", () => {
    const getPort = createVideoProviderSelector({
      videoGenConfig: undefined,
      secretManager: makeSecretManager({}),
      mainProviderId: "google",
      legacyGetter: () => undefined,
      logger: createMockLogger(),
    });
    expect(getPort()).toBeUndefined();
  });

  it("explicit provider:'fal' routes to the skills factory getter", () => {
    let legacyCalls = 0;
    const sentinel: VideoGenerationPort = {
      id: "fal",
      isAvailable: () => true,
      submit: () => Promise.resolve({ ok: true } as never),
      poll: () => Promise.resolve({ ok: true } as never),
      fetchResult: () => Promise.resolve({ ok: true } as never),
      execute: () => Promise.resolve({ ok: true } as never),
    };
    const getPort = createVideoProviderSelector({
      videoGenConfig: { ...baseConfig, provider: "fal" },
      secretManager: makeSecretManager({ FAL_KEY: "fal-xxx" }),
      mainProviderId: "google",
      legacyGetter: () => {
        legacyCalls += 1;
        return sentinel;
      },
      logger: createMockLogger(),
    });
    const port = getPort();
    expect(legacyCalls).toBe(1);
    expect(port).toBe(sentinel);
  });

  it("auto + main=google (GOOGLE_API_KEY present) → the LIVE Veo adapter (id 'veo', available)", () => {
    const getPort = createVideoProviderSelector({
      videoGenConfig: { ...baseConfig, provider: "auto" },
      secretManager: makeSecretManager({ GOOGLE_API_KEY: "g-xxx" }),
      mainProviderId: "google",
      legacyGetter: () => undefined,
      logger: createMockLogger(),
    });
    const port = getPort();
    expect(port).toBeDefined();
    // The selector constructs the live createVeoVideoAdapter from the SAME
    // GOOGLE_API_KEY the completion path uses (no video-specific secret). The Veo
    // adapter is always available once constructed (isAvailable() === true).
    expect(port!.id).toBe("veo");
    expect(port!.isAvailable()).toBe(true);
  });

  it("auto + main=openai (video-incapable) → honest-unavailable naming provider + FAL_KEY", async () => {
    const getPort = createVideoProviderSelector({
      videoGenConfig: { ...baseConfig, provider: "auto" },
      secretManager: makeSecretManager({ OPENAI_API_KEY: "o-xxx" }),
      mainProviderId: "openai",
      legacyGetter: () => undefined,
      logger: createMockLogger(),
    });
    const port = getPort();
    expect(port).toBeDefined();
    expect(port!.isAvailable()).toBe(false);
    const ex = await port!.execute({ prompt: "x" }, { timeoutMs: 1, pollIntervalMs: 1 });
    expect(ex.ok).toBe(false);
    // The resolver's honest-unavailable hint names the provider + FAL_KEY.
    expect((ex.error as VideoGenError).hint).toMatch(/FAL_KEY/);
    expect((ex.error as VideoGenError).hint).toMatch(/openai/);
  });

  it("auto + main=xai (XAI_API_KEY present) → the LIVE Grok adapter (id 'grok', available — key-primary)", () => {
    const getPort = createVideoProviderSelector({
      videoGenConfig: { ...baseConfig, provider: "auto" },
      secretManager: makeSecretManager({ XAI_API_KEY: "x-xxx" }),
      mainProviderId: "xai",
      legacyGetter: () => undefined,
      logger: createMockLogger(),
    });
    const port = getPort();
    // The selector constructs the live createGrokVideoAdapter from the XAI_API_KEY
    // (key-primary — the proven path).
    expect(port!.id).toBe("grok");
    expect(port!.isAvailable()).toBe(true);
  });

  it("auto + main=xai, NO XAI_API_KEY but an oauthManager with hasCredentials('xai') → the LIVE Grok adapter via the defensive OAuth branch", () => {
    // No xai OAuth provider is registered in the codebase today, so this
    // branch is forward-looking. We mock the manager to PROVE the selector wires
    // the key-or-OAuth contract structurally — a future xai OAuth
    // provider activates it with no further selector change.
    const oauthManager = mockOauthManager({ hasCredentials: vi.fn().mockReturnValue(true) });
    const getPort = createVideoProviderSelector({
      videoGenConfig: { ...baseConfig, provider: "auto" },
      secretManager: makeSecretManager({}), // no XAI_API_KEY
      mainProviderId: "xai",
      legacyGetter: () => undefined,
      logger: createMockLogger(),
      oauthManager,
    });
    const port = getPort();
    expect(port!.id).toBe("grok");
    expect(port!.isAvailable()).toBe(true);
    // The credsAvailable closure + the selector branch both consult hasCredentials("xai").
    expect(oauthManager.hasCredentials).toHaveBeenCalledWith("xai");
  });

  it("auto + main=xai, NO XAI_API_KEY and NO oauthManager → honest-unavailable (auth_required), never a misroute", async () => {
    const getPort = createVideoProviderSelector({
      videoGenConfig: { ...baseConfig, provider: "auto" },
      secretManager: makeSecretManager({}), // no creds at all
      mainProviderId: "xai",
      legacyGetter: () => undefined,
      logger: createMockLogger(),
      // no oauthManager
    });
    const port = getPort();
    expect(port).toBeDefined();
    expect(port!.isAvailable()).toBe(false);
    const ex = await port!.execute({ prompt: "x" }, { timeoutMs: 1, pollIntervalMs: 1 });
    expect(ex.ok).toBe(false);
    expect((ex.error as VideoGenError).videoErrorKind).toBe("auth_required");
  });

  it("auto + main=google but NO GOOGLE_API_KEY → honest-unavailable (auth_required), never a misroute", async () => {
    const getPort = createVideoProviderSelector({
      videoGenConfig: { ...baseConfig, provider: "auto" },
      secretManager: makeSecretManager({}), // no creds at all
      mainProviderId: "google",
      legacyGetter: () => undefined,
      logger: createMockLogger(),
    });
    const port = getPort();
    const ex = await port!.execute({ prompt: "x" }, { timeoutMs: 1, pollIntervalMs: 1 });
    expect(ex.ok).toBe(false);
    expect((ex.error as VideoGenError).videoErrorKind).toBe("auth_required");
  });
});
