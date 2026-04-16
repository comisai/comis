/**
 * MSG: Echo Adapter Dispatch Integration Tests
 *
 * Validates all 7 message operations by dispatching through the daemon's
 * adapterRegistry -- the same Map<string, ChannelPort> that rpcCall's
 * resolveAdapter() uses internally (daemon.ts line 1749).
 *
 *   MSG-01: message.send dispatches through registry, returns { messageId, channelId }
 *   MSG-02: message.reply dispatches with replyTo, returns { messageId, channelId }
 *   MSG-03: message.react dispatches through registry, returns { reacted, emoji }
 *   MSG-04: message.edit dispatches through registry, returns { edited }
 *   MSG-05: message.delete dispatches through registry, returns { deleted }
 *   MSG-06: message.fetch dispatches through registry, returns { messages }
 *   MSG-07: message.attach dispatches through registry, returns { messageId }
 *
 * Tests register the EchoChannelAdapter on the daemon's adapterRegistry,
 * resolve it by channel type (mirroring resolveAdapter behavior), and call
 * adapter methods with rpcCall's parameter patterns to verify response shapes.
 *
 * Uses a dedicated config (port 8449, separate memory DB) to avoid conflicts.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startTestDaemon,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import { EchoChannelAdapter } from "@comis/channels";
import type { ChannelPort, FetchedMessage } from "@comis/core";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const messagingConfigPath = resolve(
  __dirname,
  "../config/config.test-messaging.yaml",
);

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("MSG: Echo Adapter Dispatch", () => {
  let handle: TestDaemonHandle;
  let echoAdapter: EchoChannelAdapter;
  let registry: Map<string, ChannelPort>;

  // -------------------------------------------------------------------------
  // Helper: mirrors daemon.ts resolveAdapter() + rpcCall message.* dispatch
  // -------------------------------------------------------------------------

  async function dispatchMessage(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const channelType = params.channel_type as string;
    const channelId = params.channel_id as string;

    // Resolve adapter from registry -- same path as daemon.ts resolveAdapter(channelType, adaptersByType)
    const adapter = registry.get(channelType);
    if (!adapter) {
      throw new Error(
        `No adapter found for channel type: ${channelType}. Available: ${Array.from(registry.keys()).join(", ") || "none"}`,
      );
    }

    // Dispatch to adapter method -- mirrors daemon.ts rpcCall switch cases (lines 687-765)
    switch (method) {
      case "message.send": {
        const result = await adapter.sendMessage(
          channelId,
          params.text as string,
        );
        if (!result.ok) throw result.error;
        return { messageId: result.value, channelId };
      }
      case "message.reply": {
        const result = await adapter.sendMessage(
          channelId,
          params.text as string,
          { replyTo: params.message_id as string },
        );
        if (!result.ok) throw result.error;
        return { messageId: result.value, channelId };
      }
      case "message.react": {
        const result = await adapter.reactToMessage(
          channelId,
          params.message_id as string,
          params.emoji as string,
        );
        if (!result.ok) throw result.error;
        return {
          reacted: true,
          channelId,
          messageId: params.message_id,
          emoji: params.emoji,
        };
      }
      case "message.edit": {
        const result = await adapter.editMessage(
          channelId,
          params.message_id as string,
          params.text as string,
        );
        if (!result.ok) throw result.error;
        return { edited: true, channelId, messageId: params.message_id };
      }
      case "message.delete": {
        const result = await adapter.deleteMessage(
          channelId,
          params.message_id as string,
        );
        if (!result.ok) throw result.error;
        return { deleted: true, channelId, messageId: params.message_id };
      }
      case "message.fetch": {
        const result = await adapter.fetchMessages(channelId, {
          limit: (params.limit as number) ?? 20,
          before: params.before as string | undefined,
        });
        if (!result.ok) throw result.error;
        return { messages: result.value, channelId };
      }
      case "message.attach": {
        const result = await adapter.sendAttachment(channelId, {
          type:
            (params.attachment_type as
              | "image"
              | "file"
              | "audio"
              | "video") ?? "file",
          url: params.attachment_url as string,
          mimeType: params.mime_type as string | undefined,
          fileName: params.file_name as string | undefined,
          caption: params.caption as string | undefined,
        });
        if (!result.ok) throw result.error;
        return { messageId: result.value, channelId };
      }
      default:
        throw new Error(`Unknown message method: ${method}`);
    }
  }

  // -------------------------------------------------------------------------
  // Setup and teardown
  // -------------------------------------------------------------------------

  beforeAll(async () => {
    // Create echo adapter instance
    echoAdapter = new EchoChannelAdapter({
      channelId: "echo-test",
      channelType: "echo",
    });

    // Start test daemon with messaging config
    handle = await startTestDaemon({ configPath: messagingConfigPath });

    // Register echo adapter on the daemon's adapter registry
    // adapterRegistry is the same adaptersByType Map that rpcCall reads from (daemon.ts line 1740)
    registry = (handle.daemon as any).adapterRegistry as Map<
      string,
      ChannelPort
    >;
    registry.set("echo", echoAdapter);
  }, 120_000);

  afterAll(async () => {
    if (handle) {
      try {
        await handle.cleanup();
      } catch (err) {
        // Expected: graceful shutdown calls the overridden exit() which throws.
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("Daemon exit with code")) {
          throw err;
        }
      }
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  // Tests
  // -------------------------------------------------------------------------

  it(
    "echo adapter is registered and resolvable from daemon adapter registry",
    () => {
      expect(registry.get("echo")).toBeDefined();
      expect(registry.size).toBeGreaterThanOrEqual(1);
      // Reference equality -- same object rpcCall would use
      expect(registry.get("echo")).toBe(echoAdapter);
    },
    10_000,
  );

  it(
    "message.send dispatches through registry and returns { messageId, channelId } (MSG-01)",
    async () => {
      const result = (await dispatchMessage("message.send", {
        channel_type: "echo",
        channel_id: "echo-test",
        text: "Hello from test",
      })) as { messageId: string; channelId: string };

      expect(result.messageId).toMatch(/^echo-msg-/);
      expect(result.channelId).toBe("echo-test");

      // Verify the message was stored in the echo adapter
      const sent = echoAdapter.getSentMessages();
      const found = sent.find((m) => m.id === result.messageId);
      expect(found).toBeDefined();
      expect(found!.text).toBe("Hello from test");
    },
    10_000,
  );

  it(
    "message.reply dispatches with replyTo through registry (MSG-02)",
    async () => {
      const result = (await dispatchMessage("message.reply", {
        channel_type: "echo",
        channel_id: "echo-test",
        text: "Reply text",
        message_id: "original-msg-id",
      })) as { messageId: string; channelId: string };

      expect(result.messageId).toMatch(/^echo-msg-/);
      expect(result.channelId).toBe("echo-test");

      // Verify the reply was stored
      const sent = echoAdapter.getSentMessages();
      const found = sent.find((m) => m.id === result.messageId);
      expect(found).toBeDefined();
      expect(found!.text).toBe("Reply text");
    },
    10_000,
  );

  it(
    "message.react dispatches through registry and returns { reacted, emoji } (MSG-03)",
    async () => {
      const result = await dispatchMessage("message.react", {
        channel_type: "echo",
        channel_id: "echo-test",
        message_id: "echo-msg-0",
        emoji: "thumbsup",
      });

      expect(result).toEqual({
        reacted: true,
        channelId: "echo-test",
        messageId: "echo-msg-0",
        emoji: "thumbsup",
      });
    },
    10_000,
  );

  it(
    "message.edit dispatches through registry and returns { edited } (MSG-04)",
    async () => {
      const result = await dispatchMessage("message.edit", {
        channel_type: "echo",
        channel_id: "echo-test",
        message_id: "echo-msg-0",
        text: "Edited text",
      });

      expect(result).toEqual({
        edited: true,
        channelId: "echo-test",
        messageId: "echo-msg-0",
      });
    },
    10_000,
  );

  it(
    "message.delete dispatches through registry and returns { deleted } (MSG-05)",
    async () => {
      const result = await dispatchMessage("message.delete", {
        channel_type: "echo",
        channel_id: "echo-test",
        message_id: "echo-msg-0",
      });

      expect(result).toEqual({
        deleted: true,
        channelId: "echo-test",
        messageId: "echo-msg-0",
      });
    },
    10_000,
  );

  it(
    "message.fetch dispatches through registry and returns { messages } (MSG-06)",
    async () => {
      // Send 3 messages to a dedicated fetch channel
      for (let i = 0; i < 3; i++) {
        await dispatchMessage("message.send", {
          channel_type: "echo",
          channel_id: "fetch-channel",
          text: `Fetch test message ${i}`,
        });
      }

      const result = (await dispatchMessage("message.fetch", {
        channel_type: "echo",
        channel_id: "fetch-channel",
        limit: 10,
      })) as { messages: FetchedMessage[]; channelId: string };

      expect(result.channelId).toBe("fetch-channel");
      expect(Array.isArray(result.messages)).toBe(true);
      expect(result.messages.length).toBe(3);

      // Verify FetchedMessage shape
      for (const msg of result.messages) {
        expect(msg).toHaveProperty("id");
        expect(msg).toHaveProperty("senderId");
        expect(msg).toHaveProperty("text");
        expect(msg).toHaveProperty("timestamp");
      }
    },
    10_000,
  );

  it(
    "message.attach dispatches through registry and returns { messageId } (MSG-07)",
    async () => {
      const result = (await dispatchMessage("message.attach", {
        channel_type: "echo",
        channel_id: "echo-test",
        attachment_type: "image",
        attachment_url: "https://example.com/image.png",
        file_name: "image.png",
        caption: "Test image",
      })) as { messageId: string; channelId: string };

      expect(result.messageId).toMatch(/^echo-msg-/);
      expect(result.channelId).toBe("echo-test");
    },
    10_000,
  );

  it(
    "adapter resolution fails for unknown channel type",
    async () => {
      await expect(
        dispatchMessage("message.send", {
          channel_type: "nonexistent",
          channel_id: "ch1",
          text: "test",
        }),
      ).rejects.toThrow("No adapter found for channel type: nonexistent");
    },
    10_000,
  );
});
