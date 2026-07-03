// SPDX-License-Identifier: Apache-2.0
/**
 * Slack Channel Plugin: Plugin wrapper factory for the Slack adapter.
 *
 * Wraps createSlackAdapter() as a ChannelPluginPort with accurate
 * capability metadata for Slack's platform features and limits.
 *
 * @module
 */

import type { ChannelCapability, ChannelPluginPort, PluginRegistryApi } from "@comis/core";
import { ok, type Result } from "@comis/shared";
import { createSlackAdapter, type SlackAdapterDeps } from "./slack-adapter.js";

/** Slack platform capabilities (self-declared, validated at registration). */
const CAPABILITIES: ChannelCapability = {
  features: {
    reactions: true,
    editMessages: true,
    deleteMessages: true,
    fetchHistory: true,
    attachments: true,
    // Slack EditPlace + Block Kit — threads + Block Kit buttons, no typing.
    typing: false,
    threads: true,
    buttons: "blockkit",
  },
  limits: {
    maxMessageChars: 4000,
  },
  replyToMetaKey: "slackTs",
};

/**
 * Create a Slack channel plugin wrapping the Slack adapter.
 *
 * The plugin delegates activate() to adapter.start() and deactivate()
 * to adapter.stop(), while declaring accurate platform capabilities.
 */
export function createSlackPlugin(deps: SlackAdapterDeps): ChannelPluginPort {
  const adapter = createSlackAdapter(deps);

  return {
    id: "channel-slack",
    name: "Slack Channel Plugin",
    version: "1.0.0",
    channelType: "slack",
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
