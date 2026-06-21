// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  // Telegram adapter
  createTelegramAdapter,
  // Discord adapter
  createDiscordAdapter,
  // Discord utilities
  mapDiscordToNormalized,
  buildDiscordAttachments,
  validateDiscordToken,
  chunkDiscordText,
  // Slack adapter
  createSlackAdapter,
  // Slack utilities
  mapSlackToNormalized,
  buildSlackAttachments,
  validateSlackCredentials,
  escapeSlackMrkdwn,
  fetchWithSlackAuth,
  isSlackHostname,
  // WhatsApp adapter
  createWhatsAppAdapter,
  // WhatsApp utilities
  mapBaileysToNormalized,
  buildWhatsAppAttachments,
  validateWhatsAppAuth,
  normalizeWhatsAppJid,
  isWhatsAppGroupJid,
  isWhatsAppUserJid,
  extractJidPhone,
  // Shared (channels-side surface — channel-manager lives in
  // @comis/orchestrator; createTypingController stays in channels)
  createTypingController,
  // Telegram thread-context builders — the General-Topic id=1 asymmetry
  // (the asymmetric SEND-omits / TYPING-includes routing) is load-bearing
  // info-disclosure-relevant product logic that must be assertable from the
  // public surface (the v2.28 channel-emulation harness's GROUP-03 HARD
  // assertion drives the REAL builders, not a re-implementation).
  buildSendThreadParams,
  buildTypingThreadParams,
  resolveTelegramThreadContext,
} from "./index.js";
import type { TelegramThreadScope } from "./index.js";

describe("@comis/channels barrel exports", () => {
  it("exports all 4 adapter factories as functions", () => {
    expect(typeof createTelegramAdapter).toBe("function");
    expect(typeof createDiscordAdapter).toBe("function");
    expect(typeof createSlackAdapter).toBe("function");
    expect(typeof createWhatsAppAdapter).toBe("function");
  });

  it("exports Discord utilities", () => {
    expect(typeof mapDiscordToNormalized).toBe("function");
    expect(typeof buildDiscordAttachments).toBe("function");
    expect(typeof validateDiscordToken).toBe("function");
    expect(typeof chunkDiscordText).toBe("function");
  });

  it("exports Slack utilities", () => {
    expect(typeof mapSlackToNormalized).toBe("function");
    expect(typeof buildSlackAttachments).toBe("function");
    expect(typeof validateSlackCredentials).toBe("function");
    expect(typeof escapeSlackMrkdwn).toBe("function");
    expect(typeof fetchWithSlackAuth).toBe("function");
    expect(typeof isSlackHostname).toBe("function");
  });

  it("exports WhatsApp utilities", () => {
    expect(typeof mapBaileysToNormalized).toBe("function");
    expect(typeof buildWhatsAppAttachments).toBe("function");
    expect(typeof validateWhatsAppAuth).toBe("function");
    expect(typeof normalizeWhatsAppJid).toBe("function");
    expect(typeof isWhatsAppGroupJid).toBe("function");
    expect(typeof isWhatsAppUserJid).toBe("function");
    expect(typeof extractJidPhone).toBe("function");
  });

  it("exports shared infrastructure", () => {
    // createChannelManager lives in @comis/orchestrator;
    // createTypingController remains in @comis/channels public surface.
    expect(typeof createTypingController).toBe("function");
  });

  it("exports the Telegram thread-context builders (the General-Topic id=1 asymmetry surface)", () => {
    // These three are surfaced on the public barrel so the asymmetric
    // SEND-omits-id=1 / TYPING-includes-id=1 routing (an info-disclosure
    // boundary: never leak the General topic id onto a reply) is assertable
    // from the public API rather than re-implemented in a test.
    expect(typeof buildSendThreadParams).toBe("function");
    expect(typeof buildTypingThreadParams).toBe("function");
    expect(typeof resolveTelegramThreadContext).toBe("function");
  });

  it("the General-Topic id=1 asymmetry holds through the real public builders", () => {
    // A forum group's General topic resolves to id=1, scope "forum".
    const ctx = resolveTelegramThreadContext({ isForum: true, isGroup: true, rawThreadId: undefined });
    expect(ctx.threadId).toBe(1);
    const scope: TelegramThreadScope = ctx.scope;
    expect(scope).toBe("forum");
    // SEND omits message_thread_id when it is the General topic (id=1, forum).
    expect(buildSendThreadParams(1, "forum")).toBeUndefined();
    // TYPING always includes it — the asymmetric counterpart.
    expect(buildTypingThreadParams(1)).toEqual({ message_thread_id: 1 });
  });
});
