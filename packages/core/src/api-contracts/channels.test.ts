// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the channels + message + platform-action contract registry.
 *
 * Follows the shared per-domain contract-registry test pattern:
 *   - Aggregator sanity: count + method-name presence + scope assignments.
 *   - INTERNAL_FIELD_NAMES paired sanity (no contract request schema declares
 *     a dispatcher-injected `_X` key).
 *   - Per-contract spot-checks: request acceptance + rejection + optional-field
 *     acceptance, response acceptance + rejection on representative shape
 *     mismatch.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import {
  CHANNELS_CONTRACTS,
  ChannelsHealthContract,
  DeliveryQueueStatusContract,
  ChannelsCapabilitiesContract,
  ChannelsListContract,
  ChannelsGetContract,
  ChannelsEnableContract,
  ChannelsDisableContract,
  ChannelsRestartContract,
  MessageSendContract,
  MessageReplyContract,
  MessageReactContract,
  MessageEditContract,
  MessageDeleteContract,
  MessageFetchContract,
  MessageAttachContract,
  DiscordActionContract,
  TelegramActionContract,
  SlackActionContract,
  WhatsappActionContract,
  INTERNAL_FIELD_NAMES,
} from "./index.js";

// ===========================================================================
// Aggregator sanity
// ===========================================================================

describe("CHANNELS_CONTRACTS aggregator", () => {
  it("has exactly 19 entries (8 channel-handlers + 11 message-handlers)", () => {
    expect(CHANNELS_CONTRACTS.length).toBe(19);
  });

  it("includes every expected method-name", () => {
    const names = new Set(CHANNELS_CONTRACTS.map((c) => c.method));
    expect(names).toEqual(new Set([
      // channel-handlers.ts (8)
      "channels.health",
      "delivery.queue.status",
      "channels.capabilities",
      "channels.list",
      "channels.get",
      "channels.enable",
      "channels.disable",
      "channels.restart",
      // message-handlers.ts (11)
      "message.send",
      "message.reply",
      "message.react",
      "message.edit",
      "message.delete",
      "message.fetch",
      "message.attach",
      "discord.action",
      "telegram.action",
      "slack.action",
      "whatsapp.action",
    ]));
  });

  it("rpc-scoped contracts match the setup-gateway-api.ts registration", () => {
    const rpcMethods = new Set(
      CHANNELS_CONTRACTS
        .filter((c) => c.scopes.includes("rpc"))
        .map((c) => c.method),
    );
    // message.send/reply/react are rpc-scoped, not admin — the
    // genuinely-outward send subset is the orchestration surface
    // governed by orch:message, not control plane.
    expect(rpcMethods).toEqual(new Set([
      "channels.health",
      "channels.capabilities",
      "delivery.queue.status",
      "message.send",
      "message.reply",
      "message.react",
    ]));
  });

  it("admin-scoped contracts match the setup-gateway-api.ts registration", () => {
    const adminMethods = new Set(
      CHANNELS_CONTRACTS
        .filter((c) => c.scopes.includes("admin"))
        .map((c) => c.method),
    );
    // message.edit/delete/fetch/attach STAY admin-only
    // (deny-by-origin) — NOT part of orch:message.
    expect(adminMethods).toEqual(new Set([
      "channels.list",
      "channels.get",
      "channels.enable",
      "channels.disable",
      "channels.restart",
      "message.edit",
      "message.delete",
      "message.fetch",
      "message.attach",
      "discord.action",
      "telegram.action",
      "slack.action",
      "whatsapp.action",
    ]));
  });
});

// ===========================================================================
// INTERNAL_FIELD_NAMES paired sanity
// ===========================================================================

