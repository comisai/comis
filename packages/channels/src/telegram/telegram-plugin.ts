// SPDX-License-Identifier: Apache-2.0
/**
 * Telegram Channel Plugin: Plugin wrapper factory for the Telegram adapter.
 *
 * Wraps createTelegramAdapter() as a ChannelPluginPort with accurate
 * capability metadata for Telegram's platform features and limits.
 *
 * @module
 */

import type { ChannelCapability, ChannelPluginPort, MediaResolverPort, PluginRegistryApi } from "@comis/core";
import { ok, type Result } from "@comis/shared";
import { createTelegramAdapter, type TelegramAdapterDeps } from "./telegram-adapter/index.js";
import { createTelegramResolver } from "./telegram-resolver.js";

// ---------------------------------------------------------------------------
// Structural interfaces (avoid circular dep on @comis/skills)
// ---------------------------------------------------------------------------

/** Structural interface to avoid circular dep on @comis/skills. */
interface SsrfFetcher {
  fetch(url: string): Promise<Result<{ buffer: Buffer; mimeType: string; sizeBytes: number }, Error>>;
}

interface ResolverLogger {
  debug(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TelegramPluginHandle extends ChannelPluginPort {
  /** Create a media resolver using the internal Bot instance. */
  createResolver(deps: { ssrfFetcher: SsrfFetcher; maxBytes: number; logger: ResolverLogger }): MediaResolverPort;
}

/** Telegram platform capabilities (self-declared, validated at registration). */
const CAPABILITIES: ChannelCapability = {
  features: {
    reactions: true,
    editMessages: true,
    deleteMessages: true,
    fetchHistory: false,
    attachments: true,
    // §17.2: Telegram EditPlace — typing indicator + inline keyboard buttons.
    typing: true,
    threads: false,
    buttons: "inline",
  },
  limits: {
    maxMessageChars: 4096,
  },
  replyToMetaKey: "telegramMessageId",
};

/**
 * Create a Telegram channel plugin wrapping the Telegram adapter.
 *
 * The plugin delegates activate() to adapter.start() and deactivate()
 * to adapter.stop(), while declaring accurate platform capabilities.
 */
export function createTelegramPlugin(deps: TelegramAdapterDeps): TelegramPluginHandle {
  const adapter = createTelegramAdapter(deps);

  return {
    id: "channel-telegram",
    name: "Telegram Channel Plugin",
    version: "1.0.0",
    channelType: "telegram",
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
      return createTelegramResolver({
        bot: adapter.bot,
        botToken: deps.botToken,
        ssrfFetcher,
        maxBytes,
        logger,
        // Honor the Bot API root override for file downloads too (else getFile uses the override but
        // the byte download 404s against real Telegram — breaks local Bot API servers + the emulator).
        apiRoot: deps.apiRoot,
      });
    },
  };
}
