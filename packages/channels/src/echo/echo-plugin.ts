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
  chatTypes: ["dm"],
  features: {
    reactions: false,
    editMessages: false,
    deleteMessages: false,
    fetchHistory: false,
    attachments: false,
    threads: false,
    mentions: false,
    formatting: [],
    buttons: false,
    cards: false,
    effects: false,
  },
  limits: {
    maxMessageChars: 10000,
  },
  streaming: {
    supported: false,
    throttleMs: 300,
    method: "none",
  },
  threading: {
    supported: false,
    threadType: "none",
  },
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
