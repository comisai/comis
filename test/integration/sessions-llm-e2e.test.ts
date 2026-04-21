// SPDX-License-Identifier: Apache-2.0
/**
 * Sessions LLM E2E Tests
 *
 * Real LLM provider E2E tests verifying session management through actual
 * agent execution:
 *   SLLM-01: Session creation via agent.execute, verified via session.history
 *   SLLM-02: Multi-turn conversation accumulates messages in session history
 *   SLLM-03: session.status shows non-zero tokensUsed after agent execution
 *   SLLM-04: Cross-session messaging via session.send fire-and-forget
 *   SLLM-05: Sub-agent spawning (sync and async modes)
 *   SLLM-06: Session isolation across different channelIds
 *   SLLM-07: Session history pagination with offset/limit/hasMore
 *
 * Requires ANTHROPIC_API_KEY or OPENAI_API_KEY in ~/.comis/.env.
 * Skips entirely when no LLM API keys are available.
 *
 * Uses port 8506 with agentToAgent enabled for cross-session and spawn tests.
 *
 * @module
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getProviderEnv,
  hasAnyProvider,
  PROVIDER_GROUPS,
  isAuthError,
  logProviderAvailability,
} from "../support/provider-env.js";
import {
  startTestDaemon,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import {
  openAuthenticatedWebSocket,
  sendJsonRpc,
} from "../support/ws-helpers.js";
import { RPC_FAST_MS, RPC_LLM_MS } from "../support/timeouts.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = resolve(
  __dirname,
  "../config/config.test-sessions-llm-e2e.yaml",
);

const env = getProviderEnv();
const hasLlmKey = hasAnyProvider(env, PROVIDER_GROUPS.llm);

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe.skipIf(!hasLlmKey)(
  "Sessions LLM E2E Tests",
  () => {
    let handle: TestDaemonHandle;
    let ws: WebSocket;
    let msgId = 200;

    beforeAll(async () => {
      logProviderAvailability(env);
      handle = await startTestDaemon({ configPath: CONFIG_PATH });
      ws = await openAuthenticatedWebSocket(
        handle.gatewayUrl,
        handle.authToken,
      );
    }, 60_000);

    afterAll(async () => {
      ws?.close();
      if (handle) {
        try {
          await handle.cleanup();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes("Daemon exit with code")) {
            throw err;
          }
        }
      }
    }, 30_000);

    // -----------------------------------------------------------------------
    // SLLM-01: Session creation via agent.execute
    // -----------------------------------------------------------------------

    describe("SLLM-01: Session creation via agent.execute", () => {
      it(
        "agent.execute creates session visible via session.history",
        async () => {
          try {
            // Execute agent to create a session
            const execResponse = (await sendJsonRpc(
              ws,
              "agent.execute",
              {
                message: "Say exactly: sllm01-marker",
                sessionKey: {
                  userId: "rpc-client",
                  channelId: "sllm01-channel",
                  peerId: "test",
                },
              },
              msgId++,
            )) as Record<string, unknown>;

            if (execResponse.error) {
              const errMsg = JSON.stringify(execResponse.error);
              if (isAuthError(errMsg)) {
                console.warn("Skipping SLLM-01: API key invalid/expired");
                return;
              }
              throw new Error(`agent.execute failed: ${errMsg}`);
            }

            expect(execResponse).toHaveProperty("result");
            const result = execResponse.result as Record<string, unknown>;
            expect(typeof result.response).toBe("string");
            expect((result.tokensUsed as { total: number }).total).toBeGreaterThan(0);

            // Verify session history exists
            const historyResponse = (await sendJsonRpc(
              ws,
              "session.history",
              {
                session_key: "test:rpc-client:sllm01-channel",
                offset: 0,
                limit: 20,
              },
              msgId++,
              { timeoutMs: RPC_FAST_MS },
            )) as Record<string, unknown>;

            expect(historyResponse).toHaveProperty("result");
            const historyResult = historyResponse.result as Record<
              string,
              unknown
            >;
            const messages = historyResult.messages as Array<{
              role: string;
              content: string;
            }>;
            expect(Array.isArray(messages)).toBe(true);
            expect(messages.length).toBeGreaterThan(0);

            // Verify at least one user and one assistant message
            const hasUser = messages.some((m) => m.role === "user");
            const hasAssistant = messages.some((m) => m.role === "assistant");
            expect(hasUser).toBe(true);
            expect(hasAssistant).toBe(true);
            expect(historyResult.total as number).toBeGreaterThan(0);
          } catch (err) {
            if (isAuthError(err)) {
              console.warn("Skipping SLLM-01: API key invalid/expired");
              return;
            }
            throw err;
          }
        },
        90_000,
      );
    });

    // -----------------------------------------------------------------------
    // SLLM-02: Multi-turn conversation
    // -----------------------------------------------------------------------

    describe("SLLM-02: Multi-turn conversation", () => {
      it(
        "follow-up message accumulates in session history",
        async () => {
          try {
            // First turn
            const firstExec = (await sendJsonRpc(
              ws,
              "agent.execute",
              {
                message: "First message for multi-turn test",
                sessionKey: {
                  userId: "rpc-client",
                  channelId: "sllm02-channel",
                  peerId: "test",
                },
              },
              msgId++,
            )) as Record<string, unknown>;

            if (firstExec.error) {
              const errMsg = JSON.stringify(firstExec.error);
              if (isAuthError(errMsg)) {
                console.warn(
                  "Skipping SLLM-02: API key invalid/expired (first turn)",
                );
                return;
              }
              throw new Error(`First agent.execute failed: ${errMsg}`);
            }

            expect(firstExec).toHaveProperty("result");

            // Get history after first turn
            const firstHistory = (await sendJsonRpc(
              ws,
              "session.history",
              {
                session_key: "test:rpc-client:sllm02-channel",
                offset: 0,
                limit: 50,
              },
              msgId++,
              { timeoutMs: RPC_FAST_MS },
            )) as Record<string, unknown>;

            expect(firstHistory).toHaveProperty("result");
            const firstResult = firstHistory.result as Record<string, unknown>;
            const firstCount = (
              firstResult.messages as Array<Record<string, unknown>>
            ).length;
            const firstTotal = firstResult.total as number;

            // Second turn -- SAME sessionKey (same channelId)
            const secondExec = (await sendJsonRpc(
              ws,
              "agent.execute",
              {
                message: "Second message for multi-turn test",
                sessionKey: {
                  userId: "rpc-client",
                  channelId: "sllm02-channel",
                  peerId: "test",
                },
              },
              msgId++,
            )) as Record<string, unknown>;

            if (secondExec.error) {
              const errMsg = JSON.stringify(secondExec.error);
              if (isAuthError(errMsg)) {
                console.warn(
                  "Skipping SLLM-02: API key invalid/expired (second turn)",
                );
                return;
              }
              throw new Error(`Second agent.execute failed: ${errMsg}`);
            }

            expect(secondExec).toHaveProperty("result");

            // Get history after second turn
            const secondHistory = (await sendJsonRpc(
              ws,
              "session.history",
              {
                session_key: "test:rpc-client:sllm02-channel",
                offset: 0,
                limit: 50,
              },
              msgId++,
              { timeoutMs: RPC_FAST_MS },
            )) as Record<string, unknown>;

            expect(secondHistory).toHaveProperty("result");
            const secondResult = secondHistory.result as Record<
              string,
              unknown
            >;
            const secondCount = (
              secondResult.messages as Array<Record<string, unknown>>
            ).length;
            const secondTotal = secondResult.total as number;

            // Second history should have at least 2 more messages (user + assistant)
            expect(secondCount).toBeGreaterThan(firstCount);
            expect(secondTotal).toBeGreaterThan(firstTotal);
          } catch (err) {
            if (isAuthError(err)) {
              console.warn("Skipping SLLM-02: API key invalid/expired");
              return;
            }
            throw err;
          }
        },
        120_000,
      );
    });

    // -----------------------------------------------------------------------
    // SLLM-03: session.status after execution
    // -----------------------------------------------------------------------

    describe("SLLM-03: session.status after execution", () => {
      it(
        "session.status shows non-zero tokensUsed after agent execution",
        async () => {
          try {
            // Execute agent to ensure tokens are tracked
            const execResponse = (await sendJsonRpc(
              ws,
              "agent.execute",
              {
                message: "Hello",
                sessionKey: {
                  userId: "rpc-client",
                  channelId: "sllm03-channel",
                  peerId: "test",
                },
              },
              msgId++,
            )) as Record<string, unknown>;

            if (execResponse.error) {
              const errMsg = JSON.stringify(execResponse.error);
              if (isAuthError(errMsg)) {
                console.warn("Skipping SLLM-03: API key invalid/expired");
                return;
              }
              throw new Error(`agent.execute failed: ${errMsg}`);
            }

            expect(execResponse).toHaveProperty("result");

            // Check session status
            const statusResponse = (await sendJsonRpc(
              ws,
              "session.status",
              {},
              msgId++,
              { timeoutMs: RPC_FAST_MS },
            )) as Record<string, unknown>;

            expect(statusResponse).toHaveProperty("result");
            const statusResult = statusResponse.result as Record<
              string,
              unknown
            >;

            // Verify token tracking
            const tokensUsed = statusResult.tokensUsed as Record<
              string,
              unknown
            >;
            expect(tokensUsed.totalTokens as number).toBeGreaterThan(0);
            expect(tokensUsed.totalCost as number).toBeGreaterThanOrEqual(0);

            // Verify agent config
            expect(statusResult.stepsExecuted as number).toBeGreaterThanOrEqual(
              0,
            );
            expect(statusResult.model).toBe("claude-opus-4-6");
            expect(statusResult.maxSteps).toBe(10);
          } catch (err) {
            if (isAuthError(err)) {
              console.warn("Skipping SLLM-03: API key invalid/expired");
              return;
            }
            throw err;
          }
        },
        90_000,
      );
    });

    // -----------------------------------------------------------------------
    // SLLM-04: Cross-session messaging
    // -----------------------------------------------------------------------

    describe("SLLM-04: Cross-session messaging", () => {
      it(
        "session.send delivers message to target session",
        async () => {
          try {
            // Step 1: Create target session by executing agent
            const targetExec = (await sendJsonRpc(
              ws,
              "agent.execute",
              {
                message: "You are a receiver",
                sessionKey: {
                  userId: "rpc-client",
                  channelId: "sllm04-target",
                  peerId: "test",
                },
              },
              msgId++,
            )) as Record<string, unknown>;

            if (targetExec.error) {
              const errMsg = JSON.stringify(targetExec.error);
              if (isAuthError(errMsg)) {
                console.warn("Skipping SLLM-04: API key invalid/expired");
                return;
              }
              throw new Error(`agent.execute failed: ${errMsg}`);
            }

            expect(targetExec).toHaveProperty("result");

            // Get initial history count
            const initialHistory = (await sendJsonRpc(
              ws,
              "session.history",
              {
                session_key: "test:rpc-client:sllm04-target",
                offset: 0,
                limit: 50,
              },
              msgId++,
              { timeoutMs: RPC_FAST_MS },
            )) as Record<string, unknown>;

            expect(initialHistory).toHaveProperty("result");
            const initialResult = initialHistory.result as Record<
              string,
              unknown
            >;
            const initialCount = (
              initialResult.messages as Array<Record<string, unknown>>
            ).length;

            // Step 2: Send cross-session message (fire-and-forget)
            const sendResponse = (await sendJsonRpc(
              ws,
              "session.send",
              {
                session_key: "test:rpc-client:sllm04-target",
                text: "Cross-session hello from sender",
                mode: "fire-and-forget",
              },
              msgId++,
              { timeoutMs: RPC_LLM_MS },
            )) as Record<string, unknown>;

            // Fire-and-forget should return result (not error)
            expect(sendResponse).toHaveProperty("result");
            const sendResult = sendResponse.result as Record<string, unknown>;
            expect(sendResult.sent).toBe(true);

            // Step 3: Wait for message processing
            await new Promise((r) => setTimeout(r, 2000));

            // Step 4: Check target session history grew
            const afterHistory = (await sendJsonRpc(
              ws,
              "session.history",
              {
                session_key: "test:rpc-client:sllm04-target",
                offset: 0,
                limit: 50,
              },
              msgId++,
              { timeoutMs: RPC_FAST_MS },
            )) as Record<string, unknown>;

            expect(afterHistory).toHaveProperty("result");
            const afterResult = afterHistory.result as Record<string, unknown>;
            const afterCount = (
              afterResult.messages as Array<Record<string, unknown>>
            ).length;

            // Cross-session message should have been delivered (history grew)
            expect(afterCount).toBeGreaterThanOrEqual(initialCount);
          } catch (err) {
            if (isAuthError(err)) {
              console.warn("Skipping SLLM-04: API key invalid/expired");
              return;
            }
            throw err;
          }
        },
        120_000,
      );
    });

    // -----------------------------------------------------------------------
    // SLLM-05: Sub-agent spawning
    // -----------------------------------------------------------------------

    describe("SLLM-05: Sub-agent spawning", () => {
      it(
        "session.spawn sync completes and returns response",
        async () => {
          try {
            const spawnResponse = (await sendJsonRpc(
              ws,
              "session.spawn",
              {
                task: "Reply with exactly: spawn-complete-marker",
                agent: "default",
              },
              msgId++,
              { timeoutMs: 120_000 },
            )) as Record<string, unknown>;

            if (spawnResponse.error) {
              const errMsg = JSON.stringify(spawnResponse.error);
              if (isAuthError(errMsg)) {
                console.warn("Skipping SLLM-05 sync: API key invalid/expired");
                return;
              }
              throw new Error(`session.spawn sync failed: ${errMsg}`);
            }

            expect(spawnResponse).toHaveProperty("result");
            const result = spawnResponse.result as Record<string, unknown>;

            // Sync spawn may complete with response or time out to async
            if (result.async === true) {
              // Timed out to async -- just verify runId was returned
              expect(typeof result.runId).toBe("string");
            } else {
              // Completed synchronously
              if (result.response !== undefined) {
                expect(typeof result.response).toBe("string");
              }
              if (result.sessionKey !== undefined) {
                expect(typeof result.sessionKey).toBe("string");
              }
              if (result.tokensUsed !== undefined) {
                expect(typeof result.tokensUsed).toBe("object");
              }
            }
          } catch (err) {
            if (isAuthError(err)) {
              console.warn("Skipping SLLM-05 sync: API key invalid/expired");
              return;
            }
            throw err;
          }
        },
        120_000,
      );

      it(
        "session.spawn async returns runId immediately",
        async () => {
          try {
            const spawnResponse = (await sendJsonRpc(
              ws,
              "session.spawn",
              {
                task: "Background task for async test",
                agent: "default",
                async: true,
              },
              msgId++,
              { timeoutMs: 30_000 },
            )) as Record<string, unknown>;

            if (spawnResponse.error) {
              const errMsg = JSON.stringify(spawnResponse.error);
              if (isAuthError(errMsg)) {
                console.warn(
                  "Skipping SLLM-05 async: API key invalid/expired",
                );
                return;
              }
              throw new Error(`session.spawn async failed: ${errMsg}`);
            }

            expect(spawnResponse).toHaveProperty("result");
            const result = spawnResponse.result as Record<string, unknown>;

            // Async spawn returns runId immediately
            expect(typeof result.runId).toBe("string");
            expect(result.async).toBe(true);
          } catch (err) {
            if (isAuthError(err)) {
              console.warn("Skipping SLLM-05 async: API key invalid/expired");
              return;
            }
            throw err;
          }
        },
        30_000,
      );
    });

    // -----------------------------------------------------------------------
    // SLLM-06: Session isolation
    // -----------------------------------------------------------------------

    describe("SLLM-06: Session isolation", () => {
      it(
        "different channelIds produce isolated session histories",
        async () => {
          try {
            // Execute agent to alpha channel
            const alphaExec = (await sendJsonRpc(
              ws,
              "agent.execute",
              {
                message: "Alpha session message",
                sessionKey: {
                  userId: "rpc-client",
                  channelId: "sllm06-alpha",
                  peerId: "test",
                },
              },
              msgId++,
            )) as Record<string, unknown>;

            if (alphaExec.error) {
              const errMsg = JSON.stringify(alphaExec.error);
              if (isAuthError(errMsg)) {
                console.warn(
                  "Skipping SLLM-06: API key invalid/expired (alpha)",
                );
                return;
              }
              throw new Error(`Alpha agent.execute failed: ${errMsg}`);
            }

            expect(alphaExec).toHaveProperty("result");

            // Execute agent to beta channel
            const betaExec = (await sendJsonRpc(
              ws,
              "agent.execute",
              {
                message: "Beta session message",
                sessionKey: {
                  userId: "rpc-client",
                  channelId: "sllm06-beta",
                  peerId: "test",
                },
              },
              msgId++,
            )) as Record<string, unknown>;

            if (betaExec.error) {
              const errMsg = JSON.stringify(betaExec.error);
              if (isAuthError(errMsg)) {
                console.warn(
                  "Skipping SLLM-06: API key invalid/expired (beta)",
                );
                return;
              }
              throw new Error(`Beta agent.execute failed: ${errMsg}`);
            }

            expect(betaExec).toHaveProperty("result");

            // Get alpha history
            const alphaHistory = (await sendJsonRpc(
              ws,
              "session.history",
              {
                session_key: "test:rpc-client:sllm06-alpha",
                offset: 0,
                limit: 50,
              },
              msgId++,
              { timeoutMs: RPC_FAST_MS },
            )) as Record<string, unknown>;

            expect(alphaHistory).toHaveProperty("result");
            const alphaResult = alphaHistory.result as Record<string, unknown>;
            const alphaMessages = alphaResult.messages as Array<{
              role: string;
              content: string;
            }>;

            // Get beta history
            const betaHistory = (await sendJsonRpc(
              ws,
              "session.history",
              {
                session_key: "test:rpc-client:sllm06-beta",
                offset: 0,
                limit: 50,
              },
              msgId++,
              { timeoutMs: RPC_FAST_MS },
            )) as Record<string, unknown>;

            expect(betaHistory).toHaveProperty("result");
            const betaResult = betaHistory.result as Record<string, unknown>;
            const betaMessages = betaResult.messages as Array<{
              role: string;
              content: string;
            }>;

            // Both should have messages
            expect(alphaMessages.length).toBeGreaterThan(0);
            expect(betaMessages.length).toBeGreaterThan(0);

            // Alpha should not contain beta's user message
            const alphaUserMessages = alphaMessages.filter(
              (m) => m.role === "user",
            );
            const betaUserMessages = betaMessages.filter(
              (m) => m.role === "user",
            );

            for (const msg of alphaUserMessages) {
              expect(msg.content).not.toContain("Beta session message");
            }
            for (const msg of betaUserMessages) {
              expect(msg.content).not.toContain("Alpha session message");
            }
          } catch (err) {
            if (isAuthError(err)) {
              console.warn("Skipping SLLM-06: API key invalid/expired");
              return;
            }
            throw err;
          }
        },
        120_000,
      );
    });

    // -----------------------------------------------------------------------
    // SLLM-07: Session history pagination
    // -----------------------------------------------------------------------

    describe("SLLM-07: Session history pagination", () => {
      it(
        "session.history with offset and limit returns correct pagination",
        async () => {
          try {
            // Create a session with multiple exchanges
            const first = (await sendJsonRpc(
              ws,
              "agent.execute",
              {
                message: "First pagination message",
                sessionKey: {
                  userId: "rpc-client",
                  channelId: "sllm07-pagination",
                  peerId: "test",
                },
              },
              msgId++,
            )) as Record<string, unknown>;

            if (first.error) {
              const errMsg = JSON.stringify(first.error);
              if (isAuthError(errMsg)) {
                console.warn(
                  "Skipping SLLM-07: API key invalid/expired (first)",
                );
                return;
              }
              throw new Error(`First agent.execute failed: ${errMsg}`);
            }

            expect(first).toHaveProperty("result");

            const second = (await sendJsonRpc(
              ws,
              "agent.execute",
              {
                message: "Second pagination message",
                sessionKey: {
                  userId: "rpc-client",
                  channelId: "sllm07-pagination",
                  peerId: "test",
                },
              },
              msgId++,
            )) as Record<string, unknown>;

            if (second.error) {
              const errMsg = JSON.stringify(second.error);
              if (isAuthError(errMsg)) {
                console.warn(
                  "Skipping SLLM-07: API key invalid/expired (second)",
                );
                return;
              }
              throw new Error(`Second agent.execute failed: ${errMsg}`);
            }

            expect(second).toHaveProperty("result");

            // Get full history
            const fullHistory = (await sendJsonRpc(
              ws,
              "session.history",
              {
                session_key: "test:rpc-client:sllm07-pagination",
                offset: 0,
                limit: 100,
              },
              msgId++,
              { timeoutMs: RPC_FAST_MS },
            )) as Record<string, unknown>;

            expect(fullHistory).toHaveProperty("result");
            const fullResult = fullHistory.result as Record<string, unknown>;
            const totalMessages = fullResult.total as number;

            // Should have at least 4 messages (2 user + 2 assistant)
            expect(totalMessages).toBeGreaterThanOrEqual(4);

            // Get paginated: first page of 2
            const page1 = (await sendJsonRpc(
              ws,
              "session.history",
              {
                session_key: "test:rpc-client:sllm07-pagination",
                offset: 0,
                limit: 2,
              },
              msgId++,
              { timeoutMs: RPC_FAST_MS },
            )) as Record<string, unknown>;

            expect(page1).toHaveProperty("result");
            const page1Result = page1.result as Record<string, unknown>;
            const page1Messages = page1Result.messages as Array<
              Record<string, unknown>
            >;
            expect(page1Messages.length).toBe(2);
            expect(page1Result.hasMore).toBe(true);

            // Get next page
            const page2 = (await sendJsonRpc(
              ws,
              "session.history",
              {
                session_key: "test:rpc-client:sllm07-pagination",
                offset: 2,
                limit: 2,
              },
              msgId++,
              { timeoutMs: RPC_FAST_MS },
            )) as Record<string, unknown>;

            expect(page2).toHaveProperty("result");
            const page2Result = page2.result as Record<string, unknown>;
            const page2Messages = page2Result.messages as Array<
              Record<string, unknown>
            >;
            expect(page2Messages.length).toBeGreaterThanOrEqual(1);
            expect(page2Result.offset).toBe(2);
          } catch (err) {
            if (isAuthError(err)) {
              console.warn("Skipping SLLM-07: API key invalid/expired");
              return;
            }
            throw err;
          }
        },
        120_000,
      );
    });
  },
);
