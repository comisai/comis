// SPDX-License-Identifier: Apache-2.0
/**
 * DUP-CONS-13 (Plan 56-05): build a lightweight read-only ChannelRegistry
 * over the bootstrapped `channelPlugins` Map.
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
