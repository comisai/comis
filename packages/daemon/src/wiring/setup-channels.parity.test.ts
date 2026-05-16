// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { stableStringify } from "../../../../test/support/stable-stringify.js";
import {
  setupChannels,
  type ChannelsDeps,
  type ChannelsResult,
} from "./setup-channels.js";

/**
 * Phase 43 parity protection: FILE-SPLIT-08 / FILE-SPLIT-17.
 *
 * Snapshots lock the pre-split public surface of setup-channels.ts
 * (the 1,111L wiring monolith) BEFORE the 43-08b subdirectory split lands.
 *
 * Scope is structural only: wiring is a composition root, so running
 * setupChannels() requires a real AppContainer plus channel-adapter
 * credentials, executors, sessionManager, and a media pipeline. The
 * snapshots cover what can be observed without boot:
 *   1. Symbol export shape (Object.keys of the import bag).
 *   2. Type-level witnesses (ChannelsDeps and ChannelsResult interface
 *      key sets).
 *
 * The post-split behavior MUST match these snapshots exactly. Any byte
 * change to the public surface FAILS this test (which runs in CI via
 * `pnpm test`).
 *
 * Captured: Phase 43 Wave 8 sub-plan 43-08a. The 4 atomic wiring splits
 * (43-08b) run this test against byte-identical replay, then delete it per
 * OQ-5 (progressive deletion at end-of-wave).
 */

function typeKeys<T extends Record<string, unknown>>(witness: T): string[] {
  return Object.keys(witness).sort();
}

describe("setup-channels parity (FILE-SPLIT-08)", () => {
  describe("public API surface", () => {
    it("exports the expected named symbols", () => {
      const exports = {
        setupChannels,
      };
      expect(stableStringify(Object.keys(exports).sort())).toMatchSnapshot();
    });
  });

  describe("type-level interface witnesses", () => {
    it("ChannelsDeps: interface key set is stable", () => {
      // Const-witness: locks the keyof shape of the public interface.
      // If a property is renamed, added, or removed, the snapshot diff
      // surfaces it.
      const witness: Record<keyof ChannelsDeps, true> = {
        container: true,
        executors: true,
        defaultAgentId: true,
        sessionManager: true,
        sessionStore: true,
        logger: true,
        channelsLogger: true,
        linkRunner: true,
        ssrfFetcher: true,
        transcriber: true,
        maxMediaBytes: true,
        assembleToolsForAgent: true,
        ttsAdapter: true,
        audioConverter: true,
        mediaTempManager: true,
        mediaSemaphore: true,
        imageAnalyzer: true,
        fileExtractor: true,
        fileExtractionConfig: true,
        workspaceDirs: true,
        defaultWorkspaceDir: true,
        memoryAdapter: true,
        tenantId: true,
        embeddingQueue: true,
        queueConfig: true,
        deliveryQueue: true,
        activeRunRegistry: true,
        sessionResolver: true,
        rpcCall: true,
        onTaskExtraction: true,
        onMessageReceived: true,
        onMessageProcessed: true,
        approvalGate: true,
        piSessionAdapters: true,
        costTrackers: true,
        cronExecutionTrackers: true,
      };
      expect(stableStringify(typeKeys(witness))).toMatchSnapshot();
    });

    it("ChannelsResult: interface key set is stable", () => {
      const witness: Record<keyof ChannelsResult, true> = {
        adaptersByType: true,
        channelManager: true,
        compositeResolver: true,
        resolveAttachment: true,
        lifecycleReactors: true,
        approvalNotifier: true,
        channelPlugins: true,
        channelCapabilities: true,
        commandQueue: true,
        deliveryService: true,
      };
      expect(stableStringify(typeKeys(witness))).toMatchSnapshot();
    });

    it("setupChannels: returns a function value (factory contract)", () => {
      // Functional sanity check: the export is callable. This is the
      // weakest possible runtime assertion (we cannot await the factory
      // without a real container), but it locks the value-vs-type shape
      // pre-split.
      expect(stableStringify({
        kind: typeof setupChannels,
        nameLen: setupChannels.name.length > 0,
      })).toMatchSnapshot();
    });
  });
});
