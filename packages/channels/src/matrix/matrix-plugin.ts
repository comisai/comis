// SPDX-License-Identifier: Apache-2.0
/**
 * Matrix Channel Plugin: the ChannelPluginPort wrapper for the Matrix adapter.
 *
 * Every capability flag here is honest for the current plaintext scope —
 * nothing not-yet-real is advertised true. Reactions, edits, deletes, history,
 * attachments, typing, and threads are all false, and Matrix exposes no button
 * surface (`buttons: "none"`). `selectStrategy(caps)` routes rendering from
 * these flags, so a flag is flipped true only when the behavior actually ships.
 *
 * The plugin declares metadata and delegates its lifecycle: `activate()` starts
 * the adapter, `deactivate()` stops it. There is no media resolver this scope.
 *
 * @module
 */

import type { ChannelCapability, ChannelPluginPort, PluginRegistryApi } from "@comis/core";
import { ok, type Result } from "@comis/shared";
import { createMatrixAdapter, type MatrixAdapterDeps } from "./matrix-adapter.js";

/** Matrix platform capabilities (self-declared, validated at registration). */
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
 * @returns A ChannelPluginPort exposing the adapter and its capabilities.
 */
export function createMatrixPlugin(deps: MatrixAdapterDeps): ChannelPluginPort {
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
  };
}
