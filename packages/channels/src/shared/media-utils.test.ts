// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { mimeToAttachmentType } from "./media-utils.js";

describe("mimeToAttachmentType", () => {
  it("returns 'file' for null", () => {
    expect(mimeToAttachmentType(null)).toBe("file");
  });

  it("returns 'file' for undefined", () => {
    expect(mimeToAttachmentType(undefined)).toBe("file");
  });

  it("returns 'file' for empty string", () => {
    expect(mimeToAttachmentType("")).toBe("file");
  });

  it("returns 'image' for image/jpeg", () => {
    expect(mimeToAttachmentType("image/jpeg")).toBe("image");
  });

  it("returns 'image' for image/png", () => {
    expect(mimeToAttachmentType("image/png")).toBe("image");
  });

  it("returns 'image' for image/gif", () => {
    expect(mimeToAttachmentType("image/gif")).toBe("image");
  });

  it("returns 'audio' for audio/ogg", () => {
    expect(mimeToAttachmentType("audio/ogg")).toBe("audio");
  });

  it("returns 'audio' for audio/mp3", () => {
    expect(mimeToAttachmentType("audio/mp3")).toBe("audio");
  });

  it("returns 'audio' for audio/mpeg", () => {
    expect(mimeToAttachmentType("audio/mpeg")).toBe("audio");
  });

  it("returns 'video' for video/mp4", () => {
    expect(mimeToAttachmentType("video/mp4")).toBe("video");
  });

  it("returns 'video' for video/webm", () => {
    expect(mimeToAttachmentType("video/webm")).toBe("video");
  });

  it("returns 'file' for application/pdf", () => {
    expect(mimeToAttachmentType("application/pdf")).toBe("file");
  });

  it("returns 'file' for text/plain", () => {
    expect(mimeToAttachmentType("text/plain")).toBe("file");
  });

  it("returns 'file' for application/octet-stream", () => {
    expect(mimeToAttachmentType("application/octet-stream")).toBe("file");
  });

  // Edge case: MIME types are lowercase per RFC 2045.
  // We intentionally do NOT normalize case -- uppercase means "file".
  it("returns 'file' for mixed-case 'Image/jpeg' (RFC 2045: MIME types are lowercase)", () => {
    expect(mimeToAttachmentType("Image/jpeg")).toBe("file");
  });

  it("returns 'file' for mixed-case 'AUDIO/mp3'", () => {
    expect(mimeToAttachmentType("AUDIO/mp3")).toBe("file");
  });
});