describe("channels domain contracts do not declare dispatcher internals", () => {
  it("no contract's request schema declares any INTERNAL_FIELD_NAMES key", () => {
    // Run a probe input carrying every internal-field name. Each request
    // schema should either silently strip it (z.object default) or accept
    // (loose-record contracts) — never echo it back as a typed top-level
    // contract field.
    const internalPayload: Record<string, unknown> = Object.fromEntries(
      INTERNAL_FIELD_NAMES.map((n) => [n, "probe-value"]),
    );

    for (const c of CHANNELS_CONTRACTS) {
      // Combine an internal-field payload with a minimal valid input for the
      // contract.
      const minimalValid: Record<string, unknown> = {
        channel_type: "telegram",
        channel_id: "123",
        text: "x",
        attachment_url: "https://example.com/f.pdf",
        message_id: "m1",
        emoji: "👍",
        ...internalPayload,
      };

      let parseResult: unknown;
      try {
        parseResult = c.request.parse(minimalValid);
      } catch {
        // Some contracts may reject internal fields with strict (depending on
        // schema strict-mode). Either silently-strip or reject is fine; the
        // key invariant is that no contract DECLARES the internal field as a
        // top-level typed field.
        continue;
      }

      // If parsed (record contracts or non-strict objects), assert no
      // internal-field name persists in the output.
      if (parseResult && typeof parseResult === "object") {
        const output = parseResult as Record<string, unknown>;
        for (const internalName of INTERNAL_FIELD_NAMES) {
          // Loose-record contracts (discord.action, etc.) WILL retain the
          // internal field — that's expected because they are pass-through
          // shapes. The architecture test `contract-internal-fields.test.ts`
          // is the authoritative gate: it asserts no contract DECLARES the
          // internal field as a top-level z.object field. Here we just sanity-
          // check that tight-schema contracts don't echo internals through.
          if (c.request._def.type !== "record") {
            expect(output).not.toHaveProperty(internalName);
          }
        }
      }
    }
  });
});

// ===========================================================================
// Per-contract spot-checks
// ===========================================================================

describe("ChannelsHealthContract", () => {
  it("accepts empty request", () => {
    expect(() => ChannelsHealthContract.request.parse({})).not.toThrow();
  });

  it("accepts full response shape (enabled: true)", () => {
    expect(() =>
      ChannelsHealthContract.response.parse({
        channels: [{
          channelType: "telegram",
          state: "healthy",
          connectionMode: "polling",
          lastCheckedAt: 1000,
          lastMessageAt: 999,
          error: null,
          stateChangedAt: 500,
          consecutiveFailures: 0,
          activeRuns: 1,
          restartAttempts: 0,
          uptimeMs: 12000,
        }],
        timestamp: 1234,
        enabled: true,
      })
    ).not.toThrow();
  });

  it("accepts empty channels + enabled: false response", () => {
    expect(() =>
      ChannelsHealthContract.response.parse({
        channels: [],
        timestamp: 1234,
        enabled: false,
      })
    ).not.toThrow();
  });

  it("response rejects when timestamp is a string", () => {
    expect(() =>
      ChannelsHealthContract.response.parse({
        channels: [],
        timestamp: "1234",
        enabled: false,
      })
    ).toThrow();
  });
});

describe("DeliveryQueueStatusContract", () => {
  it("accepts empty request", () => {
    expect(() => DeliveryQueueStatusContract.request.parse({})).not.toThrow();
  });

  it("accepts optional channel_type filter", () => {
    expect(() =>
      DeliveryQueueStatusContract.request.parse({ channel_type: "telegram" })
    ).not.toThrow();
  });

  it("accepts full response shape", () => {
    expect(() =>
      DeliveryQueueStatusContract.response.parse({
        pending: 3, inFlight: 1, failed: 2, delivered: 10, expired: 0,
      })
    ).not.toThrow();
  });

  it("response rejects when pending is missing", () => {
    expect(() =>
      DeliveryQueueStatusContract.response.parse({
        inFlight: 1, failed: 2, delivered: 10, expired: 0,
      })
    ).toThrow();
  });
});

describe("ChannelsCapabilitiesContract", () => {
  it("accepts channel_type request", () => {
    expect(() =>
      ChannelsCapabilitiesContract.request.parse({ channel_type: "telegram" })
    ).not.toThrow();
  });

  it("rejects request without channel_type", () => {
    expect(() => ChannelsCapabilitiesContract.request.parse({})).toThrow();
  });

  it("accepts loose features response", () => {
    expect(() =>
      ChannelsCapabilitiesContract.response.parse({
        channelType: "telegram",
        features: {
          reactions: true,
          editMessages: true,
          formatting: ["bold", "italic"],
        },
      })
    ).not.toThrow();
  });
});

