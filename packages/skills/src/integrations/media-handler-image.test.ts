// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for image attachment handler.
 */

import type { Attachment, ImageAnalysisPort } from "@comis/core";
import { ok, err, type Result } from "@comis/shared";
import { describe, expect, it, vi } from "vitest";
import { processImageAttachment, type ImageHandlerDeps } from "./media-handler-image.js";
import type { MediaProcessorLogger } from "./media-preprocessor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger(): MediaProcessorLogger & { debug: ReturnType<typeof vi.fn> } {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeImageAttachment(url = "tg-file://image1"): Attachment {
  return { type: "image", url, mimeType: "image/jpeg", sizeBytes: 2048 };
}

function makeImageAnalyzer(): ImageAnalysisPort {
  return {
    analyze: vi.fn().mockResolvedValue(ok("A photo of a cat sitting on a keyboard")),
  };
}

function makeResolver(): (att: Attachment) => Promise<Buffer | null> {
  return vi.fn().mockResolvedValue(Buffer.from("fake-image-data"));
}

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

const buildHint = (att: Attachment) =>
  `[Attached: image (${att.mimeType ?? "image/jpeg"}) — use image_analyze tool to view | url: ${att.url}]`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("processImageAttachment", () => {
  // Vision-direct path
  describe("vision-direct path (visionAvailable=true)", () => {
    it("returns imageContent block when sanitizeImage succeeds", async () => {
      const sanitizeImage = makeSanitizeImage();
      const deps: ImageHandlerDeps = {
        visionAvailable: true,
        sanitizeImage,
        resolveAttachment: makeResolver(),
        logger: makeLogger(),
      };

      const result = await processImageAttachment(makeImageAttachment(), deps, 0, buildHint);

      expect(result.imageContent).toBeDefined();
      expect(result.imageContent!.type).toBe("image");
      expect(result.imageContent!.mimeType).toBe("image/jpeg");
      expect(result.imageContent!.data).toBe(Buffer.from("sanitized-image-data").toString("base64"));
      expect(result.textPrefix).toBeUndefined();
      expect(result.analysis).toBeUndefined();
    });

    it("skips with debug log when sanitizeImage is missing", async () => {
      const logger = makeLogger();
      const deps: ImageHandlerDeps = {
        visionAvailable: true,
        resolveAttachment: makeResolver(),
        logger,
      };

      const result = await processImageAttachment(makeImageAttachment(), deps, 0, buildHint);

      expect(result.imageContent).toBeUndefined();
      expect(result.textPrefix).toBeUndefined();
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "no-sanitizer" }),
        "Image skipped: visionAvailable but no sanitizeImage",
      );
    });

    it("skips with warning when imageContentCount >= 10", async () => {
      const logger = makeLogger();
      const deps: ImageHandlerDeps = {
        visionAvailable: true,
        sanitizeImage: makeSanitizeImage(),
        resolveAttachment: makeResolver(),
        logger,
      };

      const result = await processImageAttachment(makeImageAttachment(), deps, 10, buildHint);

      expect(result.imageContent).toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 10 }),
        "Image content limit reached, skipping remaining images",
      );
    });

    it("returns empty result when sanitizeImage fails", async () => {
      const logger = makeLogger();
      const deps: ImageHandlerDeps = {
        visionAvailable: true,
        sanitizeImage: makeSanitizeImage({ fail: true, error: "image too large" }),
        resolveAttachment: makeResolver(),
        logger,
      };

      const result = await processImageAttachment(makeImageAttachment(), deps, 0, buildHint);

      expect(result.imageContent).toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: "image too large" }),
        "Image sanitization failed, skipping",
      );
    });

    it("returns empty result when resolve fails", async () => {
      const logger = makeLogger();
      const deps: ImageHandlerDeps = {
        visionAvailable: true,
        sanitizeImage: makeSanitizeImage(),
        resolveAttachment: vi.fn().mockRejectedValue(new Error("network error")),
        logger,
      };

      const result = await processImageAttachment(makeImageAttachment(), deps, 0, buildHint);

      expect(result.imageContent).toBeUndefined();
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  // Analyzer fallback path
  describe("analyzer fallback path", () => {
    it("returns hint text prefix when no analyzer", async () => {
      const deps: ImageHandlerDeps = {
        resolveAttachment: makeResolver(),
        logger: makeLogger(),
      };

      const result = await processImageAttachment(makeImageAttachment(), deps, 0, buildHint);

      expect(result.textPrefix).toContain("[Attached: image");
      expect(result.analysis).toBeUndefined();
    });

    it("returns analysis on successful analyze", async () => {
      const deps: ImageHandlerDeps = {
        imageAnalyzer: makeImageAnalyzer(),
        resolveAttachment: makeResolver(),
        logger: makeLogger(),
      };

      const result = await processImageAttachment(makeImageAttachment(), deps, 0, buildHint);

      expect(result.textPrefix).toBe("[Image analysis]: A photo of a cat sitting on a keyboard");
      expect(result.analysis).toEqual({
        attachmentUrl: "tg-file://image1",
        description: "A photo of a cat sitting on a keyboard",
      });
    });

    it("returns empty result when analyzer returns error", async () => {
      const imageAnalyzer: ImageAnalysisPort = {
        analyze: vi.fn().mockResolvedValue(err(new Error("Image too large"))),
      };
      const logger = makeLogger();
      const deps: ImageHandlerDeps = {
        imageAnalyzer,
        resolveAttachment: makeResolver(),
        logger,
      };

      const result = await processImageAttachment(makeImageAttachment(), deps, 0, buildHint);

      expect(result.textPrefix).toBeUndefined();
      expect(result.analysis).toBeUndefined();
      expect(logger.warn).toHaveBeenCalled();
    });

    it("returns empty result when resolve returns null", async () => {
      const deps: ImageHandlerDeps = {
        imageAnalyzer: makeImageAnalyzer(),
        resolveAttachment: vi.fn().mockResolvedValue(null),
        logger: makeLogger(),
      };

      const result = await processImageAttachment(makeImageAttachment(), deps, 0, buildHint);

      expect(result.textPrefix).toBeUndefined();
      expect(result.analysis).toBeUndefined();
    });

    it("returns empty result when analyzer throws", async () => {
      const imageAnalyzer: ImageAnalysisPort = {
        analyze: vi.fn().mockRejectedValue(new Error("crash")),
      };
      const logger = makeLogger();
      const deps: ImageHandlerDeps = {
        imageAnalyzer,
        resolveAttachment: makeResolver(),
        logger,
      };

      const result = await processImageAttachment(makeImageAttachment(), deps, 0, buildHint);

      expect(result.textPrefix).toBeUndefined();
      expect(logger.warn).toHaveBeenCalled();
    });
  });
});
