// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the pi-ai image shim (PI-01/02/03/04 + CRED-01 resolution half).
 *
 * Uses pi-ai's REAL image-api registry (`registerImagesApiProvider` /
 * `getImagesApiProvider`) plus fake providers — never the network. The single
 * `generateImages()` call site (I1) is exercised through `createPiImageAdapter`.
 * @module
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  registerImagesApiProvider,
  getImagesApiProvider,
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
