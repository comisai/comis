// SPDX-License-Identifier: Apache-2.0
/**
 * Microsoft Teams Channel Plugin: wraps the Teams adapter as a ChannelPluginPort
 * with capability-parity metadata.
 *
 * The adapter implements inbound reactions, edit/delete, a typing keepalive and
 * threaded replies, so the plugin declares
 * `reactions/editMessages/deleteMessages/typing/threads: true`. `editMessages:true`
 * auto-routes the channel to the edit-in-place activity strategy. `buttons` stays
 * `"none"` — the channel paints no interactive buttons yet. The send-reaction port
 * methods (`reactToMessage`/`removeReaction`) are permanently omitted: Teams
 * exposes no bot-reaction send API, so `reactions:true` is an INBOUND capability.
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

/** Microsoft Teams platform capabilities — self-declared, matching the adapter. */
const CAPABILITIES: ChannelCapability = {
  features: {
    // Inbound reactions only; the send-reaction methods stay omitted.
    reactions: true,
    // Bot Framework updateActivity — auto-routes to the edit-in-place strategy.
    editMessages: true,
    // Bot Framework deleteActivity.
    deleteMessages: true,
    fetchHistory: false,
    attachments: false,
    // A {type:"typing"} keepalive over the injected timer.
    typing: true,
    // Channel/group thread root via replyToId.
    threads: true,
    // No interactive buttons yet — the rich card variant is a later capability.
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
