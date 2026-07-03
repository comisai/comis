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
  // public surface (the live channel-emulation harness's group-topic
  // assertion drives the REAL builders, not a re-implementation).
  buildSendThreadParams,
  buildTypingThreadParams,
  resolveTelegramThreadContext,
  // Telegram error classifier — the structural GrammyError → ActivityRenderError
  // mapping (429→rate_limited / 400-not-editable→not_supported{edit} /
  // 403→permission / default→internal). Surfaced on the public barrel so the
  // live channel-emulation harness's fault-injection assertion drives the REAL
  // classifier (not a re-implementation), mirroring the thread-context precedent.
  classifyTelegramError,
} from "./index.js";
import type { TelegramThreadScope } from "./index.js";
// Signal wire types — the adapter's OWN exported SignalEnvelope/SignalAttachment
// (defined in ./signal/signal-client.ts) surfaced TYPE-ONLY on the public barrel
// so the live channel-emulation harness's payload builders can import them
// from the dist-aliased @comis/channels (the test/live alias maps the bare package
// to dist/index.js — the barrel only — so signal-payloads.ts cannot import the
// wire interface until it is re-exported here). `export type` is ERASED at build:
// it adds NO runtime export (the no-`@comis/*`-runtime-edge rule holds),
// mirroring the thread-context precedent.
import type { SignalEnvelope, SignalAttachment } from "./index.js";

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

  it("re-exports the Signal wire types (SignalEnvelope/SignalAttachment) type-only for the emulator payload builders", () => {
    // `export type { SignalEnvelope, SignalAttachment }` is erased at build, so
    // there is no runtime value to assert on — the proof is that these type
    // imports resolve to the adapter's OWN wire interface. A representative
    // envelope (the mock-signal-server.ts:247-260 shape) must satisfy
    // SignalEnvelope (drift = a compile error here AND in signal-payloads.ts),
    // and the nested attachments array must satisfy SignalAttachment[].
    const attachment: SignalAttachment = { id: "att-1", contentType: "image/png" };
    const envelope: SignalEnvelope = {
      source: "+15555550100",
      sourceNumber: "+15555550100",
      sourceUuid: "00000000-0000-0000-0000-000000000000",
      sourceName: "+15555550100",
      timestamp: 1_700_000_000_001,
      dataMessage: {
        message: "hello",
        attachments: [attachment],
        reaction: { emoji: "👍", targetSentTimestamp: 1_700_000_000_000 },
      },
    };
    // A runtime assertion so the test is not type-only (vitest strips types):
    // the literal round-trips its own fields, proving the typed value was built.
    expect(envelope.dataMessage?.message).toBe("hello");
    expect(envelope.dataMessage?.reaction?.emoji).toBe("👍");
    expect(envelope.dataMessage?.attachments?.[0]?.id).toBe("att-1");
  });

  it("exports the Telegram error classifier (the fault-injection classification surface)", () => {
    // Surfaced on the public barrel so the live harness's fault-injection leg
    // drives the REAL structural classifier (429/400-edit/403/default) rather than
    // re-implementing it — the thread-context precedent applied to classification.
    expect(typeof classifyTelegramError).toBe("function");
  });

  it("the structural classifier maps the four GrammyError classes through the real public fn", () => {
    // 429 with a retry_after → rate_limited (retryAfterMs = retry_after * 1000).
    expect(classifyTelegramError({ error_code: 429, parameters: { retry_after: 5 } })).toEqual({
      kind: "rate_limited",
      retryAfterMs: 5000,
    });
    // 400 "message can't be edited" → not_supported{edit} (the editable-message regex).
    expect(classifyTelegramError({ error_code: 400, description: "message can't be edited" })).toEqual({
      kind: "not_supported",
      capability: "edit",
    });
    // 403 forbidden → permission (carries the description as detail).
    expect(classifyTelegramError({ error_code: 403, description: "bot was blocked" })).toMatchObject({
      kind: "permission",
    });
    // THE NUANCE: the default (unmatched) is {kind:"internal"}, NOT ok:true.
    expect(classifyTelegramError({ error_code: 418, description: "teapot" })).toMatchObject({
      kind: "internal",
    });
  });
});
