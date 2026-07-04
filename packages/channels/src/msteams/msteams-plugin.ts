// SPDX-License-Identifier: Apache-2.0
/**
 * Microsoft Teams Channel Plugin: wraps the Teams adapter as a ChannelPluginPort
 * with capability-parity metadata.
 *
 * The adapter implements inbound reactions, edit/delete, a typing keepalive and
 * threaded replies, so the plugin declares
 * `reactions/editMessages/deleteMessages/typing/threads: true`. `editMessages:true`
 * auto-routes the channel to the edit-in-place activity strategy. `buttons` is
 * `"adaptivecard"` — the channel advertises an Adaptive Card button surface. The
 * send-reaction port methods (`reactToMessage`/`removeReaction`) are permanently
 * omitted: Teams exposes no bot-reaction send API, so `reactions:true` is an
 * INBOUND capability.
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
  createMsTeamsAdapter,
  type MsTeamsAdapterDeps,
} from "./msteams-adapter.js";
import { createMsTeamsResolver } from "./msteams-resolver.js";

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

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The Teams plugin handle. Widens ChannelPluginPort with `createResolver`, which
 * builds the Teams media resolver closing over the adapter's Connector-token
 * getter (mirrors TelegramPluginHandle).
 */
export interface MsTeamsPluginHandle extends ChannelPluginPort {
  /**
   * Create the Teams media resolver. The injected fetcher is the auth-capable
   * SSRF-guarded fetcher the media pipeline already uses; `mediaAuthAllowHosts`
   * is the config passthrough (the resolver applies a built-in default when it
   * is empty).
   */
  createResolver(deps: {
    ssrfFetcher: SsrfFetcher;
    maxBytes: number;
    logger: ResolverLogger;
    mediaAuthAllowHosts: readonly string[];
  }): MediaResolverPort;
}

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
    // Base64-inline image send via sendAttachment; inbound media resolves through
    // the msteams-file resolver createResolver builds.
    attachments: true,
    // A {type:"typing"} keepalive over the injected timer.
    typing: true,
    // Channel/group thread root via replyToId.
    threads: true,
    // Advertises an Adaptive Card button surface.
    buttons: "adaptivecard",
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
 * while the plugin declares its honest capability matrix.
 */
export function createMsTeamsPlugin(
  deps: MsTeamsAdapterDeps,
): MsTeamsPluginHandle {
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

    createResolver({ ssrfFetcher, maxBytes, logger, mediaAuthAllowHosts }) {
      return createMsTeamsResolver({
        // Close over the adapter's cached Connector-token getter; the resolver
        // mints the Bearer once and the fetcher decides per-hop whether to attach it.
        getToken: () => adapter.getConnectorToken(),
        ssrfFetcher,
        maxBytes,
        logger,
        mediaAuthAllowHosts,
      });
    },
  };
}