describe("ChannelsListContract", () => {
  it("accepts empty request", () => {
    expect(() => ChannelsListContract.request.parse({})).not.toThrow();
  });

  it("accepts mixed running/stopped channels response", () => {
    expect(() =>
      ChannelsListContract.response.parse({
        channels: [
          { channelType: "telegram", channelId: "tg-123", status: "running" },
          { channelType: "discord", status: "stopped" },
        ],
        total: 2,
      })
    ).not.toThrow();
  });

  it("rejects invalid status enum value", () => {
    expect(() =>
      ChannelsListContract.response.parse({
        channels: [{ channelType: "telegram", status: "weird" }],
        total: 1,
      })
    ).toThrow();
  });
});

describe("ChannelsGetContract", () => {
  it("accepts channel_type request", () => {
    expect(() =>
      ChannelsGetContract.request.parse({ channel_type: "telegram" })
    ).not.toThrow();
  });

  it("rejects request without channel_type", () => {
    expect(() => ChannelsGetContract.request.parse({})).toThrow();
  });

  it("accepts running variant response", () => {
    expect(() =>
      ChannelsGetContract.response.parse({
        channelType: "telegram",
        channelId: "tg-123",
        status: "running",
      })
    ).not.toThrow();
  });

  it("accepts stopped variant response", () => {
    expect(() =>
      ChannelsGetContract.response.parse({
        channelType: "discord",
        status: "stopped",
        configured: true,
      })
    ).not.toThrow();
  });
});

describe("ChannelsEnableContract / DisableContract / RestartContract", () => {
  it("enable accepts channel_type request", () => {
    expect(() =>
      ChannelsEnableContract.request.parse({ channel_type: "telegram" })
    ).not.toThrow();
  });

  it("enable rejects status: 'stopped' (must be 'running' literal)", () => {
    expect(() =>
      ChannelsEnableContract.response.parse({
        channelType: "telegram",
        status: "stopped",
        message: "x",
      })
    ).toThrow();
  });

  it("disable response asserts status === 'stopped'", () => {
    expect(() =>
      ChannelsDisableContract.response.parse({
        channelType: "telegram",
        status: "stopped",
        message: "Channel adapter stopped",
      })
    ).not.toThrow();
  });

  it("disable rejects status: 'running' (must be 'stopped' literal)", () => {
    expect(() =>
      ChannelsDisableContract.response.parse({
        channelType: "telegram",
        status: "running",
        message: "x",
      })
    ).toThrow();
  });

  it("restart response asserts status === 'running'", () => {
    expect(() =>
      ChannelsRestartContract.response.parse({
        channelType: "telegram",
        status: "running",
        message: "Channel adapter restarted",
      })
    ).not.toThrow();
  });
});

describe("MessageSendContract", () => {
  it("accepts minimal request (no rich content)", () => {
    expect(() =>
      MessageSendContract.request.parse({
        channel_type: "telegram",
        channel_id: "123",
        text: "hello",
      })
    ).not.toThrow();
  });

  it("accepts rich content optional fields", () => {
    expect(() =>
      MessageSendContract.request.parse({
        channel_type: "telegram",
        channel_id: "123",
        text: "hello",
        buttons: [[{ label: "OK", value: "ok" }]],
        cards: [{ title: "Card", body: "x" }],
        effects: [{ kind: "highlight" }],
        thread_reply: true,
      })
    ).not.toThrow();
  });

  it("rejects request without text", () => {
    expect(() =>
      MessageSendContract.request.parse({
        channel_type: "telegram",
        channel_id: "123",
      })
    ).toThrow();
  });

  it("accepts a well-formed message.send response", () => {
    expect(() =>
      MessageSendContract.response.parse({ messageId: "msg-1", channelId: "123" })
    ).not.toThrow();
  });
});

describe("MessageReplyContract", () => {
  it("accepts request with message_id", () => {
    expect(() =>
      MessageReplyContract.request.parse({
        channel_type: "telegram",
        channel_id: "123",
        message_id: "m1",
        text: "reply",
      })
    ).not.toThrow();
  });

  it("rejects request without message_id", () => {
    expect(() =>
      MessageReplyContract.request.parse({
        channel_type: "telegram",
        channel_id: "123",
        text: "x",
      })
    ).toThrow();
  });
});

describe("MessageReactContract", () => {
  it("accepts a well-formed message.react request", () => {
    expect(() =>
      MessageReactContract.request.parse({
        channel_type: "telegram",
        channel_id: "123",
        message_id: "m1",
        emoji: "👍",
      })
    ).not.toThrow();
  });

  it("response asserts reacted: true literal", () => {
    expect(() =>
      MessageReactContract.response.parse({
        reacted: false,
        channelId: "123",
        messageId: "m1",
        emoji: "👍",
      })
    ).toThrow();
  });
});

