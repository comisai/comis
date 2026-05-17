// SPDX-License-Identifier: Apache-2.0
// Type-only port surface for channel plugin metadata.
// ChannelCapabilitySchema (Zod runtime value) + ChannelCapability (z.infer) live in
// ../domain/channel-capability.ts. This file is type-only; the public surface
// still re-exports ChannelCapability through ../exports/domain.ts and
// ../exports/ports.ts so consumers see no shape change.
import type { PluginPort } from "./plugin.js";
import type { ChannelPort } from "./channel.js";
import type { ChannelCapability } from "../domain/channel-capability.js";

// Re-export ChannelCapability so existing internal consumers and the curated public surface
// (ports/index.ts -> exports/ports.ts) keep their import paths intact.
export type { ChannelCapability };

/**
 * ChannelPluginPort: A plugin that provides a channel adapter.
 *
 * Extends the base PluginPort with channel-specific metadata:
 * - channelType: The unique channel type string (e.g. "telegram")
 * - capabilities: Self-declared feature/limit metadata
 * - adapter: The actual ChannelPort implementation
 *
 * Channel plugins register through createChannelRegistry(), which
 * validates capabilities and delegates lifecycle to PluginRegistry.
 */
export interface ChannelPluginPort extends PluginPort {
  /** The channel type this plugin provides (e.g. "telegram", "discord") */
  readonly channelType: string;
  /** Self-declared capability metadata, validated at registration */
  readonly capabilities: ChannelCapability;
  /** The underlying channel adapter implementation */
  readonly adapter: ChannelPort;
}
