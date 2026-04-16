/**
 * Tests for video-handler: base64 size estimation and video encoding with limits.
 */

import { describe, it, expect } from "vitest";
import { estimateBase64Size, encodeVideoForApi } from "./video-handler.js";

// ---------------------------------------------------------------------------
// estimateBase64Size
// ---------------------------------------------------------------------------

describe("estimateBase64Size", () => {
  it("returns 0 for 0 raw bytes", () => {
    expect(estimateBase64Size(0)).toBe(0);
  });

  it("returns 4 for 3 raw bytes (exact block)", () => {
    expect(estimateBase64Size(3)).toBe(4);
  });

  it("returns 8 for 4 raw bytes (partial block rounds up)", () => {
    expect(estimateBase64Size(4)).toBe(8);
  });

  it("returns 1336 for 1000 raw bytes", () => {
    expect(estimateBase64Size(1000)).toBe(1336);
  });

  it("returns 4 for 1 raw byte", () => {
    expect(estimateBase64Size(1)).toBe(4);
  });

  it("returns 4 for 2 raw bytes", () => {
    expect(estimateBase64Size(2)).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// encodeVideoForApi
// ---------------------------------------------------------------------------

describe("encodeVideoForApi", () => {
  it("returns ok with base64 and estimatedSize for a small buffer", () => {
    const video = Buffer.from("hello video data");
    const result = encodeVideoForApi(video, 1_000_000, 500_000);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.base64).toBe(video.toString("base64"));
    expect(result.value.estimatedSize).toBe(estimateBase64Size(video.byteLength));
  });

  it("returns err for empty buffer", () => {
    const result = encodeVideoForApi(Buffer.alloc(0), 1_000_000, 500_000);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe("Video buffer is empty");
  });

  it("returns err when raw size exceeds maxRawBytes", () => {
    const video = Buffer.alloc(100);
    const result = encodeVideoForApi(video, 1_000_000, 50); // maxRawBytes=50

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("raw size");
    expect(result.error.message).toContain("100");
    expect(result.error.message).toContain("50");
  });

  it("returns err when estimated base64 size exceeds maxBase64Bytes", () => {
    // 100 raw bytes -> estimated base64 = ceil(100/3)*4 = 136
    const video = Buffer.alloc(100);
    const result = encodeVideoForApi(video, 50, 1_000_000); // maxBase64Bytes=50

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("base64 size");
    expect(result.error.message).toContain("136");
    expect(result.error.message).toContain("50");
  });

  it("produces correct base64 encoding for known input", () => {
    const video = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"
    const result = encodeVideoForApi(video, 1_000_000, 500_000);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.base64).toBe("SGVsbG8=");
  });

  it("accepts buffer exactly at raw size limit", () => {
    const video = Buffer.alloc(50);
    const result = encodeVideoForApi(video, 1_000_000, 50); // exactly at limit

    expect(result.ok).toBe(true);
  });

  it("rejects buffer one byte over raw size limit", () => {
    const video = Buffer.alloc(51);
    const result = encodeVideoForApi(video, 1_000_000, 50);

    expect(result.ok).toBe(false);
  });
});
