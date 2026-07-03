// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the image-provider selector (setup-image-provider.ts).
 *
 * The selector decides, per the resolved config + the agent's main provider,
 * between the pi-image-adapter (provider:"auto"/openrouter) and the relegated
 * skills adapter (explicit fal/openai) — and returns an honest-unavailable
 * port (carrying the knob-naming hint) for an image-incapable main, never a
 * misroute or silence. Uses pi-ai's REAL registry + a mock
 * SecretManager; never the network.
 * @module
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  registerImagesApiProvider,
  getImagesApiProvider,
  type AssistantImages,
} from "@earendil-works/pi-ai";
import type {
  ImageGenerationConfig,
  ImageGenerationPort,
  OAuthTokenManager,
  SecretManager,
} from "@comis/core";
import { ok } from "@comis/shared";
import { createImageProviderSelector } from "./setup-image-provider.js";
import { registerComisImageProviders } from "../api/pi-image-adapter.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

/** A SecretManager exposing only the supplied keys. */
function mockSecretManager(keys: Record<string, string>): SecretManager {
  return {
    get: (k: string) => keys[k],
    has: (k: string) => keys[k] !== undefined,
    require: (k: string) => {
      const v = keys[k];
      if (v === undefined) throw new Error(`missing ${k}`);
      return v;
    },
    keys: () => Object.keys(keys),
  };
}

/** A minimal valid ImageGenerationConfig with overridable provider. */
function makeConfig(overrides: Partial<ImageGenerationConfig> = {}): ImageGenerationConfig {
  return {
    provider: "auto",
    safetyChecker: true,
    maxPerHour: 10,
    defaultSize: "1024x1024",
    timeoutMs: 60_000,
    fallbackChain: [],
    ...overrides,
  } as ImageGenerationConfig;
}

/** A legacy (fal/openai) skills adapter stand-in. */
function legacyAdapter(): ImageGenerationPort {
  return { id: "fal", isAvailable: () => true, execute: vi.fn() };
}

/**
 * A mock OAuthTokenManager exposing only the two methods the codex selector
 * touches: `hasCredentials` (the codex-aware credsAvailable seam) and
 * `getApiKey` (the per-call bearer the codex adapter would resolve on execute).
 * Defaults: logged-in (hasCredentials → true, getApiKey → a fake bearer). The
 * codex routing assertions only need `hasCredentials`; `getApiKey` is provided
 * so a downstream `execute()` would not throw on an absent method.
 */
function mockOauthManager(
  over: { hasCredentials?: ReturnType<typeof vi.fn>; getApiKey?: ReturnType<typeof vi.fn> } = {},
): OAuthTokenManager {
  return {
    hasCredentials: over.hasCredentials ?? vi.fn().mockReturnValue(true),
    getApiKey: over.getApiKey ?? vi.fn().mockResolvedValue(ok("fake.bearer.jwt")),
  } as unknown as OAuthTokenManager;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Register a fake transport over the built-in openrouter-images api so the
  // pi-adapter path resolves without the network. The built-in is auto-
  // registered by pi-ai on import; re-registering with our fake is idempotent.
  const fakeGen = vi.fn(
    async (): Promise<AssistantImages> =>
      ({
        stopReason: "stop",
        output: [{ type: "image", data: Buffer.from("PNG").toString("base64"), mimeType: "image/png" }],
        model: "black-forest-labs/flux.2-pro",
        provider: "openrouter",
      }) as unknown as AssistantImages,
  );
  registerImagesApiProvider({ api: "openrouter-images", generateImages: fakeGen } as never);
});

