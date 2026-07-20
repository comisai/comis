// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, expectTypeOf } from "vitest";
import {
  AttachmentSchema,
  getOriginalInboundMessages,
  parseInboundMessageProvenanceBatch,
  parseMessage,
  type NormalizedMessage,
} from "./normalized-message.js";

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";
const VALID_UUID_2 = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

function validMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: VALID_UUID,
    channelId: "general",
    channelType: "telegram",
    senderId: "user-123",
    text: "Hello, world!",
    timestamp: 1700000000,
    ...overrides,
  };
}

describe("NormalizedMessage", () => {
  describe("valid data", () => {
    it("parses a minimal valid message", () => {
      const result = parseMessage(validMessage());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBe(VALID_UUID);
        expect(result.value.channelType).toBe("telegram");
        expect(result.value.text).toBe("Hello, world!");
      }
    });

    it("applies default values for attachments and metadata", () => {
      const result = parseMessage(validMessage());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.attachments).toEqual([]);
        expect(result.value.metadata).toEqual({});
      }
    });

    it("accepts all valid channel types", () => {
      const channelTypes = [
        "telegram",
        "discord",
        "slack",
        "whatsapp",
        "web",
        "cli",
        "gateway",
      ] as const;
      for (const channelType of channelTypes) {
        const result = parseMessage(validMessage({ channelType }));
        expect(result.ok).toBe(true);
      }
    });

    it("accepts optional replyTo field", () => {
      const result = parseMessage(validMessage({ replyTo: VALID_UUID_2 }));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.replyTo).toBe(VALID_UUID_2);
      }
    });

    it("allows omitting optional replyTo", () => {
      const result = parseMessage(validMessage());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.replyTo).toBeUndefined();
      }
    });

    it("accepts valid attachments", () => {
      const result = parseMessage(
        validMessage({
          attachments: [
            {
              type: "image",
              url: "https://example.com/img.png",
              mimeType: "image/png",
              fileName: "img.png",
              sizeBytes: 1024,
            },
          ],
        }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.attachments).toHaveLength(1);
        expect(result.value.attachments[0].type).toBe("image");
      }
    });

    it("accepts tg-file:// URIs in attachments for deferred media resolution", () => {
      const result = parseMessage(
        validMessage({
          attachments: [
            {
              type: "file",
              url: "tg-file://abc123",
            },
          ],
        }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.attachments).toHaveLength(1);
        expect(result.value.attachments[0].url).toBe("tg-file://abc123");
      }
    });

    it("rejects empty string as attachment url", () => {
      const result = parseMessage(
        validMessage({
          attachments: [
            {
              type: "file",
              url: "",
            },
          ],
        }),
      );
      expect(result.ok).toBe(false);
    });

    it("accepts metadata with arbitrary values", () => {
      const result = parseMessage(validMessage({ metadata: { priority: 1, urgent: true } }));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.metadata).toEqual({ priority: 1, urgent: true });
      }
    });

    it("accepts a canonical per-turn response locale in message metadata", () => {
      const result = parseMessage(validMessage({ metadata: { locale: "ar" } }));

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.metadata.locale).toBe("ar");
    });

    it("rejects a non-canonical per-turn response locale in message metadata", () => {
      const result = parseMessage(validMessage({ metadata: { locale: "AR-eg" } }));

      expect(result.ok).toBe(false);
    });

    it("validates and preserves structured physical inbound provenance", () => {
      const originalMessages = [{
        id: VALID_UUID_2,
        channelId: "chat-2",
        channelType: "telegram",
        senderId: "user-2",
        text: "physical body",
        timestamp: 1_700_000_001,
      }];

      const result = parseMessage(validMessage({ originalMessages }));

      expect(result.ok).toBe(true);
      if (result.ok) expect(getOriginalInboundMessages(result.value)).toEqual(originalMessages);
    });

    it("projects an uncoalesced message into one physical inbound record", () => {
      const result = parseMessage(validMessage());
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(getOriginalInboundMessages(result.value)).toEqual([{
        id: VALID_UUID,
        channelId: "general",
        channelType: "telegram",
        senderId: "user-123",
        text: "Hello, world!",
        timestamp: 1_700_000_000,
      }]);
    });

    it("projects a restart continuation as an internal provenance record", () => {
      const result = parseMessage(validMessage({
        metadata: { isRestartContinuation: true },
      }));
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(getOriginalInboundMessages(result.value)).toEqual([{
        id: VALID_UUID,
        channelId: "general",
        channelType: "telegram",
        senderId: "system",
        text: "Hello, world!",
        timestamp: 1_700_000_000,
      }]);
    });

    it("parses the strict session provenance payload contract", () => {
      const result = parseInboundMessageProvenanceBatch({
        schemaVersion: 1,
        batchId: VALID_UUID,
        chunkIndex: 0,
        chunkCount: 1,
        recordedAt: 1_750_000_000_100,
        messages: [{
          id: VALID_UUID,
          channelId: "general",
          channelType: "telegram",
          senderId: "user-123",
          text: "Hello, world!",
          timestamp: 1_700_000_000,
        }],
      });

      expect(result.ok).toBe(true);
    });
  });

  describe("invalid data", () => {
    it("rejects provenance timestamps outside the runtime Date range", () => {
      const result = parseInboundMessageProvenanceBatch({
        schemaVersion: 1,
        batchId: VALID_UUID,
        chunkIndex: 0,
        chunkCount: 1,
        recordedAt: 1_750_000_000_100,
        messages: [{
          id: VALID_UUID,
          channelId: "general",
          channelType: "telegram",
          senderId: "user-123",
          text: "Hello, world!",
          timestamp: 8_640_000_000_000_001,
        }],
      });

      expect(result.ok).toBe(false);
    });

    it("rejects provenance chunk indices outside their bounded batch", () => {
      const result = parseInboundMessageProvenanceBatch({
        schemaVersion: 1,
        batchId: VALID_UUID,
        chunkIndex: 2,
        chunkCount: 2,
        recordedAt: 1_750_000_000_100,
        messages: [{
          id: VALID_UUID,
          channelId: "general",
          channelType: "telegram",
          senderId: "user-123",
          text: "Hello, world!",
          timestamp: 1_700_000_000,
        }],
      });

      expect(result.ok).toBe(false);
    });

    it("rejects provenance batches beyond the reader predecessor runway", () => {
      const result = parseInboundMessageProvenanceBatch({
        schemaVersion: 1,
        batchId: VALID_UUID,
        chunkIndex: 0,
        chunkCount: 33,
        recordedAt: 1_750_000_000_100,
        messages: [{
          id: VALID_UUID,
          channelId: "general",
          channelType: "telegram",
          senderId: "user-123",
          text: "Hello, world!",
          timestamp: 1_700_000_000,
        }],
      });

      expect(result.ok).toBe(false);
    });

    it("rejects missing required fields", () => {
      const result = parseMessage({});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const paths = result.error.issues.map((i) => i.path[0]);
        expect(paths).toContain("id");
        expect(paths).toContain("channelId");
        expect(paths).toContain("channelType");
        expect(paths).toContain("senderId");
        expect(paths).toContain("text");
        expect(paths).toContain("timestamp");
      }
    });

    it("rejects invalid UUID for id", () => {
      const result = parseMessage(validMessage({ id: "not-a-uuid" }));
      expect(result.ok).toBe(false);
    });

    it("accepts arbitrary non-empty channel type strings", () => {
      // channelType is z.string().min(1) to support dynamic channel plugins
      const result = parseMessage(validMessage({ channelType: "sms" }));
      expect(result.ok).toBe(true);
    });

    it("rejects empty channel type", () => {
      const result = parseMessage(validMessage({ channelType: "" }));
      expect(result.ok).toBe(false);
    });

    it("rejects empty channelId", () => {
      const result = parseMessage(validMessage({ channelId: "" }));
      expect(result.ok).toBe(false);
    });

    it("rejects empty senderId", () => {
      const result = parseMessage(validMessage({ senderId: "" }));
      expect(result.ok).toBe(false);
    });

    it("rejects text exceeding max length", () => {
      const result = parseMessage(validMessage({ text: "x".repeat(32769) }));
      expect(result.ok).toBe(false);
    });

    it("rejects non-integer timestamp", () => {
      const result = parseMessage(validMessage({ timestamp: 1700000000.5 }));
      expect(result.ok).toBe(false);
    });

    it("rejects negative timestamp", () => {
      const result = parseMessage(validMessage({ timestamp: -1 }));
      expect(result.ok).toBe(false);
    });

    it("rejects zero timestamp", () => {
      const result = parseMessage(validMessage({ timestamp: 0 }));
      expect(result.ok).toBe(false);
    });

    it("rejects invalid replyTo UUID", () => {
      const result = parseMessage(validMessage({ replyTo: "bad" }));
      expect(result.ok).toBe(false);
    });

    it("rejects malformed original inbound identities", () => {
      const result = parseMessage(validMessage({
        originalMessages: [{
          id: "not-a-message-id",
          channelId: "general",
          channelType: "telegram",
          senderId: "user-123",
          text: "body",
          timestamp: 1_700_000_000,
        }],
      }));

      expect(result.ok).toBe(false);
    });

    it("strips extra/unknown fields", () => {
      const result = parseMessage(validMessage({ extraField: "sneaky" }));
      expect(result.ok).toBe(false);
    });

    it("rejects non-object input", () => {
      const result = parseMessage("not an object");
      expect(result.ok).toBe(false);
    });

    it("rejects null as a message input", () => {
      const result = parseMessage(null);
      expect(result.ok).toBe(false);
    });

    it("returns descriptive ZodError with issue paths", () => {
      const result = parseMessage({ id: 123, channelType: "invalid" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.issues.length).toBeGreaterThan(0);
        for (const issue of result.error.issues) {
          expect(issue.message).toBeTruthy();
        }
      }
    });
  });

  describe("voice metadata fields", () => {
    it("accepts a voice attachment with all new fields", () => {
      const result = parseMessage(
        validMessage({
          attachments: [
            {
              type: "audio",
              url: "tg-file://voice123",
              durationMs: 5000,
              isVoiceNote: true,
              voiceMeta: { waveform: "AAAA", codec: "opus" },
              transcription: "Hello, world!",
            },
          ],
        }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        const att = result.value.attachments[0];
        expect(att.durationMs).toBe(5000);
        expect(att.isVoiceNote).toBe(true);
        expect(att.voiceMeta).toEqual({ waveform: "AAAA", codec: "opus" });
        expect(att.transcription).toBe("Hello, world!");
      }
    });

    it("accepts an attachment that omits every optional voice field", () => {
      const result = AttachmentSchema.safeParse({
        type: "file",
        url: "https://example.com/doc.pdf",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.durationMs).toBeUndefined();
        expect(result.data.isVoiceNote).toBeUndefined();
        expect(result.data.voiceMeta).toBeUndefined();
        expect(result.data.transcription).toBeUndefined();
      }
    });

    it("rejects voiceMeta with extra unknown fields (strictObject)", () => {
      const result = AttachmentSchema.safeParse({
        type: "audio",
        url: "https://example.com/audio.ogg",
        voiceMeta: { waveform: "AAAA", codec: "opus", extraField: "bad" },
      });
      expect(result.success).toBe(false);
    });

    it("rejects negative durationMs", () => {
      const result = AttachmentSchema.safeParse({
        type: "audio",
        url: "https://example.com/audio.ogg",
        durationMs: -100,
      });
      expect(result.success).toBe(false);
    });

    it("rejects non-integer durationMs", () => {
      const result = AttachmentSchema.safeParse({
        type: "audio",
        url: "https://example.com/audio.ogg",
        durationMs: 5000.5,
      });
      expect(result.success).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Concrete metadata.traceId typing
  // ---------------------------------------------------------------------------
  describe("metadata.traceId concrete typing", () => {
    it("metadata.traceId is typed as string | undefined at the TypeScript type level", () => {
      // With z.looseObject({ traceId: z.guid().optional() }), the type is string | undefined.
      expectTypeOf<NormalizedMessage["metadata"]["traceId"]>().toEqualTypeOf<string | undefined>();
    });

    it("rejects a non-uuid string in metadata.traceId", () => {
      // traceId must be a valid UUID when present.
      const result = parseMessage(validMessage({ metadata: { traceId: "not-a-uuid" } }));
      expect(result.ok).toBe(false);
    });

    it("accepts a valid UUID in metadata.traceId alongside arbitrary metadata keys", () => {
      const result = parseMessage(
        validMessage({
          metadata: {
            traceId: VALID_UUID,
            isButtonCallback: true,
            callbackData: "some-callback-data",
          },
        }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.metadata.traceId).toBe(VALID_UUID);
        expect(result.value.metadata["isButtonCallback"]).toBe(true);
      }
    });

    it("accepts metadata without traceId (traceId is optional)", () => {
      const result = parseMessage(validMessage({ metadata: { isButtonCallback: true } }));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.metadata.traceId).toBeUndefined();
      }
    });
  });

  describe("getMessageTraceId helper", () => {
    it("getMessageTraceId is exported from the module", async () => {
      const mod = await import("./normalized-message.js");
      expect(typeof mod.getMessageTraceId).toBe("function");
    });

    it("getMessageTraceId returns the traceId string when present", async () => {
      const { getMessageTraceId } = await import("./normalized-message.js");
      const result = parseMessage(validMessage({ metadata: { traceId: VALID_UUID } }));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(getMessageTraceId(result.value)).toBe(VALID_UUID);
      }
    });

    it("getMessageTraceId returns undefined when traceId is absent", async () => {
      const { getMessageTraceId } = await import("./normalized-message.js");
      const result = parseMessage(validMessage());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(getMessageTraceId(result.value)).toBeUndefined();
      }
    });

    it("getMessageTraceId returns undefined when metadata.traceId is a non-string value (defensive read)", async () => {
      const { getMessageTraceId } = await import("./normalized-message.js");
      // Direct type cast to test defensive behavior — covers runtime edge cases
      // where a persisted message never passed through the schema validator.
      const msg = {
        id: VALID_UUID,
        channelId: "general",
        channelType: "telegram",
        senderId: "user-123",
        text: "Hello",
        timestamp: 1700000000,
        attachments: [],
        metadata: { traceId: 42 as unknown as string },
      } as NormalizedMessage;
      expect(getMessageTraceId(msg)).toBeUndefined();
    });
  });
});
