// SPDX-License-Identifier: Apache-2.0
/**
 * DEL-03 (Phase 192 / Plan 03) — the per-channelType video-size limit table +
 * resolver + link-support map.
 *
 * RED-first (AGENTS.md §2.10): these assertions describe the behavior the new
 * `video-delivery-limits.ts` must provide. They FAIL to even import before the
 * module exists.
 *
 * The contract under test (DEL-03 must_haves):
 *   - the limit is PER-channelType (each platform's documented bot/upload limit),
 *     NOT one hardcoded global, NOT an invented byte table scattered across
 *     adapters;
 *   - the resolve helper is OVERRIDE-aware (a config `maxVideoBytes` wins) and
 *     UNKNOWN→default (never throws), and is proto-pollution-safe;
 *   - `channelRendersVideoLink` declares which channels can render a URL message
 *     (the `link` policy) vs a notice-only degrade (IRC).
 */
import { describe, it, expect } from "vitest";
import {
  resolveVideoSizeLimit,
  channelRendersVideoLink,
  formatVideoBytes,
  buildOversizedDegradeMessage,
  VIDEO_SIZE_LIMITS,
} from "./video-delivery-limits.js";

const MB = 1024 * 1024;

describe("video-delivery-limits — per-channelType limit table + resolver (DEL-03)", () => {
  // ─── Test 1: per-channelType documented limits; unknown → default; never throws ───
  it("resolves each channel's documented limit and falls back to the 25MB default for an unknown channelType", () => {
    // Telegram's bot-upload limit (~50MB) is well above Discord's free cap (~25MB):
    // the table is per-adapter, NOT one global number.
    const telegram = resolveVideoSizeLimit("telegram", undefined);
    const discord = resolveVideoSizeLimit("discord", undefined);
    expect(telegram).toBe(VIDEO_SIZE_LIMITS.telegram);
    expect(discord).toBe(VIDEO_SIZE_LIMITS.discord);
    expect(telegram).toBeGreaterThan(discord); // ~50MB > ~25MB — proves per-adapter, not global

    // An UNKNOWN channelType never throws — it falls back to the 25MB default
    // (the media-compressor maxVideoBytes default, the honest conservative floor).
    expect(() => resolveVideoSizeLimit("totally-unknown-channel", undefined)).not.toThrow();
    expect(resolveVideoSizeLimit("totally-unknown-channel", undefined)).toBe(25 * MB);
  });

  // ─── Test 2: an explicit config override wins over the per-channel constant ───
  it("an explicit maxVideoBytes override wins over the per-channel constant (DEL-03 'overridable via maxVideoBytes')", () => {
    const override = 8 * MB;
    // Telegram's constant is ~50MB, but the operator-supplied override clamps it to 8MB.
    expect(resolveVideoSizeLimit("telegram", override)).toBe(override);
    // The override also applies to an unknown channelType (it short-circuits the table).
    expect(resolveVideoSizeLimit("totally-unknown-channel", override)).toBe(override);
  });

  // ─── Test 2b: proto-pollution-safe (SEC-04 defense-in-depth) ───
  it("guards the table lookup against prototype-pollution keys (never reads the prototype chain)", () => {
    // A `__proto__` / `constructor` / `prototype` channelType must NOT read a
    // prototype-chain member — it falls back to the default, exactly like any
    // other unknown key. (channelType is platform-internal, but the guard is
    // cheap defense-in-depth — reuse the shipped isBlockedObjectKey / SEC-04 guard.)
    expect(resolveVideoSizeLimit("__proto__", undefined)).toBe(25 * MB);
    expect(resolveVideoSizeLimit("constructor", undefined)).toBe(25 * MB);
    expect(resolveVideoSizeLimit("prototype", undefined)).toBe(25 * MB);
    // …and the override still wins even for a blocked key.
    expect(resolveVideoSizeLimit("__proto__", 4 * MB)).toBe(4 * MB);
  });

  // ─── Test 3: the link-support map (link vs notice) ───
  it("channelRendersVideoLink is true for link-rendering channels and false for IRC (notice-only)", () => {
    // Channels that render a URL message → the `link` policy (send the retained URL).
    expect(channelRendersVideoLink("telegram")).toBe(true);
    expect(channelRendersVideoLink("discord")).toBe(true);
    expect(channelRendersVideoLink("slack")).toBe(true);
    expect(channelRendersVideoLink("line")).toBe(true);
    // IRC degrades with a NOTICE, never a link.
    expect(channelRendersVideoLink("irc")).toBe(false);
    // An unknown channel is conservatively treated as notice-only (no assumed link).
    expect(channelRendersVideoLink("totally-unknown-channel")).toBe(false);
    // Proto-pollution-safe here too.
    expect(channelRendersVideoLink("__proto__")).toBe(false);
  });

  // ─── formatVideoBytes — the human-readable notice formatter ───
  it("formatVideoBytes renders a human-readable size for the notice text", () => {
    expect(formatVideoBytes(512)).toBe("512 B");
    expect(formatVideoBytes(2 * 1024)).toBe("2.0 KB");
    expect(formatVideoBytes(50 * MB)).toBe("50.0 MB");
    expect(formatVideoBytes(2 * 1024 * MB)).toBe("2.0 GB");
  });

  // ─── buildOversizedDegradeMessage — the link/notice text + policy ───
  describe("buildOversizedDegradeMessage", () => {
    const FILE_PATH = "/home/agent/.comis/workspace/media/videos/abc123.mp4";

    it("link policy: a link-rendering channel with a retained sourceUrl shares the URL (+ saved path), never the silent-drop marker", () => {
      const msg = buildOversizedDegradeMessage({
        channelType: "telegram",
        sizeBytes: 60 * MB,
        limit: 50 * MB,
        filePath: FILE_PATH,
        sourceUrl: "https://provider.example/video/xyz?token=abc",
      });
      expect(msg.policy).toBe("link");
      expect(msg.text).toContain("https://provider.example/video/xyz?token=abc");
      expect(msg.text).toContain(FILE_PATH); // saved path always present (recoverable)
      expect(msg.text).not.toContain("[Attachment too large"); // never the v2.23 marker
    });

    it("notice policy: a notice-only channel (or no sourceUrl) carries the saved workspace path, never a link", () => {
      // notice-only channel (unknown → channelRendersVideoLink false), even WITH a url.
      const noticeChannel = buildOversizedDegradeMessage({
        channelType: "matrix",
        sizeBytes: 60 * MB,
        limit: 25 * MB,
        filePath: FILE_PATH,
        sourceUrl: "https://provider.example/v/xyz",
      });
      expect(noticeChannel.policy).toBe("notice");
      expect(noticeChannel.text.toLowerCase()).toContain("too large");
      expect(noticeChannel.text).toContain(FILE_PATH);
      expect(noticeChannel.text).not.toContain("https://provider.example"); // no link on a notice-only channel

      // link-rendering channel but NO sourceUrl → notice (the workspace path is the fallback).
      const noUrl = buildOversizedDegradeMessage({
        channelType: "telegram",
        sizeBytes: 60 * MB,
        limit: 50 * MB,
        filePath: FILE_PATH,
      });
      expect(noUrl.policy).toBe("notice");
      expect(noUrl.text).toContain(FILE_PATH);
      expect(noUrl.text).not.toContain("[Attachment too large");
    });

    // ─── WR-03 (Phase 192): a keyed/private provider URL is NOT a shareable link ───
    it("WR-03: a Veo keyed-download host degrades to notice+path, NEVER a (dead/key-needing) link", () => {
      // Veo's out.sourceUrl is the UN-keyed video.uri on the Google
      // generativelanguage download host: it 403s without the &key= the adapter
      // withholds. Sharing it as a `link` hands the user a DEAD url (and a keyed
      // variant would LEAK the secret). It must fall back to notice + workspace path.
      const veo = buildOversizedDegradeMessage({
        channelType: "telegram", // a link-rendering channel
        sizeBytes: 60 * MB,
        limit: 50 * MB,
        filePath: FILE_PATH,
        sourceUrl: "https://generativelanguage.googleapis.com/v1beta/files/abc:download?alt=media",
      });
      expect(veo.policy).toBe("notice");
      expect(veo.text).toContain(FILE_PATH);
      expect(veo.text).not.toContain("generativelanguage.googleapis.com");
    });

    it("WR-03: the xAI/Grok private download host also degrades to notice+path, not a link", () => {
      const grok = buildOversizedDegradeMessage({
        channelType: "discord",
        sizeBytes: 60 * MB,
        limit: 25 * MB,
        filePath: FILE_PATH,
        sourceUrl: "https://api.x.ai/v1/video/download/abc123",
      });
      expect(grok.policy).toBe("notice");
      expect(grok.text).toContain(FILE_PATH);
      expect(grok.text).not.toContain("api.x.ai");
    });

    it("WR-03: a publicly-fetchable FAL CDN URL is STILL shared as a link (regression guard)", () => {
      // FAL renders to a public CDN (fal.media / v3.fal.media) needing no secret —
      // that link IS shareable and must remain the `link` policy (don't over-degrade).
      const fal = buildOversizedDegradeMessage({
        channelType: "telegram",
        sizeBytes: 60 * MB,
        limit: 50 * MB,
        filePath: FILE_PATH,
        sourceUrl: "https://v3.fal.media/files/zebra/abc123_output.mp4",
      });
      expect(fal.policy).toBe("link");
      expect(fal.text).toContain("https://v3.fal.media/files/zebra/abc123_output.mp4");
      expect(fal.text).toContain(FILE_PATH);
    });
  });
});
