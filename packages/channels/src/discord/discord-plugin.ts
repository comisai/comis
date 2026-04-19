/**
 * Discord Channel Plugin: Plugin wrapper factory for the Discord adapter.
 *
 * Wraps createDiscordAdapter() as a ChannelPluginPort with accurate
 * capability metadata for Discord's platform features and limits.
 *
 * @module
 */

import type { ChannelCapability, ChannelPluginPort, PluginRegistryApi } from "@comis/core";
import { ok, type Result } from "@comis/shared";
import { createDiscordAdapter, type DiscordAdapterDeps } from "./discord-adapter.js";

/** Discord platform capabilities (self-declared, validated at registration). */
const CAPABILITIES: ChannelCapability = {
  chatTypes: ["dm", "group", "thread", "channel", "forum"],
  features: {
    reactions: true,
    editMessages: true,
    deleteMessages: true,
    fetchHistory: true,
    attachments: true,
    threads: true,
    mentions: true,
    formatting: ["markdown"],
    buttons: true,
    cards: true,
    effects: true,
  },
  limits: {
    maxMessageChars: 2000,
    maxAttachmentSizeMb: 25,
  },
  streaming: {
    supported: true,
    throttleMs: 500,
    maxChars: 2000,
    method: "edit",
  },
  threading: {
    supported: true,
    threadType: "native",
    maxDepth: 1,
  },
  replyToMetaKey: "discordMessageId",
};

/**
 * Create a Discord channel plugin wrapping the Discord adapter.
 *
 * The plugin delegates activate() to adapter.start() and deactivate()
 * to adapter.stop(), while declaring accurate platform capabilities.
 */
export function createDiscordPlugin(deps: DiscordAdapterDeps): ChannelPluginPort {
  const adapter = createDiscordAdapter(deps);

  return {
    id: "channel-discord",
    name: "Discord Channel Plugin",
    version: "1.0.0",
    channelType: "discord",
    capabilities: CAPABILITIES,
    adapter,

     
    register(_api: PluginRegistryApi): Result<void, Error> {
      return ok(undefined);
    },

    async activate(): Promise<Result<void, Error>> {
      return adapter.start();
    },

    async deactivate(): Promise<Result<void, Error>> {
      return adapter.stop();
    },
  };
}
