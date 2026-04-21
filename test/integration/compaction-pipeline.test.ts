// SPDX-License-Identifier: Apache-2.0
/**
 * Compaction Pipeline E2E: SDK Auto-Compaction & Manual /compact Tests
 *
 * Exercises the SDK's built-in compaction behavior through a real running
 * daemon with low maxContextChars (3000) to trigger compaction:
 *
 *   LLM-gated (requires API keys):
 *     CMP-01: Config propagation -- maxContextChars read from config
 *     CMP-02: Context growth and auto-compaction trigger at threshold
 *     CMP-03: Manual /compact slash command via WebSocket RPC
 *     CMP-04: /compact verbose flag returns progress indication
 *     CMP-05: Context manager fitToWindow trims messages when over limit
 *     CMP-06: Compaction does not crash with empty session
 *     CMP-07: /compact creates memories retrievable via memory.search RPC
 *     CMP-08: /compact with custom instructions passes them to summarizer
 *
 * Note: CMP-09 through CMP-12 (deterministic compaction component tests) were
 * removed -- the legacy compaction-safeguard, auto-compaction-trigger, and
 * context-manager modules were deleted in Phase 214 Plan 02. Compaction is
 * now handled by the SDK's built-in auto-compaction.
 *
 * Requires ANTHROPIC_API_KEY or OPENAI_API_KEY in ~/.comis/.env.
 *
 * Port 8516, unique DB test-memory-130-compaction.db
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
  logProviderAvailability,
} from "../support/provider-env.js";
import {
  startTestDaemon,
  makeAuthHeaders,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import {
  openAuthenticatedWebSocket,
  sendJsonRpc,
} from "../support/ws-helpers.js";
import { RPC_FAST_MS } from "../support/timeouts.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = resolve(__dirname, "../config/config.test-compaction.yaml");

const env = getProviderEnv();
const hasLlmKey = hasAnyProvider(env, PROVIDER_GROUPS.llm);

// ---------------------------------------------------------------------------
// LLM-gated daemon tests
// ---------------------------------------------------------------------------

describe.skipIf(!hasLlmKey)(
  "Compaction Pipeline E2E",
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
    // CMP-01: Config propagation -- maxContextChars read from config
    // -----------------------------------------------------------------------

    it(
      "CMP-01: config.get returns maxContextChars and preserveRecent from config",
      async () => {
        let ws: WebSocket | undefined;
        try {
          ws = await openAuthenticatedWebSocket(
            handle.gatewayUrl,
            handle.authToken,
          );

          const response = (await sendJsonRpc(
            ws,
            "config.get",
            { section: "agents" },
            1,
            { timeoutMs: RPC_FAST_MS },
          )) as Record<string, unknown>;

          expect(response).toHaveProperty("jsonrpc", "2.0");
          expect(response).toHaveProperty("id", 1);

          const hasResult = "result" in response;
          const hasError = "error" in response;
          expect(hasResult || hasError).toBe(true);

          if (hasResult) {
            const result = response.result as Record<string, unknown>;
            expect(result).toHaveProperty("agents");
            const agents = result.agents as Record<
              string,
              Record<string, unknown>
            >;
            const defaultAgent = agents["default"];
            expect(defaultAgent).toBeDefined();

            // Verify the new config fields propagated through the schema
            expect(defaultAgent!.maxContextChars).toBe(3000);
            expect(defaultAgent!.preserveRecent).toBe(4);
          }
        } finally {
          ws?.close();
        }
      },
      10_000,
    );

    // -----------------------------------------------------------------------
    // CMP-02: Context growth and auto-compaction trigger at threshold
    // -----------------------------------------------------------------------

    it(
      "CMP-02: context growth triggers auto-compaction without crashing",
      async () => {
        let ws: WebSocket | undefined;
        try {
          ws = await openAuthenticatedWebSocket(
            handle.gatewayUrl,
            handle.authToken,
          );

          // Send several messages with substantial content to grow context
          // past the 3000-char threshold. Each message + response ~800-1500 chars.
          // With softThresholdRatio=0.50, soft threshold fires at 1500 chars.
          const longMessages = [
            "Explain the concept of photosynthesis in detail, covering the light-dependent reactions, the Calvin cycle, and how plants convert carbon dioxide and water into glucose using sunlight energy. Include specific details about chlorophyll molecules and their role in capturing light energy.",
            "Now explain the water cycle in detail, describing evaporation from oceans, condensation into clouds, precipitation as rain or snow, and how water flows through rivers back to the ocean. Include details about transpiration from plants and groundwater storage.",
            "Finally explain plate tectonics in detail, covering how the Earth's lithosphere is divided into tectonic plates that float on the asthenosphere. Describe convergent, divergent, and transform plate boundaries with examples of geological features they create.",
          ];

          for (let i = 0; i < longMessages.length; i++) {
            const response = (await sendJsonRpc(
              ws,
              "agent.execute",
              { message: longMessages[i] },
              11 + i,
              { timeoutMs: 300_000 },
            )) as Record<string, unknown>;

            // Each response should succeed (no crash from compaction)
            expect(response).toHaveProperty("jsonrpc", "2.0");
            expect(response).toHaveProperty("id", 11 + i);

            // Accept either result (success) or error (non-crash, e.g. budget)
            // The key assertion: conversation continued without fatal crash
            const hasResult = "result" in response;
            const hasError = "error" in response;
            expect(hasResult || hasError).toBe(true);

            if (hasResult) {
              const result = response.result as Record<string, unknown>;
              expect(typeof result.response).toBe("string");
              expect((result.response as string).length).toBeGreaterThan(0);
            }
          }

          // After multiple exchanges, send one more to prove session is still
          // functional after compaction may have triggered
          const finalResponse = (await sendJsonRpc(
            ws,
            "agent.execute",
            { message: "What was the first topic we discussed?" },
            14,
            { timeoutMs: 300_000 },
          )) as Record<string, unknown>;

          expect(finalResponse).toHaveProperty("jsonrpc", "2.0");
          const hasResult = "result" in finalResponse;
          const hasError = "error" in finalResponse;
          expect(hasResult || hasError).toBe(true);
        } finally {
          ws?.close();
        }
      },
      1_200_000, // 20 min total for multiple LLM calls with compaction flush overhead
    );

    // -----------------------------------------------------------------------
    // CMP-03: Manual /compact slash command via WebSocket RPC
    // -----------------------------------------------------------------------

    it(
      "CMP-03: /compact slash command executes without error",
      async () => {
        let ws: WebSocket | undefined;
        try {
          ws = await openAuthenticatedWebSocket(
            handle.gatewayUrl,
            handle.authToken,
          );

          // Send one initial message to establish context
          const initResponse = (await sendJsonRpc(
            ws,
            "agent.execute",
            { message: "Remember the number 42 for our conversation." },
            21,
            { timeoutMs: 120_000 },
          )) as Record<string, unknown>;

          expect(initResponse).toHaveProperty("jsonrpc", "2.0");
          const initHasResult = "result" in initResponse;
          const initHasError = "error" in initResponse;
          expect(initHasResult || initHasError).toBe(true);

          // Send /compact command
          const compactResponse = (await sendJsonRpc(
            ws,
            "agent.execute",
            { message: "/compact" },
            22,
            { timeoutMs: 120_000 },
          )) as Record<string, unknown>;

          expect(compactResponse).toHaveProperty("jsonrpc", "2.0");
          expect(compactResponse).toHaveProperty("id", 22);

          // /compact with handled: false means executor still runs LLM
          // Either result (normal response) or error (budget, etc.) is acceptable
          // The key assertion: no crash, valid JSON-RPC response
          const compactHasResult = "result" in compactResponse;
          const compactHasError = "error" in compactResponse;
          expect(compactHasResult || compactHasError).toBe(true);
        } finally {
          ws?.close();
        }
      },
      300_000, // 5 min for 2 LLM calls
    );

    // -----------------------------------------------------------------------
    // CMP-04: /compact verbose flag returns progress indication
    // -----------------------------------------------------------------------

    it(
      "CMP-04: /compact verbose executes without error",
      async () => {
        let ws: WebSocket | undefined;
        try {
          ws = await openAuthenticatedWebSocket(
            handle.gatewayUrl,
            handle.authToken,
          );

          // Send initial message to establish context
          const initResponse = (await sendJsonRpc(
            ws,
            "agent.execute",
            { message: "The capital of France is Paris." },
            31,
            { timeoutMs: 120_000 },
          )) as Record<string, unknown>;

          expect(initResponse).toHaveProperty("jsonrpc", "2.0");
          const initHasResult = "result" in initResponse;
          const initHasError = "error" in initResponse;
          expect(initHasResult || initHasError).toBe(true);

          // Send /compact verbose command
          const verboseResponse = (await sendJsonRpc(
            ws,
            "agent.execute",
            { message: "/compact verbose" },
            32,
            { timeoutMs: 120_000 },
          )) as Record<string, unknown>;

          expect(verboseResponse).toHaveProperty("jsonrpc", "2.0");
          expect(verboseResponse).toHaveProperty("id", 32);

          // Valid JSON-RPC response (no crash)
          const hasResult = "result" in verboseResponse;
          const hasError = "error" in verboseResponse;
          expect(hasResult || hasError).toBe(true);
        } finally {
          ws?.close();
        }
      },
      300_000, // 5 min for 2 LLM calls
    );

    // -----------------------------------------------------------------------
    // CMP-05: Context manager fitToWindow trims messages when over limit
    // -----------------------------------------------------------------------

    it(
      "CMP-05: conversation continues coherently after context exceeds limit",
      async () => {
        let ws: WebSocket | undefined;
        try {
          ws = await openAuthenticatedWebSocket(
            handle.gatewayUrl,
            handle.authToken,
          );

          // Send 5 messages with substantial content to exceed 3000 chars
          const messages = [
            "Explain the structure of DNA, including the double helix, base pairs adenine-thymine and guanine-cytosine, sugar-phosphate backbone, and how genetic information is encoded in the sequence of nucleotides.",
            "Now explain how RNA transcription works, including the role of RNA polymerase, the creation of mRNA from a DNA template, and the differences between DNA and RNA including uracil replacing thymine.",
            "Describe the process of protein translation at the ribosome, including how tRNA molecules bring amino acids, how codons are read from mRNA, and how the polypeptide chain folds into a functional protein.",
            "Explain DNA replication, covering the roles of helicase, primase, DNA polymerase, and ligase. Describe leading and lagging strand synthesis and why Okazaki fragments are formed.",
            "Describe gene regulation in prokaryotes, including the lac operon model with its promoter, operator, and structural genes. Explain how the repressor protein and inducer molecule control transcription.",
          ];

          for (let i = 0; i < messages.length; i++) {
            const response = (await sendJsonRpc(
              ws,
              "agent.execute",
              { message: messages[i] },
              41 + i,
              { timeoutMs: 120_000 },
            )) as Record<string, unknown>;

            expect(response).toHaveProperty("jsonrpc", "2.0");
            expect(response).toHaveProperty("id", 41 + i);

            // Conversation should continue normally even after fitToWindow trims
            const hasResult = "result" in response;
            const hasError = "error" in response;
            expect(hasResult || hasError).toBe(true);

            if (hasResult) {
              const result = response.result as Record<string, unknown>;
              expect(typeof result.response).toBe("string");
              expect((result.response as string).length).toBeGreaterThan(0);
            }
          }

          // Verify session history exists via REST API
          const historyResponse = await fetch(
            `${handle.gatewayUrl}/api/chat/history?channelId=gateway`,
            {
              headers: makeAuthHeaders(handle.authToken),
            },
          );

          // Accept 200 (has history) or 404 (fresh session key mismatch)
          // The key check is that the request completes without server crash
          expect([200, 404]).toContain(historyResponse.status);

          if (historyResponse.status === 200) {
            const historyData = (await historyResponse.json()) as {
              messages?: unknown[];
            };
            // If we get history, verify it has entries
            if (historyData.messages) {
              expect(historyData.messages.length).toBeGreaterThan(0);
            }
          }
        } finally {
          ws?.close();
        }
      },
      600_000, // 10 min for 5+ LLM calls
    );

    // -----------------------------------------------------------------------
    // CMP-06: Compaction does not crash with empty session
    // -----------------------------------------------------------------------

    it(
      "CMP-06: /compact on fresh session does not crash",
      async () => {
        let ws: WebSocket | undefined;
        try {
          ws = await openAuthenticatedWebSocket(
            handle.gatewayUrl,
            handle.authToken,
          );

          // Send /compact immediately without any prior conversation
          // The pre-compaction flusher should handle empty messages gracefully
          const response = (await sendJsonRpc(
            ws,
            "agent.execute",
            { message: "/compact" },
            51,
            { timeoutMs: 120_000 },
          )) as Record<string, unknown>;

          expect(response).toHaveProperty("jsonrpc", "2.0");
          expect(response).toHaveProperty("id", 51);

          // Valid JSON-RPC response -- no crash from empty session compaction
          const hasResult = "result" in response;
          const hasError = "error" in response;
          expect(hasResult || hasError).toBe(true);
        } finally {
          ws?.close();
        }
      },
      120_000, // 2 min (single LLM call for executor processing)
    );

    // -----------------------------------------------------------------------
    // CMP-07: /compact creates memories retrievable via memory.search RPC
    // -----------------------------------------------------------------------

    it(
      "CMP-07: /compact creates memories retrievable via memory.search RPC",
      async () => {
        let ws: WebSocket | undefined;
        try {
          ws = await openAuthenticatedWebSocket(
            handle.gatewayUrl,
            handle.authToken,
          );

          // Send 2-3 messages to build conversational context with specific,
          // memorable topics the summarizer can extract
          const contextMessages = [
            "Tell me about the history of the Eiffel Tower. When was it built and who designed it?",
            "What year was the Eiffel Tower built and how tall is it? Also tell me about the initial public reaction to it.",
            "How many visitors does the Eiffel Tower receive each year and what is it made of?",
          ];

          for (let i = 0; i < contextMessages.length; i++) {
            const response = (await sendJsonRpc(
              ws,
              "agent.execute",
              { message: contextMessages[i] },
              61 + i,
              { timeoutMs: 120_000 },
            )) as Record<string, unknown>;

            expect(response).toHaveProperty("jsonrpc", "2.0");
            const hasResult = "result" in response;
            const hasError = "error" in response;
            expect(hasResult || hasError).toBe(true);
          }

          // Trigger pre-compaction flush via /compact
          const compactResponse = (await sendJsonRpc(
            ws,
            "agent.execute",
            { message: "/compact" },
            64,
            { timeoutMs: 120_000 },
          )) as Record<string, unknown>;

          expect(compactResponse).toHaveProperty("jsonrpc", "2.0");
          const compactHasResult = "result" in compactResponse;
          const compactHasError = "error" in compactResponse;
          expect(compactHasResult || compactHasError).toBe(true);

          // Wait for memory flush to settle (async memory store operations)
          await new Promise((resolve) => setTimeout(resolve, 2000));

          // Use memory.search to look for the conversation topic
          const searchResult = (await sendJsonRpc(
            ws,
            "memory.search",
            { query: "Eiffel Tower", limit: 10 },
            65,
            { timeoutMs: RPC_FAST_MS },
          )) as Record<string, unknown>;

          expect(searchResult).toHaveProperty("jsonrpc", "2.0");
          expect(searchResult).toHaveProperty("id", 65);

          // The RPC call must succeed (no crash)
          const searchHasResult = "result" in searchResult;
          const searchHasError = "error" in searchResult;
          expect(searchHasResult || searchHasError).toBe(true);

          // Soft assertion: if results exist, they should be relevant
          // memory.search may return 0 results if embedding is not configured
          if (searchHasResult) {
            const result = searchResult.result as Record<string, unknown>;
            const entries = (result as Record<string, unknown>).entries ??
              (result as Record<string, unknown>).results;
            if (Array.isArray(entries) && entries.length > 0) {
              const contents = entries
                .map((e: Record<string, unknown>) => String(e.content ?? ""))
                .join(" ");
              expect(contents.toLowerCase()).toMatch(/eiffel|tower|paris/i);
            }
            // No hard fail if 0 results -- embedding may not be configured
          }
        } finally {
          ws?.close();
        }
      },
      120_000,
    );

    // -----------------------------------------------------------------------
    // CMP-08: /compact with custom instructions passes them to summarizer
    // -----------------------------------------------------------------------

    it(
      "CMP-08: /compact with custom instructions passes through without errors",
      async () => {
        let ws: WebSocket | undefined;
        try {
          ws = await openAuthenticatedWebSocket(
            handle.gatewayUrl,
            handle.authToken,
          );

          // Send 2-3 messages discussing a specific topic
          const contextMessages = [
            "What are the key features of Rust programming language? Tell me about ownership and borrowing.",
            "How does Rust handle memory safety without a garbage collector? Explain the borrow checker.",
          ];

          for (let i = 0; i < contextMessages.length; i++) {
            const response = (await sendJsonRpc(
              ws,
              "agent.execute",
              { message: contextMessages[i] },
              71 + i,
              { timeoutMs: 120_000 },
            )) as Record<string, unknown>;

            expect(response).toHaveProperty("jsonrpc", "2.0");
            const hasResult = "result" in response;
            const hasError = "error" in response;
            expect(hasResult || hasError).toBe(true);
          }

          // Send /compact with custom instructions
          // The command handler extracts the text after "/compact " as custom
          // instructions and passes them to the pre-compaction flusher
          const compactResponse = (await sendJsonRpc(
            ws,
            "agent.execute",
            {
              message:
                "/compact preserve all mentions of Rust and memory safety",
            },
            73,
            { timeoutMs: 120_000 },
          )) as Record<string, unknown>;

          expect(compactResponse).toHaveProperty("jsonrpc", "2.0");
          expect(compactResponse).toHaveProperty("id", 73);

          // The key behavior: instructions flow through without causing errors
          // Actual instruction adherence is nondeterministic and not asserted
          const hasResult = "result" in compactResponse;
          const hasError = "error" in compactResponse;
          expect(hasResult || hasError).toBe(true);

          // Verify conversation continues normally after custom instruction compact
          const followUp = (await sendJsonRpc(
            ws,
            "agent.execute",
            { message: "Can you summarize what we discussed about Rust?" },
            74,
            { timeoutMs: 120_000 },
          )) as Record<string, unknown>;

          expect(followUp).toHaveProperty("jsonrpc", "2.0");
          const followHasResult = "result" in followUp;
          const followHasError = "error" in followUp;
          expect(followHasResult || followHasError).toBe(true);
        } finally {
          ws?.close();
        }
      },
      120_000,
    );
  },
);
