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
 * Edits (send an `m.replace`), deletes (redact the target), and honest inbound
 * edit/redaction surfacing are implemented too, but `editMessages`/`deleteMessages`
 * stay false for now: flipping `editMessages` routes rendering to the edit-in-place
 * strategy, which needs the activity renderer wired in lockstep, so until then the
 * capability gate simply does not admit these calls (a safe under-declaration — a
 * false flag never advertises a missing behavior). Attachments are not yet
 * implemented and stay false; Matrix exposes no button surface (`buttons: "none"`).
 * `selectStrategy(caps)` routes rendering from these flags, so flipping one on
 * advertises a behavior the adapter genuinely performs.
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
    reactions: true,
    editMessages: false,
    deleteMessages: false,
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
