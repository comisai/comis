/**
 * Tests for daemon-utils pure utility functions.
 * Covers resolveAdapter, authorizeChannelAccess, buildCronSchedule,
 * guessMimeFromExtension, detectMimeFromMagicBytes, mimeToExtension.
 */

import { describe, it, expect } from "vitest";
import {
  resolveAdapter,
  authorizeChannelAccess,
  buildCronSchedule,
  guessMimeFromExtension,
  detectMimeFromMagicBytes,
  mimeToExtension,
} from "./daemon-utils.js";
import type { ChannelPort } from "@comis/core";

// ---------------------------------------------------------------------------
// resolveAdapter
// ---------------------------------------------------------------------------

describe("resolveAdapter", () => {
  it("returns adapter when type is found in registry", () => {
    const adapter = { start: () => {} } as unknown as ChannelPort;
    const registry = new Map<string, ChannelPort>([["telegram", adapter]]);

    expect(resolveAdapter("telegram", registry)).toBe(adapter);
  });

  it("throws when type is not found -- lists available types", () => {
    const registry = new Map<string, ChannelPort>([
      ["telegram", {} as ChannelPort],
      ["discord", {} as ChannelPort],
    ]);

    expect(() => resolveAdapter("slack", registry)).toThrow("No adapter found");
    expect(() => resolveAdapter("slack", registry)).toThrow("telegram");
    expect(() => resolveAdapter("slack", registry)).toThrow("discord");
  });

  it("throws with 'none' when registry is empty", () => {
    const registry = new Map<string, ChannelPort>();

    expect(() => resolveAdapter("telegram", registry)).toThrow("none");
  });
});

// ---------------------------------------------------------------------------
// authorizeChannelAccess
// ---------------------------------------------------------------------------

describe("authorizeChannelAccess", () => {
  it("allows admin to access any channel (bypass)", () => {
    expect(() =>
      authorizeChannelAccess("channel-A", "channel-B", "admin"),
    ).not.toThrow();
  });

  it("allows same-channel access for non-admin", () => {
    expect(() =>
      authorizeChannelAccess("channel-A", "channel-A", "user"),
    ).not.toThrow();
  });

  it("allows when originChannelId is undefined (daemon-initiated)", () => {
    expect(() =>
      authorizeChannelAccess(undefined, "channel-B", "user"),
    ).not.toThrow();
  });

  it("denies cross-channel access for non-admin", () => {
    expect(() =>
      authorizeChannelAccess("channel-A", "channel-B", "user"),
    ).toThrow("access denied");
  });
});

// ---------------------------------------------------------------------------
// buildCronSchedule
// ---------------------------------------------------------------------------

describe("buildCronSchedule", () => {
  it("builds cron schedule with expr and tz", () => {
    const result = buildCronSchedule("cron", {
      schedule_expr: "0 * * * *",
      timezone: "UTC",
    });

    expect(result).toEqual({ kind: "cron", expr: "0 * * * *", tz: "UTC" });
  });

  it("builds every schedule with everyMs", () => {
    const result = buildCronSchedule("every", { schedule_every_ms: 60000 });

    expect(result).toEqual({ kind: "every", everyMs: 60000 });
  });

  it("builds at schedule with at timestamp", () => {
    const result = buildCronSchedule("at", { schedule_at: "2026-01-01T00:00:00Z" });

    expect(result).toEqual({ kind: "at", at: "2026-01-01T00:00:00Z" });
  });

  it("throws for unknown schedule kind", () => {
    expect(() => buildCronSchedule("invalid", {})).toThrow("Unknown schedule kind");
  });
});

// ---------------------------------------------------------------------------
// guessMimeFromExtension
// ---------------------------------------------------------------------------

describe("guessMimeFromExtension", () => {
  it.each([
    ["photo.jpg", "image/jpeg"],
    ["photo.jpeg", "image/jpeg"],
    ["image.png", "image/png"],
    ["anim.gif", "image/gif"],
    ["pic.webp", "image/webp"],
  ])("maps %s to %s", (filePath, expected) => {
    expect(guessMimeFromExtension(filePath)).toBe(expected);
  });

  it("returns image/jpeg for unknown extension", () => {
    expect(guessMimeFromExtension("file.xyz")).toBe("image/jpeg");
  });
});

// ---------------------------------------------------------------------------
// detectMimeFromMagicBytes
// ---------------------------------------------------------------------------

describe("detectMimeFromMagicBytes", () => {
  it("detects PNG from magic bytes", () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(detectMimeFromMagicBytes(buf)).toBe("image/png");
  });

  it("detects JPEG from magic bytes", () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(detectMimeFromMagicBytes(buf)).toBe("image/jpeg");
  });

  it("detects GIF from magic bytes", () => {
    const buf = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    expect(detectMimeFromMagicBytes(buf)).toBe("image/gif");
  });

  it("detects WebP from magic bytes", () => {
    // RIFF....WEBP
    const buf = Buffer.from([
      0x52, 0x49, 0x46, 0x46,
      0x00, 0x00, 0x00, 0x00,
      0x57, 0x45, 0x42, 0x50,
    ]);
    expect(detectMimeFromMagicBytes(buf)).toBe("image/webp");
  });

  it("returns undefined for short buffer (< 4 bytes)", () => {
    const buf = Buffer.from([0x89, 0x50]);
    expect(detectMimeFromMagicBytes(buf)).toBeUndefined();
  });

  it("returns undefined for unknown magic bytes", () => {
    const buf = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
    expect(detectMimeFromMagicBytes(buf)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// mimeToExtension
// ---------------------------------------------------------------------------

describe("mimeToExtension", () => {
  it.each([
    ["audio/mpeg", "mp3"],
    ["audio/opus", "opus"],
    ["audio/wav", "wav"],
  ])("maps %s to %s", (mime, ext) => {
    expect(mimeToExtension(mime)).toBe(ext);
  });

  it("returns mp3 for unknown MIME type", () => {
    expect(mimeToExtension("audio/unknown")).toBe("mp3");
  });
});
