// SPDX-License-Identifier: Apache-2.0
/**
 * LINE Channel Plugin: Plugin wrapper factory for the LINE adapter.
 *
 * Wraps createLineAdapter() as a ChannelPluginPort with accurate
 * capability metadata for LINE's platform features and limits.
 *
 * @module
 */

import type { ChannelCapability, ChannelPluginPort, MediaResolverPort, PluginRegistryApi } from "@comis/core";
import { ok, type Result } from "@comis/shared";
import { createLineAdapter, type LineAdapterDeps } from "./line-adapter.js";
import { createLineResolver } from "./line-resolver.js";

// ---------------------------------------------------------------------------
// Structural interfaces (avoid circular dep on @comis/skills)
// ---------------------------------------------------------------------------

interface ResolverLogger {
  debug(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface LinePluginHandle extends ChannelPluginPort {
  /** Create a media resolver using the internal BlobClient. */
  createResolver(deps: { maxBytes: number; logger: ResolverLogger }): MediaResolverPort;
}

/** LINE platform capabilities (self-declared, validated at registration). */
const CAPABILITIES: ChannelCapability = {
  chatTypes: ["dm", "group"],
  features: {
    reactions: false,
    editMessages: false,
    deleteMessages: false,
    fetchHistory: false,
    attachments: true,
    threads: false,
    mentions: false,
    formatting: ["flex"],
    buttons: false,
    cards: false,
    effects: false,
  },
  limits: {
    maxMessageChars: 5000,
    maxAttachmentSizeMb: 200,
  },
  streaming: {
    supported: false,
    throttleMs: 0,
    method: "none",
  },
  threading: {
    supported: false,
    threadType: "none",
  },
  replyToMetaKey: "lineMessageId",
};

/**
 * Create a LINE channel plugin wrapping the LINE adapter.
 *
 * The plugin delegates activate() to adapter.start() and deactivate()
 * to adapter.stop(), while declaring accurate platform capabilities.
 *
 * LINE capabilities:
 * - chatTypes: dm, group (LINE also has "room" but maps to group semantically)
 * - No reactions, edit, delete, or fetch history support
 * - Flex Messages for rich content (not HTML/Markdown)
 * - No streaming (LINE has no edit API for progressive updates)
 * - 5000 char message limit, 200MB attachment limit
 */
export function createLinePlugin(deps: LineAdapterDeps): LinePluginHandle {
  const adapter = createLineAdapter(deps);

  return {
    id: "channel-line",
    name: "LINE Channel Plugin",
    version: "1.0.0",
    channelType: "line",
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

    createResolver({ maxBytes, logger }) {
      return createLineResolver({
        getBlobContent: (messageId) => adapter.getBlobContent(messageId),
        maxBytes,
        logger,
      });
    },
  };
}
