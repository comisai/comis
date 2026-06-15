// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the video-provider SELECTION (RES-01/RES-03, Phase 188 / Plan 04).
 *
 * The selector selects the port ONCE at boot (the v2.20 keyless-summarizer
 * two-source firewall — the handler never re-derives). It mirrors
 * setup-image-provider.ts:
 *   - explicit `fal` → the skills factory getter;
 *   - auto + a video-capable main (google→veo / xai→grok) → the SELECTION, but
 *     Phase 188 has no live Veo/Grok adapter, so it returns an honest-unavailable
 *     port whose hint names "Phase 190" (exactly image's "not yet wired" L198-206);
 *   - auto + a video-incapable main (openai) → honest-unavailable naming
 *     provider + FAL_KEY;
 *   - !sel.ok → makeUnavailableVideoPort surfacing the resolver's errorKind+hint.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { makeUnavailableVideoPort, createVideoProviderSelector } from "./setup-video-provider.js";
import { VideoGenError } from "@comis/core";
import type { SecretManager } from "@comis/core";
import type { VideoGenerationPort } from "@comis/core";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

/** A SecretManager seeded with a fixed key set. */
function makeSecretManager(keys: Record<string, string>): SecretManager {
  return {
    get: (k: string) => keys[k],
  } as unknown as SecretManager;
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

  it("auto + main=google (GOOGLE_API_KEY present) → the veo SELECTION → 190-placeholder unavailable (hint names Phase 190)", async () => {
    const getPort = createVideoProviderSelector({
      videoGenConfig: { ...baseConfig, provider: "auto" },
      secretManager: makeSecretManager({ GOOGLE_API_KEY: "g-xxx" }),
      mainProviderId: "google",
      legacyGetter: () => undefined,
      logger: createMockLogger(),
    });
    const port = getPort();
    expect(port).toBeDefined();
    expect(port!.isAvailable()).toBe(false); // selection resolved, but no live adapter in 188
    const ex = await port!.execute({ prompt: "x" }, { timeoutMs: 1, pollIntervalMs: 1 });
    expect(ex.ok).toBe(false);
    expect((ex.error as VideoGenError).videoErrorKind).toBe("unsupported_provider");
    expect((ex.error as VideoGenError).hint).toMatch(/Phase 190/);
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

  it("auto + main=xai (XAI_API_KEY present) → the grok SELECTION → 190-placeholder unavailable", async () => {
    const getPort = createVideoProviderSelector({
      videoGenConfig: { ...baseConfig, provider: "auto" },
      secretManager: makeSecretManager({ XAI_API_KEY: "x-xxx" }),
      mainProviderId: "xai",
      legacyGetter: () => undefined,
      logger: createMockLogger(),
    });
    const port = getPort();
    const ex = await port!.execute({ prompt: "x" }, { timeoutMs: 1, pollIntervalMs: 1 });
    expect(ex.ok).toBe(false);
    expect((ex.error as VideoGenError).hint).toMatch(/Phase 190/);
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
