// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the RES-02 image-provider selector (setup-image-provider.ts).
 *
 * The selector decides, per the resolved config + the agent's main provider,
 * between the pi-image-adapter (provider:"auto"/openrouter) and the relegated
 * skills adapter (explicit fal/openai) — and returns an honest-unavailable
 * port (carrying the knob-naming hint) for an image-incapable main, never a
 * misroute or silence (RES-03). Uses pi-ai's REAL registry + a mock
 * SecretManager; never the network.
 * @module
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  registerImagesApiProvider,
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
    // RES-02 follow-main: the pi-adapter id is the resolved provider, NOT "fal".
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
    // RES-03: NOT a fal/openai fallback, NOT undefined — an unavailable PORT.
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

  it("emits a once-per-resolution INFO follow-main skip summary at the default log level (WR-04)", () => {
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

  it("keeps per-fallback-entry skips at DEBUG (only the follow-main summary is promoted) (WR-04)", () => {
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

  it("resolves the openrouter key from SecretManager with no image-specific secret (CRED-01)", async () => {
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

  it("WARNs (naming the model + knob + errorKind) when the configured model is not in the openrouter catalog (WR-02)", async () => {
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
    // The operator's explicit (typo'd / future) model choice was silently
    // discarded pre-fix; now a WARN names the unresolved id, the fallback, the
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

  it("does NOT WARN about model substitution when the configured model IS in the catalog (WR-02)", () => {
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
 * Phase 184 — codex routing + codex-aware credsAvailable (CRED-01).
 *
 * The selector must flip the 183 not-yet-wired guard for the codex api:
 *  - a resolved `openai-codex` provider builds the per-call-bearer codex
 *    adapter (id "openai-codex"), NOT an honest-unavailable port; and
 *  - codex availability consults `oauthManager.hasCredentials("openai-codex")`,
 *    NOT `resolveImageApiKey`'s SecretManager (the bearer is OAuth, not an env
 *    key) — so a Codex-only agent with NO FAL_KEY/OPENAI_API_KEY/OPENROUTER_API_KEY
 *    resolves available (CRED-01).
 * `openai-images`/`google-images` STAY honest-unavailable (they land in 185).
 */
describe("createImageProviderSelector codex routing (CDX-01 wiring + CRED-01)", () => {
  it("Test A: routes a Codex-only agent (provider:auto, main openai-codex, no env keys) to the codex adapter", () => {
    const hasCredentials = vi.fn().mockReturnValue(true);
    const selector = createImageProviderSelector({
      imageGenConfig: makeConfig({ provider: "auto" }),
      // CRED-01: NO FAL_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY — the only
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
    // The codex-aware credsAvailable consulted the OAuth manager (CRED-01),
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

  it("Test D: a resolved google provider STAYS honest-unavailable (no scope creep into 185)", async () => {
    // provider:"google" → IMAGE_CAPABILITY["google"].imagesApi === "google-images",
    // which is NOT wired in 184 — the not-yet-wired guard must still fire (the
    // codex branch is keyed EXACTLY on "openai-codex-images").
    const selector = createImageProviderSelector({
      imageGenConfig: makeConfig({ provider: "google" }),
      secretManager: mockSecretManager({ GEMINI_API_KEY: "g-123" }), // creds present
      mainProviderId: "openai-codex",
      legacyGetter: () => legacyAdapter(),
      logger: createMockLogger() as never,
      // A manager is present, but it must NOT route google to the codex adapter.
      oauthManager: mockOauthManager({ hasCredentials: vi.fn().mockReturnValue(true) }),
      oauthProfiles: {},
    });

    const provider = selector();
    expect(provider).toBeDefined();
    expect(provider!.id).not.toBe("openai-codex");
    expect(provider!.isAvailable()).toBe(false);
    const result = await provider!.execute({ prompt: "x" });
    expect(result.ok).toBe(false);
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
});

/**
 * Built-but-not-wired guard (the milestone's #1 recurring blocker).
 *
 * Asserts the RES-01 keystone is wired into the LIVE daemon.ts composition
 * root — NOT merely defined where a test imports it. Reads daemon.ts source and
 * proves (1) the accessor delegates to resolveAgentModel (I4 lockstep), and
 * (2) `resolveAgentMainProvider` appears INSIDE the LIVE `imageHandlerDeps`
 * object literal region, and (3) the boot probe wires the selector +
 * registerComisImageProviders. A parallel copy / a stranded accessor would
 * fail this. (The daemon build is the type-level twin: the now-required field
 * forces the literal to supply it.)
 */
describe("RES-01 keystone is wired into the LIVE daemon.ts composition root", () => {
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

  it("delegates the handler accessor to the pure resolveAgentMainProvider helper, threading the configurable defaultAgentId (WR-01)", () => {
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
    // WR-01 regression guard: the broken literal-"default" fallback is gone.
    expect(accessor).not.toContain('agents["default"]');
  });

  it("keeps the I4 lockstep: resolveAgentMainProvider delegates to the EXACT completion-path resolveAgentModel", () => {
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
    // Locate the imageHandlerDeps construction region and assert the field is
    // inside it (not just somewhere in the file).
    const start = daemonSrc.indexOf("const imageHandlerDeps");
    expect(start).toBeGreaterThan(-1);
    const region = daemonSrc.slice(start, start + 900);
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
});