describe("createImageProviderSelector", () => {
  it("follows the main provider to the openrouter pi-adapter when provider is auto", () => {
    const selector = createImageProviderSelector({
      imageGenConfig: makeConfig({ provider: "auto" }),
      secretManager: mockSecretManager({ OPENROUTER_API_KEY: "sk-or-123" }),
      mainProviderId: "openrouter",
      legacyGetter: () => legacyAdapter(),
      logger: createMockLogger() as never,
    });

    const provider = selector();
    expect(provider).toBeDefined();
    // Follow-main: the pi-adapter id is the resolved provider, NOT "fal".
    expect(provider!.id).toBe("openrouter");
  });

  it("honors an explicit openrouter override over a different main provider", () => {
    const selector = createImageProviderSelector({
      imageGenConfig: makeConfig({ provider: "openrouter" }),
      secretManager: mockSecretManager({ OPENROUTER_API_KEY: "sk-or-123" }),
      mainProviderId: "anthropic", // image-incapable main, but explicit wins
      legacyGetter: () => legacyAdapter(),
      logger: createMockLogger() as never,
    });

    const provider = selector();
    expect(provider).toBeDefined();
    expect(provider!.id).toBe("openrouter");
  });

  it("returns an honest-unavailable port for an image-incapable main provider", async () => {
    const selector = createImageProviderSelector({
      imageGenConfig: makeConfig({ provider: "auto" }),
      secretManager: mockSecretManager({}), // no keys
      mainProviderId: "anthropic", // image-incapable
      legacyGetter: () => legacyAdapter(),
      logger: createMockLogger() as never,
    });

    const provider = selector();
    // NOT a fal/openai fallback, NOT undefined — an unavailable PORT.
    expect(provider).toBeDefined();
    expect(provider!.isAvailable()).toBe(false);
    const result = await provider!.execute({ prompt: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The err carries the knob-naming hint (handler surfaces it via extractImageHint).
      const hint = (result.error as { hint?: string }).hint;
      expect(hint).toBeDefined();
      expect(hint).toContain("integrations.media.imageGeneration.provider");
    }
  });

  it("emits a once-per-resolution INFO follow-main skip summary at the default log level", () => {
    const logger = createMockLogger();
    const selector = createImageProviderSelector({
      imageGenConfig: makeConfig({ provider: "auto", fallbackChain: [] }),
      secretManager: mockSecretManager({}), // no creds for the (incapable) main
      mainProviderId: "anthropic", // image-incapable main
      legacyGetter: () => legacyAdapter(),
      logger: logger as never,
    });

    selector();
    // The follow-main skip narrative must be visible WITHOUT logLevel:debug —
    // an operator reading default-level logs sees why the resolution went
    // unavailable (§2.7 "load-bearing evidence was DEBUG-only").
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: expect.stringContaining("follow-main skipped"),
        step: "image_follow_main_skip",
      }),
      expect.any(String),
    );
  });

  it("keeps per-fallback-entry skips at DEBUG (only the follow-main summary is promoted)", () => {
    const logger = createMockLogger();
    const selector = createImageProviderSelector({
      // A fallback chain whose entries cannot serve → per-entry DEBUG skips,
      // then exhausted → honest-unavailable.
      imageGenConfig: makeConfig({ provider: "auto", fallbackChain: ["openrouter"] }),
      secretManager: mockSecretManager({}), // no creds anywhere
      mainProviderId: "anthropic",
      legacyGetter: () => legacyAdapter(),
      logger: logger as never,
    });

    selector();
    // The follow-main summary is INFO …
    const infoFollowMain = (logger.info as ReturnType<typeof vi.fn>).mock.calls.some(
      ([payload]) =>
        typeof (payload as { reason?: string })?.reason === "string" &&
        (payload as { reason: string }).reason.includes("follow-main skipped"),
    );
    expect(infoFollowMain).toBe(true);
    // … but a per-fallback-entry skip stays DEBUG (not promoted to INFO).
    const infoFallbackEntry = (logger.info as ReturnType<typeof vi.fn>).mock.calls.some(
      ([payload]) =>
        typeof (payload as { reason?: string })?.reason === "string" &&
        (payload as { reason: string }).reason.includes('fallback "openrouter" skipped'),
    );
    expect(infoFallbackEntry).toBe(false);
    const debugFallbackEntry = (logger.debug as ReturnType<typeof vi.fn>).mock.calls.some(
      ([payload]) =>
        typeof (payload as { reason?: string })?.reason === "string" &&
        (payload as { reason: string }).reason.includes('fallback "openrouter" skipped'),
    );
    expect(debugFallbackEntry).toBe(true);
  });

  it("returns the legacy skills adapter for an explicit fal provider", () => {
    const legacy = legacyAdapter();
    const selector = createImageProviderSelector({
      imageGenConfig: makeConfig({ provider: "fal" }),
      secretManager: mockSecretManager({ FAL_KEY: "fal-123" }),
      mainProviderId: "openrouter",
      legacyGetter: () => legacy,
      logger: createMockLogger() as never,
    });

    const provider = selector();
    // Explicit fal/openai → the EXISTING skills adapter (additive legacy path).
    expect(provider).toBe(legacy);
  });

  it("resolves the openrouter key from SecretManager with no image-specific secret", async () => {
    // ONLY OPENROUTER_API_KEY present — no FAL_KEY / OPENAI_API_KEY.
    const selector = createImageProviderSelector({
      imageGenConfig: makeConfig({ provider: "auto" }),
      secretManager: mockSecretManager({ OPENROUTER_API_KEY: "sk-or-456" }),
      mainProviderId: "openrouter",
      legacyGetter: () => legacyAdapter(),
      logger: createMockLogger() as never,
    });

    const provider = selector();
    expect(provider).toBeDefined();
    expect(provider!.id).toBe("openrouter");
    // The adapter is usable — the key reached the (fake) transport, proving
    // image creds come from the same store, no image-specific secret.
    const result = await provider!.execute({ prompt: "a cat" });
    expect(result.ok).toBe(true);
  });

  it("WARNs (naming the model + knob + errorKind) when the configured model is not in the openrouter catalog", async () => {
    const logger = createMockLogger();
    const selector = createImageProviderSelector({
      // A model id guaranteed NOT to exist in the openrouter image catalog.
      imageGenConfig: makeConfig({ provider: "auto", model: "totally-not-a-real-image-model" }),
      secretManager: mockSecretManager({ OPENROUTER_API_KEY: "sk-or-123" }),
      mainProviderId: "openrouter",
      legacyGetter: () => legacyAdapter(),
      logger: logger as never,
    });

    const provider = selector();
    expect(provider).toBeDefined();
    // Without this, the operator's explicit (typo'd / future) model choice would
    // be silently discarded; a WARN names the unresolved id, the fallback, the
    // binding knob, and an errorKind so the substitution is not silent.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedModel: "totally-not-a-real-image-model",
        errorKind: "config",
        hint: expect.stringContaining("integrations.media.imageGeneration.model"),
      }),
      expect.stringContaining("not found in catalog"),
    );
    // The adapter still works (falls back to the first catalog model).
    const result = await provider!.execute({ prompt: "a cat" });
    expect(result.ok).toBe(true);
  });

  it("does NOT WARN about model substitution when the configured model IS in the catalog", () => {
    const logger = createMockLogger();
    const selector = createImageProviderSelector({
      // No explicit model → sel.defaultModel (the per-provider default, which
      // IS in the catalog) is used; no substitution, no WARN.
      imageGenConfig: makeConfig({ provider: "auto" }),
      secretManager: mockSecretManager({ OPENROUTER_API_KEY: "sk-or-123" }),
      mainProviderId: "openrouter",
      legacyGetter: () => legacyAdapter(),
      logger: logger as never,
    });

    selector();
    const warnedSubstitution = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.some(
      ([, msg]) => typeof msg === "string" && msg.includes("not found in catalog"),
    );
    expect(warnedSubstitution).toBe(false);
  });

  it("returns undefined when image generation config is absent", () => {
    const selector = createImageProviderSelector({
      imageGenConfig: undefined,
      secretManager: mockSecretManager({}),
      mainProviderId: "openrouter",
      legacyGetter: () => legacyAdapter(),
      logger: createMockLogger() as never,
    });

    expect(selector()).toBeUndefined();
  });
});

