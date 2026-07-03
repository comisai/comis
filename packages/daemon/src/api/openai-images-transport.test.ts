// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the OpenAI Images transport (openai-images-transport.ts).
 *
 * The transport is a pi-ai `ImagesFunction` that constructs an `openai`
 * client from `options.apiKey` and calls `images.generate` (text->image) or
 * `images.edit` (when the context carries an `ImageContent` reference),
 * mapping `data[0].b64_json` -> `AssistantImages.output[0]`.
 *
 * Every test mocks the `openai` MODULE (`vi.mock("openai", ...)`) — NEVER a real
 * `OPENAI_API_KEY`, NEVER the network.
 * The transport NEVER throws out: any miss (no key, SDK throw, empty data) ->
 * `stopReason:"error"` with an `errorMessage` the shipped `classifyImageError`
 * maps. GPT image models always return base64 -> `response_format` is NEVER set.
 * @module
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ImagesModel, ProviderImagesOptions } from "@earendil-works/pi-ai";

// ---------------------------------------------------------------------------
// Mock the openai MODULE — no real key, no network. The default export is the
// OpenAI client constructor; `toFile` is a named export from the package root.
// `generate`/`edit` are controllable vi.fn()s captured per test. The mocks are
// declared via vi.hoisted() so the (hoisted) vi.mock factory can close over
// them — a plain top-level const would be a TDZ ReferenceError at hoist time.
// ---------------------------------------------------------------------------
const { generate, edit, ctor, toFile, MockOpenAI } = vi.hoisted(() => {
  const generate = vi.fn();
  const edit = vi.fn();
  // `ctor` records the constructor args (asserted: constructed with the apiKey).
  const ctor = vi.fn();
  // A class default export (mirrors the in-repo @google/genai mock in
  // gemini-cache-manager.test.ts) so `new OpenAI(...)` constructs cleanly under
  // vitest's ESM default-interop.
  class MockOpenAI {
    images = { generate, edit };
    constructor(args: unknown) {
      ctor(args);
    }
  }
  const toFile = vi.fn();
  return { generate, edit, ctor, toFile, MockOpenAI };
});

vi.mock("openai", () => ({
  default: MockOpenAI,
  toFile,
}));

import { generateImagesOpenAI, OPENAI_IMAGE_MODEL } from "./openai-images-transport.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function openaiModel(): ImagesModel<"openai-images"> {
  return OPENAI_IMAGE_MODEL;
}

/** Base64 of "PNGDATA" — proves the b64 round-trips onto the output. */
const PNG_B64 = Buffer.from("PNGDATA").toString("base64");
const REF_B64 = Buffer.from("REFIMAGE").toString("base64");

const textContext = (text: string) => ({ input: [{ type: "text" as const, text }] });
const editContext = (text: string) => ({
  input: [
    { type: "text" as const, text },
    { type: "image" as const, data: REF_B64, mimeType: "image/png" },
  ],
});
const opts = (over: Partial<ProviderImagesOptions> = {}): ProviderImagesOptions => ({
  apiKey: "sk-test",
  ...over,
});

beforeEach(() => {
  generate.mockReset();
  edit.mockReset();
  ctor.mockClear();
  toFile.mockClear();
  toFile.mockResolvedValue({ __isFile: true });
});

// ---------------------------------------------------------------------------
// Test 1 — generate (text->image)
// ---------------------------------------------------------------------------

describe("generateImagesOpenAI — text-to-image generate", () => {
  it("calls images.generate with the default model and maps b64_json to output[0]", async () => {
    generate.mockResolvedValue({ data: [{ b64_json: PNG_B64 }] });

    const res = await generateImagesOpenAI(openaiModel(), textContext("a fox"), opts());

    expect(res.stopReason).toBe("stop");
    expect(res.output).toEqual([{ type: "image", data: PNG_B64, mimeType: "image/png" }]);
    expect(generate).toHaveBeenCalledTimes(1);
    const args = generate.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.model).toBe("gpt-image-1");
    expect(args.prompt).toBe("a fox");
    expect(args.n).toBe(1);
    expect(args.size).toBe("1024x1024");
    // GPT image models ALWAYS return base64 — response_format is dall-e-only.
    expect(args).not.toHaveProperty("response_format");
    // The edit branch must NOT have been taken for a text-only context.
    expect(edit).not.toHaveBeenCalled();
    // The client is constructed from options.apiKey.
    expect(ctor).toHaveBeenCalledWith({ apiKey: "sk-test" });
  });
});

// ---------------------------------------------------------------------------
// size threading: options.metadata.size → images.generate/edit size
// ---------------------------------------------------------------------------

