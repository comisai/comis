// SPDX-License-Identifier: Apache-2.0
/**
 * The runtime leaf hosts `buildAndStartChannelManager` (voice pipeline +
 * command queue + slash-command handler + retry engine + lifecycle
 * reactors). The integration matrix (ChannelManager startAll, lifecycle
 * reactor creation) is exercised by setup-channels-registry.test.ts which
 * invokes setupChannels end-to-end with mocks; this neighbor test pins the
 * symbol-export shape and the deps + result interface key sets for
 * compile-time regression coverage.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import {
  buildAndStartChannelManager,
  type ChannelManagerBuildDeps,
  type ChannelManagerBuildResult,
} from "./setup-channels-runtime.js";

describe("setup-channels-runtime", () => {
  it("buildAndStartChannelManager: exported as a callable function", () => {
    expect(typeof buildAndStartChannelManager).toBe("function");
    expect(buildAndStartChannelManager.length).toBeGreaterThanOrEqual(1);
  });

  it("ChannelManagerBuildDeps witness pins the closure-captured key set", () => {
    // The witness's `Record<keyof T, true>` compile-checks exhaustiveness;
    // if a closure capture is added/renamed without updating the deps
    // surface, the literal stops type-checking.
    //
    // exportSessionBundle: DI seam for the /export-trajectory slash command.
    const witness: Record<keyof ChannelManagerBuildDeps, true> = {
      container: true,
      executors: true,
      defaultAgentId: true,
      sessionManager: true,
      channelsLogger: true,
      ssrfFetcher: true,
      linkRunner: true,
      deliveryService: true,
      adaptersByType: true,
      channelPlugins: true,
      preprocessMessageCallback: true,
      preflightFn: true,
      assembleToolsForAgent: true,
      ttsAdapter: true,
      audioConverter: true,
      mediaTempManager: true,
      mediaSemaphore: true,
      queueConfig: true,
      deliveryQueue: true,
      activeRunRegistry: true,
      sessionResolver: true,
      rpcCall: true,
      onMessageReceived: true,
      onMessageProcessed: true,
      approvalGate: true,
      piSessionAdapters: true,
      costTrackers: true,
      cronExecutionTrackers: true,
      exportSessionBundle: true,
    };
    expect(Object.keys(witness).length).toBe(29);
  });

  it("ChannelManagerBuildResult witness pins the manager handle output keys", () => {
    const witness: Record<keyof ChannelManagerBuildResult, true> = {
      channelManager: true,
      lifecycleReactors: true,
      commandQueue: true,
    };
    expect(Object.keys(witness).length).toBe(3);
  });
});
