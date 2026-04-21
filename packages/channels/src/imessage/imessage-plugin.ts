// SPDX-License-Identifier: Apache-2.0
/**
 * iMessage Channel Plugin: Plugin wrapper factory for the iMessage adapter.
 *
 * Wraps createIMessageAdapter() as a ChannelPluginPort with accurate
 * capability metadata for iMessage's platform features and limits.
 *
 * iMessage is a macOS-only plain-text platform with limited API support
 * via the imsg CLI. No edit, no reactions, no threading, no streaming.
 *
 * @module
 */

import type { ChannelCapability, ChannelPluginPort, PluginRegistryApi } from "@comis/core";
import { ok, type Result } from "@comis/shared";
import { createIMessageAdapter, type IMessageAdapterDeps } from "./imessage-adapter.js";

/** iMessage platform capabilities (self-declared, validated at registration). */
const CAPABILITIES: ChannelCapability = {
  chatTypes: ["dm", "group"],
  features: {
    reactions: false,
    editMessages: false,
    deleteMessages: false,
    fetchHistory: true,
    attachments: true,
    threads: false,
    mentions: false,
    formatting: [],
    buttons: false,
    cards: false,
    effects: false,
  },
  limits: {
    maxMessageChars: 20000,
    maxAttachmentSizeMb: 16,
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
  replyToMetaKey: "imsgMessageId",
};

/**
 * Create an iMessage channel plugin wrapping the iMessage adapter.
 *
 * The plugin delegates activate() to adapter.start() and deactivate()
 * to adapter.stop(), while declaring accurate platform capabilities.
 */
export function createIMessagePlugin(deps: IMessageAdapterDeps): ChannelPluginPort {
  const adapter = createIMessageAdapter(deps);

  return {
    id: "channel-imessage",
    name: "iMessage Channel Plugin",
    version: "1.0.0",
    channelType: "imessage",
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
