// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { stableStringify } from "../../../../test/support/stable-stringify.js";
import {
  resolveAgentModel,
  setupAgents,
  setupSingleAgent,
  type AgentsResult,
  type SingleAgentDeps,
  type SingleAgentResult,
} from "./setup-agents.js";

/**
 * Phase 43 parity protection: FILE-SPLIT-08 / FILE-SPLIT-17.
 *
 * Snapshots lock the pre-split public surface of setup-agents.ts
 * (the 1,164L wiring monolith) BEFORE the 43-08b subdirectory split lands.
 *
 * Scope is structural only: wiring is a composition root, so running
 * setupAgents() requires a real AppContainer plus secrets, memory, and
 * MCP-client subsystems. The snapshots cover what can be observed without
 * boot:
 *   1. Symbol export shape (Object.keys of the import bag).
 *   2. Pure helper behavior (resolveAgentModel priority chain).
 *   3. Type-level witnesses (SingleAgentDeps, SingleAgentResult,
 *      AgentsResult interface key sets).
 *
 * The post-split behavior MUST match these snapshots exactly. Any byte
 * change to the public surface FAILS this test (which runs in CI via
 * `pnpm test`).
 *
 * Captured: Phase 43 Wave 8 sub-plan 43-08a. The 4 atomic wiring splits
 * (43-08b) run this test against byte-identical replay, then delete it per
 * OQ-5 (progressive deletion at end-of-wave).
 */

// Type-witness helper: a value-level proxy that captures interface key
// sets without instantiating the real type (which would require a live
// container). Each witness is a `Record<keyof T, true>` literal; the
// snapshot serializes the sorted key list.
function typeKeys<T extends Record<string, unknown>>(witness: T): string[] {
  return Object.keys(witness).sort();
}

describe("setup-agents parity (FILE-SPLIT-08)", () => {
  describe("public API surface", () => {
    it("exports the expected named symbols", () => {
      const exports = {
        resolveAgentModel,
        setupAgents,
        setupSingleAgent,
      };
      expect(stableStringify(Object.keys(exports).sort())).toMatchSnapshot();
    });
  });

  describe("resolveAgentModel behavior matrix", () => {
    it("resolveAgentModel: returns explicit per-agent provider and model when neither is the default sentinel", () => {
      const result = resolveAgentModel(
        { model: "claude-sonnet-4-20250514", provider: "anthropic" },
        { defaultModel: "", defaultProvider: "" },
      );
      expect(stableStringify(result)).toMatchSnapshot();
    });

    it("resolveAgentModel: returns models.defaultProvider when agent provider is default and YAML default is set", () => {
      const result = resolveAgentModel(
        { model: "claude-sonnet-4-20250514", provider: "default" },
        { defaultModel: "", defaultProvider: "anthropic" },
      );
      expect(stableStringify(result)).toMatchSnapshot();
    });

    it("resolveAgentModel: returns models.defaultModel when agent model is default and YAML default is set", () => {
      const result = resolveAgentModel(
        { model: "default", provider: "anthropic" },
        { defaultModel: "claude-opus-4-20250115", defaultProvider: "" },
      );
      expect(stableStringify(result)).toMatchSnapshot();
    });
  });

  describe("type-level interface witnesses", () => {
    it("SingleAgentDeps: interface key set is stable", () => {
      // Const-witness: each property is the literal `true`. Witnesses lock
      // the keyof structure of the public interface; if a property is
      // renamed, added, or removed, the snapshot diff surfaces it.
      const witness: Record<keyof SingleAgentDeps, true> = {
        container: true,
        memoryAdapter: true,
        sessionStore: true,
        agentLogger: true,
        resolvedAgentDir: true,
        daemonTracingDefaults: true,
        subAgentToolNames: true,
        mcpToolsInherited: true,
        outboundMediaEnabled: true,
        autonomousMediaEnabled: true,
        activeRunRegistry: true,
        canaryFallbackSecret: true,
        injectionRateLimiter: true,
        embeddingQueue: true,
        contextStore: true,
        db: true,
        providerHealth: true,
        lastKnownModel: true,
        embeddingPort: true,
        deliveryMirror: true,
        deliveryMirrorConfig: true,
        geminiCacheManager: true,
        getChannelMaxChars: true,
        backgroundTaskManager: true,
        secretsCrypto: true,
        secretsDb: true,
        oauthCredentialStore: true,
        mcpClientManager: true,
        fileLock: true,
        clock: true,
        env: true,
        timers: true,
      };
      expect(stableStringify(typeKeys(witness))).toMatchSnapshot();
    });

    it("SingleAgentResult: interface key set is stable", () => {
      const witness: Record<keyof SingleAgentResult, true> = {
        executor: true,
        workspaceDir: true,
        costTracker: true,
        budgetGuard: true,
        stepCounter: true,
        piSessionAdapter: true,
        skillWatcherHandle: true,
        skillRegistry: true,
        toolCapabilityPort: true,
      };
      expect(stableStringify(typeKeys(witness))).toMatchSnapshot();
    });

    it("AgentsResult: interface key set is stable", () => {
      const witness: Record<keyof AgentsResult, true> = {
        sessionManager: true,
        executors: true,
        workspaceDirs: true,
        costTrackers: true,
        budgetGuards: true,
        stepCounters: true,
        defaultAgentId: true,
        defaultWorkspaceDir: true,
        getExecutor: true,
        piSessionAdapters: true,
        skillWatcherHandles: true,
        skillRegistries: true,
        toolCapabilityPorts: true,
        lockCleanupTimer: true,
        singleAgentDeps: true,
        providerHealth: true,
        oauthCredentialStore: true,
      };
      expect(stableStringify(typeKeys(witness))).toMatchSnapshot();
    });
  });
});