/**
 * Codex routing + codex-aware credsAvailable.
 *
 * The selector routes the codex api:
 *  - a resolved `openai-codex` provider builds the per-call-bearer codex
 *    adapter (id "openai-codex"), NOT an honest-unavailable port; and
 *  - codex availability consults `oauthManager.hasCredentials("openai-codex")`,
 *    NOT `resolveImageApiKey`'s SecretManager (the bearer is OAuth, not an env
 *    key) — so a Codex-only agent with NO FAL_KEY/OPENAI_API_KEY/OPENROUTER_API_KEY
 *    resolves available.
 */
describe("createImageProviderSelector codex routing", () => {
  it("Test A: routes a Codex-only agent (provider:auto, main openai-codex, no env keys) to the codex adapter", () => {
    const hasCredentials = vi.fn().mockReturnValue(true);
    const selector = createImageProviderSelector({
      imageGenConfig: makeConfig({ provider: "auto" }),
      // NO FAL_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY — the only
      // credential is the OAuth profile (via the manager below).
      secretManager: mockSecretManager({}),
      mainProviderId: "openai-codex",
      legacyGetter: () => legacyAdapter(),
      logger: createMockLogger() as never,
      oauthManager: mockOauthManager({ hasCredentials }),
      oauthProfiles: { "openai-codex": "default" },
    });

    const provider = selector();
    expect(provider).toBeDefined();
    // The codex adapter id is "openai-codex" — NOT "unavailable", NOT "fal".
    expect(provider!.id).toBe("openai-codex");
    // The codex-aware credsAvailable consulted the OAuth manager,
    // keyed on the OAuth provider id "openai-codex" (NOT the images api).
    expect(hasCredentials).toHaveBeenCalledWith("openai-codex");
  });

  it("Test B: a logged-out Codex agent (hasCredentials → false) returns honest-unavailable, not the adapter", async () => {
    const selector = createImageProviderSelector({
      imageGenConfig: makeConfig({ provider: "auto" }),
      secretManager: mockSecretManager({}),
      mainProviderId: "openai-codex",
      legacyGetter: () => legacyAdapter(),
      logger: createMockLogger() as never,
      oauthManager: mockOauthManager({ hasCredentials: vi.fn().mockReturnValue(false) }),
      oauthProfiles: {},
    });

    const provider = selector();
    expect(provider).toBeDefined();
    // NOT the codex adapter — an honest-unavailable port.
    expect(provider!.id).not.toBe("openai-codex");
    expect(provider!.isAvailable()).toBe(false);
    const result = await provider!.execute({ prompt: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const hint = (result.error as { hint?: string }).hint;
      expect(hint).toContain("integrations.media.imageGeneration.provider");
    }
  });

  it("Test C: an explicit openai-codex override wins over an image-incapable main", () => {
    const selector = createImageProviderSelector({
      imageGenConfig: makeConfig({ provider: "openai-codex" }),
      secretManager: mockSecretManager({}),
      mainProviderId: "anthropic", // image-incapable, but explicit codex wins
      legacyGetter: () => legacyAdapter(),
      logger: createMockLogger() as never,
      oauthManager: mockOauthManager({ hasCredentials: vi.fn().mockReturnValue(true) }),
      oauthProfiles: { "openai-codex": "work" },
    });

    const provider = selector();
    expect(provider).toBeDefined();
    expect(provider!.id).toBe("openai-codex");
  });

  it("Test D: a resolved google provider ROUTES to the pi-adapter (id \"google\", available)", () => {
    // provider:"google" → IMAGE_CAPABILITY["google"].imagesApi === "google-images",
    // which is wired — the not-yet-wired guard does not fire; the selector
    // builds a createPiImageAdapter over GOOGLE_IMAGE_MODEL with the env key.
    // The key is GOOGLE_API_KEY (the resolver's google key), so a
    // GOOGLE_API_KEY-only google main resolves AVAILABLE.
    const selector = createImageProviderSelector({
      imageGenConfig: makeConfig({ provider: "google" }),
      secretManager: mockSecretManager({ GOOGLE_API_KEY: "g-123" }), // the google env key
      mainProviderId: "google",
      legacyGetter: () => legacyAdapter(),
      logger: createMockLogger() as never,
      // A manager is present, but it must NOT route google to the codex adapter.
      oauthManager: mockOauthManager({ hasCredentials: vi.fn().mockReturnValue(true) }),
      oauthProfiles: {},
    });

    const provider = selector();
    expect(provider).toBeDefined();
    // The pi-adapter id is the resolved provider "google" — NOT "openai-codex",
    // NOT "unavailable", NOT "fal".
    expect(provider!.id).toBe("google");
    expect(provider!.isAvailable()).toBe(true);
  });

  it("Test E: no oauthManager (undefined) → codex credsAvailable is false → honest-unavailable, never a crash", async () => {
    const selector = createImageProviderSelector({
      imageGenConfig: makeConfig({ provider: "auto" }),
      secretManager: mockSecretManager({}),
      mainProviderId: "openai-codex",
      legacyGetter: () => legacyAdapter(),
      logger: createMockLogger() as never,
      // oauthManager intentionally omitted (undefined).
    });

    const provider = selector();
    expect(provider).toBeDefined();
    // credsAvailable("openai-codex-images") === (undefined?.hasCredentials ?? false)
    // → false → resolver reports unavailable → honest-unavailable port (no throw).
    expect(provider!.id).not.toBe("openai-codex");
    expect(provider!.isAvailable()).toBe(false);
    const result = await provider!.execute({ prompt: "x" });
    expect(result.ok).toBe(false);
  });

  it("Test F: no regression — openrouter follow-main still routes to the openrouter pi-adapter (codex branch must not intercept it)", () => {
    const selector = createImageProviderSelector({
      imageGenConfig: makeConfig({ provider: "auto" }),
      secretManager: mockSecretManager({ OPENROUTER_API_KEY: "sk-or-789" }),
      mainProviderId: "openrouter",
      legacyGetter: () => legacyAdapter(),
      logger: createMockLogger() as never,
      // A codex manager present but the openrouter path must be untouched.
      oauthManager: mockOauthManager(),
      oauthProfiles: {},
    });

    const provider = selector();
    expect(provider).toBeDefined();
    expect(provider!.id).toBe("openrouter");
  });

  it("Test H (the cold-cache bug): a store-backed Codex login (codexCredentialsAvailable=true) routes to the codex adapter even when the sync cache says no", () => {
    // The reported production bug: a Codex agent's images were honest-unavailable
    // at boot because the gate used the sync, cache-only hasCredentials (cold at
    // boot in encrypted-store mode, where the login lives in the persisted store).
    // The fix threads a STORE-AWARE flag (resolved by buildImageGenBundle via
    // hasStoredCredentials) that the gate honors. Here the sync hasCredentials
    // says FALSE (cold cache) but the store-aware flag is TRUE → the selector
    // MUST route to the codex adapter, NOT the honest-unavailable port.
    const selector = createImageProviderSelector({
      imageGenConfig: makeConfig({ provider: "auto" }),
      secretManager: mockSecretManager({}), // no env keys
      mainProviderId: "openai-codex",
      legacyGetter: () => legacyAdapter(),
      logger: createMockLogger() as never,
      // Cache cold: the sync gate would say "no creds" …
      oauthManager: mockOauthManager({ hasCredentials: vi.fn().mockReturnValue(false) }),
      oauthProfiles: { "openai-codex": "default" },
      // … but the store-aware probe found the logged-in profile.
      codexCredentialsAvailable: true,
    });

    const provider = selector();
    expect(provider).toBeDefined();
    expect(provider!.id).toBe("openai-codex");
  });

  it("Test I (the HTTP-400 fix): the codex request uses the agent's CHAT model (codexChatModelId), NOT the invalid 'gpt-image-1'", async () => {
    // VERIFIED LIVE: the Codex Responses endpoint rejects model:"gpt-image-1"
    // (an image-API model) with HTTP 400 — it needs a CHAT model + the
    // image_generation TOOL. The selector must thread the resolved chat model
    // into the codex adapter so the request body carries it.
    let capturedModelId: string | undefined;
    registerImagesApiProvider({
      api: "openai-codex-images",
      generateImages: async (model) => {
        capturedModelId = model.id;
        return {
          api: model.api,
          provider: model.provider,
          model: model.id,
          output: [{ type: "image", data: Buffer.from("PNG").toString("base64"), mimeType: "image/png" }],
          stopReason: "stop",
          timestamp: 0,
        } as unknown as AssistantImages;
      },
    } as never);
    const selector = createImageProviderSelector({
      imageGenConfig: makeConfig({ provider: "auto" }),
      secretManager: mockSecretManager({}),
      mainProviderId: "openai-codex",
      legacyGetter: () => legacyAdapter(),
      logger: createMockLogger() as never,
      oauthManager: mockOauthManager({ hasCredentials: vi.fn().mockReturnValue(true) }),
      oauthProfiles: { "openai-codex": "default" },
      codexCredentialsAvailable: true,
      codexChatModelId: "gpt-5.5",
    });

    const provider = selector();
    expect(provider!.id).toBe("openai-codex");
    await provider!.execute({ prompt: "x" });
    // The request used the agent's CHAT model — NOT the 400-causing gpt-image-1.
    expect(capturedModelId).toBe("gpt-5.5");
  });
});

/**
 * openai-images / google-images selector wiring.
 *
 * The selector wires the two apis so a resolved `openai`/`google` main builds a
 * `createPiImageAdapter` (env-key creds via `resolveImageApiKey`), NOT an
 * honest-unavailable port. Distinct from codex (which needs the per-call OAuth
 * bearer): openai/google use a static env key resolved once at boot. Key-auth
 * `openai` (`openai-images`) and `openai-codex` (`openai-codex-images`) are
 * DISTINCT transports and must not collide.
 */
describe("createImageProviderSelector openai/google routing (wiring keystone)", () => {
  it("Test E: an openai main (OPENAI_API_KEY) routes to the pi-adapter (id \"openai\", available)", () => {
    const selector = createImageProviderSelector({
      imageGenConfig: makeConfig({ provider: "auto" }),
      secretManager: mockSecretManager({ OPENAI_API_KEY: "sk-openai-123" }),
      mainProviderId: "openai",
      legacyGetter: () => legacyAdapter(),
      logger: createMockLogger() as never,
    });

    const provider = selector();
    expect(provider).toBeDefined();
    // The pi-adapter id is OPENAI_IMAGE_MODEL.provider === "openai" — NOT the
    // not-yet-wired "unavailable" guard, NOT "fal", NOT "openai-codex".
    expect(provider!.id).toBe("openai");
    expect(provider!.isAvailable()).toBe(true);
  });

  it("Test E2: an explicit openai-images / google-images model override is threaded onto the adapter (sel.model wins)", () => {
    // The selector threads sel.model (the tool/config override) onto the
    // hand-built model literal; the adapter id stays the provider (openai).
    const selector = createImageProviderSelector({
      imageGenConfig: makeConfig({ provider: "auto", model: "gpt-image-1.5" }),
      secretManager: mockSecretManager({ OPENAI_API_KEY: "sk-openai-123" }),
      mainProviderId: "openai",
      legacyGetter: () => legacyAdapter(),
      logger: createMockLogger() as never,
    });

    const provider = selector();
    expect(provider).toBeDefined();
    expect(provider!.id).toBe("openai");
    expect(provider!.isAvailable()).toBe(true);
  });

  it("Test F (source guard): registerComisImageProviders registers BOTH new apis AND the selector builds the adapter (not the guard)", () => {
    // Built-but-not-wired guard: the two
    // transports are only DONE when (1) getImagesApiProvider(api) round-trips
    // after registerComisImageProviders() AND (2) the LIVE selector builds the
    // adapter for each (NOT makeUnavailableImagePort).
    registerComisImageProviders();
    expect(getImagesApiProvider("openai-images")).toBeDefined();
    expect(getImagesApiProvider("google-images")).toBeDefined();

    // (2) the selector routes each to a built adapter whose id is the provider
    // (NOT "unavailable").
    const openai = createImageProviderSelector({
      imageGenConfig: makeConfig({ provider: "openai" }),
      secretManager: mockSecretManager({ OPENAI_API_KEY: "sk-openai-123" }),
      mainProviderId: "openai",
      legacyGetter: () => legacyAdapter(),
      logger: createMockLogger() as never,
    })();
    expect(openai!.id).toBe("openai");
    expect(openai!.id).not.toBe("unavailable");

    const google = createImageProviderSelector({
      imageGenConfig: makeConfig({ provider: "google" }),
      secretManager: mockSecretManager({ GOOGLE_API_KEY: "g-123" }),
      mainProviderId: "google",
      legacyGetter: () => legacyAdapter(),
      logger: createMockLogger() as never,
    })();
    expect(google!.id).toBe("google");
    expect(google!.id).not.toBe("unavailable");
  });

  it("Test G: key-auth openai and openai-codex resolve DISTINCT transports — no collision", () => {
    // An `openai` main resolves the env-key openai-images path and NEVER
    // consults the OAuth manager …
    const oauthHasCreds = vi.fn().mockReturnValue(true);
    const openaiKeyAuth = createImageProviderSelector({
      imageGenConfig: makeConfig({ provider: "auto" }),
      secretManager: mockSecretManager({ OPENAI_API_KEY: "sk-openai-123" }),
      mainProviderId: "openai",
      legacyGetter: () => legacyAdapter(),
      logger: createMockLogger() as never,
      oauthManager: mockOauthManager({ hasCredentials: oauthHasCreds }),
      oauthProfiles: { "openai-codex": "default" },
    })();
    expect(openaiKeyAuth!.id).toBe("openai");
    // The env-key openai path must NOT trigger the codex hasCredentials seam.
    expect(oauthHasCreds).not.toHaveBeenCalledWith("openai-codex");

    // … and an `openai-codex` main resolves the OAuth codex path (id
    // "openai-codex") with NO OPENAI_API_KEY in the SecretManager — proving the
    // two are distinct (the codex bearer is OAuth, not the env key).
    const codexHasCreds = vi.fn().mockReturnValue(true);
    const codexAuth = createImageProviderSelector({
      imageGenConfig: makeConfig({ provider: "auto" }),
      secretManager: mockSecretManager({}), // NO OPENAI_API_KEY
      mainProviderId: "openai-codex",
      legacyGetter: () => legacyAdapter(),
      logger: createMockLogger() as never,
      oauthManager: mockOauthManager({ hasCredentials: codexHasCreds }),
      oauthProfiles: { "openai-codex": "default" },
    })();
    expect(codexAuth!.id).toBe("openai-codex");
    expect(codexHasCreds).toHaveBeenCalledWith("openai-codex");
  });
});

/**
 * Built-but-not-wired guard.
 *
 * Asserts the selector keystone is wired into the LIVE daemon.ts composition
 * root — NOT merely defined where a test imports it. Reads daemon.ts source and
 * proves (1) the accessor delegates to resolveAgentModel (the lockstep), and
 * (2) `resolveAgentMainProvider` appears INSIDE the LIVE `imageHandlerDeps`
 * object literal region, and (3) the boot probe wires the selector +
 * registerComisImageProviders. A parallel copy / a stranded accessor would
 * fail this. (The daemon build is the type-level twin: the now-required field
 * forces the literal to supply it.)
 */
describe("The selector keystone is wired into the LIVE daemon.ts composition root", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const daemonSrc = readFileSync(resolve(here, "../daemon.ts"), "utf8");
  const toolingSrc = readFileSync(
    resolve(here, "./setup-agents/setup-agents-tooling.ts"),
    "utf8",
  );
  // The image-gen boot wiring (selector + registerComisImageProviders) was
  // extracted from daemon.ts into wiring/main-helpers.ts (buildImageGenBundle)
  // to keep the composition root under its architecture line cap; daemon.ts
  // calls the helper.
  const helpersSrc = readFileSync(resolve(here, "./main-helpers.ts"), "utf8");

  it("delegates the handler accessor to the pure resolveAgentMainProvider helper, threading the configurable defaultAgentId", () => {
    // The accessor is a thin local closure that delegates to the extracted,
    // unit-tested resolveAgentMainProvider helper — passing c.defaultAgentId
    // (the operator-configurable default), NOT a literal "default" fallback.
    expect(daemonSrc).toMatch(/const resolveAgentMainProviderFor\s*=/);
    const accessor = daemonSrc.slice(
      daemonSrc.indexOf("const resolveAgentMainProviderFor ="),
      daemonSrc.indexOf("const resolveAgentMainProviderFor =") + 260,
    );
    expect(accessor).toContain("resolveAgentMainProvider(");
    expect(accessor).toContain("c.defaultAgentId");
    // Regression guard: the broken literal-"default" fallback is gone.
    expect(accessor).not.toContain('agents["default"]');
  });

  it("keeps the lockstep: resolveAgentMainProvider delegates to the EXACT completion-path resolveAgentModel", () => {
    // The lockstep MECHANISM now lives in the helper (co-located with
    // resolveAgentModel), not inlined in daemon.ts. It must still call the
    // EXACT completion-path resolver so the image path can never disagree.
    const helper = toolingSrc.slice(
      toolingSrc.indexOf("export function resolveAgentMainProvider("),
      toolingSrc.indexOf("export function resolveAgentMainProvider(") + 600,
    );
    expect(helper).toContain("resolveAgentModel(");
    expect(helper).toContain("providerId");
    // Fallback keys off defaultAgentId, not the literal "default".
    expect(helper).toContain("agents[defaultAgentId]");
  });

  it("threads resolveAgentMainProvider INTO the live imageHandlerDeps object literal", () => {
    // The imageHandlerDeps construction lives in
    // buildImageHandlerDeps (main-helpers.ts) to relieve the line cap. The
    // selector keystone must still be threaded INTO the live composition root:
    //   (a) daemon.ts passes the per-request resolver into the helper call, and
    //   (b) the helper's returned literal threads it as resolveAgentMainProvider
    //       alongside getChannelAdapter.
    // daemon.ts side: the resolver is the argument to the extracted helper.
    const callStart = daemonSrc.indexOf("const imageHandlerDeps");
    expect(callStart).toBeGreaterThan(-1);
    const callRegion = daemonSrc.slice(callStart, callStart + 120);
    expect(callRegion).toContain("buildImageHandlerDeps(c, resolveAgentMainProviderFor)");

    // helper side: the literal threads resolveAgentMainProvider + getChannelAdapter.
    const litStart = helpersSrc.indexOf("export function buildImageHandlerDeps");
    expect(litStart).toBeGreaterThan(-1);
    const region = helpersSrc.slice(litStart, litStart + 1400);
    expect(region).toContain("getChannelAdapter");
    expect(region).toContain("resolveAgentMainProvider");
  });

  it("wires the selector + registerComisImageProviders at the boot probe (in buildImageGenBundle)", () => {
    // daemon.ts delegates the boot probe to the extracted helper …
    expect(daemonSrc).toContain("buildImageGenBundle({");
    // … and the helper does the actual selector + registration wiring,
    // following the DEFAULT agent's resolved main provider.
    expect(helpersSrc).toContain("createImageProviderSelector({");
    expect(helpersSrc).toContain("registerComisImageProviders()");
    expect(helpersSrc).toMatch(/mainProviderId:\s*defaultMain/);
  });

  it("threads the DEFAULT agent's oauthManager into the LIVE buildImageGenBundle call (built-but-not-wired guard)", () => {
    // The composition-root threading gap: the per-agent OAuthTokenManager must
    // reach the image selector through the LIVE daemon.ts wiring — not just be
    // defined where a test imports it. A parallel copy / a stranded manager
    // would fail this (a built-but-not-wired regression).
    // (1) daemon.ts surfaces oauthManagers from setupAgents …
    expect(daemonSrc).toContain("oauthManagers");
    // (2) … and threads the DEFAULT agent's manager into the LIVE bundle call.
    const callStart = daemonSrc.indexOf("buildImageGenBundle({");
    expect(callStart).toBeGreaterThan(-1);
    const callRegion = daemonSrc.slice(callStart, callStart + 200);
    expect(callRegion).toMatch(/oauthManager:\s*[\w.]*oauthManagers\.get\(defaultAgentId\)/);
  });

  it("buildImageGenBundle threads oauthManager + oauthProfiles into the LIVE selector call", () => {
    // main-helpers.ts must pass the manager + the DEFAULT agent's profiles into
    // createImageProviderSelector — else the codex credsAvailable/adapter never
    // sees a manager and a Codex agent boots honest-unavailable despite login.
    const selStart = helpersSrc.indexOf("createImageProviderSelector({");
    expect(selStart).toBeGreaterThan(-1);
    // Span to the call's closing `});` so inline comments inside the object
    // literal cannot push the asserted fields out of the captured region.
    const selEnd = helpersSrc.indexOf("});", selStart);
    expect(selEnd).toBeGreaterThan(selStart);
    const selRegion = helpersSrc.slice(selStart, selEnd);
    expect(selRegion).toContain("oauthManager");
    expect(selRegion).toMatch(/oauthProfiles:\s*[\w.?]*oauthProfiles/);
    // The HTTP-400 fix: the resolved CHAT model must be threaded to the codex
    // image path (else it falls back to the 400-causing gpt-image-1). A stranded
    // thread would leave a Codex agent's images broken despite the availability fix.
    expect(selRegion).toContain("codexChatModelId");
  });

  it("buildImageGenBundle resolves Codex availability from the STORE (hasStoredCredentials), not the cold cache (the cold-cache bug fix)", () => {
    // The fix: the boot probe must consult the PERSISTED store (store-aware) so
    // a logged-in Codex profile counts as available even with a cold in-memory
    // cache at boot. main-helpers must (1) call hasStoredCredentials("openai-codex")
    // and (2) thread the resolved flag into the selector as codexCredentialsAvailable.
    // A parallel copy / a stranded resolution would fail this guard (a
    // built-but-not-wired regression; the original bug was exactly a gate that
    // used the cold-cache-only hasCredentials).
    expect(helpersSrc).toContain('hasStoredCredentials("openai-codex")');
    const selStart = helpersSrc.indexOf("createImageProviderSelector({");
    const selEnd = helpersSrc.indexOf("});", selStart);
    const selRegion = helpersSrc.slice(selStart, selEnd);
    expect(selRegion).toContain("codexCredentialsAvailable");
  });
});
