// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the Google (Gemini) Images transport (google-images-transport.ts).
 *
 * The transport is a pi-ai `ImagesFunction` that constructs a `GoogleGenAI`
 * client from `options.apiKey` and calls `models.generateContent` with
 * `config.responseModalities:[Modality.IMAGE]`, extracting the inline image
 * from `candidates[0].content.parts[].inlineData.{data,mimeType}`.
 *
 * Every test mocks the `@google/genai` MODULE (`vi.mock`, class-based — mirrors
 * gemini-cache-manager.test.ts) — NEVER a real `GOOGLE_API_KEY`, NEVER the
 * network. It uses `generateContent`, NOT `models.generateImages` (that is the
 * Imagen path; the mock has no such fn). Never-throw: any miss (no key, SDK
 * throw, blocked, no image) -> `stopReason:"error"` + an `errorMessage` the
 * shipped `classifyImageError` maps.
 * @module
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ImagesModel, ProviderImagesOptions } from "@earendil-works/pi-ai";

// ---------------------------------------------------------------------------
// Mock @google/genai — class-based GoogleGenAI (mirrors the in-repo
// gemini-cache-manager.test.ts precedent). `gen` is the controllable
// generateContent vi.fn(); `ctor` records the constructor args. `genImages`
// proves models.generateImages (the Imagen path) is NEVER called.
// ---------------------------------------------------------------------------
const { gen, genImages, ctor, MockGoogleGenAI } = vi.hoisted(() => {
  const gen = vi.fn();
  const genImages = vi.fn();
  const ctor = vi.fn();
  class MockGoogleGenAI {
    models = { generateContent: gen, generateImages: genImages };
    constructor(args: unknown) {
      ctor(args);
    }
  }
  return { gen, genImages, ctor, MockGoogleGenAI };
});

vi.mock("@google/genai", () => ({
  GoogleGenAI: MockGoogleGenAI,
  Modality: { IMAGE: "IMAGE", TEXT: "TEXT" },
}));

import { generateImagesGoogle, GOOGLE_IMAGE_MODEL } from "./google-images-transport.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function googleModel(): ImagesModel<"google-images"> {
  return GOOGLE_IMAGE_MODEL;
}

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
  apiKey: "gk-test",
  ...over,
});

/** A generateContent response carrying one inline image in candidates[0]. */
const imageResponse = (b64: string, mimeType = "image/png", leadingText?: string) => {
  const parts: unknown[] = [];
  if (leadingText !== undefined) parts.push({ text: leadingText });
  parts.push({ inlineData: { data: b64, mimeType } });
  return { candidates: [{ content: { parts } }] };
};

beforeEach(() => {
  gen.mockReset();
  genImages.mockReset();
  ctor.mockClear();
});

// ---------------------------------------------------------------------------
// Generate (text->image)
// ---------------------------------------------------------------------------

describe("generateImagesGoogle — generate", () => {
  it("calls generateContent with responseModalities:[IMAGE] and maps inlineData -> output[0]", async () => {
    gen.mockResolvedValue(imageResponse(PNG_B64));

    const res = await generateImagesGoogle(googleModel(), textContext("a fox"), opts());

    expect(res.stopReason).toBe("stop");
    expect(res.output).toEqual([{ type: "image", data: PNG_B64, mimeType: "image/png" }]);
    expect(gen).toHaveBeenCalledTimes(1);
    const args = gen.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.model).toBe("gemini-2.5-flash-image");
    expect(args.contents).toEqual([{ text: "a fox" }]);
    expect(args.config).toEqual({ responseModalities: ["IMAGE"] });
    // The Imagen path must NOT be used.
    expect(genImages).not.toHaveBeenCalled();
    expect(ctor).toHaveBeenCalledWith({ apiKey: "gk-test" });
  });
});

// ---------------------------------------------------------------------------
// Edit (reference->image): both parts, in order
// ---------------------------------------------------------------------------

