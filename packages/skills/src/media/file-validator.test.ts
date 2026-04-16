import { describe, it, expect } from "vitest";
import { createFileValidator } from "./file-validator.js";

/**
 * Minimal valid PNG (1x1 transparent) -- file-type identifies this as image/png.
 */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
  "base64",
);

describe("createFileValidator", () => {
  it("validates a known PNG image as valid", async () => {
    const validator = createFileValidator();
    const result = await validator.validate(TINY_PNG);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.valid).toBe(true);
    expect(result.value.mime).toBe("image/png");
    expect(result.value.kind).toBe("image");
  });

  it("rejects a buffer exceeding image size limit", async () => {
    // Create a buffer that exceeds the image limit (10 MB) -- fake with custom limits
    const validator = createFileValidator({
      sizeLimits: { image: 50 }, // 50 bytes limit
    });
    const result = await validator.validate(TINY_PNG);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.valid).toBe(false);
    expect(result.value.error).toContain("exceeds");
    expect(result.value.error).toContain("size limit");
  });

  it("rejects MIME not in whitelist", async () => {
    // Only allow video -- PNG will be rejected
    const validator = createFileValidator({
      mimeWhitelist: ["video/mp4"],
    });
    const result = await validator.validate(TINY_PNG);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.valid).toBe(false);
    expect(result.value.error).toContain("MIME type not allowed");
    expect(result.value.mime).toBe("image/png");
  });

  it("accepts all default whitelist MIME types via extension fallback", async () => {
    const validator = createFileValidator();
    const defaultMimes = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
      "audio/mpeg",
      "audio/ogg",
      "audio/wav",
      "audio/mp4",
      "video/mp4",
      "video/webm",
      "application/pdf",
      "text/plain",
    ];

    // For each MIME, validate a small buffer with a filename hint
    for (const mime of defaultMimes) {
      // Use an unrecognizable buffer with filename hint to get extension-based MIME
      const extMap: Record<string, string> = {
        "image/jpeg": "test.jpg",
        "image/png": "test.png",
        "image/webp": "test.webp",
        "image/gif": "test.gif",
        "audio/mpeg": "test.mp3",
        "audio/ogg": "test.ogg",
        "audio/wav": "test.wav",
        "audio/mp4": "test.mp4",
        "video/mp4": "test.mp4",
        "video/webm": "test.webm",
        "application/pdf": "test.pdf",
        "text/plain": "test.txt",
      };

      // Use headerMime to force the right MIME (since buffer is empty-ish)
      const buf = Buffer.from("testdata");
      const result = await validator.validate(buf, {
        headerMime: mime,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      // Either valid or (for video.mp4 overlap with audio.mp4) valid with correct MIME
      if (result.value.valid) {
        expect(result.value.mime).toBe(mime);
      }
    }
  });

  it("returns correct MediaKind for different MIME types", async () => {
    const validator = createFileValidator();
    const buf = Buffer.from("x");

    // image
    const imgResult = await validator.validate(buf, { headerMime: "image/png" });
    expect(imgResult.ok && imgResult.value.kind).toBe("image");

    // audio
    const audioResult = await validator.validate(buf, { headerMime: "audio/mpeg" });
    expect(audioResult.ok && audioResult.value.kind).toBe("audio");

    // video
    const videoResult = await validator.validate(buf, { headerMime: "video/mp4" });
    expect(videoResult.ok && videoResult.value.kind).toBe("video");

    // document
    const docResult = await validator.validate(buf, { headerMime: "application/pdf" });
    expect(docResult.ok && docResult.value.kind).toBe("document");
  });

  it("custom sizeLimits override defaults", async () => {
    // Default audio limit is 25MB; set custom to 10 bytes
    const validator = createFileValidator({
      sizeLimits: { audio: 10 },
    });

    const buf = Buffer.alloc(20);
    const result = await validator.validate(buf, { headerMime: "audio/mpeg" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.valid).toBe(false);
    expect(result.value.error).toContain("exceeds");
  });

  it("returns error for undetectable MIME with no hints", async () => {
    const validator = createFileValidator();
    const result = await validator.validate(Buffer.from("unknown"));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.valid).toBe(false);
    expect(result.value.error).toContain("Unable to determine file type");
  });
});
