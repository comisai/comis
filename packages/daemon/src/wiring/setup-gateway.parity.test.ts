// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { stableStringify } from "../../../../test/support/stable-stringify.js";
import {
  setupGateway,
  setupRpcBridge,
  buildExecutionRequestedLogFields,
  deriveTrustLevel,
  handleConfigChatCommand,
  type GatewayDeps,
  type GatewayResult,
  type RpcBridgeResult,
} from "./setup-gateway.js";

/**
 * Phase 43 parity protection: FILE-SPLIT-08 / FILE-SPLIT-17.
 *
 * Snapshots lock the pre-split public surface of setup-gateway.ts
 * (the 976L wiring monolith) BEFORE the 43-08b subdirectory split lands.
 *
 * Scope is structural plus pure-helper invocations: wiring is a
 * composition root, so running setupGateway() requires a real
 * AppContainer plus gateway server, RPC dispatch, tokenStore, and the
 * full executor pipeline. The snapshots cover:
 *   1. Symbol export shape (Object.keys of the import bag).
 *   2. Pure helper behavior (deriveTrustLevel, buildExecutionRequestedLogFields).
 *   3. Pure async helper behavior (handleConfigChatCommand trust-gate paths).
 *   4. Type-level witnesses (GatewayDeps, GatewayResult, RpcBridgeResult
 *      interface key sets).
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

describe("setup-gateway parity (FILE-SPLIT-08)", () => {
  describe("public API surface", () => {
    it("exports the expected named symbols", () => {
      const exports = {
        setupGateway,
        setupRpcBridge,
        buildExecutionRequestedLogFields,
        deriveTrustLevel,
        handleConfigChatCommand,
      };
      expect(stableStringify(Object.keys(exports).sort())).toMatchSnapshot();
    });
  });

  describe("deriveTrustLevel behavior matrix", () => {
    it("deriveTrustLevel: returns admin when scopes include literal admin", () => {
      expect(stableStringify(deriveTrustLevel(["admin"]))).toMatchSnapshot();
    });

    it("deriveTrustLevel: returns admin when scopes include wildcard star", () => {
      expect(stableStringify(deriveTrustLevel(["*"]))).toMatchSnapshot();
    });

    it("deriveTrustLevel: returns user when scopes are undefined (fail-closed default)", () => {
      expect(stableStringify(deriveTrustLevel(undefined))).toMatchSnapshot();
    });

    it("deriveTrustLevel: returns user when scopes is an empty array", () => {
      expect(stableStringify(deriveTrustLevel([]))).toMatchSnapshot();
    });

    it("deriveTrustLevel: returns user when scopes contain only non-privileged scopes", () => {
      expect(stableStringify(deriveTrustLevel(["read", "write"]))).toMatchSnapshot();
    });
  });

  describe("buildExecutionRequestedLogFields behavior matrix", () => {
    it("buildExecutionRequestedLogFields: includes messageHash and connectionId when both provided", () => {
      const fields = buildExecutionRequestedLogFields({
        agentId: "default",
        message: "hello world",
        connectionId: "conn-123",
      });
      // Snapshot full result: agentId, messageLen, messageHash, connectionId.
      expect(stableStringify(fields)).toMatchSnapshot();
    });

    it("buildExecutionRequestedLogFields: omits messageHash when message is empty string", () => {
      const fields = buildExecutionRequestedLogFields({
        agentId: "default",
        message: "",
        connectionId: undefined,
      });
      expect(stableStringify(fields)).toMatchSnapshot();
    });

    it("buildExecutionRequestedLogFields: omits messageHash when message is undefined", () => {
      const fields = buildExecutionRequestedLogFields({
        agentId: "default",
        message: undefined,
        connectionId: undefined,
      });
      expect(stableStringify(fields)).toMatchSnapshot();
    });

    it("buildExecutionRequestedLogFields: produces stable 12-char messageHash prefix for the same message", () => {
      // Snapshot the hash itself to lock the SHA-256 prefix length and
      // alphabet. The byte-identity gate post-split depends on the hash
      // construction not drifting.
      const fields = buildExecutionRequestedLogFields({
        agentId: "default",
        message: "hello world",
        connectionId: undefined,
      });
      expect(stableStringify({
        messageHash: fields.messageHash,
        messageHashLen: fields.messageHash?.length,
      })).toMatchSnapshot();
    });
  });

  describe("handleConfigChatCommand trust-gate behavior matrix", () => {
    it("handleConfigChatCommand: blocks config show when caller has no admin scope", async () => {
      // rpcCall must never be reached on the trust-blocked path; supply a
      // throwing stub to assert the gate short-circuits before dispatch.
      const rpcCallStub = (async () => {
        throw new Error("rpcCall must not be called on the trust-blocked path");
      }) as unknown as Parameters<typeof handleConfigChatCommand>[1];
      const result = await handleConfigChatCommand(["show"], rpcCallStub, ["read"]);
      expect(stableStringify(result)).toMatchSnapshot();
    });

    it("handleConfigChatCommand: blocks config history when caller has no admin scope", async () => {
      const rpcCallStub = (async () => {
        throw new Error("rpcCall must not be called on the trust-blocked path");
      }) as unknown as Parameters<typeof handleConfigChatCommand>[1];
      const result = await handleConfigChatCommand(["history"], rpcCallStub, undefined);
      expect(stableStringify(result)).toMatchSnapshot();
    });

    it("handleConfigChatCommand: blocks config set when caller has no admin scope", async () => {
      const rpcCallStub = (async () => {
        throw new Error("rpcCall must not be called on the trust-blocked path");
      }) as unknown as Parameters<typeof handleConfigChatCommand>[1];
      const result = await handleConfigChatCommand(
        ["set", "agent.name", "test"],
        rpcCallStub,
        ["read"],
      );
      expect(stableStringify(result)).toMatchSnapshot();
    });

    it("handleConfigChatCommand: returns the unknown-subcommand response", async () => {
      const rpcCallStub = (async () => {
        throw new Error("rpcCall must not be called on the unknown-subcommand path");
      }) as unknown as Parameters<typeof handleConfigChatCommand>[1];
      const result = await handleConfigChatCommand(
        ["bogus-subcommand"],
        rpcCallStub,
        ["admin"],
      );
      expect(stableStringify(result)).toMatchSnapshot();
    });
  });

  describe("setupRpcBridge factory contract", () => {
    it("setupRpcBridge: returns a result object with rpcCall and wireDispatch keys", () => {
      const result: RpcBridgeResult = setupRpcBridge({
        gatewayLogger: {
          trace: () => {},
          debug: () => {},
          info: () => {},
          warn: () => {},
          error: () => {},
          fatal: () => {},
          silent: () => {},
          level: "silent",
          child() { return this; },
          bindings: () => ({}),
          isLevelEnabled: () => false,
          flush: () => {},
        } as unknown as Parameters<typeof setupRpcBridge>[0]["gatewayLogger"],
      });
      expect(stableStringify({
        keys: Object.keys(result).sort(),
        rpcCallKind: typeof result.rpcCall,
        wireDispatchKind: typeof result.wireDispatch,
      })).toMatchSnapshot();
    });
  });

  describe("type-level interface witnesses", () => {
    it("GatewayDeps: interface key set is stable", () => {
      const witness: Record<keyof GatewayDeps, true> = {
        container: true,
        gwConfig: true,
        webhooksConfig: true,
        agents: true,
        defaultAgentId: true,
        configPaths: true,
        defaultConfigPaths: true,
        gatewayLogger: true,
        embeddingQueue: true,
        memoryAdapter: true,
        memoryApi: true,
        cachedPort: true,
        sessionStore: true,
        getExecutor: true,
        assembleToolsForAgent: true,
        preprocessMessageText: true,
        rpcCall: true,
        costTrackers: true,
        workspaceDirs: true,
        _createGatewayServer: true,
        instanceId: true,
        startupStartMs: true,
        piSessionAdapters: true,
        resolvedTokens: true,
        suspendedAgents: true,
      };
      expect(stableStringify(typeKeys(witness))).toMatchSnapshot();
    });

    it("GatewayResult: interface key set is stable", () => {
      const witness: Record<keyof GatewayResult, true> = {
        gatewayHandle: true,
        activeExecutions: true,
        getActiveConnectionCount: true,
        wsConnections: true,
      };
      expect(stableStringify(typeKeys(witness))).toMatchSnapshot();
    });

    it("RpcBridgeResult: interface key set is stable", () => {
      const witness: Record<keyof RpcBridgeResult, true> = {
        rpcCall: true,
        wireDispatch: true,
      };
      expect(stableStringify(typeKeys(witness))).toMatchSnapshot();
    });
  });
});