describe("generateImagesGoogle — edit branch", () => {
  it("includes both the text and the inlineData reference parts (in order)", async () => {
    gen.mockResolvedValue(imageResponse(PNG_B64));

    const res = await generateImagesGoogle(googleModel(), editContext("make it night"), opts());

    expect(res.stopReason).toBe("stop");
    const args = gen.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.contents).toEqual([
      { text: "make it night" },
      { inlineData: { data: REF_B64, mimeType: "image/png" } },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Scan ALL parts (image not at index 0)
// ---------------------------------------------------------------------------

describe("generateImagesGoogle — scan all parts", () => {
  it("extracts the image even when a text part precedes the inlineData", async () => {
    gen.mockResolvedValue(imageResponse(PNG_B64, "image/png", "here is your image:"));

    const res = await generateImagesGoogle(googleModel(), textContext("x"), opts());

    expect(res.stopReason).toBe("stop");
    expect(res.output).toEqual([{ type: "image", data: PNG_B64, mimeType: "image/png" }]);
  });

  it("honors the inlineData mimeType when present (not hard-coded png)", async () => {
    gen.mockResolvedValue(imageResponse(PNG_B64, "image/jpeg"));

    const res = await generateImagesGoogle(googleModel(), textContext("x"), opts());

    expect(res.output).toEqual([{ type: "image", data: PNG_B64, mimeType: "image/jpeg" }]);
  });
});

// ---------------------------------------------------------------------------
// No key (no SDK call attempted)
// ---------------------------------------------------------------------------

describe("generateImagesGoogle — no key", () => {
  it("returns stopReason:error + no-API-key message; does NOT construct the client", async () => {
    const res = await generateImagesGoogle(googleModel(), textContext("x"), opts({ apiKey: undefined }));

    expect(res.stopReason).toBe("error");
    expect(res.errorMessage).toContain("No API key for provider: google");
    expect(ctor).not.toHaveBeenCalled();
    expect(gen).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Content blocked / no image
// ---------------------------------------------------------------------------

describe("generateImagesGoogle — blocked / no image", () => {
  it("maps a blocked response (promptFeedback, no candidates) to 'content blocked'", async () => {
    gen.mockResolvedValue({ promptFeedback: { blockReason: "SAFETY" } });

    const res = await generateImagesGoogle(googleModel(), textContext("x"), opts());

    expect(res.stopReason).toBe("error");
    expect(res.errorMessage?.toLowerCase()).toContain("content blocked");
  });

  it("maps candidates-without-inlineData to 'no image'", async () => {
    gen.mockResolvedValue({ candidates: [{ content: { parts: [{ text: "sorry, no image" }] } }] });

    const res = await generateImagesGoogle(googleModel(), textContext("x"), opts());

    expect(res.stopReason).toBe("error");
    expect(res.errorMessage?.toLowerCase()).toContain("no image");
  });
});

// ---------------------------------------------------------------------------
// SDK throw -> never throw out
// ---------------------------------------------------------------------------

describe("generateImagesGoogle — never-throw (SDK reject)", () => {
  it("RESOLVES stopReason:error with the thrown message (does not throw out)", async () => {
    gen.mockRejectedValue(new Error("429 quota exceeded"));

    const res = await generateImagesGoogle(googleModel(), textContext("x"), opts());

    expect(res.stopReason).toBe("error");
    expect(res.errorMessage).toBe("429 quota exceeded");
  });
});

// ---------------------------------------------------------------------------
// The hand-built ImagesModel literal (8 fields)
// ---------------------------------------------------------------------------

describe("GOOGLE_IMAGE_MODEL literal", () => {
  it("is the 8-field ImagesModel for gemini-2.5-flash-image / google-images", () => {
    expect(GOOGLE_IMAGE_MODEL.id).toBe("gemini-2.5-flash-image");
    expect(GOOGLE_IMAGE_MODEL.api).toBe("google-images");
    expect(GOOGLE_IMAGE_MODEL.provider).toBe("google");
    expect(GOOGLE_IMAGE_MODEL.input).toEqual(["text", "image"]);
    expect(GOOGLE_IMAGE_MODEL.output).toEqual(["image"]);
    expect(GOOGLE_IMAGE_MODEL.baseUrl).toBe("https://generativelanguage.googleapis.com");
    expect(typeof GOOGLE_IMAGE_MODEL.name).toBe("string");
    expect(GOOGLE_IMAGE_MODEL.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(Object.keys(GOOGLE_IMAGE_MODEL).sort()).toEqual(
      ["api", "baseUrl", "cost", "id", "input", "name", "output", "provider"].sort(),
    );
  });
});
