// SPDX-License-Identifier: Apache-2.0
/**
 * Echo Channel Plugin: Plugin wrapper factory for the Echo test adapter.
 *
 * Wraps EchoChannelAdapter as a ChannelPluginPort with minimal test
 * capabilities. Intended for integration testing of the channel plugin
 * registration and lifecycle flow.
 *
 * @module
 */

import type { ChannelCapability, ChannelPluginPort, PluginRegistryApi } from "@comis/core";
import { ok, type Result } from "@comis/shared";
import { EchoChannelAdapter, type EchoAdapterOptions } from "./echo-adapter.js";

/** Echo test adapter capabilities (minimal -- all features disabled). */
const CAPABILITIES: ChannelCapability = {
  features: {
    reactions: false,
    editMessages: false,
    deleteMessages: false,
    fetchHistory: false,
    attachments: false,
  },
  limits: {
    maxMessageChars: 10000,
  },
  // DUP-CONS-13 (Plan 56-05): defensive declaration so the lifecycle
  // reactor + replyToMetaKey single-source path (post-REPLY_TO_META_KEY
  // Record deletion) does not silently disable echo replies in
  // integration tests. Echo's adapter stores message IDs under this key.
  replyToMetaKey: "echoMessageId",
};

/**
 * Create an Echo channel plugin wrapping the EchoChannelAdapter.
 *
 * The plugin delegates activate() to adapter.start() and deactivate()
 * to adapter.stop(). Useful for integration testing of the channel
 * plugin system without external dependencies.
 */
export function createEchoPlugin(options?: EchoAdapterOptions): ChannelPluginPort {
  const adapter = new EchoChannelAdapter(options);

  return {
    id: "channel-echo",
    name: "Echo Channel Plugin",
    version: "1.0.0",
    channelType: adapter.channelType,
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
