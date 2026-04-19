/**
 * IRC Channel Plugin: Plugin wrapper factory for the IRC adapter.
 *
 * Wraps createIrcAdapter() as a ChannelPluginPort with accurate
 * capability metadata for IRC's platform features and limits.
 *
 * IRC is the simplest adapter: text-only, no attachments, no editing,
 * no reactions, no streaming, no history. It supports DMs and channels,
 * mentions (nick highlighting), and IRC control code formatting.
 *
 * @module
 */

import type { ChannelCapability, ChannelPluginPort, PluginRegistryApi } from "@comis/core";
import { ok, type Result } from "@comis/shared";
import { createIrcAdapter, type IrcAdapterDeps } from "./irc-adapter.js";

/** IRC platform capabilities (self-declared, validated at registration). */
const CAPABILITIES: ChannelCapability = {
  chatTypes: ["dm", "channel"],
  features: {
    reactions: false,
    editMessages: false,
    deleteMessages: false,
    fetchHistory: false,
    attachments: false,
    threads: false,
    mentions: true,
    formatting: ["irc-control-codes"],
    buttons: false,
    cards: false,
    effects: false,
  },
  limits: {
    maxMessageChars: 512,
  },
  streaming: {
    supported: false,
    throttleMs: 300,
    method: "none",
  },
  threading: {
    supported: false,
    threadType: "none",
  },
  replyToMetaKey: "ircMessageId",
};

/**
 * Create an IRC channel plugin wrapping the IRC adapter.
 *
 * The plugin delegates activate() to adapter.start() and deactivate()
 * to adapter.stop(), while declaring accurate platform capabilities.
 */
export function createIrcPlugin(deps: IrcAdapterDeps): ChannelPluginPort {
  const adapter = createIrcAdapter(deps);

  return {
    id: "channel-irc",
    name: "IRC Channel Plugin",
    version: "1.0.0",
    channelType: "irc",
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
