// SPDX-License-Identifier: Apache-2.0
/**
 * Build a lightweight read-only ChannelRegistry over the bootstrapped
 * `channelPlugins` Map.
 *
 * The orchestrator reads `replyToMetaKey` and other capability metadata via
 * `deps.channelRegistry?.getCapabilities(channelType)` since the
 * REPLY_TO_META_KEY hardcoded Record was deleted. Channel lifecycle is
 * owned by `setup-channels-adapters.ts` which populates the Map directly
 * from each adapter's plugin factory; we do NOT delegate registration to
 * `container.pluginRegistry` because channel plugins do not register
 * through that registry in production.
 *
 * The returned registry is intentionally read-only: `registerChannel` and
 * `unregisterChannel` return an explicit `err()` so any future caller that
 * mistakenly tries to mutate at this seam fails loudly rather than
 * silently bypassing the canonical adapter bootstrap path.
 *
 * @module
 */

import type { ChannelPluginPort } from "@comis/core";
import type { ChannelRegistry } from "@comis/channels";
import { err } from "@comis/shared";

/**
 * Map each enabled channel's secret env-var name → channelType
 * for use with the createChannelManager targeted-reconnect subscription.
 */
export function buildChannelCredentialMap(channels: unknown): Map<string, string> {
  const ch = channels as Record<string, { enabled?: boolean }> | null | undefined;
  const m = new Map<string, string>();
  if (!ch) return m;
  if (ch.telegram?.enabled) m.set("TELEGRAM_BOT_TOKEN", "telegram");
  if (ch.discord?.enabled) m.set("DISCORD_BOT_TOKEN", "discord");
  if (ch.slack?.enabled) { m.set("SLACK_BOT_TOKEN", "slack"); m.set("SLACK_APP_TOKEN", "slack"); }
  if (ch.line?.enabled) { m.set("LINE_CHANNEL_ACCESS_TOKEN", "line"); m.set("LINE_CHANNEL_SECRET", "line"); }
  if (ch.irc?.enabled) m.set("IRC_NICKSERV_PASSWORD", "irc");
  if (ch.email?.enabled) { m.set("EMAIL_PASSWORD", "email"); m.set("EMAIL_REFRESH_TOKEN", "email"); }
  if (ch.msteams?.enabled) m.set("MSTEAMS_APP_PASSWORD", "msteams");
  return m;
}

export function buildReadOnlyChannelRegistry(
  channelPlugins: Map<string, ChannelPluginPort>,
): ChannelRegistry {
  const readOnlyErr = () =>
    err(new Error("ChannelRegistry at this seam is read-only; mutate via setup-channels-adapters"));
  return {
    getCapabilities: (channelType: string) => channelPlugins.get(channelType)?.capabilities,
    getAdapter: (channelType: string) => channelPlugins.get(channelType)?.adapter,
    getChannelTypes: () => Array.from(channelPlugins.keys()),
    getChannelPlugins: () => Array.from(channelPlugins.values()),
    registerChannel: readOnlyErr,
    unregisterChannel: readOnlyErr,
  };
}
