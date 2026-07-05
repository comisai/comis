// SPDX-License-Identifier: Apache-2.0
/**
 * Google Chat Channel Plugin: wraps the Google Chat adapter as a
 * ChannelPluginPort with an honest, app-auth capability matrix.
 *
 * The adapter sends and receives text over Pub/Sub pull, edits and deletes its
 * own messages, posts threaded replies, and renders and routes Cards v2
 * interactive buttons, so `editMessages`, `deleteMessages`, `threads`, and the
 * `"cardsv2"` button surface are advertised with their supporting paths in place.
 * Reactions, history fetch, outbound attachments, and typing indicators are not
 * reachable for a service-account app, so those flags stay `false`. That honesty
 * is load-bearing: the daemon capability gate
 * (requireMethod) throws if a capability is advertised whose adapter method is
 * omitted, and blocks a false-flag call before it reaches an unimplemented path.
 * Every advertised-true flag has its method present; every false flag has its
 * method deliberately OMITTED — the honest-capability contract.
 *
 * activate() delegates to adapter.start() (which opens the pull loop) and
 * deactivate() to adapter.stop(). The plugin returns a plain ChannelPluginPort:
 * an inbound-media resolver handle is not part of this surface.
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
  createGoogleChatAdapter,
  type GoogleChatAdapterDeps,
} from "./googlechat-adapter.js";

/** Google Chat platform capabilities — the honest app-auth capability matrix. */
const CAPABILITIES: ChannelCapability = {
  features: {
    reactions: false, // user-auth-only — permanently omitted
    editMessages: true, // edit lands in place via a text-masked patch
    deleteMessages: true, // the app can delete its own message
    fetchHistory: false, // admin-approval-gated
    attachments: false, // outbound upload is user-auth-only
    typing: false, // no typing API
    threads: true, // threaded replies route through the send path
    buttons: "cardsv2", // Cards v2 interactive widget buttons, rendered and routed
  },
  limits: { maxMessageChars: 4000 },
  replyToMetaKey: "googlechatMessageName",
};

/**
 * Create a Google Chat channel plugin wrapping the Google Chat adapter.
 *
 * activate() delegates to adapter.start() and deactivate() to adapter.stop(),
 * while the plugin declares its honest app-auth capability matrix (threaded
 * replies, edit/delete; reactions, uploads, and history are omitted).
 */
export function createGoogleChatPlugin(
  deps: GoogleChatAdapterDeps,
): ChannelPluginPort {
  const adapter = createGoogleChatAdapter(deps);

  return {
    id: "channel-googlechat",
    name: "Google Chat Channel Plugin",
    version: "1.0.0",
    channelType: "googlechat",
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
