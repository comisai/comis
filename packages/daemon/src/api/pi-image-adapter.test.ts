// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the pi-ai image shim (PI-01/02/03/04 + CRED-01 resolution half).
 *
 * Uses pi-ai's REAL image-api registry (`registerImagesApiProvider` /
 * `getImagesApiProvider`) plus fake providers — never the network. The single
 * `generateImages()` call site (I1) is exercised through `createPiImageAdapter`.
 * @module
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  registerImagesApiProvider,
  getImagesApiProvider,
  getImageModel,
  type AssistantImages,
  type ImagesContext,
  type ImagesModel,
  type ImagesOptions,
} from "@earendil-works/pi-ai";
import type { ImageErrorKind } from "@comis/core";
import { makeMockLogger } from "../../../../test/support/mock-logger.js";
import {
  createPiImageAdapter,
  registerComisImageProviders,
  resolveImageApiKey,
  ImageGenError,
} from "./pi-image-adapter.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_API = "comis-test-images";

/**
 * Build a minimal valid `ImagesModel` for a given api. The pi-ai registry's
 * `wrapGenerateImages` guard rejects a model whose `.api` does not match the
 * registered provider's api, so this MUST be kept in sync with the registered
 * fake's `api`.
 */
function makeTestModel(api = TEST_API): ImagesModel<typeof api> {
  return {
    id: "test-image-model",
    name: "Test Image Model",
    api,
    provider: "comis-test",
    baseUrl: "https://example.invalid/v1",
    input: ["text"],
    output: ["image", "text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

/** Base64 of the ASCII string "PNGDATA" — proves the base64 round-trip. */
const PNG_B64 = Buffer.from("PNGDATA").toString("base64");

function imagesResult(over: Partial<AssistantImages>): AssistantImages {
  return {
    api: TEST_API,
    provider: "comis-test",
    model: "test-image-model",
    output: [],
    stopReason: "stop",
    timestamp: Date.now(),
    ...over,
  };
}

/**
 * Register a fake provider for {@link TEST_API} that returns a fixed result.
 * Re-registering overwrites the prior entry (registry is a Map keyed by api).
 */
function registerFakeReturning(result: AssistantImages): void {
  registerImagesApiProvider({
    api: TEST_API,
    generateImages: async () => result,
  });
}

// ---------------------------------------------------------------------------
// Task 1 — PI-01: execute() mapping + classification
// ---------------------------------------------------------------------------

describe("createPiImageAdapter execute()", () => {
  let logger: ReturnType<typeof makeMockLogger>;

  beforeEach(() => {
    logger = makeMockLogger();
  });

  it("maps a successful AssistantImages to a buffer + mimeType (base64 round-trip)", async () => {
    registerFakeReturning(
      imagesResult({
        stopReason: "stop",
        output: [{ type: "image", data: PNG_B64, mimeType: "image/png" }],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0.04, cacheRead: 0, cacheWrite: 0, total: 0.04 },
        },
      }),
    );
    const adapter = createPiImageAdapter({ model: makeTestModel(), logger });

    const result = await adapter.execute({ prompt: "a cat" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mimeType).toBe("image/png");
    expect(Buffer.isBuffer(result.value.buffer)).toBe(true);
    expect(result.value.buffer.toString()).toBe("PNGDATA");
  });

  it("classifies a no-key stopReason:error as auth_required (Result err, never a throw)", async () => {
    registerFakeReturning(
      imagesResult({
        stopReason: "error",
        errorMessage: "No API key for provider: openrouter",
        output: [],
      }),
    );
    const adapter = createPiImageAdapter({ model: makeTestModel(), logger });

    const result = await adapter.execute({ prompt: "a cat" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ImageGenError);
    expect((result.error as ImageGenError).imageErrorKind).toBe<ImageErrorKind>("auth_required");
  });

  it("classifies a stop with no image content as empty_response", async () => {
    registerFakeReturning(
      imagesResult({
        stopReason: "stop",
        output: [{ type: "text", text: "sorry, no image" }],
      }),
    );
    const adapter = createPiImageAdapter({ model: makeTestModel(), logger });

    const result = await adapter.execute({ prompt: "a cat" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect((result.error as ImageGenError).imageErrorKind).toBe<ImageErrorKind>("empty_response");
  });

  it("classifies a stopReason:aborted as timeout (abort/signal mapping)", async () => {
    registerFakeReturning(imagesResult({ stopReason: "aborted", output: [] }));
    const adapter = createPiImageAdapter({ model: makeTestModel(), logger });

    const result = await adapter.execute({ prompt: "a cat" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect((result.error as ImageGenError).imageErrorKind).toBe<ImageErrorKind>("timeout");
  });

  it("classifies a safety-system error message as content_blocked", async () => {
    registerFakeReturning(
      imagesResult({
        stopReason: "error",
        errorMessage: "content blocked by safety system",
        output: [],
      }),
    );
    const adapter = createPiImageAdapter({ model: makeTestModel(), logger });

    const result = await adapter.execute({ prompt: "a cat" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect((result.error as ImageGenError).imageErrorKind).toBe<ImageErrorKind>("content_blocked");
  });

  it("returns a Result err when the underlying provider rejects (never propagates the throw)", async () => {
    registerImagesApiProvider({
      api: TEST_API,
      generateImages: async () => {
        throw new Error("network exploded");
      },
    });
    const adapter = createPiImageAdapter({ model: makeTestModel(), logger });

    const result = await adapter.execute({ prompt: "a cat" });

    expect(result.ok).toBe(false);
  });

  it("exposes the model provider as the port id", () => {
    registerFakeReturning(imagesResult({ stopReason: "stop", output: [] }));
    const adapter = createPiImageAdapter({ model: makeTestModel(), logger });
    expect(adapter.id).toBe("comis-test");
    expect(adapter.isAvailable()).toBe(true);
  });

  it("logs a WARN carrying errorKind + imageErrorKind + hint on a classified failure", async () => {
    registerFakeReturning(
      imagesResult({
        stopReason: "error",
        errorMessage: "No API key for provider: openrouter",
        output: [],
      }),
    );
    const adapter = createPiImageAdapter({ model: makeTestModel(), logger });

    await adapter.execute({ prompt: "a cat" });

    const warns = logger._calls("warn");
    expect(warns.length).toBeGreaterThanOrEqual(1);
    const payload = warns[0]!.payload;
    expect(payload.imageErrorKind).toBe("auth_required");
    // log errorKind must be one of the closed log union (auth_required → "auth")
    expect(payload.errorKind).toBe("auth");
    expect(typeof payload.hint).toBe("string");
    expect((payload.hint as string).length).toBeGreaterThan(0);
    // SEC: the resolved key / raw provider errorMessage must not leak into the log payload
    expect(JSON.stringify(payload)).not.toContain("No API key for provider");
  });
});

// ---------------------------------------------------------------------------
// Task 2 — PI-02: registerComisImageProviders + registry round-trip
// ---------------------------------------------------------------------------

describe("registerComisImageProviders", () => {
  it("makes the built-in openrouter-images provider reachable and is idempotent", () => {
    // The built-in is auto-registered on pi-ai import; the boot hook must be
    // callable once-at-boot AND safe to call twice without throwing (PI-02).
    expect(() => registerComisImageProviders()).not.toThrow();
    expect(() => registerComisImageProviders()).not.toThrow();
    expect(getImagesApiProvider("openrouter-images")).toBeDefined();
  });

  it("registers the codex transport so openai-codex-images round-trips (184)", () => {
    // Phase 184 wiring keystone: registerComisImageProviders() must register the
    // custom Codex Responses transport under the "openai-codex-images" api so
    // pi-ai's generateImages() can dispatch to it. Round-trip via
    // getImagesApiProvider (mirrors the PI-02 openrouter round-trip above).
    registerComisImageProviders();
    const codex = getImagesApiProvider("openai-codex-images");
    expect(codex).toBeDefined();
    expect(codex!.api).toBe("openai-codex-images");
    // No regression: the built-in openrouter-images is still reachable.
    expect(getImagesApiProvider("openrouter-images")).toBeDefined();
  });

  // 185 Test B — the built-but-not-wired guard: the two genuinely-new SDK
  // transports must be REGISTERED (not just written) so generateImages()
  // dispatches to them by model.api. This is the milestone's recurring
  // failure-class defense (a transport file that exists but is never wired).
  it("registers the openai-images + google-images transports so both round-trip (185)", () => {
    registerComisImageProviders();

    const openai = getImagesApiProvider("openai-images");
    expect(openai).toBeDefined();
    expect(openai!.api).toBe("openai-images");
    expect(typeof openai!.generateImages).toBe("function");

    const google = getImagesApiProvider("google-images");
    expect(google).toBeDefined();
    expect(google!.api).toBe("google-images");
    expect(typeof google!.generateImages).toBe("function");

    // No regression: the 183/184 registrations stay reachable.
    expect(getImagesApiProvider("openrouter-images")).toBeDefined();
    expect(getImagesApiProvider("openai-codex-images")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Task 2 — PI-03: full ImagesOptions passthrough (the load-bearing assertion)
// ---------------------------------------------------------------------------

describe("createPiImageAdapter ImagesOptions passthrough (PI-03)", () => {
  it("forwards apiKey, headers, signal, timeoutMs, and maxRetries to generateImages", async () => {
    let captured: ImagesOptions | undefined;
    let capturedCtx: ImagesContext | undefined;
    registerImagesApiProvider({
      api: TEST_API,
      generateImages: async (_model, ctx, options) => {
        captured = options;
        capturedCtx = ctx;
        return imagesResult({
          stopReason: "stop",
          output: [{ type: "image", data: PNG_B64, mimeType: "image/png" }],
        });
      },
    });

    const signal = new AbortController().signal;
    const adapter = createPiImageAdapter({
      model: makeTestModel(),
      apiKey: "sk-test",
      headers: { "X-Test": "1" },
      timeoutMs: 12345,
      maxRetries: 3,
      signal,
      logger: makeMockLogger(),
    });

    const result = await adapter.execute({ prompt: "x" });
    expect(result.ok).toBe(true);

    expect(captured).toBeDefined();
    expect(captured!.apiKey).toBe("sk-test");
    expect(captured!.headers).toEqual({ "X-Test": "1" });
    expect(captured!.timeoutMs).toBe(12345);
    expect(captured!.maxRetries).toBe(3);
    expect(captured!.signal).toBe(signal);
    // ImagesContext carries the prompt as a single text input.
    expect(capturedCtx!.input).toEqual([{ type: "text", text: "x" }]);
  });

  // ─── WR-04: thread input.size to the transport (via options.metadata.size) ──
  // and make a non-honoring drop OBSERVABLE (the openai transport honors size;
  // google/openrouter cannot, so an agent-supplied size must not vanish silently).

  it("WR-04: forwards input.size to the transport via options.metadata.size", async () => {
    let captured: ImagesOptions | undefined;
    registerImagesApiProvider({
      api: TEST_API,
      generateImages: async (_model, _ctx, options) => {
        captured = options;
        return imagesResult({
          stopReason: "stop",
          output: [{ type: "image", data: PNG_B64, mimeType: "image/png" }],
        });
      },
    });
    const adapter = createPiImageAdapter({ model: makeTestModel(), logger: makeMockLogger() });

    const result = await adapter.execute({ prompt: "x", size: "1792x1024" });
    expect(result.ok).toBe(true);
    expect(captured!.metadata).toMatchObject({ size: "1792x1024" });
  });

  it("WR-04: WARNs (once) when size is set but the provider cannot honor it (google/openrouter)", async () => {
    const logger = makeMockLogger();
    registerImagesApiProvider({
      api: TEST_API,
      generateImages: async () =>
        imagesResult({ stopReason: "stop", output: [{ type: "image", data: PNG_B64, mimeType: "image/png" }] }),
    });
    // makeTestModel().provider === "comis-test" → NOT an openai-honoring path.
    const adapter = createPiImageAdapter({ model: makeTestModel(), logger });

    await adapter.execute({ prompt: "x", size: "1792x1024" });

    const warned = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.find(
      ([payload]) => (payload as { step?: string }).step === "image_size_unsupported",
    );
    expect(warned).toBeDefined();
    const [payload] = warned as [Record<string, unknown>, string];
    expect(payload.requestedSize).toBe("1792x1024");
    expect(payload.provider).toBe("comis-test");
    expect(payload.errorKind).toBe("config");
    expect(payload.hint).toBeDefined();
  });

  it("WR-04: does NOT WARN about size on the openai path (it honors size)", async () => {
    const logger = makeMockLogger();
    registerImagesApiProvider({
      api: TEST_API,
      generateImages: async () =>
        imagesResult({ stopReason: "stop", output: [{ type: "image", data: PNG_B64, mimeType: "image/png" }] }),
    });
    // An openai-provider model → the transport honors size → no drop WARN.
    const adapter = createPiImageAdapter({ model: { ...makeTestModel(), provider: "openai" }, logger });

    await adapter.execute({ prompt: "x", size: "1792x1024" });

    const warned = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.find(
      ([payload]) => (payload as { step?: string }).step === "image_size_unsupported",
    );
    expect(warned).toBeUndefined();
  });

  it("WR-04: does NOT WARN or set metadata.size when no size is supplied", async () => {
    const logger = makeMockLogger();
    let captured: ImagesOptions | undefined;
    registerImagesApiProvider({
      api: TEST_API,
      generateImages: async (_m, _c, options) => {
        captured = options;
        return imagesResult({ stopReason: "stop", output: [{ type: "image", data: PNG_B64, mimeType: "image/png" }] });
      },
    });
    const adapter = createPiImageAdapter({ model: makeTestModel(), logger });

    await adapter.execute({ prompt: "x" });

    expect((captured!.metadata as { size?: string } | undefined)?.size).toBeUndefined();
    const warned = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.find(
      ([payload]) => (payload as { step?: string }).step === "image_size_unsupported",
    );
    expect(warned).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Task 1 (185-03) — IN-01: referenceImage → ImagesContext.input append
// ---------------------------------------------------------------------------

describe("createPiImageAdapter ImagesContext.input (IN-01 reference append)", () => {
  it("appends the reference ImageContent SECOND when input.referenceImage is present (Test H)", async () => {
    let capturedCtx: ImagesContext | undefined;
    registerImagesApiProvider({
      api: TEST_API,
      generateImages: async (_model, ctx) => {
        capturedCtx = ctx;
        return imagesResult({
          stopReason: "stop",
          output: [{ type: "image", data: PNG_B64, mimeType: "image/png" }],
        });
      },
    });
    const adapter = createPiImageAdapter({ model: makeTestModel(), logger: makeMockLogger() });

    const result = await adapter.execute({
      prompt: "a fox",
      referenceImage: { data: PNG_B64, mimeType: "image/png" },
    });

    expect(result.ok).toBe(true);
    // The text element is FIRST, the reference image SECOND (edit/img2img order).
    expect(capturedCtx!.input).toEqual([
      { type: "text", text: "a fox" },
      { type: "image", data: PNG_B64, mimeType: "image/png" },
    ]);
  });

  it("keeps input EXACTLY [{type:text}] when no referenceImage (no-regression — Pitfall 3, Test I)", async () => {
    // The ImagesContext.input build is SHARED with the openrouter built-in +
    // codex transports. A text-only request must stay byte-identical to today
    // so those paths cannot regress.
    let capturedCtx: ImagesContext | undefined;
    registerImagesApiProvider({
      api: TEST_API,
      generateImages: async (_model, ctx) => {
        capturedCtx = ctx;
        return imagesResult({
          stopReason: "stop",
          output: [{ type: "image", data: PNG_B64, mimeType: "image/png" }],
        });
      },
    });
    const adapter = createPiImageAdapter({ model: makeTestModel(), logger: makeMockLogger() });

    const result = await adapter.execute({ prompt: "a fox" });

    expect(result.ok).toBe(true);
    expect(capturedCtx!.input).toEqual([{ type: "text", text: "a fox" }]);
  });
});

// ---------------------------------------------------------------------------
// Task 2 — PI-04: built-in openrouter-images path end-to-end (MOCKED in CI)
// + CRED-01 resolution half (key via SecretManager, no image-specific secret)
// ---------------------------------------------------------------------------

describe("createPiImageAdapter openrouter path (PI-04 + CRED-01)", () => {
  it("drives getImageModel(openrouter) end-to-end with a mocked transport and a SecretManager key", async () => {
    // Register a fake OVER the built-in openrouter-images transport so the path
    // is deterministic with no network (RESEARCH recommendation b). Capture the
    // apiKey to prove it came from the resolved SecretManager key.
    let seenKey: string | undefined;
    registerImagesApiProvider({
      api: "openrouter-images",
      generateImages: async (_model, _ctx, options) => {
        seenKey = options?.apiKey;
        return {
          api: "openrouter-images",
          provider: "openrouter",
          model: "black-forest-labs/flux.2-pro",
          output: [{ type: "image", data: PNG_B64, mimeType: "image/png" }],
          stopReason: "stop",
          timestamp: Date.now(),
        } satisfies AssistantImages;
      },
    });

    // CRED-01: a SecretManager that has ONLY OPENROUTER_API_KEY — no FAL_KEY,
    // no OPENAI_API_KEY. The image key comes from the SAME store the main
    // provider uses, with no image-specific secret configured.
    const secretManager = {
      get: vi.fn((key: string) => (key === "OPENROUTER_API_KEY" ? "or-key-123" : undefined)),
    };
    const apiKey = resolveImageApiKey("openrouter-images", secretManager);
    expect(apiKey).toBe("or-key-123");
    expect(secretManager.get).toHaveBeenCalledWith("OPENROUTER_API_KEY");

    const model = getImageModel("openrouter", "black-forest-labs/flux.2-pro");
    const adapter = createPiImageAdapter({ model, apiKey, logger: makeMockLogger() });

    const result = await adapter.execute({ prompt: "a watercolor fox" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.buffer.length).toBeGreaterThan(0);
    expect(result.value.mimeType).toMatch(/^image\//);
    expect(seenKey).toBe("or-key-123");
  });

  it("resolveImageApiKey returns undefined for an unknown imagesApi (no image-specific store)", () => {
    const secretManager = { get: vi.fn(() => undefined) };
    expect(resolveImageApiKey("does-not-exist-images", secretManager)).toBeUndefined();
  });

  // 185 Test A — CRED-01 lockstep fix: google-images must resolve GOOGLE_API_KEY
  // (the SAME key the completion path / vision registry / env-vars docs use),
  // NOT GEMINI_API_KEY. Before the fix a GOOGLE_API_KEY-only google agent was
  // reported image-unavailable (the resolver read the wrong env var).
  it("resolveImageApiKey('google-images') reads GOOGLE_API_KEY (CRED-01 lockstep)", () => {
    const secretManager = {
      get: vi.fn((key: string) => (key === "GOOGLE_API_KEY" ? "gk" : undefined)),
    };
    expect(resolveImageApiKey("google-images", secretManager)).toBe("gk");
    expect(secretManager.get).toHaveBeenCalledWith("GOOGLE_API_KEY");
  });

  it("resolveImageApiKey('google-images') no longer reads GEMINI_API_KEY", () => {
    // With ONLY GEMINI_API_KEY set, the resolver returns undefined (it reads
    // GOOGLE_API_KEY now). Pins that the bug key is gone.
    const secretManager = {
      get: vi.fn((key: string) => (key === "GEMINI_API_KEY" ? "old-gemini" : undefined)),
    };
    expect(resolveImageApiKey("google-images", secretManager)).toBeUndefined();
    expect(secretManager.get).not.toHaveBeenCalledWith("GEMINI_API_KEY");
  });

  it("resolveImageApiKey('openai-images') reads OPENAI_API_KEY (unchanged, still correct)", () => {
    const secretManager = {
      get: vi.fn((key: string) => (key === "OPENAI_API_KEY" ? "sk" : undefined)),
    };
    expect(resolveImageApiKey("openai-images", secretManager)).toBe("sk");
    expect(secretManager.get).toHaveBeenCalledWith("OPENAI_API_KEY");
  });

  // PI-04 LIVE opt-in: hits the REAL built-in openrouter-images transport when a
  // key is present. Operator UAT only — CI is NOT gated on OPENROUTER_API_KEY.
  // Env reads are allowed in *.test.ts (the gate test exempts test files);
  // production source resolves creds via SecretManager only.
  it.skipIf(!process.env.OPENROUTER_API_KEY)(
    "LIVE: generates a real image via the built-in openrouter-images path (operator opt-in)",
    async () => {
      // Re-import is unnecessary; the built-in is auto-registered. But a prior
      // test in this file may have registered a fake over openrouter-images, so
      // this LIVE case is best run in isolation. Skipped without a key.
      const model = getImageModel("openrouter", "black-forest-labs/flux.2-pro");
      const adapter = createPiImageAdapter({
        model,
        apiKey: process.env.OPENROUTER_API_KEY,
        logger: makeMockLogger(),
      });
      const result = await adapter.execute({ prompt: "a small red cube on a white background" });
      expect(result.ok).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// Task 2 — PI-02 register-before-call guard (RESEARCH Pitfall 5)
// ---------------------------------------------------------------------------

describe("createPiImageAdapter unregistered api (register-before-call guard)", () => {
  it("surfaces a Result err (not an uncaught throw) for an unregistered api", async () => {
    // pi-ai's generateImages throws `No API provider registered for api: X` for
    // an unregistered api; fromPromise must convert it to a Result err.
    const adapter = createPiImageAdapter({
      model: makeTestModel("comis-unregistered-images"),
      logger: makeMockLogger(),
    });

    const result = await adapter.execute({ prompt: "x" });

    expect(result.ok).toBe(false);
  });
});
