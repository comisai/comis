// SPDX-License-Identifier: Apache-2.0
/**
 * Matrix Channel Plugin: the ChannelPluginPort wrapper for the Matrix adapter.
 *
 * Every capability flag here is honest — a flag is true only when the behavior
 * ships AND its rendering path is wired. Reactions (send an `m.reaction`
 * annotation, redact to remove), history fetch (paginate `/messages`), threaded
 * replies (an `m.thread` relation, with over-budget content split into
 * byte-bounded sequential events), and typing (a `/typing` notice via
 * `platformAction`, refreshed before its timeout) are real and declared true.
 * Edits (send an `m.replace`) and deletes (redact the target) are declared true
 * TOGETHER: `selectStrategy` routes on `editMessages` first, so both flip in
 * lockstep with the edit-in-place activity renderer — `editMessages: true` routes
 * rendering to that strategy (an approval/status frame edits the same event
 * rather than reposting), and `deleteMessages` never reaches the repost path.
 * Attachments are not yet implemented and stay false; Matrix exposes no button
 * surface (`buttons: "none"`), so approval frames degrade to text. `selectStrategy(caps)`
 * routes rendering from these flags, so each true flag advertises a behavior the
 * adapter genuinely performs.
 *
 * The plugin declares metadata and delegates its lifecycle: `activate()` starts
 * the adapter, `deactivate()` stops it. It also exposes `createResolver` — the
 * factory the media pipeline calls to build the authenticated `mxc://` media
 * downloader, closing over the adapter's started media-client and encrypted-file
 * getters.
 *
 * @module
 */

import type { ChannelCapability, ChannelPluginPort, MediaResolverPort, PluginRegistryApi } from "@comis/core";
import { ok, type Result } from "@comis/shared";
import { createMatrixAdapter, type MatrixAdapterDeps } from "./matrix-adapter.js";
import { createMatrixResolver } from "./matrix-resolver.js";

// ---------------------------------------------------------------------------
// Structural interfaces (avoid a circular dep on the HTTP-transport package)
// ---------------------------------------------------------------------------

/**
 * Structural interface for the auth-capable SSRF-guarded fetcher (avoids a
 * circular dep on the package that owns the HTTP transport). `opts` carries the
 * Authorization header value and the host allowlist the header may ride; the
 * fetcher enforces the per-hop attach/drop decision, re-validates every redirect,
 * and caps the body size.
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
 * The Matrix plugin handle. Widens ChannelPluginPort with `createResolver`, which
 * builds the Matrix media resolver closing over the adapter's started media client
 * (the authed mxc→http URL builder, access token, and homeserver host) and its
 * encrypted-file lookup (the E2EE decryption records the inbound mapper caches).
 */
export interface MatrixPluginHandle extends ChannelPluginPort {
  /**
   * Create the Matrix media resolver. The injected fetcher is the auth-capable
   * SSRF-guarded fetcher the media pipeline already uses. `mediaAuthAllowHosts` is
   * accepted for parity with the pipeline's resolver-factory contract but is not
   * consumed here: Matrix has no per-deployment media-auth config key, so the
   * resolver scopes the token to the homeserver host internally.
   */
  createResolver(deps: {
    ssrfFetcher: SsrfFetcher;
    maxBytes: number;
    logger: ResolverLogger;
    mediaAuthAllowHosts: readonly string[];
  }): MediaResolverPort;
}

/** Matrix platform capabilities (self-declared, validated at registration). */
const CAPABILITIES: ChannelCapability = {
  features: {
    reactions: true,
    editMessages: true,
    deleteMessages: true,
    fetchHistory: true,
    attachments: false,
    typing: true,
    threads: true,
    buttons: "none",
  },
  limits: {
    // The NormalizedMessage text cap; Matrix imposes no tighter per-message bound.
    maxMessageChars: 32768,
  },
  replyToMetaKey: "matrixEventId",
};

/**
 * Create a Matrix channel plugin wrapping the Matrix adapter.
 *
 * The plugin delegates `activate()` to `adapter.start()` and `deactivate()` to
 * `adapter.stop()`, while declaring the honest capability metadata above.
 *
 * @param deps - The Matrix adapter dependencies (credentials, gating, seams).
 * @returns A MatrixPluginHandle exposing the adapter, its capabilities, and the
 *   `mxc://` media resolver factory.
 */
export function createMatrixPlugin(deps: MatrixAdapterDeps): MatrixPluginHandle {
  const adapter = createMatrixAdapter(deps);

  return {
    id: "channel-matrix",
    name: "Matrix Channel Plugin",
    version: "1.0.0",
    channelType: "matrix",
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
      // Close over the adapter's started media getters. `getMediaClient` is
      // undefined until the adapter start()s, so a resolver built at wiring time
      // errs cleanly rather than crashing. `mediaAuthAllowHosts` is intentionally
      // not consumed — the resolver scopes the token to the homeserver host.
      return createMatrixResolver({
        ssrfFetcher,
        maxBytes,
        logger,
        getMediaClient: () => adapter.getMediaClient(),
        getEncryptedFile: (mxc) => adapter.getEncryptedFile(mxc),
      });
    },
  };
}
