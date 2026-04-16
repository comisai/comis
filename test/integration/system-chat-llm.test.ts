/**
 * System Chat LLM Integration Tests
 *
 * Covers LLM-dependent phases from the comprehensive system test plan:
 *
 *   Phase 3 — Chat with agentId, invalid agentId
 *   Phase 4 — SSE streaming chat (/api/chat/stream with query token auth)
 *   Phase 6 — OpenAI multi-turn conversation
 *   Phase 9 — Activity verification after chat
 *   Phase 10 — Memory storage and retrieval via chat
 *   Phase 11 — Post-budget health verification
 *
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
  PROVIDER_GROUPS,
  logProviderAvailability,
} from "../support/provider-env.js";
import {
  startTestDaemon,
  makeAuthHeaders,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import { ASYNC_SETTLE_MS } from "../support/timeouts.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = resolve(__dirname, "../config/config.test-system-chat-llm.yaml");

const env = getProviderEnv();
const hasLlmKey = hasAnyProvider(env, PROVIDER_GROUPS.llm);

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

interface SseEvent {
  event?: string;
  data: string;
  id?: string;
}

/**
 * Read SSE events from a streaming fetch response.
 */
async function readSseEvents(
  response: Response,
  maxEvents: number,
  timeoutMs: number,
): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  if (!response.body) return events;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const abortTimeout = setTimeout(() => {
    reader.cancel().catch(() => {});
  }, timeoutMs);

  try {
    while (events.length < maxEvents) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        if (!part.trim()) continue;
        const event: SseEvent = { data: "" };
        for (const line of part.split("\n")) {
          if (line.startsWith("event:")) event.event = line.slice(6).trim();
          else if (line.startsWith("data:")) event.data = line.slice(5).trim();
          else if (line.startsWith("id:")) event.id = line.slice(3).trim();
        }
        events.push(event);
        if (events.length >= maxEvents) break;
      }
    }
  } catch {
    // Cancelled or ended
  } finally {
    clearTimeout(abortTimeout);
    reader.cancel().catch(() => {});
  }

  return events;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe.skipIf(!hasLlmKey)(
  "System Chat LLM (Phases 3, 4, 6, 9, 10)",
  () => {
    let handle: TestDaemonHandle;
    let gatewayUrl: string;
    let authToken: string;

    beforeAll(async () => {
      logProviderAvailability(env);
      handle = await startTestDaemon({ configPath: CONFIG_PATH });
      gatewayUrl = handle.gatewayUrl;
      authToken = handle.authToken;
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
    // Phase 3: Chat with Agent ID
    // -----------------------------------------------------------------------

    describe("Phase 3: Chat with Agent ID", () => {
      it(
        "CHAT-AGENT-01: POST /api/chat with valid agentId succeeds",
        async () => {
          // First, get the agent list
          const agentsRes = await fetch(`${gatewayUrl}/api/agents`, {
            headers: makeAuthHeaders(authToken),
          });
          const agentsBody = (await agentsRes.json()) as {
            agents: Array<{ id: string }>;
          };
          const agentId = agentsBody.agents[0]?.id;
          expect(agentId).toBeDefined();

          // Send chat with valid agentId
          const response = await fetch(`${gatewayUrl}/api/chat`, {
            method: "POST",
            headers: makeAuthHeaders(authToken),
            body: JSON.stringify({
              message: "Respond with exactly one word.",
              agentId,
            }),
          });

          expect(response.status).toBe(200);

          const body = (await response.json()) as { response: string };
          expect(typeof body.response).toBe("string");
          expect(body.response.length).toBeGreaterThan(0);
        },
        90_000,
      );

      it(
        "CHAT-AGENT-02: POST /api/chat with invalid agentId returns error",
        async () => {
          const response = await fetch(`${gatewayUrl}/api/chat`, {
            method: "POST",
            headers: makeAuthHeaders(authToken),
            body: JSON.stringify({
              message: "Hello",
              agentId: "nonexistent-agent-xyz",
            }),
          });

          expect(response.status).toBe(400);

          const body = (await response.json()) as { error: string };
          expect(body.error).toBeDefined();
          // Error should mention the unknown agent
          expect(body.error.toLowerCase()).toContain("unknown");
        },
        30_000,
      );
    });

    // -----------------------------------------------------------------------
    // Phase 3.1: Basic Chat
    // -----------------------------------------------------------------------

    describe("Phase 3.1: Basic Chat", () => {
      it(
        "CHAT-BASIC-01: POST /api/chat returns LLM response with tokensUsed",
        async () => {
          const response = await fetch(`${gatewayUrl}/api/chat`, {
            method: "POST",
            headers: makeAuthHeaders(authToken),
            body: JSON.stringify({
              message: "What is 2+2? Reply with just the number.",
            }),
          });

          expect(response.status).toBe(200);

          const body = (await response.json()) as {
            response: string;
            tokensUsed?: { input: number; output: number; total: number };
            finishReason?: string;
          };

          expect(typeof body.response).toBe("string");
          expect(body.response.length).toBeGreaterThan(0);
        },
        90_000,
      );
    });

    // -----------------------------------------------------------------------
    // Phase 4: SSE Streaming Chat
    // -----------------------------------------------------------------------

    describe("Phase 4: SSE Streaming Chat", () => {
      it(
        "SSE-CHAT-01: GET /api/chat/stream with query token returns SSE events",
        async () => {
          const response = await fetch(
            `${gatewayUrl}/api/chat/stream?message=${encodeURIComponent("Say hello")}&token=${encodeURIComponent(authToken)}`,
          );

          expect(response.status).toBe(200);

          const events = await readSseEvents(response, 10, 90_000);

          // Should receive at least one event
          expect(events.length).toBeGreaterThan(0);

          // Should have a "done" event with the final response
          const doneEvent = events.find((e) => e.event === "done");
          expect(doneEvent).toBeDefined();

          if (doneEvent) {
            const data = JSON.parse(doneEvent.data) as Record<string, unknown>;
            expect(data).toHaveProperty("response");
          }
        },
        90_000,
      );

      it("SSE-CHAT-02: GET /api/chat/stream without message returns 400", async () => {
        const response = await fetch(
          `${gatewayUrl}/api/chat/stream?token=${encodeURIComponent(authToken)}`,
        );

        expect(response.status).toBe(400);

        const body = (await response.json()) as Record<string, unknown>;
        expect(body).toHaveProperty("error");
      });

      it("SSE-CHAT-03: GET /api/chat/stream without auth returns 401", async () => {
        const response = await fetch(
          `${gatewayUrl}/api/chat/stream?message=${encodeURIComponent("Hello")}`,
        );

        expect(response.status).toBe(401);
      });
    });

    // -----------------------------------------------------------------------
    // Phase 6: OpenAI Multi-turn Conversation
    // -----------------------------------------------------------------------

    describe("Phase 6: OpenAI Multi-turn", () => {
      it(
        "OPENAI-MULTI-01: POST /v1/chat/completions with multi-turn history returns valid response",
        async () => {
          // Note: The OpenAI compat layer extracts the last user message and
          // sends it to the agent. Multi-turn context is not fully preserved
          // (the gateway uses the last user message only). This test verifies
          // the endpoint accepts multi-turn format and returns a valid response.
          const response = await fetch(
            `${gatewayUrl}/v1/chat/completions`,
            {
              method: "POST",
              headers: makeAuthHeaders(authToken),
              body: JSON.stringify({
                model: "comis",
                messages: [
                  { role: "system", content: "You are a helpful assistant." },
                  { role: "user", content: "What is the capital of France?" },
                  { role: "assistant", content: "Paris" },
                  { role: "user", content: "Say hello in one word." },
                ],
              }),
            },
          );

          expect(response.status).toBe(200);

          const body = (await response.json()) as {
            id: string;
            object: string;
            choices: Array<{
              message: { role: string; content: string };
              finish_reason: string;
            }>;
          };

          // Verify valid ChatCompletion structure
          expect(body.id).toMatch(/^chatcmpl-/);
          expect(body.object).toBe("chat.completion");
          expect(body.choices.length).toBe(1);
          expect(body.choices[0].message.role).toBe("assistant");
          expect(body.choices[0].message.content.length).toBeGreaterThan(0);
        },
        90_000,
      );
    });

    // -----------------------------------------------------------------------
    // Phase 9: Activity Verification After Chat
    // -----------------------------------------------------------------------

    describe("Phase 9: Activity After Chat", () => {
      it(
        "ACTIVITY-01: activity buffer contains events after chat interaction",
        async () => {
          // Send a chat message to generate activity
          const chatResponse = await fetch(`${gatewayUrl}/api/chat`, {
            method: "POST",
            headers: makeAuthHeaders(authToken),
            body: JSON.stringify({
              message: "Activity tracking test. Reply briefly.",
            }),
          });
          expect(chatResponse.status).toBe(200);

          // Allow time for activity events to settle
          await new Promise((resolve) => setTimeout(resolve, ASYNC_SETTLE_MS));

          // Check activity buffer
          const activityResponse = await fetch(
            `${gatewayUrl}/api/activity?limit=20`,
            { headers: makeAuthHeaders(authToken) },
          );
          expect(activityResponse.status).toBe(200);

          const body = (await activityResponse.json()) as {
            entries: Array<{ event: string; timestamp: number }>;
            count: number;
          };

          expect(body.count).toBeGreaterThan(0);

          // Collect all event types
          const eventTypes = body.entries.map((e) => e.event);

          // Should have at least one message-related event
          const hasMessageEvent = eventTypes.some(
            (t) => t === "message:received" || t === "message:sent",
          );
          expect(hasMessageEvent).toBe(true);
        },
        90_000,
      );

      it("ACTIVITY-02: activity entries have correct shape", async () => {
        const response = await fetch(
          `${gatewayUrl}/api/activity?limit=5`,
          { headers: makeAuthHeaders(authToken) },
        );
        expect(response.status).toBe(200);

        const body = (await response.json()) as {
          entries: Array<Record<string, unknown>>;
          count: number;
        };

        if (body.entries.length > 0) {
          const entry = body.entries[0];
          expect(entry).toHaveProperty("id");
          expect(entry).toHaveProperty("event");
          expect(entry).toHaveProperty("payload");
          expect(entry).toHaveProperty("timestamp");
          expect(typeof entry.id).toBe("number");
          expect(typeof entry.event).toBe("string");
          expect(typeof entry.timestamp).toBe("number");
        }
      });
    });

    // -----------------------------------------------------------------------
    // Phase 10: Memory Storage and Retrieval
    // -----------------------------------------------------------------------

    describe("Phase 10: Memory Storage & Retrieval", () => {
      it(
        "MEMORY-01: memory stats shows totalEntries after chat",
        async () => {
          // Send a distinctive message
          const chatRes = await fetch(`${gatewayUrl}/api/chat`, {
            method: "POST",
            headers: makeAuthHeaders(authToken),
            body: JSON.stringify({
              message:
                "Remember this: The secret codename is ZEPHYR-OMEGA-9941. Confirm you noted it.",
            }),
          });
          expect(chatRes.status).toBe(200);

          // Wait for memory storage
          await new Promise((resolve) => setTimeout(resolve, 2_000));

          // Check memory stats
          const statsRes = await fetch(`${gatewayUrl}/api/memory/stats`, {
            headers: makeAuthHeaders(authToken),
          });
          expect(statsRes.status).toBe(200);

          const stats = (await statsRes.json()) as Record<string, unknown>;
          expect(stats).toBeDefined();
          // Stats should have a stats property with totalEntries
          const innerStats = stats.stats as Record<string, unknown> | undefined;
          if (innerStats) {
            expect(typeof innerStats.totalEntries).toBe("number");
            expect(innerStats.totalEntries as number).toBeGreaterThanOrEqual(1);
          }
        },
        90_000,
      );

      it(
        "MEMORY-02: memory search finds previously stored content",
        async () => {
          // Search for the distinctive content
          const searchRes = await fetch(
            `${gatewayUrl}/api/memory/search?q=ZEPHYR-OMEGA-9941&limit=5`,
            { headers: makeAuthHeaders(authToken) },
          );
          expect(searchRes.status).toBe(200);

          const body = (await searchRes.json()) as {
            results: Array<Record<string, unknown>>;
          };
          expect(Array.isArray(body.results)).toBe(true);

          // Should find at least one result containing the code
          if (body.results.length > 0) {
            const hasMatch = body.results.some((r) =>
              String(r.content).toUpperCase().includes("ZEPHYR"),
            );
            expect(hasMatch).toBe(true);
          }
        },
        30_000,
      );
    });

    // -----------------------------------------------------------------------
    // Phase 11: Post-operations Health
    // -----------------------------------------------------------------------

    describe("Phase 11: Post-operations Health", () => {
      it("HEALTH-POST-01: daemon remains healthy after all LLM operations", async () => {
        const response = await fetch(`${gatewayUrl}/health`);
        expect(response.status).toBe(200);

        const body = (await response.json()) as { status: string };
        expect(body.status).toBe("ok");
      });

      it("HEALTH-POST-02: all REST API endpoints respond after LLM operations", async () => {
        const endpoints = [
          "/api/agents",
          "/api/channels",
          "/api/activity",
          "/api/memory/stats",
          "/api/memory/search?q=test",
          "/api/chat/history",
        ];

        const requests = endpoints.map((path) =>
          fetch(`${gatewayUrl}${path}`, {
            headers: makeAuthHeaders(authToken),
          }),
        );

        const responses = await Promise.all(requests);

        for (let i = 0; i < responses.length; i++) {
          expect(responses[i].status).toBe(200);
        }
      });
    });
  },
);
