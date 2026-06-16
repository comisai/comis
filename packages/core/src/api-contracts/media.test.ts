// SPDX-License-Identifier: Apache-2.0
/**
 * Per-contract test for the media + image domain contracts.
 *
 * Covers the 16 contracts spanning the two daemon handler-factory files that
 * share the `MediaApiDeps` cluster slice:
 *   - media-handlers.ts (15 methods)
 *   - image-handlers.ts ( 1 method)
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import {
  ImageAnalyzeContract,
  TtsSynthesizeContract,
  TtsAutoCheckContract,
  LinkProcessContract,
  AudioTranscribeContract,
  MediaTranscribeContract,
  MediaDescribeVideoContract,
  MediaExtractDocumentContract,
  MediaTestSttContract,
  MediaTestTtsContract,
  MediaTestVisionContract,
  MediaTestDocumentContract,
  MediaTestVideoContract,
  MediaTestLinkContract,
  MediaProvidersContract,
  ImageGenerateContract,
  MEDIA_CONTRACTS,
} from "./media.js";
import { INTERNAL_FIELD_NAMES } from "./internals.js";

describe("media + image domain contracts", () => {
  // -------------------------------------------------------------------------
  // Aggregator sanity
  // -------------------------------------------------------------------------

  it("MEDIA_CONTRACTS has exactly 18 entries (15 media + 1 image + 2 video)", () => {
    expect(MEDIA_CONTRACTS.length).toBe(18);
  });

  it("MEDIA_CONTRACTS method names cover every handler-factory method", () => {
    const methods = new Set(MEDIA_CONTRACTS.map((c) => c.method));
    // media-handlers.ts (15):
    expect(methods.has("image.analyze")).toBe(true);
    expect(methods.has("tts.synthesize")).toBe(true);
    expect(methods.has("tts.auto_check")).toBe(true);
    expect(methods.has("link.process")).toBe(true);
    expect(methods.has("audio.transcribe")).toBe(true);
    expect(methods.has("media.transcribe")).toBe(true);
    expect(methods.has("media.describe_video")).toBe(true);
    expect(methods.has("media.extract_document")).toBe(true);
    expect(methods.has("media.test.stt")).toBe(true);
    expect(methods.has("media.test.tts")).toBe(true);
    expect(methods.has("media.test.vision")).toBe(true);
    expect(methods.has("media.test.document")).toBe(true);
    expect(methods.has("media.test.video")).toBe(true);
    expect(methods.has("media.test.link")).toBe(true);
    expect(methods.has("media.providers")).toBe(true);
    // image-handlers.ts (1):
    expect(methods.has("image.generate")).toBe(true);
    // video-handlers.ts (1) — handler lands Phase 188 Plan 04:
    expect(methods.has("video.generate")).toBe(true);
  });

  it("scope assignments mirror setup-gateway-api.ts registrations", () => {
    // media-handlers.ts scopes
    // Agent-tool dispatch (rpc) — not registered in setup-gateway-api.ts:
    expect(ImageAnalyzeContract.scopes).toEqual(["rpc"]);
    expect(TtsSynthesizeContract.scopes).toEqual(["rpc"]);
    expect(TtsAutoCheckContract.scopes).toEqual(["rpc"]);
    expect(LinkProcessContract.scopes).toEqual(["rpc"]);
    expect(MediaTranscribeContract.scopes).toEqual(["rpc"]);
    expect(MediaDescribeVideoContract.scopes).toEqual(["rpc"]);
    expect(MediaExtractDocumentContract.scopes).toEqual(["rpc"]);
    // Registered in setup-gateway-api.ts:
    expect(AudioTranscribeContract.scopes).toEqual(["rpc"]); // line 187
    expect(MediaTestSttContract.scopes).toEqual(["admin"]); // line 189
    expect(MediaTestTtsContract.scopes).toEqual(["admin"]); // line 189
    expect(MediaTestVisionContract.scopes).toEqual(["admin"]); // line 190
    expect(MediaTestDocumentContract.scopes).toEqual(["admin"]); // line 190
    expect(MediaTestVideoContract.scopes).toEqual(["admin"]); // line 191
    expect(MediaTestLinkContract.scopes).toEqual(["admin"]); // line 191
    expect(MediaProvidersContract.scopes).toEqual(["admin"]); // line 192
    // image-handlers.ts scopes
    expect(ImageGenerateContract.scopes).toEqual(["rpc"]);
  });

  // -------------------------------------------------------------------------
  // INTERNAL_FIELD_NAMES paired sanity
  // -------------------------------------------------------------------------

  it("no contract request schema declares any INTERNAL_FIELD_NAMES key", () => {
    // The 15 internal `_X` field names (e.g. `_callerSessionKey`, `_trustLevel`)
    // are dispatcher-injected and MUST be stripped via `stripInternalFields()`
    // BEFORE contract.request.parse(). They MUST NOT appear as keys in any
    // request schema's top-level shape.
    const internalSet = new Set(INTERNAL_FIELD_NAMES);
    for (const contract of MEDIA_CONTRACTS) {
      const shape = (contract.request as unknown as { shape?: Record<string, unknown> }).shape;
      if (!shape) continue;
      for (const key of Object.keys(shape)) {
        expect(
          internalSet.has(key),
          `${contract.method}: request schema must not declare internal field "${key}"`,
        ).toBe(false);
      }
    }
  });

  // -------------------------------------------------------------------------
  // image.analyze
  // -------------------------------------------------------------------------

  it("image.analyze: request accepts source_type + source", () => {
    expect(() =>
      ImageAnalyzeContract.request.parse({
        source_type: "base64",
        source: "abc",
        prompt: "describe",
      }),
    ).not.toThrow();
  });

  it("image.analyze: request accepts attachment_url shorthand", () => {
    expect(() =>
      ImageAnalyzeContract.request.parse({
        attachment_url: "tg-file://abc",
      }),
    ).not.toThrow();
  });

  it("image.analyze: response requires description", () => {
    expect(() =>
      ImageAnalyzeContract.response.parse({ description: "A nice image" }),
    ).not.toThrow();
    expect(() =>
      ImageAnalyzeContract.response.parse({
        description: "A nice image",
        provider: "gemini",
        model: "gemini-pro-vision",
      }),
    ).not.toThrow();
    expect(() => ImageAnalyzeContract.response.parse({})).toThrow();
  });

  // -------------------------------------------------------------------------
  // tts.synthesize
  // -------------------------------------------------------------------------

  it("tts.synthesize: request requires text", () => {
    expect(() => TtsSynthesizeContract.request.parse({})).toThrow();
  });

  it("tts.synthesize: request accepts text + optional voice/format", () => {
    expect(() => TtsSynthesizeContract.request.parse({ text: "Hello" })).not.toThrow();
    expect(() =>
      TtsSynthesizeContract.request.parse({
        text: "Hello",
        voice: "nova",
        format: "mp3",
      }),
    ).not.toThrow();
  });

  it("tts.synthesize: response carries filePath/mimeType/sizeBytes", () => {
    expect(() =>
      TtsSynthesizeContract.response.parse({
        filePath: "/tmp/tts.mp3",
        mimeType: "audio/mpeg",
        sizeBytes: 1024,
      }),
    ).not.toThrow();
    expect(() =>
      TtsSynthesizeContract.response.parse({ filePath: "/tmp/x.mp3" }),
    ).toThrow();
  });

  // -------------------------------------------------------------------------
  // tts.auto_check
  // -------------------------------------------------------------------------

  it("tts.auto_check: request requires response_text", () => {
    expect(() => TtsAutoCheckContract.request.parse({})).toThrow();
  });

  it("tts.auto_check: response requires shouldSynthesize + mode", () => {
    expect(() =>
      TtsAutoCheckContract.response.parse({
        shouldSynthesize: false,
        mode: "off",
      }),
    ).not.toThrow();
    expect(() =>
      TtsAutoCheckContract.response.parse({
        shouldSynthesize: true,
        strippedText: "stripped",
        mode: "tag",
      }),
    ).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // link.process
  // -------------------------------------------------------------------------

  it("link.process: request requires text", () => {
    expect(() => LinkProcessContract.request.parse({})).toThrow();
  });

  it("link.process: response carries enrichedText/linksProcessed/errors (string[])", () => {
    expect(() =>
      LinkProcessContract.response.parse({
        enrichedText: "x",
        linksProcessed: 2,
        errors: [],
      }),
    ).not.toThrow();
    expect(() =>
      LinkProcessContract.response.parse({
        enrichedText: "x",
        linksProcessed: 1,
        errors: ["fetch failed: https://e.com (HTTP 404)"],
      }),
    ).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // audio.transcribe
  // -------------------------------------------------------------------------

  it("audio.transcribe: request accepts empty (handler enforces audio presence)", () => {
    // The contract intentionally models `audio` as optional — the handler
    // returns `{ error: "Missing required parameter: audio..." }` when it's
    // missing (bespoke pre-Zod check). Modeling it as required here would
    // make `audio.transcribe({})` throw a ZodError at parse-time instead.
    expect(() => AudioTranscribeContract.request.parse({})).not.toThrow();
  });

  it("audio.transcribe: response is a loose record (success + error variants)", () => {
    expect(() =>
      AudioTranscribeContract.response.parse({
        text: "hello",
        language: "en",
        durationMs: 1200,
      }),
    ).not.toThrow();
    expect(() =>
      AudioTranscribeContract.response.parse({
        error: "Missing required parameter: audio (base64-encoded string)",
      }),
    ).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // media.transcribe
  // -------------------------------------------------------------------------

  it("media.transcribe: request requires attachment_url", () => {
    expect(() => MediaTranscribeContract.request.parse({})).toThrow();
  });

  it("media.transcribe: response requires text + durationMs", () => {
    expect(() =>
      MediaTranscribeContract.response.parse({
        text: "transcribed",
        language: "en",
        durationMs: 1500,
      }),
    ).not.toThrow();
    expect(() =>
      MediaTranscribeContract.response.parse({ text: "transcribed", durationMs: 100 }),
    ).not.toThrow();
    expect(() =>
      MediaTranscribeContract.response.parse({ text: "transcribed" }),
    ).toThrow();
  });

  // -------------------------------------------------------------------------
  // media.describe_video
  // -------------------------------------------------------------------------

  it("media.describe_video: request requires attachment_url", () => {
    expect(() => MediaDescribeVideoContract.request.parse({})).toThrow();
  });

  it("media.describe_video: response requires description/provider/model", () => {
    expect(() =>
      MediaDescribeVideoContract.response.parse({
        description: "a clip",
        provider: "gemini",
        model: "gemini-pro-vision",
      }),
    ).not.toThrow();
    expect(() =>
      MediaDescribeVideoContract.response.parse({ description: "a clip" }),
    ).toThrow();
  });

  // -------------------------------------------------------------------------
  // media.extract_document
  // -------------------------------------------------------------------------

  it("media.extract_document: request requires attachment_url", () => {
    expect(() => MediaExtractDocumentContract.request.parse({})).toThrow();
  });

  it("media.extract_document: response requires text/mimeType/extractedChars/truncated/durationMs", () => {
    expect(() =>
      MediaExtractDocumentContract.response.parse({
        text: "doc text",
        fileName: "doc.pdf",
        mimeType: "application/pdf",
        extractedChars: 100,
        truncated: false,
        durationMs: 500,
      }),
    ).not.toThrow();
    expect(() =>
      MediaExtractDocumentContract.response.parse({
        text: "x",
        mimeType: "text/plain",
        extractedChars: 1,
        truncated: false,
        durationMs: 1,
      }),
    ).not.toThrow();
    expect(() =>
      MediaExtractDocumentContract.response.parse({ text: "x" }),
    ).toThrow();
  });

  // -------------------------------------------------------------------------
  // media.test.stt
  // -------------------------------------------------------------------------

  it("media.test.stt: request requires audio + mimeType", () => {
    expect(() => MediaTestSttContract.request.parse({})).toThrow();
    expect(() => MediaTestSttContract.request.parse({ audio: "abc" })).toThrow();
  });

  it("media.test.stt: response requires text/durationMs/provider", () => {
    expect(() =>
      MediaTestSttContract.response.parse({
        text: "x",
        durationMs: 100,
        provider: "configured",
      }),
    ).not.toThrow();
    expect(() =>
      MediaTestSttContract.response.parse({
        text: "x",
        language: "en",
        durationMs: 100,
        provider: "openai",
      }),
    ).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // media.test.tts
  // -------------------------------------------------------------------------

  it("media.test.tts: request requires text", () => {
    expect(() => MediaTestTtsContract.request.parse({})).toThrow();
  });

  it("media.test.tts: response requires audio/mimeType/sizeBytes/provider", () => {
    expect(() =>
      MediaTestTtsContract.response.parse({
        audio: "base64=",
        mimeType: "audio/mpeg",
        sizeBytes: 1024,
        provider: "openai",
      }),
    ).not.toThrow();
    expect(() =>
      MediaTestTtsContract.response.parse({ audio: "x" }),
    ).toThrow();
  });

  // -------------------------------------------------------------------------
  // media.test.vision
  // -------------------------------------------------------------------------

  it("media.test.vision: request requires image + mimeType", () => {
    expect(() => MediaTestVisionContract.request.parse({})).toThrow();
  });

  it("media.test.vision: response requires description/provider/model", () => {
    expect(() =>
      MediaTestVisionContract.response.parse({
        description: "x",
        provider: "gemini",
        model: "gemini-pro-vision",
      }),
    ).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // media.test.document
  // -------------------------------------------------------------------------

  it("media.test.document: request requires file + mimeType", () => {
    expect(() => MediaTestDocumentContract.request.parse({})).toThrow();
  });

  it("media.test.document: response requires text/fileName/mimeType/extractedChars/truncated/durationMs", () => {
    expect(() =>
      MediaTestDocumentContract.response.parse({
        text: "x",
        fileName: "doc.pdf",
        mimeType: "application/pdf",
        extractedChars: 100,
        truncated: false,
        durationMs: 500,
      }),
    ).not.toThrow();
    expect(() =>
      MediaTestDocumentContract.response.parse({
        text: "x",
        fileName: "unknown",
        mimeType: "text/plain",
        extractedChars: 1,
        truncated: false,
        durationMs: 1,
        pageCount: 1,
      }),
    ).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // media.test.video
  // -------------------------------------------------------------------------

  it("media.test.video: request requires video + mimeType", () => {
    expect(() => MediaTestVideoContract.request.parse({})).toThrow();
  });

  it("media.test.video: response requires description/provider/model", () => {
    expect(() =>
      MediaTestVideoContract.response.parse({
        description: "x",
        provider: "gemini",
        model: "gemini-pro-vision",
      }),
    ).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // media.test.link
  // -------------------------------------------------------------------------

  it("media.test.link: request requires url", () => {
    expect(() => MediaTestLinkContract.request.parse({})).toThrow();
  });

  it("media.test.link: response shape matches link.process", () => {
    expect(() =>
      MediaTestLinkContract.response.parse({
        enrichedText: "x",
        linksProcessed: 1,
        errors: [],
      }),
    ).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // media.providers
  // -------------------------------------------------------------------------

  it("media.providers: request accepts empty object", () => {
    expect(() => MediaProvidersContract.request.parse({})).not.toThrow();
  });

  it("media.providers: response is a loose record (variable provider config)", () => {
    expect(() =>
      MediaProvidersContract.response.parse({
        stt: { provider: "configured" },
        tts: null,
        vision: { providers: ["gemini"], defaultProvider: "gemini", videoCapable: ["gemini"] },
        documentExtraction: { enabled: true, supportedMimes: ["application/pdf"] },
        linkUnderstanding: { enabled: true, maxLinks: 5 },
      }),
    ).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // image.generate
  // -------------------------------------------------------------------------

  it("image.generate: request accepts empty (handler enforces prompt presence)", () => {
    // Same as audio.transcribe — the handler returns `{ success: false,
    // error: "Missing required parameter: prompt" }` for missing prompt.
    // Modeling prompt as required would short-circuit the bespoke check.
    expect(() => ImageGenerateContract.request.parse({})).not.toThrow();
  });

  it("image.generate: request accepts prompt + optional size", () => {
    expect(() =>
      ImageGenerateContract.request.parse({ prompt: "a fox" }),
    ).not.toThrow();
    expect(() =>
      ImageGenerateContract.request.parse({
        prompt: "a fox",
        size: "1024x1024",
      }),
    ).not.toThrow();
  });

  it("image.generate: request accepts optional model + reference_image, surviving typed (CFG-02, Pitfall 5)", () => {
    // The handler does `ImageGenerateContract.request.parse(userParams)`; without
    // growing the request, params.model/params.reference_image are typed
    // `undefined` to the handler even though Zod passes the keys at runtime. This
    // pins that the two new fields are part of the contract AND survive parsing.
    const parsed = ImageGenerateContract.request.parse({
      prompt: "a fox",
      model: "gpt-image-1",
      reference_image: "ws/ref.png",
    });
    expect(parsed.model).toBe("gpt-image-1");
    expect(parsed.reference_image).toBe("ws/ref.png");
  });

  it("image.generate: request is additive — prompt-only leaves model/reference_image undefined", () => {
    // Existing callers (no model / no reference_image) are unaffected.
    const parsed = ImageGenerateContract.request.parse({ prompt: "a fox" });
    expect(parsed.model).toBeUndefined();
    expect(parsed.reference_image).toBeUndefined();
  });

  it("image.generate: model + reference_image accept only strings", () => {
    expect(() =>
      ImageGenerateContract.request.parse({ model: 123 }),
    ).toThrow();
    expect(() =>
      ImageGenerateContract.request.parse({ reference_image: 123 }),
    ).toThrow();
  });

  it("image.generate: response is a loose record (3 delivery variants)", () => {
    // failure variant
    expect(() =>
      ImageGenerateContract.response.parse({
        success: false,
        error: "Missing required parameter: prompt",
      }),
    ).not.toThrow();
    // delivered variant
    expect(() =>
      ImageGenerateContract.response.parse({
        success: true,
        delivered: true,
        mimeType: "image/png",
      }),
    ).not.toThrow();
    // base64 fallback variant
    expect(() =>
      ImageGenerateContract.response.parse({
        success: true,
        imageBase64: "iVBORw0KGgo...",
        mimeType: "image/png",
      }),
    ).not.toThrow();
  });
});
