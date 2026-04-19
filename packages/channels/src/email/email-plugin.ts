/**
 * Email Channel Plugin: ChannelPluginPort wrapper for the email adapter.
 *
 * Wraps createEmailAdapter() as a ChannelPluginPort with accurate
 * capability metadata for email's platform features and limits.
 *
 * @module
 */

import type { ChannelCapability, ChannelPluginPort, PluginRegistryApi } from "@comis/core";
import { ok, type Result } from "@comis/shared";
import { createEmailAdapter, type EmailAdapterDeps } from "./email-adapter.js";

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/** Email platform capabilities (self-declared, validated at registration). */
const EMAIL_CAPABILITIES: ChannelCapability = {
  chatTypes: ["dm"],
  features: {
    reactions: false,
    editMessages: false,
    deleteMessages: false,
    fetchHistory: false,
    attachments: true,
    threads: true,
    mentions: false,
    formatting: ["html"],
    buttons: false,
    cards: false,
    effects: false,
  },
  limits: {
    maxMessageChars: 100_000,
  },
  streaming: {
    supported: false,
    throttleMs: 300,
    method: "none",
  },
  threading: {
    supported: true,
    threadType: "reply-chain",
  },
  replyToMetaKey: "emailMessageId",
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an email channel plugin wrapping the email adapter.
 *
 * The plugin delegates activate() to adapter.start() and deactivate()
 * to adapter.stop(), while declaring accurate email capabilities.
 *
 * @param deps - Email adapter configuration and dependencies
 * @returns ChannelPluginPort for the email channel
 */
export function createEmailPlugin(deps: EmailAdapterDeps): ChannelPluginPort {
  const adapter = createEmailAdapter(deps);

  return {
    id: "channel-email",
    name: "Email Channel Plugin",
    version: "1.0.0",
    channelType: "email",
    capabilities: EMAIL_CAPABILITIES,
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
