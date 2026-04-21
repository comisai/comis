// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock event emitter for Baileys socket
function createMockEv() {
  const listeners = new Map<string, Function[]>();
  return {
    on(event: string, fn: Function) {
      const list = listeners.get(event) ?? [];
      list.push(fn);
      listeners.set(event, list);
    },
    emit(event: string, data: unknown) {
      for (const fn of listeners.get(event) ?? []) fn(data);
    },
    listeners,
  };
}

let mockEv = createMockEv();
const mockSendMessage = vi.fn();
const mockEnd = vi.fn();
const mockSaveCreds = vi.fn();
const mockMakeWASocket = vi.fn();
const mockGroupMetadata = vi.fn();
const mockGroupUpdateSubject = vi.fn();
const mockGroupUpdateDescription = vi.fn();
const mockGroupParticipantsUpdate = vi.fn();
const mockGroupSettingUpdate = vi.fn();
const mockGroupInviteCode = vi.fn();
const mockUpdateProfileStatus = vi.fn();
const mockGroupLeave = vi.fn();

vi.mock("@whiskeysockets/baileys", () => ({
  makeWASocket: (...args: unknown[]) => mockMakeWASocket(...args),
  default: (...args: unknown[]) => mockMakeWASocket(...args),
  DisconnectReason: {
    loggedOut: 401,
    connectionClosed: 428,
    connectionLost: 408,
    timedOut: 440,
  },
  useMultiFileAuthState: vi.fn(async () => ({
    state: { creds: {}, keys: {} },
    saveCreds: mockSaveCreds,
  })),
}));

vi.mock("@hapi/boom", () => ({
  Boom: class Boom {
    output: { statusCode: number };
    constructor(msg: string, opts?: { statusCode?: number }) {
      this.output = { statusCode: opts?.statusCode ?? 500 };
    }
  },
}));

vi.mock("./credential-validator.js", () => ({
  validateWhatsAppAuth: vi.fn(),
}));

