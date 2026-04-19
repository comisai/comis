/**
 * Signal Channel Plugin: Plugin wrapper factory for the Signal adapter.
 *
 * Wraps createSignalAdapter() as a ChannelPluginPort with accurate
 * capability metadata for Signal's platform features and limits.
 *
 * @module
 */

import type { ChannelCapability, ChannelPluginPort, PluginRegistryApi } from "@comis/core";
import { ok, type Result } from "@comis/shared";
import { createSignalAdapter, type SignalAdapterDeps } from "./signal-adapter.js";

/** Signal platform capabilities (self-declared, validated at registration). */
const CAPABILITIES: ChannelCapability = {
  chatTypes: ["dm", "group"],
  features: {
    reactions: true,
    editMessages: false,
    deleteMessages: true,
    fetchHistory: false,
    attachments: true,
    threads: false,
    mentions: false,
    formatting: ["signal-text-styles"],
    buttons: false,
    cards: false,
    effects: false,
  },
  limits: {
    maxMessageChars: 65536,
    maxAttachmentSizeMb: 100,
  },
  streaming: {
    supported: true,
    throttleMs: 500,
    method: "block",
  },
  threading: {
    supported: false,
    threadType: "none",
  },
  replyToMetaKey: "signalTimestamp",
};

/**
 * Create a Signal channel plugin wrapping the Signal adapter.
 *
 * The plugin delegates activate() to adapter.start() and deactivate()
 * to adapter.stop(), while declaring accurate platform capabilities.
 */
export function createSignalPlugin(deps: SignalAdapterDeps): ChannelPluginPort {
  const adapter = createSignalAdapter(deps);

  return {
    id: "channel-signal",
    name: "Signal Channel Plugin",
    version: "1.0.0",
    channelType: "signal",
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
