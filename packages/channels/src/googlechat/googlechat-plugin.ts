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
 * deactivate() to adapter.stop(). Beyond the ChannelPluginPort surface the plugin
 * is a GoogleChatPluginHandle: it exposes createResolver, which builds the
 * inbound-media resolver that resolves attachments over the supported bot download
 * path, closing over the adapter's shared per-scope chat.bot token provider.
 *
 * @module
 */

import type {
  ChannelCapability,
  ChannelPluginPort,
  MediaResolverPort,
  PluginRegistryApi,
} from "@comis/core";
import { ok, type Result } from "@comis/shared";
import {
  createGoogleChatAdapter,
  type GoogleChatAdapterDeps,
} from "./googlechat-adapter.js";
import { createGoogleChatResolver } from "./googlechat-resolver.js";
import { CHAT_SCOPE } from "./googlechat-auth.js";

// ---------------------------------------------------------------------------
// Structural interfaces (avoid a circular dep on @comis/skills)
// ---------------------------------------------------------------------------

/**
 * Structural interface for the auth-capable SSRF-guarded fetcher (avoids a
 * circular dep on the package that owns the HTTP transport). It is the auth
 * superset of the plain `fetch(url)` seam: `opts` carries the Authorization
 * header value and the host allowlist the header may ride.
 */
interface SsrfFetcher {
  fetch(
    url: string,
    opts?: { authHeader?: string; authAllowHosts?: readonly string[] },
  ): Promise<Result<{ buffer: Buffer; mimeType: string; sizeBytes: number }, Error>>;
}

/** Minimal logger interface for the media resolver. */
interface ResolverLogger {
  debug(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

/**
 * The Google Chat plugin handle. Widens ChannelPluginPort with `createResolver`,
 * which builds the inbound-media resolver closing over the adapter's shared
 * per-scope chat.bot token provider. Unlike the Teams handle it takes no host
 * allowlist: the resolver pins the Bearer to the single media host with no config
 * escape hatch.
 */
export interface GoogleChatPluginHandle extends ChannelPluginPort {
  createResolver(deps: {
    ssrfFetcher: SsrfFetcher;
    maxBytes: number;
    logger: ResolverLogger;
  }): MediaResolverPort;
}

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
): GoogleChatPluginHandle {
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

    createResolver({ ssrfFetcher, maxBytes, logger }) {
      return createGoogleChatResolver({
        ssrfFetcher,
        maxBytes,
        logger,
        // Close over the adapter's SHARED per-scope token provider at the chat.bot
        // scope — the one provider minted for the pull loop and the send path, not a
        // second one (which would re-parse the service-account key).
        getToken: () => adapter.getPubSubTokenProvider().getToken(CHAT_SCOPE),
      });
    },
  };
}
