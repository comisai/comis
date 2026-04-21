// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import type { ChannelPort } from "@comis/core";
import { ok, err } from "@comis/shared";
import { reactWithFallback, TELEGRAM_SAFE_EMOJI } from "./emoji-fallback.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockAdapter(): ChannelPort {
  return {
    channelId: "adapter-001",
    channelType: "telegram",
    start: vi.fn().mockResolvedValue(ok(undefined)),
    stop: vi.fn().mockResolvedValue(ok(undefined)),
    sendMessage: vi.fn().mockResolvedValue(ok("msg-1")),
    editMessage: vi.fn().mockResolvedValue(ok(undefined)),
    onMessage: vi.fn(),
    reactToMessage: vi.fn().mockResolvedValue(ok(undefined)),
    removeReaction: vi.fn().mockResolvedValue(ok(undefined)),
    deleteMessage: vi.fn().mockResolvedValue(ok(undefined)),
    fetchMessages: vi.fn().mockResolvedValue(ok([])),
    sendAttachment: vi.fn().mockResolvedValue(ok("att-1")),
    platformAction: vi.fn().mockResolvedValue(ok(undefined)),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("reactWithFallback", () => {
  it("returns ok when primary emoji succeeds (no fallback triggered)", async () => {
    const adapter = createMockAdapter();
    const result = await reactWithFallback(adapter, "chat-1", "msg-1", "\u{1F914}");

    expect(result.ok).toBe(true);
    expect(adapter.reactToMessage).toHaveBeenCalledTimes(1);
    expect(adapter.reactToMessage).toHaveBeenCalledWith("chat-1", "msg-1", "\u{1F914}");
  });

  it("tries safe emoji when primary fails with REACTION_INVALID", async () => {
    const adapter = createMockAdapter();
    const reactMock = adapter.reactToMessage as ReturnType<typeof vi.fn>;

    // Primary fails with REACTION_INVALID
    reactMock.mockResolvedValueOnce(err(new Error("REACTION_INVALID: emoji not allowed")));
    // First safe emoji succeeds
    reactMock.mockResolvedValueOnce(ok(undefined));

    const result = await reactWithFallback(adapter, "chat-1", "msg-1", "\u{1F914}");

    expect(result.ok).toBe(true);
    // Primary + 1 fallback = 2 calls
    expect(reactMock).toHaveBeenCalledTimes(2);
  });

  it("returns last error when all fallbacks fail", async () => {
    const adapter = createMockAdapter();
    const reactMock = adapter.reactToMessage as ReturnType<typeof vi.fn>;

    // All calls fail with REACTION_INVALID
    reactMock.mockResolvedValue(err(new Error("REACTION_INVALID: restricted chat")));

    const result = await reactWithFallback(adapter, "chat-1", "msg-1", "\u{1F914}");

    expect(result.ok).toBe(false);
    // Primary + all safe emoji that differ from primary
    expect(reactMock.mock.calls.length).toBeGreaterThanOrEqual(TELEGRAM_SAFE_EMOJI.length);
  });

  it("returns immediately on non-REACTION_INVALID errors (no fallback)", async () => {
    const adapter = createMockAdapter();
    const reactMock = adapter.reactToMessage as ReturnType<typeof vi.fn>;

    // Network error (not REACTION_INVALID)
    reactMock.mockResolvedValueOnce(err(new Error("Network timeout")));

    const result = await reactWithFallback(adapter, "chat-1", "msg-1", "\u{1F914}");

    expect(result.ok).toBe(false);
    // Only the primary call, no fallback
    expect(reactMock).toHaveBeenCalledTimes(1);
  });

  it("skips the primary emoji in fallback chain if it appears in TELEGRAM_SAFE_EMOJI", async () => {
    const adapter = createMockAdapter();
    const reactMock = adapter.reactToMessage as ReturnType<typeof vi.fn>;

    // Primary is thumbs up (first in TELEGRAM_SAFE_EMOJI)
    // Primary fails with REACTION_INVALID
    reactMock.mockResolvedValueOnce(err(new Error("REACTION_INVALID")));
    // Next safe emoji succeeds (should skip thumbs up since that's the primary)
    reactMock.mockResolvedValueOnce(ok(undefined));

    const result = await reactWithFallback(adapter, "chat-1", "msg-1", "\u{1F44D}");

    expect(result.ok).toBe(true);
    // Primary + 1 fallback (skipped itself in chain)
    expect(reactMock).toHaveBeenCalledTimes(2);
    // Second call should NOT be thumbs up
    expect(reactMock.mock.calls[1]![2]).not.toBe("\u{1F44D}");
  });

  it("has expected safe emoji set", () => {
    expect(TELEGRAM_SAFE_EMOJI).toHaveLength(6);
    expect(TELEGRAM_SAFE_EMOJI).toContain("\u{1F44D}"); // thumbs up
    expect(TELEGRAM_SAFE_EMOJI).toContain("\u{2705}");   // check
    expect(TELEGRAM_SAFE_EMOJI).toContain("\u{274C}");   // cross
  });
});