describe("MessageEditContract / DeleteContract", () => {
  it("edit accepts request", () => {
    expect(() =>
      MessageEditContract.request.parse({
        channel_type: "telegram",
        channel_id: "123",
        message_id: "m1",
        text: "edited",
      })
    ).not.toThrow();
  });

  it("delete accepts request", () => {
    expect(() =>
      MessageDeleteContract.request.parse({
        channel_type: "telegram",
        channel_id: "123",
        message_id: "m1",
      })
    ).not.toThrow();
  });

  it("delete rejects request without message_id", () => {
    expect(() =>
      MessageDeleteContract.request.parse({
        channel_type: "telegram",
        channel_id: "123",
      })
    ).toThrow();
  });
});

describe("MessageFetchContract", () => {
  it("accepts minimal request", () => {
    expect(() =>
      MessageFetchContract.request.parse({
        channel_type: "telegram",
        channel_id: "123",
      })
    ).not.toThrow();
  });

  it("accepts optional limit + before", () => {
    expect(() =>
      MessageFetchContract.request.parse({
        channel_type: "telegram",
        channel_id: "123",
        limit: 50,
        before: "m1",
      })
    ).not.toThrow();
  });

  it("accepts loose messages response array", () => {
    expect(() =>
      MessageFetchContract.response.parse({
        messages: [
          { id: "m1", text: "hi", date: 100 },
          { id: "m2", from: "user", content: "yo" },
        ],
        channelId: "123",
      })
    ).not.toThrow();
  });
});

describe("MessageAttachContract", () => {
  it("accepts minimal request (just channel + url)", () => {
    expect(() =>
      MessageAttachContract.request.parse({
        channel_type: "telegram",
        channel_id: "123",
        attachment_url: "https://example.com/f.pdf",
      })
    ).not.toThrow();
  });

  it("accepts full request with all optional fields", () => {
    expect(() =>
      MessageAttachContract.request.parse({
        channel_type: "telegram",
        channel_id: "123",
        attachment_url: "https://example.com/f.pdf",
        attachment_type: "file",
        mime_type: "application/pdf",
        file_name: "report.pdf",
        caption: "see attached",
      })
    ).not.toThrow();
  });

  it("accepts all attachment_type enum values", () => {
    for (const type of ["image", "file", "audio", "video"] as const) {
      expect(() =>
        MessageAttachContract.request.parse({
          channel_type: "telegram",
          channel_id: "123",
          attachment_url: "https://example.com/f",
          attachment_type: type,
        })
      ).not.toThrow();
    }
  });

  it("rejects invalid attachment_type enum value", () => {
    expect(() =>
      MessageAttachContract.request.parse({
        channel_type: "telegram",
        channel_id: "123",
        attachment_url: "https://example.com/f",
        attachment_type: "weird",
      })
    ).toThrow();
  });
});

describe("Platform action contracts (Discord/Telegram/Slack/WhatsApp)", () => {
  it("discord.action accepts any record", () => {
    expect(() =>
      DiscordActionContract.request.parse({
        action: "pin_message",
        channel_id: "ch1",
        message_id: "m1",
      })
    ).not.toThrow();
  });

  it("telegram.action accepts any record", () => {
    expect(() =>
      TelegramActionContract.request.parse({
        action: "set_commands",
        chat_id: "12345",
        commands: [{ command: "start", description: "begin" }],
      })
    ).not.toThrow();
  });

  it("slack.action accepts any record", () => {
    expect(() =>
      SlackActionContract.request.parse({
        action: "pin_message",
        channel_id: "C1234",
        ts: "1234.5678",
      })
    ).not.toThrow();
  });

  it("whatsapp.action accepts any record", () => {
    expect(() =>
      WhatsappActionContract.request.parse({
        action: "promote",
        group_jid: "12345@g.us",
        participant_jid: "67890@s.whatsapp.net",
      })
    ).not.toThrow();
  });

  it("each platform-action response accepts an arbitrary record", () => {
    for (const contract of [DiscordActionContract, TelegramActionContract, SlackActionContract, WhatsappActionContract]) {
      expect(() => contract.response.parse({ ok: true, result: 42 })).not.toThrow();
      expect(() => contract.response.parse({})).not.toThrow();
    }
  });
});
