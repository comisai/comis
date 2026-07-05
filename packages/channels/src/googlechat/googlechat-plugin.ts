// SPDX-License-Identifier: Apache-2.0
/**
 * Google Chat Channel Plugin: wraps the Google Chat adapter as a
 * ChannelPluginPort with an honest, text-only capability matrix.
 *
 * The adapter implements a text send/receive round-trip over Pub/Sub pull and
 * nothing more, so every optional feature flag is `false` and `buttons` is
 * `"none"`. That honesty is load-bearing: the daemon capability gate
 * (requireMethod) throws if a capability is advertised whose adapter method is
 * omitted. Each `false`/`"none"` flag here has its method deliberately OMITTED
 * from the adapter, so a forbidden call is blocked at the gate rather than
 * silently reaching an unimplemented path — the honest-capability contract.
 *
 * activate() delegates to adapter.start() (which opens the pull loop) and
 * deactivate() to adapter.stop(). The plugin returns a plain ChannelPluginPort:
 * an inbound-media resolver handle is not part of the text-only surface.
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

/** Google Chat platform capabilities — the honest text-only interim matrix. */
const CAPABILITIES: ChannelCapability = {
  features: {
    reactions: false, // user-auth-only — permanently omitted
    editMessages: false, // edit not implemented (method omitted so the capability gate blocks it)
    deleteMessages: false, // delete not implemented
    fetchHistory: false, // admin-approval-gated
    attachments: false, // outbound upload is user-auth-only
    typing: false, // no typing API
    threads: false, // threaded replies not implemented (mapper still captures threadId)
    buttons: "none", // no card buttons yet — text-only
  },
  limits: { maxMessageChars: 4000 },
  replyToMetaKey: "googlechatMessageName",
};

/**
 * Create a Google Chat channel plugin wrapping the Google Chat adapter.
 *
 * activate() delegates to adapter.start() and deactivate() to adapter.stop(),
 * while the plugin declares its honest text-only capability matrix.
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