describe("generateImagesOpenAI — size threading", () => {
  it("forwards options.metadata.size to images.generate (text->image)", async () => {
    generate.mockResolvedValue({ data: [{ b64_json: PNG_B64 }] });

    await generateImagesOpenAI(openaiModel(), textContext("a fox"), opts({ metadata: { size: "1792x1024" } }));

    const args = generate.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.size).toBe("1792x1024");
  });

  it("forwards options.metadata.size to images.edit (reference->image)", async () => {
    edit.mockResolvedValue({ data: [{ b64_json: PNG_B64 }] });

    await generateImagesOpenAI(openaiModel(), editContext("make it night"), opts({ metadata: { size: "1024x1792" } }));

    const args = edit.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.size).toBe("1024x1792");
  });

  it("defaults size to 1024x1024 when no metadata.size is supplied", async () => {
    generate.mockResolvedValue({ data: [{ b64_json: PNG_B64 }] });

    await generateImagesOpenAI(openaiModel(), textContext("a fox"), opts());

    const args = generate.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.size).toBe("1024x1024");
  });
});

// ---------------------------------------------------------------------------
// Test 2 — edit (reference->image branch)
// ---------------------------------------------------------------------------

describe("generateImagesOpenAI — edit branch", () => {
  it("calls images.edit (not generate) when the context carries an ImageContent", async () => {
    edit.mockResolvedValue({ data: [{ b64_json: PNG_B64 }] });

    const res = await generateImagesOpenAI(openaiModel(), editContext("make it night"), opts());

    expect(res.stopReason).toBe("stop");
    expect(res.output).toEqual([{ type: "image", data: PNG_B64, mimeType: "image/png" }]);
    expect(edit).toHaveBeenCalledTimes(1);
    expect(generate).not.toHaveBeenCalled();
    // The reference image is wrapped via toFile and passed as `image`.
    expect(toFile).toHaveBeenCalledTimes(1);
    const args = edit.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.image).toEqual({ __isFile: true });
    expect(args.prompt).toBe("make it night");
    expect(args.model).toBe("gpt-image-1");
    expect(args.n).toBe(1);
    expect(args.size).toBe("1024x1024");
  });
});

// ---------------------------------------------------------------------------
// Test 3 — no key (no SDK call attempted)
// ---------------------------------------------------------------------------

describe("generateImagesOpenAI — no key", () => {
  it("returns stopReason:error with the no-API-key message and does NOT construct the client", async () => {
    const res = await generateImagesOpenAI(openaiModel(), textContext("x"), opts({ apiKey: undefined }));

    expect(res.stopReason).toBe("error");
    expect(res.errorMessage).toContain("No API key for provider: openai");
    expect(ctor).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(edit).not.toHaveBeenCalled();
  });

  it("returns stopReason:error when options is entirely undefined", async () => {
    const res = await generateImagesOpenAI(openaiModel(), textContext("x"), undefined);

    expect(res.stopReason).toBe("error");
    expect(res.errorMessage).toContain("No API key for provider: openai");
    expect(ctor).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test 4 — SDK throw -> never throw out
// ---------------------------------------------------------------------------

describe("generateImagesOpenAI — never-throw (SDK reject)", () => {
  it("RESOLVES stopReason:error with the thrown message (does not throw out)", async () => {
    generate.mockRejectedValue(new Error("401 Unauthorized"));

    const res = await generateImagesOpenAI(openaiModel(), textContext("x"), opts());

    expect(res.stopReason).toBe("error");
    expect(res.errorMessage).toBe("401 Unauthorized");
  });
});

// ---------------------------------------------------------------------------
// Test 5 — empty data
// ---------------------------------------------------------------------------

describe("generateImagesOpenAI — empty response", () => {
  it("maps an empty data array to stopReason:error + 'no image data'", async () => {
    generate.mockResolvedValue({ data: [] });

    const res = await generateImagesOpenAI(openaiModel(), textContext("x"), opts());

    expect(res.stopReason).toBe("error");
    expect(res.errorMessage?.toLowerCase()).toContain("no image data");
  });

  it("maps a missing data field to stopReason:error", async () => {
    generate.mockResolvedValue({});

    const res = await generateImagesOpenAI(openaiModel(), textContext("x"), opts());

    expect(res.stopReason).toBe("error");
    expect(res.errorMessage?.toLowerCase()).toContain("no image data");
  });
});

// ---------------------------------------------------------------------------
// Test 6 — the hand-built ImagesModel literal (8 fields)
// ---------------------------------------------------------------------------

describe("OPENAI_IMAGE_MODEL literal", () => {
  it("is the 8-field ImagesModel for gpt-image-1 / openai-images", () => {
    expect(OPENAI_IMAGE_MODEL.id).toBe("gpt-image-1");
    expect(OPENAI_IMAGE_MODEL.api).toBe("openai-images");
    expect(OPENAI_IMAGE_MODEL.provider).toBe("openai");
    expect(OPENAI_IMAGE_MODEL.input).toEqual(["text", "image"]);
    expect(OPENAI_IMAGE_MODEL.output).toEqual(["image"]);
    expect(OPENAI_IMAGE_MODEL.baseUrl).toBe("https://api.openai.com/v1");
    expect(typeof OPENAI_IMAGE_MODEL.name).toBe("string");
    expect(OPENAI_IMAGE_MODEL.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    // Exactly the 8 ImagesModel fields (no reasoning/contextWindow/maxTokens/compat).
    expect(Object.keys(OPENAI_IMAGE_MODEL).sort()).toEqual(
      ["api", "baseUrl", "cost", "id", "input", "name", "output", "provider"].sort(),
    );
  });
});
