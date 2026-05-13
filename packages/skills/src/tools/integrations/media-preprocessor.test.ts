// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for media message preprocessor.
 */

import type {
  NormalizedMessage,
  Attachment,
  TranscriptionPort,
  ImageAnalysisPort,
  FileExtractionPort,
} from "@comis/core";
import { ok, err, type Result } from "@comis/shared";
import { describe, expect, it, vi } from "vitest";
import {
  preprocessMessage,
  type MediaProcessorDeps,
  type MediaProcessorLogger,
  type FileExtractionMetric,
} from "./media-preprocessor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger(): MediaProcessorLogger & { debug: ReturnType<typeof vi.fn> } {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function makeMessage(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    channelId: "test-channel",
    channelType: "telegram",
    senderId: "user-1",
    text: "Hello world",
    timestamp: Date.now(),
    attachments: [],
    metadata: {},
    ...overrides,
  };
}

function makeAudioAttachment(url = "tg-file://audio1"): Attachment {
  return {
    type: "audio",
    url,
    mimeType: "audio/ogg",
    sizeBytes: 1024,
  };
}

function makeImageAttachment(url = "tg-file://image1"): Attachment {
  return {
    type: "image",
    url,
    mimeType: "image/jpeg",
    sizeBytes: 2048,
  };
}

function makeTranscriber(): TranscriptionPort {
  return {
    transcribe: vi.fn().mockResolvedValue(ok({ text: "hello from voice", language: "en" })),
  };
}

function makeImageAnalyzer(): ImageAnalysisPort {
  return {
    analyze: vi.fn().mockResolvedValue(ok("A photo of a cat sitting on a keyboard")),
  };
}

