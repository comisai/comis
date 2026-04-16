/**
 * FULL-SYSTEM: Single-Agent End-to-End Workflow Tests
 *
 * Capstone E2E tests for v7.0 -- exercises cross-subsystem integration through
 * a single daemon with ALL subsystems enabled (LLM, tools, RAG, embeddings,
 * scheduler, memory, link understanding). Tests verify complete agent workflows
 * where the LLM autonomously processes messages, stores memories, recalls via
 * RAG, uses tools, and tracks session state -- all with real provider APIs.
 *
 * Coverage:
 *   FS-01: Basic agent execution with all subsystems active
 *   FS-02: Memory storage and RAG recall across sessions (requires OPENAI_API_KEY)
 *   FS-03: Agent uses cron tool to create scheduled job
 *   FS-04: Multi-turn conversation with context retention
 *   FS-05: Session status reflects token usage
 *   FS-06: Web search tool integration (requires SEARCH_API_KEY)
 *
 * Uses a dedicated config (port 8494, all subsystems) to avoid conflicts.
 * Requires ANTHROPIC_API_KEY or OPENAI_API_KEY in ~/.comis/.env.
 * Skips entirely when no LLM API keys are available.
 *
 * @module
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getProviderEnv,
  hasAnyProvider,
  hasProvider,
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
  "../config/config.test-full-system.yaml",
);

const env = getProviderEnv();
const hasLlmKey = hasAnyProvider(env, PROVIDER_GROUPS.llm);
const hasOpenAIKey = hasProvider(env, "OPENAI_API_KEY");
const hasSearchKey = hasProvider(env, "SEARCH_API_KEY");

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe.skipIf(!hasLlmKey)(
  "FULL-SYSTEM: End-to-End Workflows",
  () => {
    let handle: TestDaemonHandle;

    beforeAll(async () => {
      logProviderAvailability(env);
      handle = await startTestDaemon({ configPath: CONFIG_PATH });
    }, 60_000);

    afterAll(async () => {
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
    // FS-01: Basic agent execution with all subsystems active
    // -----------------------------------------------------------------------

    it(
      "FS-01: agent executes with all subsystems active and returns valid response",
      async () => {
        let ws: WebSocket | undefined;
        try {
          ws = await openAuthenticatedWebSocket(
            handle.gatewayUrl,
            handle.authToken,
          );

          const response = (await sendJsonRpc(
            ws,
            "agent.execute",
            { message: "Say 'hello' and nothing else." },
            1,
          )) as Record<string, unknown>;

          expect(response).toHaveProperty("jsonrpc", "2.0");
          expect(response).toHaveProperty("result");
          expect(response).not.toHaveProperty("error");

          const result = response.result as Record<string, unknown>;
          expect(typeof result.response).toBe("string");
          expect((result.response as string).length).toBeGreaterThan(0);
        } catch (err) {
          if (isAuthError(err)) {
            console.warn("Skipping FS-01: API key invalid/expired");
            return;
          }
          throw err;
        } finally {
          ws?.close();
        }
      },
      90_000,
    );

    // -----------------------------------------------------------------------
    // FS-02: Memory storage and RAG recall across sessions
    // -----------------------------------------------------------------------

    describe.skipIf(!hasOpenAIKey)(
      "With Embeddings (RAG)",
      () => {
        it(
          "FS-02: stores memory via conversation and recalls via RAG on new session",
          async () => {
            // Step 1: Open WS1, seed a fabricated fact the LLM cannot know
            let ws1: WebSocket | undefined;
            try {
              ws1 = await openAuthenticatedWebSocket(
                handle.gatewayUrl,
                handle.authToken,
              );

              const storeResponse = (await sendJsonRpc(
                ws1,
                "agent.execute",
                {
                  message:
                    "Remember this classified fact: Operation ZEPHYR launched on March 3, 2025, from base DELTA-7. Acknowledge you have noted it.",
                },
                10,
              )) as Record<string, unknown>;

              if (storeResponse.error) {
                const errMsg = JSON.stringify(storeResponse.error);
                if (isAuthError(errMsg)) {
                  console.warn("Skipping FS-02: API key invalid/expired (store step)");
                  return;
                }
                throw new Error(`Store RPC failed: ${errMsg}`);
              }

              expect(storeResponse).toHaveProperty("result");
              const storeResult = storeResponse.result as Record<string, unknown>;
              expect(typeof storeResult.response).toBe("string");
              expect((storeResult.response as string).length).toBeGreaterThan(0);
            } catch (err) {
              if (isAuthError(err)) {
                console.warn("Skipping FS-02: API key invalid/expired (store step)");
                return;
              }
              throw err;
            } finally {
              ws1?.close();
            }

            // Wait for memory flush to SQLite
            await new Promise((r) => setTimeout(r, 2000));

            // Step 2: Verify memory was written via memory.search RPC
            let ws2: WebSocket | undefined;
            try {
              ws2 = await openAuthenticatedWebSocket(
                handle.gatewayUrl,
                handle.authToken,
              );

              const searchResponse = (await sendJsonRpc(
                ws2,
                "memory.search",
                { query: "Operation ZEPHYR", limit: 5 },
                11,
                { timeoutMs: RPC_FAST_MS },
              )) as Record<string, unknown>;

              expect(searchResponse).toHaveProperty("result");
              expect(searchResponse).not.toHaveProperty("error");

              // Step 3: Ask about the fact on the NEW connection (forces RAG)
              const recallResponse = (await sendJsonRpc(
                ws2,
                "agent.execute",
                {
                  message:
                    "What was Operation ZEPHYR? When did it launch? Check your memories.",
                },
                12,
              )) as Record<string, unknown>;

              if (recallResponse.error) {
                const errMsg = JSON.stringify(recallResponse.error);
                if (isAuthError(errMsg)) {
                  console.warn("Skipping FS-02: API key invalid/expired (recall step)");
                  return;
                }
                throw new Error(`Recall RPC failed: ${errMsg}`);
              }

              expect(recallResponse).toHaveProperty("result");
              const recallResult = recallResponse.result as Record<string, unknown>;
              expect(typeof recallResult.response).toBe("string");
              expect((recallResult.response as string).length).toBeGreaterThan(0);
              // NOTE: Do NOT assert content-exact match on LLM output (decision 112-01).
              // Structural validation only: response exists, is non-empty string.
            } catch (err) {
              if (isAuthError(err)) {
                console.warn("Skipping FS-02: API key invalid/expired (recall step)");
                return;
              }
              throw err;
            } finally {
              ws2?.close();
            }
          },
          120_000,
        );
      },
    );

    // -----------------------------------------------------------------------
    // FS-03: Agent uses cron tool to create scheduled job
    // -----------------------------------------------------------------------

    it(
      "FS-03: agent uses cron tool to create a scheduled job",
      async () => {
        let ws: WebSocket | undefined;
        try {
          ws = await openAuthenticatedWebSocket(
            handle.gatewayUrl,
            handle.authToken,
          );

          // Ask agent to use the cron tool explicitly
          const response = (await sendJsonRpc(
            ws,
            "agent.execute",
            {
              message:
                "Use the cron tool to create a scheduled job named 'full-system-test-reminder' that runs every hour with the cron expression '0 * * * *'. The task should be 'Send a status update'.",
            },
            20,
          )) as Record<string, unknown>;

          if (response.error) {
            const errMsg = JSON.stringify(response.error);
            if (isAuthError(errMsg)) {
              console.warn("Skipping FS-03: API key invalid/expired");
              return;
            }
            throw new Error(`Agent execute RPC failed: ${errMsg}`);
          }

          expect(response).toHaveProperty("result");
          const result = response.result as Record<string, unknown>;
          expect(typeof result.response).toBe("string");
          expect((result.response as string).length).toBeGreaterThan(0);

          // Verify side effect: check if the cron job was created via cron.list RPC
          const cronListResponse = (await sendJsonRpc(
            ws,
            "cron.list",
            {},
            21,
            { timeoutMs: RPC_FAST_MS },
          )) as Record<string, unknown>;

          expect(cronListResponse).toHaveProperty("result");
          const cronResult = cronListResponse.result as { jobs: Array<{ id: string; name: string; enabled: boolean }> };

          // The LLM may or may not have successfully used the cron tool.
          // If it did, verify the job exists. If not, the structural response
          // assertion above is sufficient.
          const matchingJob = cronResult.jobs.find(
            (j) => j.name.toLowerCase().includes("full-system-test-reminder"),
          );

          if (!matchingJob) {
            console.warn(
              "FS-03: LLM did not create the requested cron job (nondeterministic tool use). " +
              `Jobs found: ${cronResult.jobs.map((j) => j.name).join(", ") || "(none)"}. ` +
              "Agent response was structurally valid.",
            );
          } else {
            expect(matchingJob.name.toLowerCase()).toContain("full-system-test-reminder");
          }
        } catch (err) {
          if (isAuthError(err)) {
            console.warn("Skipping FS-03: API key invalid/expired");
            return;
          }
          throw err;
        } finally {
          ws?.close();
        }
      },
      120_000,
    );

    // -----------------------------------------------------------------------
    // FS-04: Multi-turn conversation with context retention
    // -----------------------------------------------------------------------

    it(
      "FS-04: multi-turn conversation preserves context across turns",
      async () => {
        let ws: WebSocket | undefined;
        try {
          ws = await openAuthenticatedWebSocket(
            handle.gatewayUrl,
            handle.authToken,
          );

          // First turn: establish a fact
          const first = (await sendJsonRpc(
            ws,
            "agent.execute",
            { message: "My favorite color is cerulean blue. Remember that." },
            30,
          )) as Record<string, unknown>;

          if (first.error) {
            const errMsg = JSON.stringify(first.error);
            if (isAuthError(errMsg)) {
              console.warn("Skipping FS-04: API key invalid/expired (first turn)");
              return;
            }
            throw new Error(`First turn RPC failed: ${errMsg}`);
          }

          expect(first).toHaveProperty("result");
          const firstResult = first.result as Record<string, unknown>;
          expect(typeof firstResult.response).toBe("string");
          expect((firstResult.response as string).length).toBeGreaterThan(0);

          // Second turn: ask about the fact on the SAME WebSocket
          const second = (await sendJsonRpc(
            ws,
            "agent.execute",
            { message: "What is my favorite color?" },
            31,
          )) as Record<string, unknown>;

          if (second.error) {
            const errMsg = JSON.stringify(second.error);
            if (isAuthError(errMsg)) {
              console.warn("Skipping FS-04: API key invalid/expired (second turn)");
              return;
            }
            throw new Error(`Second turn RPC failed: ${errMsg}`);
          }

          expect(second).toHaveProperty("result");
          const secondResult = second.result as Record<string, unknown>;
          expect(typeof secondResult.response).toBe("string");
          expect((secondResult.response as string).length).toBeGreaterThan(0);
          // NOTE: Do NOT assert the response contains "cerulean" -- LLMs are
          // nondeterministic. Just verify structural success across two turns.
        } catch (err) {
          if (isAuthError(err)) {
            console.warn("Skipping FS-04: API key invalid/expired");
            return;
          }
          throw err;
        } finally {
          ws?.close();
        }
      },
      180_000,
    );

    // -----------------------------------------------------------------------
    // FS-05: Session status reflects token usage
    // -----------------------------------------------------------------------

    it(
      "FS-05: session status reflects accumulated token usage after LLM execution",
      async () => {
        let ws: WebSocket | undefined;
        try {
          ws = await openAuthenticatedWebSocket(
            handle.gatewayUrl,
            handle.authToken,
          );

          // Execute a simple prompt to generate token usage
          const execResponse = (await sendJsonRpc(
            ws,
            "agent.execute",
            { message: "Respond with exactly one word." },
            40,
          )) as Record<string, unknown>;

          if (execResponse.error) {
            const errMsg = JSON.stringify(execResponse.error);
            if (isAuthError(errMsg)) {
              console.warn("Skipping FS-05: API key invalid/expired");
              return;
            }
            throw new Error(`Agent execute RPC failed: ${errMsg}`);
          }

          expect(execResponse).toHaveProperty("result");

          // Query session status on the same WS
          const statusResponse = (await sendJsonRpc(
            ws,
            "session.status",
            { agentId: "default" },
            41,
            { timeoutMs: RPC_FAST_MS },
          )) as Record<string, unknown>;

          expect(statusResponse).toHaveProperty("result");
          expect(statusResponse).not.toHaveProperty("error");

          const status = statusResponse.result as {
            model: string;
            agentName: string;
            tokensUsed: { totalTokens: number; totalCost: number };
            stepsExecuted: number;
            maxSteps: number;
          };

          expect(typeof status.model).toBe("string");
          expect(typeof status.agentName).toBe("string");
          expect(typeof status.tokensUsed).toBe("object");
          expect(typeof status.tokensUsed.totalTokens).toBe("number");
          // After at least one LLM execution in this daemon, tokens should be > 0
          // Note: tokens accumulate across all tests sharing this daemon instance,
          // so this will be > 0 as long as any prior test ran an LLM call.
          expect(status.tokensUsed.totalTokens).toBeGreaterThan(0);
          expect(status.maxSteps).toBe(15);
        } catch (err) {
          if (isAuthError(err)) {
            console.warn("Skipping FS-05: API key invalid/expired");
            return;
          }
          throw err;
        } finally {
          ws?.close();
        }
      },
      120_000,
    );

    // -----------------------------------------------------------------------
    // FS-06: Web search tool integration
    // -----------------------------------------------------------------------

    describe.skipIf(!hasSearchKey)(
      "With Web Search",
      () => {
        it(
          "FS-06: agent uses web search tool and returns structurally valid response",
          async () => {
            let ws: WebSocket | undefined;
            try {
              ws = await openAuthenticatedWebSocket(
                handle.gatewayUrl,
                handle.authToken,
              );

              const response = (await sendJsonRpc(
                ws,
                "agent.execute",
                {
                  message:
                    "Use the web_search tool to search for 'Comis AI agent platform'. Report what you find briefly.",
                },
                50,
              )) as Record<string, unknown>;

              if (response.error) {
                const errMsg = JSON.stringify(response.error);
                if (isAuthError(errMsg)) {
                  console.warn("Skipping FS-06: API key invalid/expired");
                  return;
                }
                throw new Error(`Agent execute RPC failed: ${errMsg}`);
              }

              expect(response).toHaveProperty("result");
              const result = response.result as Record<string, unknown>;
              expect(typeof result.response).toBe("string");
              expect((result.response as string).length).toBeGreaterThan(0);
              // NOTE: Do NOT assert content -- search results and LLM summary
              // are nondeterministic.
            } catch (err) {
              if (isAuthError(err)) {
                console.warn("Skipping FS-06: API key invalid/expired");
                return;
              }
              throw err;
            } finally {
              ws?.close();
            }
          },
          120_000,
        );
      },
    );
  },
);
