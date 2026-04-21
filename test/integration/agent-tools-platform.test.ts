// SPDX-License-Identifier: Apache-2.0
/**
 * TOOLS: Comprehensive Agent Tools Platform Integration Tests
 *
 * Validates all platform tool categories for autonomous agent operations through
 * the daemon's internal rpcCall — the same dispatch path used by platform tools
 * when invoked by the agent executor.
 *
 * Coverage matrix:
 *
 * SESSION TOOLS (no LLM keys needed):
 *   TOOLS-01: agents.list returns all configured agent IDs
 *   TOOLS-02: session.status returns model, cost, and step info
 *   TOOLS-03: session.list returns empty session list initially
 *   TOOLS-04: session.list filtering by kind (dm, group, sub-agent)
 *
 * PLATFORM ACTIONS (via EchoChannelAdapter, no LLM keys needed):
 *   TOOLS-10: discord.action dispatches through adapter and returns echoed result
 *   TOOLS-11: discord.action pin/unpin/guild_info/channel_info/set_topic/set_slowmode
 *   TOOLS-12: telegram.action dispatches through adapter (chat_info, member_count, pin)
 *   TOOLS-13: slack.action dispatches through adapter (channel_info, set_topic, pin)
 *   TOOLS-14: whatsapp.action dispatches through adapter (group_info, group_invite_code)
 *   TOOLS-15: platform action rejects unknown channel type
 *   TOOLS-16: platform action rejects unknown action (via adapter echo)
 *
 * CROSS-CUTTING:
 *   TOOLS-20: rpcCall rejects unknown method names
 *   TOOLS-21: session.run_status rejects unknown run ID
 *
 * Uses a dedicated config (port 8493, separate memory DB) to avoid conflicts.
 * Accesses daemon internals directly: rpcCall, adapterRegistry.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startTestDaemon,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import { EchoChannelAdapter } from "@comis/channels";
import type { ChannelPort } from "@comis/core";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const AGENT_TOOLS_CONFIG_PATH = resolve(
  __dirname,
  "../config/config.test-agent-tools.yaml",
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Type alias for the daemon's internal rpcCall function. */
type RpcCall = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("TOOLS: Comprehensive Agent Tools Platform Integration", () => {
  let handle: TestDaemonHandle;
  let rpcCall: RpcCall;
  let registry: Map<string, ChannelPort>;

  // Echo adapters for each platform
  let discordAdapter: EchoChannelAdapter;
  let telegramAdapter: EchoChannelAdapter;
  let slackAdapter: EchoChannelAdapter;
  let whatsappAdapter: EchoChannelAdapter;

  beforeAll(async () => {
    // Start daemon with agent-tools config
    handle = await startTestDaemon({ configPath: AGENT_TOOLS_CONFIG_PATH });

    // Access internal rpcCall from daemon instance
    rpcCall = (handle.daemon as any).rpcCall as RpcCall;

    // Access adapter registry (same Map that rpcCall's resolveAdapter reads from)
    registry = (handle.daemon as any).adapterRegistry as Map<
      string,
      ChannelPort
    >;

    // Register echo adapters for each platform type
    discordAdapter = new EchoChannelAdapter({
      channelId: "discord-test",
      channelType: "discord",
    });
    telegramAdapter = new EchoChannelAdapter({
      channelId: "telegram-test",
      channelType: "telegram",
    });
    slackAdapter = new EchoChannelAdapter({
      channelId: "slack-test",
      channelType: "slack",
    });
    whatsappAdapter = new EchoChannelAdapter({
      channelId: "whatsapp-test",
      channelType: "whatsapp",
    });

    registry.set("discord", discordAdapter);
    registry.set("telegram", telegramAdapter);
    registry.set("slack", slackAdapter);
    registry.set("whatsapp", whatsappAdapter);
  }, 120_000);

  afterAll(async () => {
    // Remove test adapters from registry
    registry?.delete("discord");
    registry?.delete("telegram");
    registry?.delete("slack");
    registry?.delete("whatsapp");

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

  // =========================================================================
  // Section 1: Session & Agent Information Tools
  // =========================================================================

  describe("Session & Agent Information Tools", () => {
    // -----------------------------------------------------------------------
    // TOOLS-01: agents.list
    // -----------------------------------------------------------------------

    it(
      "TOOLS-01: agents.list returns all configured agent IDs",
      async () => {
        const result = (await rpcCall("agents.list", {})) as {
          agents: string[];
        };

        expect(result).toBeDefined();
        expect(Array.isArray(result.agents)).toBe(true);
        expect(result.agents).toContain("default");
        expect(result.agents).toContain("helper");
        expect(result.agents.length).toBe(2);
      },
      10_000,
    );

    // -----------------------------------------------------------------------
    // TOOLS-02: session.status
    // -----------------------------------------------------------------------

    it(
      "TOOLS-02: session.status returns model, cost tracking, and step info",
      async () => {
        const result = (await rpcCall("session.status", {})) as {
          model: string;
          agentName: string;
          tokensUsed: { totalTokens: number; totalCost: number };
          stepsExecuted: number;
          maxSteps: number;
        };

        expect(result).toBeDefined();
        expect(typeof result.model).toBe("string");
        expect(result.model).toBe("claude-opus-4-6");
        expect(typeof result.agentName).toBe("string");
        expect(result.agentName).toBe("TestAgent");
        expect(typeof result.tokensUsed).toBe("object");
        expect(typeof result.tokensUsed.totalTokens).toBe("number");
        expect(typeof result.tokensUsed.totalCost).toBe("number");
        expect(typeof result.stepsExecuted).toBe("number");
        expect(result.stepsExecuted).toBeGreaterThanOrEqual(0);
        expect(typeof result.maxSteps).toBe("number");
        expect(result.maxSteps).toBe(10);
      },
      10_000,
    );

    it(
      "TOOLS-02b: session.status for specific agent returns that agent's config",
      async () => {
        const result = (await rpcCall("session.status", {
          _agentId: "helper",
        })) as {
          model: string;
          agentName: string;
          maxSteps: number;
        };

        expect(result.agentName).toBe("HelperAgent");
        expect(result.maxSteps).toBe(5);
      },
      10_000,
    );

    // -----------------------------------------------------------------------
    // TOOLS-03: session.list (empty)
    // -----------------------------------------------------------------------

    it(
      "TOOLS-03: session.list returns session list with total count",
      async () => {
        const result = (await rpcCall("session.list", {})) as {
          sessions: Array<{
            sessionKey: string;
            userId: string;
            channelId: string;
            kind: string;
            updatedAt: number;
            createdAt: number;
          }>;
          total: number;
        };

        expect(result).toBeDefined();
        expect(Array.isArray(result.sessions)).toBe(true);
        expect(typeof result.total).toBe("number");
        expect(result.total).toBe(result.sessions.length);

        // Verify session shape if any exist
        for (const session of result.sessions) {
          expect(typeof session.sessionKey).toBe("string");
          expect(typeof session.userId).toBe("string");
          expect(typeof session.channelId).toBe("string");
          expect(["dm", "group", "sub-agent"]).toContain(session.kind);
          expect(typeof session.updatedAt).toBe("number");
          expect(typeof session.createdAt).toBe("number");
        }
      },
      10_000,
    );

    // -----------------------------------------------------------------------
    // TOOLS-04: session.list with kind filter
    // -----------------------------------------------------------------------

    it(
      "TOOLS-04: session.list accepts kind filter without error",
      async () => {
        // dm filter
        const dmResult = (await rpcCall("session.list", {
          kind: "dm",
        })) as { sessions: unknown[]; total: number };
        expect(Array.isArray(dmResult.sessions)).toBe(true);
        expect(typeof dmResult.total).toBe("number");

        // group filter
        const groupResult = (await rpcCall("session.list", {
          kind: "group",
        })) as { sessions: unknown[]; total: number };
        expect(Array.isArray(groupResult.sessions)).toBe(true);

        // sub-agent filter
        const subAgentResult = (await rpcCall("session.list", {
          kind: "sub-agent",
        })) as { sessions: unknown[]; total: number };
        expect(Array.isArray(subAgentResult.sessions)).toBe(true);
      },
      10_000,
    );

    it(
      "TOOLS-04b: session.list accepts since_minutes recency filter",
      async () => {
        const result = (await rpcCall("session.list", {
          since_minutes: 5,
        })) as { sessions: unknown[]; total: number };

        expect(Array.isArray(result.sessions)).toBe(true);
        expect(typeof result.total).toBe("number");
      },
      10_000,
    );

    // -----------------------------------------------------------------------
    // TOOLS-21: session.run_status rejects unknown run ID
    // -----------------------------------------------------------------------

    it(
      "TOOLS-21: session.run_status rejects unknown run ID",
      async () => {
        await expect(
          rpcCall("session.run_status", { run_id: "nonexistent-run-id" }),
        ).rejects.toThrow(/Unknown run ID/);
      },
      10_000,
    );
  });

  // =========================================================================
  // Section 2: Platform Actions — Discord
  // =========================================================================

  describe("TOOLS-10/11: Discord Platform Actions", () => {
    it(
      "discord.action pin dispatches through adapter",
      async () => {
        const result = (await rpcCall("discord.action", {
          action: "pin",
          channel_id: "discord-channel-1",
          message_id: "msg-123",
          _trustLevel: "admin",
        })) as { action: string; params: Record<string, unknown>; echoed: boolean };

        expect(result.echoed).toBe(true);
        expect(result.action).toBe("pin");
        expect(result.params.channel_id).toBe("discord-channel-1");
        expect(result.params.message_id).toBe("msg-123");
      },
      10_000,
    );

    it(
      "discord.action unpin dispatches through adapter",
      async () => {
        const result = (await rpcCall("discord.action", {
          action: "unpin",
          channel_id: "discord-channel-1",
          message_id: "msg-456",
          _trustLevel: "admin",
        })) as { action: string; echoed: boolean };

        expect(result.echoed).toBe(true);
        expect(result.action).toBe("unpin");
      },
      10_000,
    );

    it(
      "discord.action guild_info dispatches through adapter",
      async () => {
        const result = (await rpcCall("discord.action", {
          action: "guild_info",
          guild_id: "guild-789",
          _trustLevel: "admin",
        })) as { action: string; params: Record<string, unknown>; echoed: boolean };

        expect(result.echoed).toBe(true);
        expect(result.action).toBe("guild_info");
        expect(result.params.guild_id).toBe("guild-789");
      },
      10_000,
    );

    it(
      "discord.action channel_info dispatches through adapter",
      async () => {
        const result = (await rpcCall("discord.action", {
          action: "channel_info",
          channel_id: "discord-channel-2",
          _trustLevel: "admin",
        })) as { action: string; echoed: boolean };

        expect(result.echoed).toBe(true);
        expect(result.action).toBe("channel_info");
      },
      10_000,
    );

    it(
      "discord.action set_topic dispatches through adapter",
      async () => {
        const result = (await rpcCall("discord.action", {
          action: "set_topic",
          channel_id: "discord-channel-1",
          topic: "New channel topic",
          _trustLevel: "admin",
        })) as { action: string; params: Record<string, unknown>; echoed: boolean };

        expect(result.echoed).toBe(true);
        expect(result.action).toBe("set_topic");
        expect(result.params.topic).toBe("New channel topic");
      },
      10_000,
    );

    it(
      "discord.action set_slowmode dispatches through adapter",
      async () => {
        const result = (await rpcCall("discord.action", {
          action: "set_slowmode",
          channel_id: "discord-channel-1",
          seconds: 30,
          _trustLevel: "admin",
        })) as { action: string; params: Record<string, unknown>; echoed: boolean };

        expect(result.echoed).toBe(true);
        expect(result.action).toBe("set_slowmode");
        expect(result.params.seconds).toBe(30);
      },
      10_000,
    );

    it(
      "discord.action kick dispatches destructive action through adapter",
      async () => {
        const result = (await rpcCall("discord.action", {
          action: "kick",
          guild_id: "guild-789",
          user_id: "user-001",
          reason: "Test kick",
          _trustLevel: "admin",
        })) as { action: string; params: Record<string, unknown>; echoed: boolean };

        expect(result.echoed).toBe(true);
        expect(result.action).toBe("kick");
        expect(result.params.user_id).toBe("user-001");
      },
      10_000,
    );

    it(
      "discord.action ban dispatches destructive action through adapter",
      async () => {
        const result = (await rpcCall("discord.action", {
          action: "ban",
          guild_id: "guild-789",
          user_id: "user-002",
          reason: "Test ban",
          delete_message_days: 1,
          _trustLevel: "admin",
        })) as { action: string; params: Record<string, unknown>; echoed: boolean };

        expect(result.echoed).toBe(true);
        expect(result.action).toBe("ban");
        expect(result.params.user_id).toBe("user-002");
      },
      10_000,
    );

    it(
      "discord.action role_add dispatches through adapter",
      async () => {
        const result = (await rpcCall("discord.action", {
          action: "role_add",
          guild_id: "guild-789",
          user_id: "user-001",
          role_id: "role-moderator",
          _trustLevel: "admin",
        })) as { action: string; params: Record<string, unknown>; echoed: boolean };

        expect(result.echoed).toBe(true);
        expect(result.action).toBe("role_add");
        expect(result.params.role_id).toBe("role-moderator");
      },
      10_000,
    );

    it(
      "discord.action role_remove dispatches through adapter",
      async () => {
        const result = (await rpcCall("discord.action", {
          action: "role_remove",
          guild_id: "guild-789",
          user_id: "user-001",
          role_id: "role-moderator",
          _trustLevel: "admin",
        })) as { action: string; echoed: boolean };

        expect(result.echoed).toBe(true);
        expect(result.action).toBe("role_remove");
      },
      10_000,
    );

    it(
      "discord.action unban dispatches through adapter",
      async () => {
        const result = (await rpcCall("discord.action", {
          action: "unban",
          guild_id: "guild-789",
          user_id: "user-002",
          _trustLevel: "admin",
        })) as { action: string; echoed: boolean };

        expect(result.echoed).toBe(true);
        expect(result.action).toBe("unban");
      },
      10_000,
    );
  });

  // =========================================================================
  // Section 3: Platform Actions — Telegram
  // =========================================================================

  describe("TOOLS-12: Telegram Platform Actions", () => {
    it(
      "telegram.action chat_info dispatches through adapter",
      async () => {
        const result = (await rpcCall("telegram.action", {
          action: "chat_info",
          chat_id: "tg-chat-001",
          _trustLevel: "admin",
        })) as { action: string; params: Record<string, unknown>; echoed: boolean };

        expect(result.echoed).toBe(true);
        expect(result.action).toBe("chat_info");
        expect(result.params.chat_id).toBe("tg-chat-001");
      },
      10_000,
    );

    it(
      "telegram.action member_count dispatches through adapter",
      async () => {
        const result = (await rpcCall("telegram.action", {
          action: "member_count",
          chat_id: "tg-chat-001",
          _trustLevel: "admin",
        })) as { action: string; echoed: boolean };

        expect(result.echoed).toBe(true);
        expect(result.action).toBe("member_count");
      },
      10_000,
    );

    it(
      "telegram.action pin dispatches through adapter",
      async () => {
        const result = (await rpcCall("telegram.action", {
          action: "pin",
          chat_id: "tg-chat-001",
          message_id: "tg-msg-100",
          _trustLevel: "admin",
        })) as { action: string; params: Record<string, unknown>; echoed: boolean };

        expect(result.echoed).toBe(true);
        expect(result.action).toBe("pin");
        expect(result.params.message_id).toBe("tg-msg-100");
      },
      10_000,
    );

    it(
      "telegram.action unpin dispatches through adapter",
      async () => {
        const result = (await rpcCall("telegram.action", {
          action: "unpin",
          chat_id: "tg-chat-001",
          message_id: "tg-msg-100",
          _trustLevel: "admin",
        })) as { action: string; echoed: boolean };

        expect(result.echoed).toBe(true);
        expect(result.action).toBe("unpin");
      },
      10_000,
    );

    it(
      "telegram.action get_admins dispatches through adapter",
      async () => {
        const result = (await rpcCall("telegram.action", {
          action: "get_admins",
          chat_id: "tg-chat-001",
          _trustLevel: "admin",
        })) as { action: string; echoed: boolean };

        expect(result.echoed).toBe(true);
        expect(result.action).toBe("get_admins");
      },
      10_000,
    );

    it(
      "telegram.action set_title dispatches through adapter",
      async () => {
        const result = (await rpcCall("telegram.action", {
          action: "set_title",
          chat_id: "tg-chat-001",
          title: "New Chat Title",
          _trustLevel: "admin",
        })) as { action: string; params: Record<string, unknown>; echoed: boolean };

        expect(result.echoed).toBe(true);
        expect(result.action).toBe("set_title");
        expect(result.params.title).toBe("New Chat Title");
      },
      10_000,
    );

    it(
      "telegram.action set_description dispatches through adapter",
      async () => {
        const result = (await rpcCall("telegram.action", {
          action: "set_description",
          chat_id: "tg-chat-001",
          description: "Updated description",
          _trustLevel: "admin",
        })) as { action: string; echoed: boolean };

        expect(result.echoed).toBe(true);
        expect(result.action).toBe("set_description");
      },
      10_000,
    );

    it(
      "telegram.action ban dispatches destructive action through adapter",
      async () => {
        const result = (await rpcCall("telegram.action", {
          action: "ban",
          chat_id: "tg-chat-001",
          user_id: "tg-user-99",
          _trustLevel: "admin",
        })) as { action: string; params: Record<string, unknown>; echoed: boolean };

        expect(result.echoed).toBe(true);
        expect(result.action).toBe("ban");
        expect(result.params.user_id).toBe("tg-user-99");
      },
      10_000,
    );

    it(
      "telegram.action unban dispatches through adapter",
      async () => {
        const result = (await rpcCall("telegram.action", {
          action: "unban",
          chat_id: "tg-chat-001",
          user_id: "tg-user-99",
          _trustLevel: "admin",
        })) as { action: string; echoed: boolean };

        expect(result.echoed).toBe(true);
        expect(result.action).toBe("unban");
      },
      10_000,
    );

    it(
      "telegram.action poll dispatches through adapter",
      async () => {
        const result = (await rpcCall("telegram.action", {
          action: "poll",
          chat_id: "tg-chat-001",
          question: "Favorite color?",
          options: ["Red", "Blue", "Green"],
          _trustLevel: "admin",
        })) as { action: string; params: Record<string, unknown>; echoed: boolean };

        expect(result.echoed).toBe(true);
        expect(result.action).toBe("poll");
        expect(result.params.question).toBe("Favorite color?");
        expect(result.params.options).toEqual(["Red", "Blue", "Green"]);
      },
      10_000,
    );

    it(
      "telegram.action sticker dispatches through adapter",
      async () => {
        const result = (await rpcCall("telegram.action", {
          action: "sticker",
          chat_id: "tg-chat-001",
          sticker_id: "sticker-abc",
          _trustLevel: "admin",
        })) as { action: string; echoed: boolean };

        expect(result.echoed).toBe(true);
        expect(result.action).toBe("sticker");
      },
      10_000,
    );

    it(
      "telegram.action promote dispatches destructive action through adapter",
      async () => {
        const result = (await rpcCall("telegram.action", {
          action: "promote",
          chat_id: "tg-chat-001",
          user_id: "tg-user-50",
          _trustLevel: "admin",
        })) as { action: string; echoed: boolean };

        expect(result.echoed).toBe(true);
        expect(result.action).toBe("promote");
      },
      10_000,
    );
  });

  // =========================================================================
  // Section 4: Platform Actions — Slack
  // =========================================================================

  describe("TOOLS-13: Slack Platform Actions", () => {
    it(
      "slack.action channel_info dispatches through adapter",
      async () => {
        const result = (await rpcCall("slack.action", {
          action: "channel_info",
          channel_id: "C12345678",
          _trustLevel: "admin",
        })) as { action: string; params: Record<string, unknown>; echoed: boolean };

        expect(result.echoed).toBe(true);
        expect(result.action).toBe("channel_info");
        expect(result.params.channel_id).toBe("C12345678");
      },
      10_000,
    );

    it(
      "slack.action set_topic dispatches through adapter",
      async () => {
        const result = (await rpcCall("slack.action", {
          action: "set_topic",
          channel_id: "C12345678",
          topic: "New Slack topic",
          _trustLevel: "admin",
        })) as { action: string; params: Record<string, unknown>; echoed: boolean };

        expect(result.echoed).toBe(true);
        expect(result.action).toBe("set_topic");
        expect(result.params.topic).toBe("New Slack topic");
      },
      10_000,
    );

    it(
      "slack.action set_purpose dispatches through adapter",
      async () => {
        const result = (await rpcCall("slack.action", {
          action: "set_purpose",
          channel_id: "C12345678",
          purpose: "Channel purpose text",
          _trustLevel: "admin",
        })) as { action: string; echoed: boolean };

        expect(result.echoed).toBe(true);
        expect(result.action).toBe("set_purpose");
      },
      10_000,
    );

    it(
      "slack.action pin dispatches through adapter",
      async () => {
        const result = (await rpcCall("slack.action", {
          action: "pin",
          channel_id: "C12345678",
          message_id: "1234567890.123456",
          _trustLevel: "admin",
        })) as { action: string; echoed: boolean };

        expect(result.echoed).toBe(true);
        expect(result.action).toBe("pin");
      },
      10_000,
    );

    it(
      "slack.action unpin dispatches through adapter",
      async () => {
        const result = (await rpcCall("slack.action", {
          action: "unpin",
          channel_id: "C12345678",
          message_id: "1234567890.123456",
          _trustLevel: "admin",
        })) as { action: string; echoed: boolean };

        expect(result.echoed).toBe(true);
        expect(result.action).toBe("unpin");
      },
      10_000,
    );

    it(
      "slack.action members_list dispatches through adapter",
      async () => {
        const result = (await rpcCall("slack.action", {
          action: "members_list",
          channel_id: "C12345678",
          limit: 50,
          _trustLevel: "admin",
        })) as { action: string; params: Record<string, unknown>; echoed: boolean };

        expect(result.echoed).toBe(true);
        expect(result.action).toBe("members_list");
        expect(result.params.limit).toBe(50);
      },
      10_000,
    );

    it(
      "slack.action invite dispatches through adapter",
      async () => {
        const result = (await rpcCall("slack.action", {
          action: "invite",
          channel_id: "C12345678",
          user_ids: ["U001", "U002"],
          _trustLevel: "admin",
        })) as { action: string; params: Record<string, unknown>; echoed: boolean };

        expect(result.echoed).toBe(true);
        expect(result.action).toBe("invite");
        expect(result.params.user_ids).toEqual(["U001", "U002"]);
      },
      10_000,
    );

    it(
      "slack.action kick dispatches destructive action through adapter",
      async () => {
        const result = (await rpcCall("slack.action", {
          action: "kick",
          channel_id: "C12345678",
          user_id: "U003",
          _trustLevel: "admin",
        })) as { action: string; echoed: boolean };

        expect(result.echoed).toBe(true);
        expect(result.action).toBe("kick");
      },
      10_000,
    );

    it(
      "slack.action archive dispatches destructive action through adapter",
      async () => {
        const result = (await rpcCall("slack.action", {
          action: "archive",
          channel_id: "C12345678",
          _trustLevel: "admin",
        })) as { action: string; echoed: boolean };

        expect(result.echoed).toBe(true);
        expect(result.action).toBe("archive");
      },
      10_000,
    );

    it(
      "slack.action unarchive dispatches through adapter",
      async () => {
        const result = (await rpcCall("slack.action", {
          action: "unarchive",
          channel_id: "C12345678",
          _trustLevel: "admin",
        })) as { action: string; echoed: boolean };

        expect(result.echoed).toBe(true);
        expect(result.action).toBe("unarchive");
      },
      10_000,
    );

    it(
      "slack.action create_channel dispatches destructive action through adapter",
      async () => {
        const result = (await rpcCall("slack.action", {
          action: "create_channel",
          name: "new-test-channel",
          is_private: false,
          _trustLevel: "admin",
        })) as { action: string; params: Record<string, unknown>; echoed: boolean };

        expect(result.echoed).toBe(true);
        expect(result.action).toBe("create_channel");
        expect(result.params.name).toBe("new-test-channel");
      },
      10_000,
    );

    it(
      "slack.action bookmark_add dispatches through adapter",
      async () => {
        const result = (await rpcCall("slack.action", {
          action: "bookmark_add",
          channel_id: "C12345678",
          title: "Important Doc",
          link: "https://example.com/doc",
          _trustLevel: "admin",
        })) as { action: string; params: Record<string, unknown>; echoed: boolean };

        expect(result.echoed).toBe(true);
        expect(result.action).toBe("bookmark_add");
        expect(result.params.title).toBe("Important Doc");
      },
      10_000,
    );
  });

  // =========================================================================
  // Section 5: Platform Actions — WhatsApp
  // =========================================================================

  describe("TOOLS-14: WhatsApp Platform Actions", () => {
    it(
      "whatsapp.action group_info dispatches through adapter",
      async () => {
        const result = (await rpcCall("whatsapp.action", {
          action: "group_info",
          group_jid: "12345@g.us",
          _trustLevel: "admin",
        })) as { action: string; params: Record<string, unknown>; echoed: boolean };

        expect(result.echoed).toBe(true);
        expect(result.action).toBe("group_info");
        expect(result.params.group_jid).toBe("12345@g.us");
      },
      10_000,
    );

    it(
      "whatsapp.action group_invite_code dispatches through adapter",
      async () => {
        const result = (await rpcCall("whatsapp.action", {
          action: "group_invite_code",
          group_jid: "12345@g.us",
          _trustLevel: "admin",
        })) as { action: string; echoed: boolean };

        expect(result.echoed).toBe(true);
        expect(result.action).toBe("group_invite_code");
      },
      10_000,
    );

    it(
      "whatsapp.action group_update_subject dispatches through adapter",
      async () => {
        const result = (await rpcCall("whatsapp.action", {
          action: "group_update_subject",
          group_jid: "12345@g.us",
          subject: "New Group Name",
          _trustLevel: "admin",
        })) as { action: string; params: Record<string, unknown>; echoed: boolean };

        expect(result.echoed).toBe(true);
        expect(result.action).toBe("group_update_subject");
        expect(result.params.subject).toBe("New Group Name");
      },
      10_000,
    );

    it(
      "whatsapp.action group_update_description dispatches through adapter",
      async () => {
        const result = (await rpcCall("whatsapp.action", {
          action: "group_update_description",
          group_jid: "12345@g.us",
          description: "Updated group description",
          _trustLevel: "admin",
        })) as { action: string; echoed: boolean };

        expect(result.echoed).toBe(true);
        expect(result.action).toBe("group_update_description");
      },
      10_000,
    );

    it(
      "whatsapp.action group_participants_add dispatches through adapter",
      async () => {
        const result = (await rpcCall("whatsapp.action", {
          action: "group_participants_add",
          group_jid: "12345@g.us",
          participant_jids: ["1111@s.whatsapp.net", "2222@s.whatsapp.net"],
          _trustLevel: "admin",
        })) as { action: string; params: Record<string, unknown>; echoed: boolean };

        expect(result.echoed).toBe(true);
        expect(result.action).toBe("group_participants_add");
        expect(result.params.participant_jids).toEqual([
          "1111@s.whatsapp.net",
          "2222@s.whatsapp.net",
        ]);
      },
      10_000,
    );

    it(
      "whatsapp.action group_participants_remove dispatches destructive action through adapter",
      async () => {
        const result = (await rpcCall("whatsapp.action", {
          action: "group_participants_remove",
          group_jid: "12345@g.us",
          participant_jids: ["3333@s.whatsapp.net"],
          _trustLevel: "admin",
        })) as { action: string; echoed: boolean };

        expect(result.echoed).toBe(true);
        expect(result.action).toBe("group_participants_remove");
      },
      10_000,
    );

    it(
      "whatsapp.action group_promote dispatches destructive action through adapter",
      async () => {
        const result = (await rpcCall("whatsapp.action", {
          action: "group_promote",
          group_jid: "12345@g.us",
          participant_jids: ["1111@s.whatsapp.net"],
          _trustLevel: "admin",
        })) as { action: string; echoed: boolean };

        expect(result.echoed).toBe(true);
        expect(result.action).toBe("group_promote");
      },
      10_000,
    );

    it(
      "whatsapp.action group_demote dispatches through adapter",
      async () => {
        const result = (await rpcCall("whatsapp.action", {
          action: "group_demote",
          group_jid: "12345@g.us",
          participant_jids: ["1111@s.whatsapp.net"],
          _trustLevel: "admin",
        })) as { action: string; echoed: boolean };

        expect(result.echoed).toBe(true);
        expect(result.action).toBe("group_demote");
      },
      10_000,
    );

    it(
      "whatsapp.action group_settings dispatches through adapter",
      async () => {
        const result = (await rpcCall("whatsapp.action", {
          action: "group_settings",
          group_jid: "12345@g.us",
          setting: "announcement",
          _trustLevel: "admin",
        })) as { action: string; params: Record<string, unknown>; echoed: boolean };

        expect(result.echoed).toBe(true);
        expect(result.action).toBe("group_settings");
        expect(result.params.setting).toBe("announcement");
      },
      10_000,
    );

    it(
      "whatsapp.action profile_status dispatches through adapter",
      async () => {
        const result = (await rpcCall("whatsapp.action", {
          action: "profile_status",
          status_text: "Available",
          _trustLevel: "admin",
        })) as { action: string; echoed: boolean };

        expect(result.echoed).toBe(true);
        expect(result.action).toBe("profile_status");
      },
      10_000,
    );

    it(
      "whatsapp.action group_leave dispatches destructive action through adapter",
      async () => {
        const result = (await rpcCall("whatsapp.action", {
          action: "group_leave",
          group_jid: "12345@g.us",
          _trustLevel: "admin",
        })) as { action: string; echoed: boolean };

        expect(result.echoed).toBe(true);
        expect(result.action).toBe("group_leave");
      },
      10_000,
    );
  });

  // =========================================================================
  // Section 6: Platform Action Error Handling
  // =========================================================================

  describe("TOOLS-15/16: Platform Action Error Handling", () => {
    it(
      "TOOLS-15: platform action rejects unregistered channel type",
      async () => {
        // Remove any existing "matrix" adapter to ensure it's not found
        registry.delete("matrix");

        await expect(
          rpcCall("discord.action", {
            action: "pin",
            channel_id: "ch-1",
            message_id: "msg-1",
            _trustLevel: "admin",
          }),
        ).resolves.toBeDefined(); // discord IS registered

        // Try a platform that has no adapter registered
        // We can't call a non-existent method, but we can test by
        // temporarily removing an adapter
        registry.delete("discord");
        try {
          await expect(
            rpcCall("discord.action", {
              action: "pin",
              channel_id: "ch-1",
              message_id: "msg-1",
              _trustLevel: "admin",
            }),
          ).rejects.toThrow(/No adapter found/);
        } finally {
          // Re-register for remaining tests
          registry.set("discord", discordAdapter);
        }
      },
      10_000,
    );

    it(
      "TOOLS-16: all platform action echo adapters pass through unknown actions",
      async () => {
        // The echo adapter echoes any action, verifying the dispatch path works
        // even for arbitrary action names (real adapters would reject unsupported ones)
        const result = (await rpcCall("discord.action", {
          action: "some_custom_action",
          custom_param: "custom_value",
          _trustLevel: "admin",
        })) as { action: string; params: Record<string, unknown>; echoed: boolean };

        expect(result.echoed).toBe(true);
        expect(result.action).toBe("some_custom_action");
        expect(result.params.custom_param).toBe("custom_value");
      },
      10_000,
    );
  });

  // =========================================================================
  // Section 7: Cross-Cutting Validation
  // =========================================================================

  describe("TOOLS-20: Cross-Cutting Validation", () => {
    it(
      "TOOLS-20: rpcCall rejects unknown method names",
      async () => {
        await expect(
          rpcCall("nonexistent.method", {}),
        ).rejects.toThrow();
      },
      10_000,
    );

    it(
      "all four platform adapters are registered and resolvable",
      async () => {
        expect(registry.get("discord")).toBe(discordAdapter);
        expect(registry.get("telegram")).toBe(telegramAdapter);
        expect(registry.get("slack")).toBe(slackAdapter);
        expect(registry.get("whatsapp")).toBe(whatsappAdapter);
        expect(registry.size).toBeGreaterThanOrEqual(4);
      },
      10_000,
    );

    it(
      "message operations work through each registered platform adapter",
      async () => {
        // Verify the message dispatch path works for all registered adapter types
        for (const channelType of ["discord", "telegram", "slack", "whatsapp"]) {
          const adapter = registry.get(channelType)!;
          const sendResult = await adapter.sendMessage(
            `${channelType}-channel`,
            `Test message on ${channelType}`,
          );
          expect(sendResult.ok).toBe(true);
          expect(typeof sendResult.value).toBe("string");
          expect(sendResult.value).toMatch(/^echo-msg-/);
        }
      },
      10_000,
    );
  });
});
