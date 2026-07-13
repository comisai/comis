// SPDX-License-Identifier: Apache-2.0
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
  features: {
    reactions: false,
    editMessages: false,
    deleteMessages: false,
    fetchHistory: false,
    attachments: true,
    // Email is DigestOnly — no typing, no threads, no buttons.
    typing: false,
    threads: false,
    buttons: "none",
  },
  limits: {
    maxMessageChars: 100_000,
  },
  replyToMetaKey: "emailMessageId",
  // Email threads via invisible In-Reply-To/References headers, so reply-to must
  // be set even on 1:1 replies (unlike visible-quote channels that skip DM reply-to).
  threadReplyInDm: true,
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
