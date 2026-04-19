/**
 * WhatsApp Channel Plugin: Plugin wrapper factory for the WhatsApp adapter.
 *
 * Wraps createWhatsAppAdapter() as a ChannelPluginPort with accurate
 * capability metadata for WhatsApp's platform features and limits.
 *
 * @module
 */

import type { ChannelCapability, ChannelPluginPort, PluginRegistryApi } from "@comis/core";
import { ok, type Result } from "@comis/shared";
import { createWhatsAppAdapter, type WhatsAppAdapterDeps } from "./whatsapp-adapter.js";

/** WhatsApp platform capabilities (self-declared, validated at registration). */
const CAPABILITIES: ChannelCapability = {
  chatTypes: ["dm", "group"],
  features: {
    reactions: true,
    editMessages: true,
    deleteMessages: true,
    fetchHistory: false,
    attachments: true,
    threads: false,
    mentions: false,
    formatting: [],
    buttons: true,
    cards: false,
    effects: false,
  },
  limits: {
    maxMessageChars: 65536,
    maxAttachmentSizeMb: 100,
  },
  streaming: {
    supported: true,
    throttleMs: 600,
    maxChars: 65536,
    method: "block",
  },
  threading: {
    supported: false,
    threadType: "none",
  },
  replyToMetaKey: "whatsappMessageId",
};

/**
 * Create a WhatsApp channel plugin wrapping the WhatsApp adapter.
 *
 * The plugin delegates activate() to adapter.start() and deactivate()
 * to adapter.stop(), while declaring accurate platform capabilities.
 */
export function createWhatsAppPlugin(deps: WhatsAppAdapterDeps): ChannelPluginPort {
  const adapter = createWhatsAppAdapter(deps);

  return {
    id: "channel-whatsapp",
    name: "WhatsApp Channel Plugin",
    version: "1.0.0",
    channelType: "whatsapp",
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