vi.mock("./message-mapper.js", () => ({
  mapBaileysToNormalized: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { ok, err } from "@comis/shared";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { DisconnectReason } from "@whiskeysockets/baileys";
import { validateWhatsAppAuth } from "./credential-validator.js";
import { mapBaileysToNormalized } from "./message-mapper.js";
import { createWhatsAppAdapter, type WhatsAppAdapterDeps } from "./whatsapp-adapter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(overrides?: Partial<WhatsAppAdapterDeps>): WhatsAppAdapterDeps {
  return {
    authDir: "/tmp/wa-test-auth",
    printQR: true,
    logger: createMockLogger(),
    ...overrides,
  };
}

function makeNormalized() {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    channelId: "41796666864@s.whatsapp.net",
    channelType: "whatsapp" as const,
    senderId: "41796666864",
    text: "Hello",
    timestamp: Date.now(),
    attachments: [],
    metadata: {
      whatsappMessageId: "msg-1",
      whatsappRemoteJid: "41796666864@s.whatsapp.net",
      whatsappPushName: "John",
      isGroup: false,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createWhatsAppAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEv = createMockEv();
    mockMakeWASocket.mockReturnValue({
      ev: mockEv,
      sendMessage: mockSendMessage,
      end: mockEnd,
      user: { id: "41796666864:0@s.whatsapp.net" },
      groupMetadata: mockGroupMetadata,
      groupUpdateSubject: mockGroupUpdateSubject,
      groupUpdateDescription: mockGroupUpdateDescription,
      groupParticipantsUpdate: mockGroupParticipantsUpdate,
      groupSettingUpdate: mockGroupSettingUpdate,
      groupInviteCode: mockGroupInviteCode,
      updateProfileStatus: mockUpdateProfileStatus,
      groupLeave: mockGroupLeave,
    });
  });

  describe("channelType", () => {
    it("returns 'whatsapp'", () => {
      const adapter = createWhatsAppAdapter(makeDeps());
      expect(adapter.channelType).toBe("whatsapp");
    });
  });

  describe("channelId", () => {
    it("starts as 'whatsapp-pending'", () => {
      const adapter = createWhatsAppAdapter(makeDeps());
      expect(adapter.channelId).toBe("whatsapp-pending");
    });
  });

  describe("start()", () => {
    it("validates auth directory", async () => {
      vi.mocked(validateWhatsAppAuth).mockResolvedValue(
        ok({ authDir: "/tmp/wa-test-auth", isFirstRun: false }),
      );

      const adapter = createWhatsAppAdapter(makeDeps());
      const result = await adapter.start();

      expect(result.ok).toBe(true);
      expect(validateWhatsAppAuth).toHaveBeenCalledWith({
        authDir: "/tmp/wa-test-auth",
        printQR: true,
      });
    });

    it("returns err when auth validation fails and logs Adapter start failed", async () => {
      vi.mocked(validateWhatsAppAuth).mockResolvedValue(
        err(new Error("WhatsApp auth directory must not be empty")),
      );

      const deps = makeDeps();
      const adapter = createWhatsAppAdapter(deps);
      const result = await adapter.start();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("must not be empty");
      }
      expect(deps.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          channelType: "whatsapp",
          hint: expect.stringContaining("Baileys auth directory"),
          errorKind: "auth",
        }),
        "Adapter start failed",
      );
    });

    it("calls makeWASocket with auth state", async () => {
      vi.mocked(validateWhatsAppAuth).mockResolvedValue(
        ok({ authDir: "/tmp/wa-test-auth", isFirstRun: false }),
      );

      const adapter = createWhatsAppAdapter(makeDeps());
      await adapter.start();

      expect(mockMakeWASocket).toHaveBeenCalled();
    });

    it("logs first-run info when isFirstRun is true", async () => {
      vi.mocked(validateWhatsAppAuth).mockResolvedValue(
        ok({ authDir: "/tmp/wa-test-auth", isFirstRun: true }),
      );

      const deps = makeDeps();
      const adapter = createWhatsAppAdapter(deps);
      await adapter.start();

      expect(deps.logger.info).toHaveBeenCalledWith(
        expect.stringContaining("WhatsApp first run"),
      );
    });
  });

  describe("connection.update events", () => {
    it("connection open sets connected state and channelId", async () => {
      vi.mocked(validateWhatsAppAuth).mockResolvedValue(
        ok({ authDir: "/tmp/wa-test-auth", isFirstRun: false }),
      );

      const deps = makeDeps();
      const adapter = createWhatsAppAdapter(deps);
      await adapter.start();

      // Simulate connection open
      mockEv.emit("connection.update", { connection: "open" });

      expect(adapter.channelId).toContain("whatsapp-");
      expect(deps.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ channelType: "whatsapp" }),
        "Adapter started",
      );
    });

    it("connection close with non-loggedOut triggers reconnect", async () => {
      vi.mocked(validateWhatsAppAuth).mockResolvedValue(
        ok({ authDir: "/tmp/wa-test-auth", isFirstRun: false }),
      );

      const deps = makeDeps();
      const adapter = createWhatsAppAdapter(deps);
      await adapter.start();

      const callCount = mockMakeWASocket.mock.calls.length;

      // Simulate disconnect with connectionClosed (not loggedOut)
      const boomError = { output: { statusCode: DisconnectReason.connectionClosed } };
      mockEv.emit("connection.update", {
        connection: "close",
        lastDisconnect: { error: boomError },
      });

      // Wait for async reconnect
      await new Promise((r) => setTimeout(r, 50));

      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          channelType: "whatsapp",
          attempt: 1,
          statusCode: DisconnectReason.connectionClosed,
          hint: "Connection lost, attempting automatic reconnection",
          errorKind: "network",
        }),
        "Reconnection attempt",
      );
      // makeWASocket should have been called again for reconnection
      expect(mockMakeWASocket.mock.calls.length).toBeGreaterThan(callCount);
    });

    it("connection close with loggedOut does NOT reconnect", async () => {
      vi.mocked(validateWhatsAppAuth).mockResolvedValue(
        ok({ authDir: "/tmp/wa-test-auth", isFirstRun: false }),
      );

      const deps = makeDeps();
      const adapter = createWhatsAppAdapter(deps);
      await adapter.start();

      const callCount = mockMakeWASocket.mock.calls.length;

      // Simulate loggedOut disconnect
      const boomError = { output: { statusCode: DisconnectReason.loggedOut } };
      mockEv.emit("connection.update", {
        connection: "close",
        lastDisconnect: { error: boomError },
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(deps.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          channelType: "whatsapp",
          hint: "WhatsApp logged out, re-scan QR code to re-authenticate",
          errorKind: "auth",
        }),
        "Adapter connection lost permanently",
      );
      // makeWASocket should NOT be called again
      expect(mockMakeWASocket.mock.calls.length).toBe(callCount);
    });

    it("QR code event logs info", async () => {
      vi.mocked(validateWhatsAppAuth).mockResolvedValue(
        ok({ authDir: "/tmp/wa-test-auth", isFirstRun: false }),
      );

      const deps = makeDeps();
      const adapter = createWhatsAppAdapter(deps);
      await adapter.start();

      mockEv.emit("connection.update", { qr: "some-qr-data" });

      expect(deps.logger.info).toHaveBeenCalledWith(
        expect.stringContaining("WhatsApp QR code"),
      );
    });
  });

  describe("messages.upsert", () => {
    it("dispatches new messages to handlers", async () => {
      vi.mocked(validateWhatsAppAuth).mockResolvedValue(
        ok({ authDir: "/tmp/wa-test-auth", isFirstRun: false }),
      );
      const normalized = makeNormalized();
      vi.mocked(mapBaileysToNormalized).mockReturnValue(normalized);

      const adapter = createWhatsAppAdapter(makeDeps());
      const handler = vi.fn();
      adapter.onMessage(handler);
      await adapter.start();

      // Simulate incoming message
      mockEv.emit("messages.upsert", {
        messages: [
          {
            key: { remoteJid: "41796666864@s.whatsapp.net", fromMe: false, id: "msg-1" },
            message: { conversation: "Hello" },
            messageTimestamp: 1700000000,
            pushName: "John",
          },
        ],
        type: "notify",
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(mapBaileysToNormalized).toHaveBeenCalled();
      expect(handler).toHaveBeenCalledWith(normalized);
    });

    it("ignores history sync messages", async () => {
      vi.mocked(validateWhatsAppAuth).mockResolvedValue(
        ok({ authDir: "/tmp/wa-test-auth", isFirstRun: false }),
      );

      const adapter = createWhatsAppAdapter(makeDeps());
      const handler = vi.fn();
      adapter.onMessage(handler);
      await adapter.start();

      // Simulate history sync
      mockEv.emit("messages.upsert", {
        messages: [
          {
            key: { remoteJid: "41796666864@s.whatsapp.net", fromMe: false, id: "hist-1" },
            message: { conversation: "Old message" },
          },
        ],
        type: "append",
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(handler).not.toHaveBeenCalled();
    });

    it("filters out own messages (key.fromMe)", async () => {
      vi.mocked(validateWhatsAppAuth).mockResolvedValue(
        ok({ authDir: "/tmp/wa-test-auth", isFirstRun: false }),
      );

      const adapter = createWhatsAppAdapter(makeDeps());
      const handler = vi.fn();
      adapter.onMessage(handler);
      await adapter.start();

      // Simulate own message
      mockEv.emit("messages.upsert", {
        messages: [
          {
            key: { remoteJid: "41796666864@s.whatsapp.net", fromMe: true, id: "own-1" },
            message: { conversation: "My message" },
          },
        ],
        type: "notify",
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(handler).not.toHaveBeenCalled();
    });

    it("logs error when handler throws (fire-and-forget)", async () => {
      vi.mocked(validateWhatsAppAuth).mockResolvedValue(
        ok({ authDir: "/tmp/wa-test-auth", isFirstRun: false }),
      );
      vi.mocked(mapBaileysToNormalized).mockReturnValue(makeNormalized());

      const deps = makeDeps();
      const adapter = createWhatsAppAdapter(deps);
      adapter.onMessage(() => {
        throw new Error("Handler failed");
      });
      await adapter.start();

      mockEv.emit("messages.upsert", {
        messages: [
          {
            key: { remoteJid: "41796666864@s.whatsapp.net", fromMe: false, id: "err-1" },
            message: { conversation: "Hello" },
          },
        ],
        type: "notify",
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(deps.logger.error).toHaveBeenCalled();
    });
  });

  describe("sendMessage", () => {
    it("sends text and returns message ID", async () => {
      vi.mocked(validateWhatsAppAuth).mockResolvedValue(
        ok({ authDir: "/tmp/wa-test-auth", isFirstRun: false }),
      );
      mockSendMessage.mockResolvedValue({ key: { id: "sent-123" } });

      const adapter = createWhatsAppAdapter(makeDeps());
      await adapter.start();

      // Simulate connection open to set connected = true
      mockEv.emit("connection.update", { connection: "open" });

      const result = await adapter.sendMessage("41796666864@s.whatsapp.net", "Hello!");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("sent-123");
      }
      expect(mockSendMessage).toHaveBeenCalledWith("41796666864@s.whatsapp.net", {
        text: "Hello!",
      });
    });

    it("returns err when not connected", async () => {
      const adapter = createWhatsAppAdapter(makeDeps());
      const result = await adapter.sendMessage("41796666864@s.whatsapp.net", "Hello!");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe("WhatsApp not connected");
      }
    });

    it("returns err on send failure", async () => {
      vi.mocked(validateWhatsAppAuth).mockResolvedValue(
        ok({ authDir: "/tmp/wa-test-auth", isFirstRun: false }),
      );
      mockSendMessage.mockRejectedValue(new Error("Network error"));

      const adapter = createWhatsAppAdapter(makeDeps());
      await adapter.start();
      mockEv.emit("connection.update", { connection: "open" });

      const result = await adapter.sendMessage("41796666864@s.whatsapp.net", "Hello!");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Failed to send message");
      }
    });
  });

  describe("editMessage", () => {
    it("sends edit with correct key", async () => {
      vi.mocked(validateWhatsAppAuth).mockResolvedValue(
        ok({ authDir: "/tmp/wa-test-auth", isFirstRun: false }),
      );
      mockSendMessage.mockResolvedValue({});

      const adapter = createWhatsAppAdapter(makeDeps());
      await adapter.start();
      mockEv.emit("connection.update", { connection: "open" });

      const result = await adapter.editMessage(
        "41796666864@s.whatsapp.net",
        "msg-123",
        "Updated text",
      );

      expect(result.ok).toBe(true);
      expect(mockSendMessage).toHaveBeenCalledWith("41796666864@s.whatsapp.net", {
        text: "Updated text",
        edit: {
          remoteJid: "41796666864@s.whatsapp.net",
          id: "msg-123",
          fromMe: true,
        },
      });
    });

    it("returns err when not connected", async () => {
      const adapter = createWhatsAppAdapter(makeDeps());
      const result = await adapter.editMessage("41796666864@s.whatsapp.net", "msg-123", "Updated");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe("WhatsApp not connected");
      }
    });
  });

  describe("platformAction", () => {
    it("group_info returns group metadata", async () => {
      vi.mocked(validateWhatsAppAuth).mockResolvedValue(
        ok({ authDir: "/tmp/wa-test-auth", isFirstRun: false }),
      );
      mockGroupMetadata.mockResolvedValue({
        subject: "Test Group",
        desc: "A test group",
        participants: [{ id: "1" }, { id: "2" }, { id: "3" }],
        owner: "1@s.whatsapp.net",
      });

      const adapter = createWhatsAppAdapter(makeDeps());
      await adapter.start();
      mockEv.emit("connection.update", { connection: "open" });

      const result = await adapter.platformAction("group_info", {
        group_jid: "120363000000@g.us",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({
          subject: "Test Group",
          description: "A test group",
          participantsCount: 3,
          owner: "1@s.whatsapp.net",
        });
      }
      expect(mockGroupMetadata).toHaveBeenCalledWith("120363000000@g.us");
    });

    it("group_update_subject calls sock.groupUpdateSubject", async () => {
      vi.mocked(validateWhatsAppAuth).mockResolvedValue(
        ok({ authDir: "/tmp/wa-test-auth", isFirstRun: false }),
      );
      mockGroupUpdateSubject.mockResolvedValue(undefined);

      const adapter = createWhatsAppAdapter(makeDeps());
      await adapter.start();
      mockEv.emit("connection.update", { connection: "open" });

      const result = await adapter.platformAction("group_update_subject", {
        group_jid: "120363000000@g.us",
        subject: "New Name",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({ subjectUpdated: true });
      }
      expect(mockGroupUpdateSubject).toHaveBeenCalledWith("120363000000@g.us", "New Name");
    });

    it("unsupported action returns error", async () => {
      vi.mocked(validateWhatsAppAuth).mockResolvedValue(
        ok({ authDir: "/tmp/wa-test-auth", isFirstRun: false }),
      );

      const adapter = createWhatsAppAdapter(makeDeps());
      await adapter.start();
      mockEv.emit("connection.update", { connection: "open" });

      const result = await adapter.platformAction("does_not_exist", {});

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe("Unsupported action: does_not_exist on whatsapp");
      }
    });

    it("SDK error returns descriptive failure", async () => {
      vi.mocked(validateWhatsAppAuth).mockResolvedValue(
        ok({ authDir: "/tmp/wa-test-auth", isFirstRun: false }),
      );
      mockGroupMetadata.mockRejectedValue(new Error("not-authorized"));

      const adapter = createWhatsAppAdapter(makeDeps());
      await adapter.start();
      mockEv.emit("connection.update", { connection: "open" });

      const result = await adapter.platformAction("group_info", {
        group_jid: "120363000000@g.us",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe(
          "WhatsApp action 'group_info' failed: not-authorized",
        );
      }
    });

    it("returns error when not connected", async () => {
      const adapter = createWhatsAppAdapter(makeDeps());
      const result = await adapter.platformAction("group_info", {
        group_jid: "120363000000@g.us",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe("WhatsApp not connected");
      }
    });
  });

  describe("stop()", () => {
    it("calls sock.end() and sets connected = false", async () => {
      vi.mocked(validateWhatsAppAuth).mockResolvedValue(
        ok({ authDir: "/tmp/wa-test-auth", isFirstRun: false }),
      );

      const adapter = createWhatsAppAdapter(makeDeps());
      await adapter.start();
      mockEv.emit("connection.update", { connection: "open" });

      const result = await adapter.stop();

      expect(result.ok).toBe(true);
      expect(mockEnd).toHaveBeenCalledWith(undefined);
    });

    it("logs standardized 'Adapter stopped' on success", async () => {
      vi.mocked(validateWhatsAppAuth).mockResolvedValue(
        ok({ authDir: "/tmp/wa-test-auth", isFirstRun: false }),
      );

      const deps = makeDeps();
      const adapter = createWhatsAppAdapter(deps);
      await adapter.start();
      mockEv.emit("connection.update", { connection: "open" });
      await adapter.stop();

      expect(deps.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ channelType: "whatsapp" }),
        "Adapter stopped",
      );
    });

    it("returns ok when no socket exists", async () => {
      const adapter = createWhatsAppAdapter(makeDeps());
      const result = await adapter.stop();

      expect(result.ok).toBe(true);
    });
  });
});