function makeResolver(): (attachment: Attachment) => Promise<Buffer | null> {
  return vi.fn().mockResolvedValue(Buffer.from("fake-media-data"));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("preprocessMessage", () => {
  it("returns original message unchanged when no attachments", async () => {
    const msg = makeMessage({ text: "no attachments here" });
    const deps: MediaProcessorDeps = { logger: makeLogger() };

    const result = await preprocessMessage(deps, msg);

    expect(result.message.text).toBe("no attachments here");
    expect(result.transcriptions).toHaveLength(0);
    expect(result.analyses).toHaveLength(0);
  });

  it("returns original message unchanged when attachments array is empty", async () => {
    const msg = makeMessage({ attachments: [] });
    const deps: MediaProcessorDeps = { logger: makeLogger() };

    const result = await preprocessMessage(deps, msg);

    expect(result.message.text).toBe("Hello world");
    expect(result.transcriptions).toHaveLength(0);
    expect(result.analyses).toHaveLength(0);
  });

  it("transcribes audio attachment and prepends transcript to text", async () => {
    const transcriber = makeTranscriber();
    const resolver = makeResolver();
    const msg = makeMessage({
      text: "original text",
      attachments: [makeAudioAttachment()],
    });
    const deps: MediaProcessorDeps = {
      transcriber,
      resolveAttachment: resolver,
      logger: makeLogger(),
    };

    const result = await preprocessMessage(deps, msg);

    expect(result.message.text).toContain("[Voice message transcription]: hello from voice");
    expect(result.message.text).toContain("original text");
    expect(result.transcriptions).toHaveLength(1);
    expect(result.transcriptions[0]!.text).toBe("hello from voice");
    expect(result.transcriptions[0]!.language).toBe("en");
    expect(transcriber.transcribe).toHaveBeenCalledOnce();
    expect(resolver).toHaveBeenCalledOnce();
  });

  it("analyzes image attachment and prepends analysis to text", async () => {
    const imageAnalyzer = makeImageAnalyzer();
    const resolver = makeResolver();
    const msg = makeMessage({
      text: "what is this?",
      attachments: [makeImageAttachment()],
    });
    const deps: MediaProcessorDeps = {
      imageAnalyzer,
      resolveAttachment: resolver,
      logger: makeLogger(),
    };

    const result = await preprocessMessage(deps, msg);

    expect(result.message.text).toContain(
      "[Image analysis]: A photo of a cat sitting on a keyboard",
    );
    expect(result.message.text).toContain("what is this?");
    expect(result.analyses).toHaveLength(1);
    expect(result.analyses[0]!.description).toBe("A photo of a cat sitting on a keyboard");
    expect(imageAnalyzer.analyze).toHaveBeenCalledOnce();
  });

  it("processes both audio and image attachments", async () => {
    const transcriber = makeTranscriber();
    const imageAnalyzer = makeImageAnalyzer();
    const resolver = makeResolver();
    const msg = makeMessage({
      text: "mixed media",
      attachments: [makeAudioAttachment(), makeImageAttachment()],
    });
    const deps: MediaProcessorDeps = {
      transcriber,
      imageAnalyzer,
      resolveAttachment: resolver,
      logger: makeLogger(),
    };

    const result = await preprocessMessage(deps, msg);

    expect(result.message.text).toContain("[Voice message transcription]: hello from voice");
    expect(result.message.text).toContain(
      "[Image analysis]: A photo of a cat sitting on a keyboard",
    );
    expect(result.message.text).toContain("mixed media");
    expect(result.transcriptions).toHaveLength(1);
    expect(result.analyses).toHaveLength(1);
  });

  it("skips audio attachments gracefully when no transcriber provided (emits hint)", async () => {
    const resolver = makeResolver();
    const msg = makeMessage({
      text: "voice message",
      attachments: [makeAudioAttachment()],
    });
    const deps: MediaProcessorDeps = {
      resolveAttachment: resolver,
      logger: makeLogger(),
    };

    const result = await preprocessMessage(deps, msg);

    expect(result.message.text).toContain("voice message");
    expect(result.message.text).toContain("[Attached: voice message");
    expect(result.transcriptions).toHaveLength(0);
    // resolver should not even be called since there's no transcriber
    expect(resolver).not.toHaveBeenCalled();
  });

  it("skips image attachments gracefully when no imageAnalyzer provided (emits hint)", async () => {
    const resolver = makeResolver();
    const msg = makeMessage({
      text: "photo message",
      attachments: [makeImageAttachment()],
    });
    const deps: MediaProcessorDeps = {
      resolveAttachment: resolver,
      logger: makeLogger(),
    };

    const result = await preprocessMessage(deps, msg);

    expect(result.message.text).toContain("photo message");
    expect(result.message.text).toContain("[Attached: image");
    expect(result.analyses).toHaveLength(0);
    expect(resolver).not.toHaveBeenCalled();
  });

  it("logs warning and continues when transcriber returns error", async () => {
    const transcriber: TranscriptionPort = {
      transcribe: vi.fn().mockResolvedValue(err(new Error("API rate limited"))),
    };
    const resolver = makeResolver();
    const logger = makeLogger();
    const msg = makeMessage({
      text: "try transcribe",
      attachments: [makeAudioAttachment()],
    });
    const deps: MediaProcessorDeps = {
      transcriber,
      resolveAttachment: resolver,
      logger,
    };

    const result = await preprocessMessage(deps, msg);

    expect(result.message.text).toContain("transcription failed");
    expect(result.message.text).toContain("try transcribe");
    expect(result.transcriptions).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("logs warning and continues when imageAnalyzer returns error", async () => {
    const imageAnalyzer: ImageAnalysisPort = {
      analyze: vi.fn().mockResolvedValue(err(new Error("Image too large"))),
    };
    const resolver = makeResolver();
    const logger = makeLogger();
    const msg = makeMessage({
      text: "try analyze",
      attachments: [makeImageAttachment()],
    });
    const deps: MediaProcessorDeps = {
      imageAnalyzer,
      resolveAttachment: resolver,
      logger,
    };

    const result = await preprocessMessage(deps, msg);

    expect(result.message.text).toBe("try analyze");
    expect(result.analyses).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("skips attachment when resolveAttachment returns null", async () => {
    const transcriber = makeTranscriber();
    const resolver = vi.fn().mockResolvedValue(null);
    const msg = makeMessage({
      text: "null resolve",
      attachments: [makeAudioAttachment()],
    });
    const deps: MediaProcessorDeps = {
      transcriber,
      resolveAttachment: resolver,
      logger: makeLogger(),
    };

    const result = await preprocessMessage(deps, msg);

    expect(result.message.text).toBe("null resolve");
    expect(result.transcriptions).toHaveLength(0);
    expect(transcriber.transcribe).not.toHaveBeenCalled();
  });

  it("skips all media attachments gracefully when no resolveAttachment provided", async () => {
    const transcriber = makeTranscriber();
    const imageAnalyzer = makeImageAnalyzer();
    const msg = makeMessage({
      text: "no resolver",
      attachments: [makeAudioAttachment(), makeImageAttachment()],
    });
    const deps: MediaProcessorDeps = {
      transcriber,
      imageAnalyzer,
      logger: makeLogger(),
    };

    const result = await preprocessMessage(deps, msg);

    expect(result.message.text).toBe("no resolver");
    expect(result.transcriptions).toHaveLength(0);
    expect(result.analyses).toHaveLength(0);
    expect(transcriber.transcribe).not.toHaveBeenCalled();
    expect(imageAnalyzer.analyze).not.toHaveBeenCalled();
  });

  it("preserves original attachments on enriched message", async () => {
    const transcriber = makeTranscriber();
    const resolver = makeResolver();
    const audioAtt = makeAudioAttachment();
    const msg = makeMessage({
      text: "check attachments preserved",
      attachments: [audioAtt],
    });
    const deps: MediaProcessorDeps = {
      transcriber,
      resolveAttachment: resolver,
      logger: makeLogger(),
    };

    const result = await preprocessMessage(deps, msg);

    // Original attachments remain on the enriched message
    expect(result.message.attachments).toHaveLength(1);
    expect(result.message.attachments[0]).toEqual(audioAtt);
  });

  it("uses attachment type field as fallback when mimeType is missing", async () => {
    const transcriber = makeTranscriber();
    const resolver = makeResolver();
    const att: Attachment = {
      type: "audio",
      url: "tg-file://voice",
      // No mimeType specified
    };
    const msg = makeMessage({
      text: "no mime",
      attachments: [att],
    });
    const deps: MediaProcessorDeps = {
      transcriber,
      resolveAttachment: resolver,
      logger: makeLogger(),
    };

    const result = await preprocessMessage(deps, msg);

    expect(result.transcriptions).toHaveLength(1);
    // Should default to audio/ogg when mimeType is missing
    expect(transcriber.transcribe).toHaveBeenCalledWith(expect.any(Buffer), {
      mimeType: "audio/ogg",
    });
  });

  // -------------------------------------------------------------------------
  // alreadyTranscribed check
  // -------------------------------------------------------------------------

  it("reuses existing transcription when att.transcription is set", async () => {
    const transcriber = makeTranscriber();
    const resolver = makeResolver();
    const att: Attachment = {
      type: "audio",
      url: "tg-file://voice-preflight",
      mimeType: "audio/ogg",
      transcription: "hello from preflight",
    };
    const msg = makeMessage({
      text: "original text",
      attachments: [att],
    });
    const deps: MediaProcessorDeps = {
      transcriber,
      resolveAttachment: resolver,
      logger: makeLogger(),
    };

    const result = await preprocessMessage(deps, msg);

    // Should NOT call transcriber or resolver
    expect(transcriber.transcribe).not.toHaveBeenCalled();
    expect(resolver).not.toHaveBeenCalled();
    // Should include preflight transcript in enriched text
    expect(result.message.text).toContain("[Voice message transcription]: hello from preflight");
    expect(result.message.text).toContain("original text");
    expect(result.transcriptions).toHaveLength(1);
    expect(result.transcriptions[0]!.text).toBe("hello from preflight");
  });

  it("logs debug with reason 'preflight' when reusing existing transcription", async () => {
    const transcriber = makeTranscriber();
    const resolver = makeResolver();
    const logger = makeLogger();
    const att: Attachment = {
      type: "audio",
      url: "tg-file://voice-preflight",
      mimeType: "audio/ogg",
      transcription: "preflight text",
    };
    const msg = makeMessage({ attachments: [att] });
    const deps: MediaProcessorDeps = {
      transcriber,
      resolveAttachment: resolver,
      logger,
    };

    await preprocessMessage(deps, msg);

    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ url: att.url, reason: "preflight" }),
      "Audio attachment already transcribed, reusing",
    );
  });

  // -------------------------------------------------------------------------
  // File size pre-check
  // -------------------------------------------------------------------------

  it("rejects oversized attachment when sizeBytes exceeds maxMediaBytes", async () => {
    const transcriber = makeTranscriber();
    const resolver = makeResolver();
    const att: Attachment = {
      type: "audio",
      url: "tg-file://big-audio",
      mimeType: "audio/ogg",
      sizeBytes: 50_000_000, // 50MB
    };
    const msg = makeMessage({
      text: "big file",
      attachments: [att],
    });
    const deps: MediaProcessorDeps = {
      transcriber,
      resolveAttachment: resolver,
      maxMediaBytes: 25_000_000, // 25MB limit
      logger: makeLogger(),
    };

    const result = await preprocessMessage(deps, msg);

    // Should skip the attachment entirely
    expect(result.message.text).toBe("big file");
    expect(result.transcriptions).toHaveLength(0);
    expect(resolver).not.toHaveBeenCalled();
    expect(transcriber.transcribe).not.toHaveBeenCalled();
  });

  it("rejects oversized image attachment via maxMediaBytes pre-check", async () => {
    const imageAnalyzer = makeImageAnalyzer();
    const resolver = makeResolver();
    const logger = makeLogger();
    const att: Attachment = {
      type: "image",
      url: "tg-file://big-image",
      mimeType: "image/jpeg",
      sizeBytes: 100_000_000,
    };
    const msg = makeMessage({ attachments: [att] });
    const deps: MediaProcessorDeps = {
      imageAnalyzer,
      resolveAttachment: resolver,
      maxMediaBytes: 25_000_000,
      logger,
    };

    const result = await preprocessMessage(deps, msg);

    expect(result.analyses).toHaveLength(0);
    expect(resolver).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "oversized", sizeBytes: 100_000_000, maxBytes: 25_000_000 }),
      "Attachment rejected: exceeds size limit",
    );
  });

  it("allows attachment when sizeBytes is within maxMediaBytes limit", async () => {
    const transcriber = makeTranscriber();
    const resolver = makeResolver();
    const att: Attachment = {
      type: "audio",
      url: "tg-file://small-audio",
      mimeType: "audio/ogg",
      sizeBytes: 1_000_000,
    };
    const msg = makeMessage({ attachments: [att] });
    const deps: MediaProcessorDeps = {
      transcriber,
      resolveAttachment: resolver,
      maxMediaBytes: 25_000_000,
      logger: makeLogger(),
    };

    const result = await preprocessMessage(deps, msg);

    expect(result.transcriptions).toHaveLength(1);
    expect(transcriber.transcribe).toHaveBeenCalledOnce();
  });

  it("skips size check when sizeBytes is undefined", async () => {
    const transcriber = makeTranscriber();
    const resolver = makeResolver();
    const att: Attachment = {
      type: "audio",
      url: "tg-file://no-size",
      mimeType: "audio/ogg",
      // No sizeBytes
    };
    const msg = makeMessage({ attachments: [att] });
    const deps: MediaProcessorDeps = {
      transcriber,
      resolveAttachment: resolver,
      maxMediaBytes: 25_000_000,
      logger: makeLogger(),
    };

    const result = await preprocessMessage(deps, msg);

    expect(result.transcriptions).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Decision tracking logging
  // -------------------------------------------------------------------------

  it("logs debug with reason 'stt' on successful transcription", async () => {
    const transcriber = makeTranscriber();
    const resolver = makeResolver();
    const logger = makeLogger();
    const att = makeAudioAttachment();
    const msg = makeMessage({ attachments: [att] });
    const deps: MediaProcessorDeps = {
      transcriber,
      resolveAttachment: resolver,
      logger,
    };

    await preprocessMessage(deps, msg);

    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ url: att.url, reason: "stt" }),
      "Audio attachment transcribed",
    );
  });

  it("logs debug with reason 'vision' on successful image analysis", async () => {
    const imageAnalyzer = makeImageAnalyzer();
    const resolver = makeResolver();
    const logger = makeLogger();
    const att = makeImageAttachment();
    const msg = makeMessage({ attachments: [att] });
    const deps: MediaProcessorDeps = {
      imageAnalyzer,
      resolveAttachment: resolver,
      logger,
    };

    await preprocessMessage(deps, msg);

    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ url: att.url, reason: "vision" }),
      "Image attachment analyzed",
    );
  });

  it("logs debug with reason 'no-transcriber' when transcriber is missing", async () => {
    const resolver = makeResolver();
    const logger = makeLogger();
    const att = makeAudioAttachment();
    const msg = makeMessage({ attachments: [att] });
    const deps: MediaProcessorDeps = {
      resolveAttachment: resolver,
      logger,
    };

    await preprocessMessage(deps, msg);

    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ url: att.url, reason: "no-transcriber" }),
      "Audio skipped: no transcriber",
    );
  });

  it("logs debug with reason 'no-analyzer' when imageAnalyzer is missing", async () => {
    const resolver = makeResolver();
    const logger = makeLogger();
    const att = makeImageAttachment();
    const msg = makeMessage({ attachments: [att] });
    const deps: MediaProcessorDeps = {
      resolveAttachment: resolver,
      logger,
    };

    await preprocessMessage(deps, msg);

    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ url: att.url, reason: "no-analyzer" }),
      "Image skipped: no analyzer",
    );
  });

  it("logs debug with reason 'stt-failed' when transcription returns error", async () => {
    const transcriber: TranscriptionPort = {
      transcribe: vi.fn().mockResolvedValue(err(new Error("API rate limited"))),
    };
    const resolver = makeResolver();
    const logger = makeLogger();
    const att = makeAudioAttachment();
    const msg = makeMessage({ attachments: [att] });
    const deps: MediaProcessorDeps = {
      transcriber,
      resolveAttachment: resolver,
      logger,
    };

    await preprocessMessage(deps, msg);

    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ url: att.url, reason: "stt-failed" }),
      "Transcription failed",
    );
  });

  it("logs debug with reason 'resolve-failed' when audio resolve throws", async () => {
    const transcriber = makeTranscriber();
    const resolver = vi.fn().mockRejectedValue(new Error("network error"));
    const logger = makeLogger();
    const att = makeAudioAttachment();
    const msg = makeMessage({ attachments: [att] });
    const deps: MediaProcessorDeps = {
      transcriber,
      resolveAttachment: resolver,
      logger,
    };

    await preprocessMessage(deps, msg);

    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ url: att.url, reason: "resolve-failed" }),
      "Attachment resolve failed",
    );
  });

  // -------------------------------------------------------------------------
  // Vision-direct path (visionAvailable=true)
  // -------------------------------------------------------------------------

  function makeSanitizeImage(overrides?: { fail?: boolean; error?: string }) {
    return vi.fn(async (_buffer: Buffer, _mimeType: string) => {
      if (overrides?.fail) {
        return err(overrides.error ?? "sanitize-failed") as Result<{ buffer: Buffer; mimeType: string; width: number; height: number; originalBytes: number; sanitizedBytes: number }, string>;
      }
      const sanitizedBuf = Buffer.from("sanitized-image-data");
      return ok({
        buffer: sanitizedBuf,
        mimeType: "image/jpeg",
        width: 800,
        height: 600,
        originalBytes: 2048,
        sanitizedBytes: sanitizedBuf.length,
      }) as Result<{ buffer: Buffer; mimeType: string; width: number; height: number; originalBytes: number; sanitizedBytes: number }, string>;
    });
  }

  it("produces imageContents when visionAvailable=true with image attachment", async () => {
    const sanitizeImage = makeSanitizeImage();
    const resolver = makeResolver();
    const msg = makeMessage({
      text: "look at this",
      attachments: [makeImageAttachment()],
    });
    const deps: MediaProcessorDeps = {
      visionAvailable: true,
      sanitizeImage,
      resolveAttachment: resolver,
      logger: makeLogger(),
    };

    const result = await preprocessMessage(deps, msg);

    expect(result.imageContents).toHaveLength(1);
    expect(result.imageContents[0]!.type).toBe("image");
    expect(result.imageContents[0]!.mimeType).toBe("image/jpeg");
    expect(result.imageContents[0]!.data).toBe(Buffer.from("sanitized-image-data").toString("base64"));
    // Should NOT produce text descriptions or analyses
    expect(result.analyses).toHaveLength(0);
    expect(result.message.text).toBe("look at this"); // No [Image analysis] prefix
    expect(sanitizeImage).toHaveBeenCalledOnce();
    expect(resolver).toHaveBeenCalledOnce();
  });

  it("uses text description fallback when visionAvailable=false with image attachment", async () => {
    const imageAnalyzer = makeImageAnalyzer();
    const resolver = makeResolver();
    const msg = makeMessage({
      text: "describe this",
      attachments: [makeImageAttachment()],
    });
    const deps: MediaProcessorDeps = {
      visionAvailable: false,
      imageAnalyzer,
      resolveAttachment: resolver,
      logger: makeLogger(),
    };

    const result = await preprocessMessage(deps, msg);

    expect(result.imageContents).toHaveLength(0);
    expect(result.analyses).toHaveLength(1);
    expect(result.message.text).toContain("[Image analysis]:");
    expect(imageAnalyzer.analyze).toHaveBeenCalledOnce();
  });

  it("skips image gracefully when visionAvailable=true but sanitizeImage is missing", async () => {
    const resolver = makeResolver();
    const logger = makeLogger();
    const msg = makeMessage({
      text: "no sanitizer",
      attachments: [makeImageAttachment()],
    });
    const deps: MediaProcessorDeps = {
      visionAvailable: true,
      // No sanitizeImage provided
      resolveAttachment: resolver,
      logger,
    };

    const result = await preprocessMessage(deps, msg);

    expect(result.imageContents).toHaveLength(0);
    expect(result.analyses).toHaveLength(0);
    expect(result.message.text).toBe("no sanitizer");
    expect(resolver).not.toHaveBeenCalled(); // resolver is not called when sanitizer missing
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "no-sanitizer" }),
      "Image skipped: visionAvailable but no sanitizeImage",
    );
  });

  it("produces empty imageContents when visionAvailable=true but sanitizeImage returns err", async () => {
    const sanitizeImage = makeSanitizeImage({ fail: true, error: "image too large" });
    const resolver = makeResolver();
    const logger = makeLogger();
    const msg = makeMessage({
      text: "bad image",
      attachments: [makeImageAttachment()],
    });
    const deps: MediaProcessorDeps = {
      visionAvailable: true,
      sanitizeImage,
      resolveAttachment: resolver,
      logger,
    };

    const result = await preprocessMessage(deps, msg);

    expect(result.imageContents).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: "image too large" }),
      "Image sanitization failed, skipping",
    );
  });

  it("mixed voice + image with visionAvailable=true: transcription in text, image in imageContents", async () => {
    const transcriber = makeTranscriber();
    const sanitizeImage = makeSanitizeImage();
    const resolver = makeResolver();
    const msg = makeMessage({
      text: "mixed",
      attachments: [makeAudioAttachment(), makeImageAttachment()],
    });
    const deps: MediaProcessorDeps = {
      transcriber,
      visionAvailable: true,
      sanitizeImage,
      resolveAttachment: resolver,
      logger: makeLogger(),
    };

    const result = await preprocessMessage(deps, msg);

    // Audio should be transcribed normally
    expect(result.transcriptions).toHaveLength(1);
    expect(result.message.text).toContain("[Voice message transcription]: hello from voice");
    // Image should be in imageContents, not text
    expect(result.imageContents).toHaveLength(1);
    expect(result.analyses).toHaveLength(0);
    expect(result.message.text).not.toContain("[Image analysis]");
  });

  it("caps imageContents at 10 and warns when more than 10 images", async () => {
    const sanitizeImage = makeSanitizeImage();
    const resolver = makeResolver();
    const logger = makeLogger();
    const attachments = Array.from({ length: 12 }, (_, i) =>
      makeImageAttachment(`tg-file://image-${i}`),
    );
    const msg = makeMessage({
      text: "many images",
      attachments,
    });
    const deps: MediaProcessorDeps = {
      visionAvailable: true,
      sanitizeImage,
      resolveAttachment: resolver,
      logger,
    };

    const result = await preprocessMessage(deps, msg);

    expect(result.imageContents).toHaveLength(10);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 10 }),
      "Image content limit reached, skipping remaining images",
    );
    // sanitizeImage should have been called exactly 10 times
    expect(sanitizeImage).toHaveBeenCalledTimes(10);
  });

  // -------------------------------------------------------------------------
  // Video processing
  // -------------------------------------------------------------------------

  function makeVideoAttachment(url = "tg-file://video1"): Attachment {
    return {
      type: "video",
      url,
      mimeType: "video/mp4",
      sizeBytes: 5_000_000,
    };
  }

  function makeVideoDescriber() {
    return vi.fn().mockResolvedValue(
      ok({ text: "A person walks through a garden", provider: "google", model: "gemini-2.0-flash" }),
    );
  }

  describe("video processing", () => {
    it("describes video attachment and prepends description to text", async () => {
      const describeVideo = makeVideoDescriber();
      const resolver = makeResolver();
      const msg = makeMessage({
        text: "check this video",
        attachments: [makeVideoAttachment()],
      });
      const deps: MediaProcessorDeps = {
        describeVideo,
        resolveAttachment: resolver,
        logger: makeLogger(),
      };

      const result = await preprocessMessage(deps, msg);

      expect(result.message.text).toContain("[Video description]: A person walks through a garden");
      expect(result.message.text).toContain("check this video");
      expect(result.videoDescriptions).toHaveLength(1);
      expect(result.videoDescriptions[0]!.description).toBe("A person walks through a garden");
      expect(result.videoDescriptions[0]!.attachmentUrl).toBe("tg-file://video1");
      expect(resolver).toHaveBeenCalledOnce();
      expect(describeVideo).toHaveBeenCalledOnce();
    });

    it("skips video gracefully when no describeVideo callback provided (emits hint)", async () => {
      const resolver = makeResolver();
      const logger = makeLogger();
      const msg = makeMessage({
        text: "video message",
        attachments: [makeVideoAttachment()],
      });
      const deps: MediaProcessorDeps = {
        resolveAttachment: resolver,
        logger,
      };

      const result = await preprocessMessage(deps, msg);

      expect(result.message.text).toContain("video message");
      expect(result.message.text).toContain("[Attached: video");
      expect(result.videoDescriptions).toHaveLength(0);
      expect(resolver).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "no-video-describer" }),
        "Video skipped: no describer",
      );
    });

    it("logs warning and preserves text when describeVideo returns error", async () => {
      const describeVideo = vi.fn().mockResolvedValue(err(new Error("Gemini quota exceeded")));
      const resolver = makeResolver();
      const logger = makeLogger();
      const msg = makeMessage({
        text: "try describe",
        attachments: [makeVideoAttachment()],
      });
      const deps: MediaProcessorDeps = {
        describeVideo,
        resolveAttachment: resolver,
        logger,
      };

      const result = await preprocessMessage(deps, msg);

      expect(result.message.text).toBe("try describe");
      expect(result.videoDescriptions).toHaveLength(0);
      expect(logger.warn).toHaveBeenCalled();
    });

    it("logs warning and preserves text when describeVideo throws", async () => {
      const describeVideo = vi.fn().mockRejectedValue(new Error("unexpected crash"));
      const resolver = makeResolver();
      const logger = makeLogger();
      const msg = makeMessage({
        text: "try describe throw",
        attachments: [makeVideoAttachment()],
      });
      const deps: MediaProcessorDeps = {
        describeVideo,
        resolveAttachment: resolver,
        logger,
      };

      const result = await preprocessMessage(deps, msg);

      expect(result.message.text).toBe("try describe throw");
      expect(result.videoDescriptions).toHaveLength(0);
      expect(logger.warn).toHaveBeenCalled();
    });

    it("truncates video description to maxVideoDescriptionChars", async () => {
      const longText = "x".repeat(800);
      const describeVideo = vi.fn().mockResolvedValue(
        ok({ text: longText, provider: "google", model: "gemini-2.0-flash" }),
      );
      const resolver = makeResolver();
      const msg = makeMessage({
        text: "long description",
        attachments: [makeVideoAttachment()],
      });
      const deps: MediaProcessorDeps = {
        describeVideo,
        resolveAttachment: resolver,
        maxVideoDescriptionChars: 100,
        logger: makeLogger(),
      };

      const result = await preprocessMessage(deps, msg);

      expect(result.videoDescriptions).toHaveLength(1);
      expect(result.videoDescriptions[0]!.description).toHaveLength(100);
      expect(result.message.text).toContain("[Video description]: " + "x".repeat(100));
    });

    it("uses default 500 char limit when maxVideoDescriptionChars not set", async () => {
      const longText = "y".repeat(600);
      const describeVideo = vi.fn().mockResolvedValue(
        ok({ text: longText, provider: "google", model: "gemini-2.0-flash" }),
      );
      const resolver = makeResolver();
      const msg = makeMessage({
        text: "default limit",
        attachments: [makeVideoAttachment()],
      });
      const deps: MediaProcessorDeps = {
        describeVideo,
        resolveAttachment: resolver,
        logger: makeLogger(),
      };

      const result = await preprocessMessage(deps, msg);

      expect(result.videoDescriptions).toHaveLength(1);
      expect(result.videoDescriptions[0]!.description).toHaveLength(500);
    });

    it("classifies attachment as video via mimeType", async () => {
      const describeVideo = makeVideoDescriber();
      const resolver = makeResolver();
      const att: Attachment = {
        type: "other",
        url: "tg-file://video-webm",
        mimeType: "video/webm",
        sizeBytes: 3_000_000,
      };
      const msg = makeMessage({
        text: "webm video",
        attachments: [att],
      });
      const deps: MediaProcessorDeps = {
        describeVideo,
        resolveAttachment: resolver,
        logger: makeLogger(),
      };

      const result = await preprocessMessage(deps, msg);

      expect(result.videoDescriptions).toHaveLength(1);
      expect(describeVideo).toHaveBeenCalledOnce();
    });

    it("classifies attachment as video via type field fallback", async () => {
      const describeVideo = makeVideoDescriber();
      const resolver = makeResolver();
      const att: Attachment = {
        type: "video",
        url: "tg-file://video-notype",
        // No mimeType
      };
      const msg = makeMessage({
        text: "type fallback",
        attachments: [att],
      });
      const deps: MediaProcessorDeps = {
        describeVideo,
        resolveAttachment: resolver,
        logger: makeLogger(),
      };

      const result = await preprocessMessage(deps, msg);

      expect(result.videoDescriptions).toHaveLength(1);
      expect(describeVideo).toHaveBeenCalledOnce();
    });

    it("processes mixed audio + video + image attachments", async () => {
      const transcriber = makeTranscriber();
      const imageAnalyzer = makeImageAnalyzer();
      const describeVideo = makeVideoDescriber();
      const resolver = makeResolver();
      const msg = makeMessage({
        text: "mixed media all types",
        attachments: [makeAudioAttachment(), makeVideoAttachment(), makeImageAttachment()],
      });
      const deps: MediaProcessorDeps = {
        transcriber,
        imageAnalyzer,
        describeVideo,
        resolveAttachment: resolver,
        logger: makeLogger(),
      };

      const result = await preprocessMessage(deps, msg);

      expect(result.transcriptions).toHaveLength(1);
      expect(result.videoDescriptions).toHaveLength(1);
      expect(result.analyses).toHaveLength(1);
      expect(result.message.text).toContain("[Voice message transcription]:");
      expect(result.message.text).toContain("[Video description]:");
      expect(result.message.text).toContain("[Image analysis]:");
      expect(result.message.text).toContain("mixed media all types");
    });

    it("skips video when resolveAttachment returns null", async () => {
      const describeVideo = makeVideoDescriber();
      const resolver = vi.fn().mockResolvedValue(null);
      const msg = makeMessage({
        text: "null resolve video",
        attachments: [makeVideoAttachment()],
      });
      const deps: MediaProcessorDeps = {
        describeVideo,
        resolveAttachment: resolver,
        logger: makeLogger(),
      };

      const result = await preprocessMessage(deps, msg);

      expect(result.videoDescriptions).toHaveLength(0);
      expect(describeVideo).not.toHaveBeenCalled();
    });

    it("skips video when resolveAttachment throws", async () => {
      const describeVideo = makeVideoDescriber();
      const resolver = vi.fn().mockRejectedValue(new Error("network error"));
      const logger = makeLogger();
      const msg = makeMessage({
        text: "resolve throw video",
        attachments: [makeVideoAttachment()],
      });
      const deps: MediaProcessorDeps = {
        describeVideo,
        resolveAttachment: resolver,
        logger,
      };

      const result = await preprocessMessage(deps, msg);

      expect(result.videoDescriptions).toHaveLength(0);
      expect(describeVideo).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalled();
    });

    it("defaults to video/mp4 mimeType when attachment mimeType is missing", async () => {
      const describeVideo = makeVideoDescriber();
      const resolver = makeResolver();
      const att: Attachment = {
        type: "video",
        url: "tg-file://video-nomime",
        // No mimeType
      };
      const msg = makeMessage({
        text: "no mime video",
        attachments: [att],
      });
      const deps: MediaProcessorDeps = {
        describeVideo,
        resolveAttachment: resolver,
        logger: makeLogger(),
      };

      const result = await preprocessMessage(deps, msg);

      expect(result.videoDescriptions).toHaveLength(1);
      expect(describeVideo).toHaveBeenCalledWith(
        expect.any(Buffer),
        "video/mp4",
        "Describe this video concisely.",
      );
    });
  });

  // -------------------------------------------------------------------------
  // Document processing
  // -------------------------------------------------------------------------

  function makeFileExtractor(overrides?: { fail?: boolean; errorKind?: string; text?: string }): FileExtractionPort {
    return {
      supportedMimes: ["text/plain", "application/pdf"],
      extract: overrides?.fail
        ? vi.fn().mockResolvedValue(err({ kind: overrides.errorKind ?? "internal", message: "extraction failed" }))
        : vi.fn().mockResolvedValue(ok({
            text: overrides?.text ?? "Extracted document content",
            fileName: "report.pdf",
            mimeType: "application/pdf",
            extractedChars: (overrides?.text ?? "Extracted document content").length,
            truncated: false,
            durationMs: 15,
            buffer: Buffer.from("fake-pdf"),
          })),
    };
  }

  function makeDocumentAttachment(url = "tg-file://doc1", overrides?: Partial<Attachment>): Attachment {
    return {
      type: "file",
      url,
      mimeType: "application/pdf",
      fileName: "report.pdf",
      sizeBytes: 50_000,
      ...overrides,
    };
  }

  describe("document processing", () => {
    it("extracts document content and wraps with security boundary", async () => {
      const fileExtractor = makeFileExtractor();
      const resolver = makeResolver();
      const msg = makeMessage({
        text: "check this document",
        attachments: [makeDocumentAttachment()],
      });
      const deps: MediaProcessorDeps = {
        fileExtractor,
        resolveAttachment: resolver,
        logger: makeLogger(),
      };

      const result = await preprocessMessage(deps, msg);

      // Enriched text should contain XML file block markers
      expect(result.message.text).toContain("<file name=");
      expect(result.message.text).toContain("Extracted document content");
      // Security wrapping: UNTRUSTED_ marker from wrapExternalContent
      expect(result.message.text).toContain("UNTRUSTED_");
      // Original text preserved
      expect(result.message.text).toContain("check this document");
      // Metrics collected
      expect(result.fileExtractions).toHaveLength(1);
      expect(result.fileExtractions[0]!.url).toBe("tg-file://doc1");
      expect(result.fileExtractions[0]!.fileName).toBe("report.pdf");
      expect(result.fileExtractions[0]!.mimeType).toBe("application/pdf");
      expect(result.fileExtractions[0]!.extractedChars).toBe("Extracted document content".length);
      expect(result.fileExtractions[0]!.truncated).toBe(false);
      expect(result.fileExtractions[0]!.durationMs).toBe(15);
      expect(fileExtractor.extract).toHaveBeenCalledOnce();
      expect(resolver).toHaveBeenCalledOnce();
    });

    it("skips document when fileExtractor is not provided but emits hint", async () => {
      const resolver = makeResolver();
      const msg = makeMessage({
        text: "no extractor",
        attachments: [makeDocumentAttachment()],
      });
      const deps: MediaProcessorDeps = {
        // No fileExtractor
        resolveAttachment: resolver,
        logger: makeLogger(),
      };

      const result = await preprocessMessage(deps, msg);

      expect(result.message.text).toContain("no extractor");
      expect(result.message.text).toContain("[Attached: document");
      expect(result.fileExtractions).toHaveLength(0);
      expect(resolver).not.toHaveBeenCalled();
    });

    it("classifies attachment as document via MIME type", async () => {
      const fileExtractor = makeFileExtractor();
      const resolver = makeResolver();
      const att: Attachment = {
        type: "other",
        url: "tg-file://textfile",
        mimeType: "text/plain",
        sizeBytes: 1000,
      };
      const msg = makeMessage({
        text: "text file",
        attachments: [att],
      });
      const deps: MediaProcessorDeps = {
        fileExtractor,
        resolveAttachment: resolver,
        logger: makeLogger(),
      };

      const result = await preprocessMessage(deps, msg);

      expect(fileExtractor.extract).toHaveBeenCalledOnce();
      expect(result.fileExtractions).toHaveLength(1);
    });

    it("classifies attachment as document via att.type=file fallback", async () => {
      const fileExtractor = makeFileExtractor();
      const resolver = makeResolver();
      const att: Attachment = {
        type: "file",
        url: "tg-file://unknown-file",
        // No mimeType
      };
      const msg = makeMessage({
        text: "file fallback",
        attachments: [att],
      });
      const deps: MediaProcessorDeps = {
        fileExtractor,
        resolveAttachment: resolver,
        logger: makeLogger(),
      };

      const result = await preprocessMessage(deps, msg);

      expect(fileExtractor.extract).toHaveBeenCalledOnce();
      expect(result.fileExtractions).toHaveLength(1);
    });

    it("logs warning and continues when extraction fails", async () => {
      const fileExtractor = makeFileExtractor({ fail: true, errorKind: "encrypted" });
      const resolver = makeResolver();
      const logger = makeLogger();
      const msg = makeMessage({
        text: "bad document",
        attachments: [makeDocumentAttachment()],
      });
      const deps: MediaProcessorDeps = {
        fileExtractor,
        resolveAttachment: resolver,
        logger,
      };

      const result = await preprocessMessage(deps, msg);

      expect(result.message.text).toBe("bad document");
      expect(result.fileExtractions).toHaveLength(0);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          hint: "Document extraction failed; message pipeline continues",
          errorKind: "dependency",
        }),
        "Document extraction failed",
      );
    });

    it("enforces per-message maxTotalChars budget", async () => {
      // Each extraction returns 30 chars, budget is 50, so 2 fit (30 + 30 = 60 > 50 but
      // first two are processed because budget check is BEFORE download and total is checked
      // against cumulative. First doc: total = 0 < 50 -> process -> total = 30.
      // Second doc: total = 30 < 50 -> process -> total = 60.
      // Third doc: total = 60 >= 50 -> skip.
      const text30 = "x".repeat(30);
      const fileExtractor = makeFileExtractor({ text: text30 });
      const resolver = makeResolver();
      const msg = makeMessage({
        text: "budget test",
        attachments: [
          makeDocumentAttachment("tg-file://doc1"),
          makeDocumentAttachment("tg-file://doc2"),
          makeDocumentAttachment("tg-file://doc3"),
        ],
      });
      const deps: MediaProcessorDeps = {
        fileExtractor,
        fileExtractionConfig: { maxTotalChars: 50 },
        resolveAttachment: resolver,
        logger: makeLogger(),
      };

      const result = await preprocessMessage(deps, msg);

      // First two processed, third skipped
      expect(result.fileExtractions).toHaveLength(2);
      expect(fileExtractor.extract).toHaveBeenCalledTimes(2);
    });

    it("processes multiple document attachments", async () => {
      const fileExtractor = makeFileExtractor();
      const resolver = makeResolver();
      const msg = makeMessage({
        text: "two docs",
        attachments: [
          makeDocumentAttachment("tg-file://doc1"),
          makeDocumentAttachment("tg-file://doc2"),
        ],
      });
      const deps: MediaProcessorDeps = {
        fileExtractor,
        resolveAttachment: resolver,
        logger: makeLogger(),
      };

      const result = await preprocessMessage(deps, msg);

      expect(result.fileExtractions).toHaveLength(2);
      expect(fileExtractor.extract).toHaveBeenCalledTimes(2);
      // Both file blocks should appear in text
      const fileBlockCount = (result.message.text.match(/<file name=/g) ?? []).length;
      expect(fileBlockCount).toBe(2);
    });

    it("handles resolve failure gracefully for documents", async () => {
      const fileExtractor = makeFileExtractor();
      const resolver = vi.fn().mockRejectedValue(new Error("network error"));
      const logger = makeLogger();
      const msg = makeMessage({
        text: "resolve fail",
        attachments: [makeDocumentAttachment()],
      });
      const deps: MediaProcessorDeps = {
        fileExtractor,
        resolveAttachment: resolver,
        logger,
      };

      const result = await preprocessMessage(deps, msg);

      expect(result.message.text).toBe("resolve fail");
      expect(result.fileExtractions).toHaveLength(0);
      expect(logger.warn).toHaveBeenCalled();
      expect(fileExtractor.extract).not.toHaveBeenCalled();
    });

    it("skips document when resolve returns null", async () => {
      const fileExtractor = makeFileExtractor();
      const resolver = vi.fn().mockResolvedValue(null);
      const msg = makeMessage({
        text: "null resolve doc",
        attachments: [makeDocumentAttachment()],
      });
      const deps: MediaProcessorDeps = {
        fileExtractor,
        resolveAttachment: resolver,
        logger: makeLogger(),
      };

      const result = await preprocessMessage(deps, msg);

      expect(result.fileExtractions).toHaveLength(0);
      expect(fileExtractor.extract).not.toHaveBeenCalled();
    });

    it("processes mixed audio + document + image attachments", async () => {
      const transcriber = makeTranscriber();
      const imageAnalyzer = makeImageAnalyzer();
      const fileExtractor = makeFileExtractor();
      const resolver = makeResolver();
      const msg = makeMessage({
        text: "all three types",
        attachments: [
          makeAudioAttachment(),
          makeDocumentAttachment(),
          makeImageAttachment(),
        ],
      });
      const deps: MediaProcessorDeps = {
        transcriber,
        imageAnalyzer,
        fileExtractor,
        resolveAttachment: resolver,
        logger: makeLogger(),
      };

      const result = await preprocessMessage(deps, msg);

      expect(result.transcriptions).toHaveLength(1);
      expect(result.fileExtractions).toHaveLength(1);
      expect(result.analyses).toHaveLength(1);
      expect(result.message.text).toContain("[Voice message transcription]:");
      expect(result.message.text).toContain("<file name=");
      expect(result.message.text).toContain("[Image analysis]:");
      expect(result.message.text).toContain("all three types");
    });

    it("skips document when maxMediaBytes exceeded", async () => {
      const fileExtractor = makeFileExtractor();
      const resolver = makeResolver();
      const msg = makeMessage({
        text: "oversized doc",
        attachments: [makeDocumentAttachment("tg-file://bigdoc", { sizeBytes: 100_000_000 })],
      });
      const deps: MediaProcessorDeps = {
        fileExtractor,
        resolveAttachment: resolver,
        maxMediaBytes: 25_000_000,
        logger: makeLogger(),
      };

      const result = await preprocessMessage(deps, msg);

      expect(result.fileExtractions).toHaveLength(0);
      expect(resolver).not.toHaveBeenCalled();
      expect(fileExtractor.extract).not.toHaveBeenCalled();
    });

    it("returns empty fileExtractions when no attachments", async () => {
      const msg = makeMessage({ text: "no attachments" });
      const deps: MediaProcessorDeps = { logger: makeLogger() };

      const result = await preprocessMessage(deps, msg);

      expect(result.fileExtractions).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Attachment hint injection
  // -------------------------------------------------------------------------

  describe("attachment hint injection", () => {
    it("emits audio hint when no transcriber is provided", async () => {
      const resolver = makeResolver();
      const att: Attachment = {
        type: "audio",
        url: "tg-file://abc",
        mimeType: "audio/ogg",
        durationMs: 3000,
        sizeBytes: 1024,
      };
      const msg = makeMessage({
        text: "original text",
        attachments: [att],
      });
      const deps: MediaProcessorDeps = {
        resolveAttachment: resolver,
        logger: makeLogger(),
      };

      const result = await preprocessMessage(deps, msg);

      expect(result.message.text).toContain(
        "[Attached: voice message (3000ms, audio/ogg) — use transcribe_audio tool to listen | url: tg-file://abc]",
      );
      expect(result.message.text).toContain("original text");
    });

    it("emits audio hint without duration when durationMs is missing", async () => {
      const resolver = makeResolver();
      const att: Attachment = {
        type: "audio",
        url: "tg-file://abc2",
        mimeType: "audio/ogg",
        sizeBytes: 1024,
        // no durationMs
      };
      const msg = makeMessage({
        text: "no duration",
        attachments: [att],
      });
      const deps: MediaProcessorDeps = {
        resolveAttachment: resolver,
        logger: makeLogger(),
      };

      const result = await preprocessMessage(deps, msg);

      expect(result.message.text).toContain(
        "[Attached: voice message (audio/ogg) — use transcribe_audio tool to listen | url: tg-file://abc2]",
      );
    });

    it("emits image hint when no imageAnalyzer and visionAvailable is false", async () => {
      const resolver = makeResolver();
      const att: Attachment = {
        type: "image",
        url: "discord://img",
        mimeType: "image/jpeg",
        sizeBytes: 12345,
      };
      const msg = makeMessage({
        text: "original text",
        attachments: [att],
      });
      const deps: MediaProcessorDeps = {
        visionAvailable: false,
        resolveAttachment: resolver,
        logger: makeLogger(),
      };

      const result = await preprocessMessage(deps, msg);

      expect(result.message.text).toContain(
        "[Attached: image (image/jpeg, 12345 bytes) — use image_analyze tool to view | url: discord://img]",
      );
      expect(result.message.text).toContain("original text");
    });

    it("emits image hint without size when sizeBytes is missing", async () => {
      const resolver = makeResolver();
      const att: Attachment = {
        type: "image",
        url: "discord://img2",
        mimeType: "image/png",
        // no sizeBytes
      };
      const msg = makeMessage({
        text: "no size",
        attachments: [att],
      });
      const deps: MediaProcessorDeps = {
        resolveAttachment: resolver,
        logger: makeLogger(),
      };

      const result = await preprocessMessage(deps, msg);

      expect(result.message.text).toContain(
        "[Attached: image (image/png) — use image_analyze tool to view | url: discord://img2]",
      );
    });

    it("emits video hint when no describeVideo is provided", async () => {
      const resolver = makeResolver();
      const att: Attachment = {
        type: "video",
        url: "tg-file://vid",
        mimeType: "video/mp4",
        sizeBytes: 99999,
        durationMs: 5000,
      };
      const msg = makeMessage({
        text: "original text",
        attachments: [att],
      });
      const deps: MediaProcessorDeps = {
        resolveAttachment: resolver,
        logger: makeLogger(),
      };

      const result = await preprocessMessage(deps, msg);

      expect(result.message.text).toContain(
        "[Attached: video (video/mp4, 99999 bytes, 5000ms) — use describe_video tool to view | url: tg-file://vid]",
      );
      expect(result.message.text).toContain("original text");
    });

    it("emits video hint with omitted optional fields", async () => {
      const resolver = makeResolver();
      const att: Attachment = {
        type: "video",
        url: "tg-file://vid2",
        // no mimeType, no sizeBytes, no durationMs
      };
      const msg = makeMessage({
        text: "minimal video",
        attachments: [att],
      });
      const deps: MediaProcessorDeps = {
        resolveAttachment: resolver,
        logger: makeLogger(),
      };

      const result = await preprocessMessage(deps, msg);

      expect(result.message.text).toContain(
        "[Attached: video (video/mp4) — use describe_video tool to view | url: tg-file://vid2]",
      );
    });

    it("emits document hint when no fileExtractor is provided", async () => {
      const resolver = makeResolver();
      const att: Attachment = {
        type: "file",
        url: "tg-file://doc",
        mimeType: "application/pdf",
        fileName: "report.pdf",
        sizeBytes: 50000,
      };
      const msg = makeMessage({
        text: "original text",
        attachments: [att],
      });
      const deps: MediaProcessorDeps = {
        resolveAttachment: resolver,
        logger: makeLogger(),
      };

      const result = await preprocessMessage(deps, msg);

      expect(result.message.text).toContain(
        '[Attached: document "report.pdf" (application/pdf, 50000 bytes) — use extract_document tool to read | url: tg-file://doc]',
      );
      expect(result.message.text).toContain("original text");
    });

    it("emits document hint with defaults when optional fields are missing", async () => {
      const resolver = makeResolver();
      const att: Attachment = {
        type: "file",
        url: "tg-file://doc2",
        // no mimeType, no fileName, no sizeBytes
      };
      const msg = makeMessage({
        text: "minimal doc",
        attachments: [att],
      });
      const deps: MediaProcessorDeps = {
        resolveAttachment: resolver,
        logger: makeLogger(),
      };

      const result = await preprocessMessage(deps, msg);

      expect(result.message.text).toContain(
        '[Attached: document "file" (application/octet-stream) — use extract_document tool to read | url: tg-file://doc2]',
      );
    });

    // Negative tests

    it("does NOT emit hint for oversized attachment", async () => {
      const resolver = makeResolver();
      const att: Attachment = {
        type: "audio",
        url: "tg-file://big-audio",
        mimeType: "audio/ogg",
        sizeBytes: 50_000_000,
        durationMs: 3000,
      };
      const msg = makeMessage({
        text: "oversized test",
        attachments: [att],
      });
      const deps: MediaProcessorDeps = {
        resolveAttachment: resolver,
        maxMediaBytes: 25_000_000,
        logger: makeLogger(),
      };

      const result = await preprocessMessage(deps, msg);

      expect(result.message.text).toBe("oversized test");
      expect(result.message.text).not.toContain("[Attached:");
    });

    it("does NOT emit hint for audio with existing transcription", async () => {
      const transcriber = makeTranscriber();
      const resolver = makeResolver();
      const att: Attachment = {
        type: "audio",
        url: "tg-file://already-transcribed",
        mimeType: "audio/ogg",
        transcription: "hello from preflight",
      };
      const msg = makeMessage({
        text: "already transcribed",
        attachments: [att],
      });
      const deps: MediaProcessorDeps = {
        transcriber,
        resolveAttachment: resolver,
        logger: makeLogger(),
      };

      const result = await preprocessMessage(deps, msg);

      // Should use the existing transcription path, not emit a hint
      expect(result.message.text).not.toContain("[Attached:");
      expect(result.message.text).toContain("[Voice message transcription]: hello from preflight");
    });

    it("does NOT emit hint for image when visionAvailable=true", async () => {
      const sanitizeImage = makeSanitizeImage();
      const resolver = makeResolver();
      const att: Attachment = {
        type: "image",
        url: "tg-file://vision-image",
        mimeType: "image/jpeg",
        sizeBytes: 2048,
      };
      const msg = makeMessage({
        text: "vision direct",
        attachments: [att],
      });
      const deps: MediaProcessorDeps = {
        visionAvailable: true,
        sanitizeImage,
        resolveAttachment: resolver,
        logger: makeLogger(),
      };

      const result = await preprocessMessage(deps, msg);

      expect(result.message.text).not.toContain("[Attached:");
      expect(result.imageContents).toHaveLength(1);
    });

    it("does NOT emit hint when resolveAttachment is absent (short-circuit)", async () => {
      const att: Attachment = {
        type: "audio",
        url: "tg-file://no-resolver",
        mimeType: "audio/ogg",
        durationMs: 3000,
      };
      const msg = makeMessage({
        text: "no resolver",
        attachments: [att],
      });
      const deps: MediaProcessorDeps = {
        // No resolveAttachment
        logger: makeLogger(),
      };

      const result = await preprocessMessage(deps, msg);

      expect(result.message.text).toBe("no resolver");
      expect(result.message.text).not.toContain("[Attached:");
    });

    it("does NOT emit hint for budget-exhausted document skip", async () => {
      const text30 = "x".repeat(30);
      const fileExtractor = makeFileExtractor({ text: text30 });
      const resolver = makeResolver();
      const msg = makeMessage({
        text: "budget test",
        attachments: [
          makeDocumentAttachment("tg-file://doc1"),
          makeDocumentAttachment("tg-file://doc2"),
          makeDocumentAttachment("tg-file://doc3"),
        ],
      });
      const deps: MediaProcessorDeps = {
        fileExtractor,
        fileExtractionConfig: { maxTotalChars: 50 },
        resolveAttachment: resolver,
        logger: makeLogger(),
      };

      const result = await preprocessMessage(deps, msg);

      // First two processed (extracted), third budget-exhausted — no hint for third
      expect(result.fileExtractions).toHaveLength(2);
      expect(result.message.text).not.toContain("[Attached: document");
    });

    it("does NOT emit hint for 'other' type attachments", async () => {
      const resolver = makeResolver();
      const att: Attachment = {
        type: "link" as Attachment["type"],
        url: "https://example.com",
        mimeType: "application/x-unknown-mime",
      };
      const msg = makeMessage({
        text: "link attachment",
        attachments: [att],
      });
      const deps: MediaProcessorDeps = {
        resolveAttachment: resolver,
        logger: makeLogger(),
      };

      const result = await preprocessMessage(deps, msg);

      expect(result.message.text).toBe("link attachment");
      expect(result.message.text).not.toContain("[Attached:");
    });
  });
});
