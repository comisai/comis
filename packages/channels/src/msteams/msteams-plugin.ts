// SPDX-License-Identifier: Apache-2.0
/**
 * Microsoft Teams Channel Plugin: wraps the Teams adapter as a ChannelPluginPort
 * with honest text-only capability metadata.
 *
 * Every feature flag is false and `buttons` is `"none"`: this channel round-trips
 * plain text only. Declaring `editMessages:false` keeps it out of the closed
 * EditPlace rendering union, and `buttons:"none"` keeps it off the interactive
 * button surface — both are the honest reflection of what the adapter implements,
 * not a stub. `reactToMessage`/`removeReaction` are permanently omitted (Teams
 * exposes no bot-reaction send API).
 *
 * @module
 */

import type {
  ChannelCapability,
  ChannelPluginPort,
  PluginRegistryApi,
} from "@comis/core";
import { ok, type Result } from "@comis/shared";
import {
  createMsTeamsAdapter,
  type MsTeamsAdapterDeps,
} from "./msteams-adapter.js";

/** Microsoft Teams platform capabilities — text-only, self-declared. */
const CAPABILITIES: ChannelCapability = {
  features: {
    reactions: false,
    editMessages: false,
    deleteMessages: false,
    fetchHistory: false,
    attachments: false,
    typing: false,
    threads: false,
    buttons: "none",
  },
  limits: {
    maxMessageChars: 28000,
  },
  replyToMetaKey: "teamsActivityId",
};

/**
 * Create a Microsoft Teams channel plugin wrapping the Teams adapter.
 *
 * activate() delegates to adapter.start() and deactivate() to adapter.stop(),
 * while the plugin declares the honest text-only capability matrix.
 */
export function createMsTeamsPlugin(
  deps: MsTeamsAdapterDeps,
): ChannelPluginPort {
  const adapter = createMsTeamsAdapter(deps);

  return {
    id: "channel-msteams",
    name: "Microsoft Teams Channel Plugin",
    version: "1.0.0",
    channelType: "msteams",
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
