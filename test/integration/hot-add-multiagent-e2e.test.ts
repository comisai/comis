/**
 * Hot-Add Multi-Agent E2E Integration Tests
 *
 * Validates the full multi-agent hot-add/remove workflow end-to-end:
 *   TEST-05-01: Creates agent at runtime and it appears in agents.list
 *   TEST-05-02: Creates multiple agents without restart
 *   TEST-05-03: SSE stream delivers agent:hot_added event on create
 *   TEST-05-04: SSE stream delivers agent:hot_removed event on delete
 *   TEST-05-05: Deleted agent is no longer in agents.list
 *
 * Uses a dedicated config (port 8720, single admin token, separate memory DB)
 * to avoid conflicts with other test suites.
 *
 * Spies on process.kill to no-op SIGUSR1 signals (prevents daemon restart
 * mid-test when agents.create/delete triggers persistToConfig).
 *
 * @module
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  startTestDaemon,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import { RPC_FAST_MS } from "../support/timeouts.js";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = resolve(__dirname, "../config/config.test-hot-add-e2e.yaml");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SseEvent {
  event?: string;
  data: string;
  id?: string;
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Read SSE events from a streaming fetch response.
 *
 * Parses the text/event-stream format: fields separated by newlines,
 * events separated by double newlines. Collects up to maxEvents or
 * until timeoutMs elapsed, then aborts and returns collected events.
 */
async function readSseEvents(
  response: Response,
  maxEvents: number,
  timeoutMs: number,
): Promise<SseEvent[]> {
  const events: SseEvent[] = [];

  if (!response.body) {
    return events;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const abortTimeout = setTimeout(() => {
    reader.cancel().catch(() => {});
  }, timeoutMs);

  try {
    while (events.length < maxEvents) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by double newlines
      const parts = buffer.split("\n\n");

      // The last part may be incomplete; keep it in the buffer
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        if (!part.trim()) {
          continue;
        }

        const event: SseEvent = { data: "" };
        const lines = part.split("\n");

        for (const line of lines) {
          if (line.startsWith("event:")) {
            event.event = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            event.data = line.slice(5).trim();
          } else if (line.startsWith("id:")) {
            event.id = line.slice(3).trim();
          }
        }

        events.push(event);

        if (events.length >= maxEvents) {
          break;
        }
      }
    }
  } catch {
    // Reader was cancelled by timeout or stream ended -- expected
  } finally {
    clearTimeout(abortTimeout);
    reader.cancel().catch(() => {});
  }

  return events;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Hot-Add Multi-Agent E2E Integration", () => {
  let handle: TestDaemonHandle;
  let rpcCall: TestDaemonHandle["daemon"]["rpcCall"];
  let killSpy: ReturnType<typeof vi.spyOn>;

  // Agent IDs created during the suite -- cleaned up in afterAll
  const TEST_AGENT_IDS = [
    "hot-e2e-agent-1",
    "hot-e2e-agent-2",
    "hot-e2e-agent-3",
    "hot-e2e-agent-4",
    "hot-e2e-sse-agent",
    "hot-e2e-del-agent",
    "hot-e2e-gone-agent",
  ];

  beforeAll(async () => {
    // Spy on process.kill to no-op SIGUSR1 signals BEFORE starting the daemon.
    // agents.create/delete triggers persistToConfig which sends SIGUSR1 200ms
    // after success. This kills the daemon mid-test. Suppress it.
    killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
      if (signal === "SIGUSR1") return true; // No-op: suppress restart signal during tests
      return process.kill.call(process, pid, signal as string);
    }) as typeof process.kill);

    handle = await startTestDaemon({ configPath: CONFIG_PATH });
    rpcCall = handle.daemon.rpcCall;

    // Pre-clean: delete any test agents left over from a previous run that
    // may have been persisted to config. Best-effort; ignore errors.
    for (const agentId of TEST_AGENT_IDS) {
      try {
        await rpcCall("agents.delete", { agentId, _trustLevel: "admin" });
      } catch {
        // Agent does not exist -- expected on clean run
      }
    }
  }, 120_000);

  afterAll(async () => {
    // Best-effort cleanup of all test agents
    if (rpcCall) {
      for (const agentId of TEST_AGENT_IDS) {
        try {
          await rpcCall("agents.delete", { agentId, _trustLevel: "admin" });
        } catch {
          // Agent may not exist -- ignore
        }
      }
    }

    // Restore process.kill spy before cleanup
    if (killSpy) {
      killSpy.mockRestore();
    }

    if (handle) {
      try {
        await handle.cleanup();
      } catch (err) {
        // Expected: graceful shutdown calls the overridden exit() which throws.
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("Daemon exit with code")) {
          throw err;
        }
      }
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  // TEST-05-01: Creates agent at runtime and it appears in agents.list
  // -------------------------------------------------------------------------

  it(
    "TEST-05-01: creates agent at runtime and it appears in agents.list",
    async () => {
      // Create a single agent at runtime
      const createResult = await rpcCall("agents.create", {
        agentId: "hot-e2e-agent-1",
        config: { name: "Hot E2E Agent 1" },
        _trustLevel: "admin",
      }) as { created: boolean };

      expect(createResult.created).toBe(true);

      // Verify it appears in agents.list
      const listResult = await rpcCall("agents.list", {}) as {
        agents: string[];
      };

      expect(listResult.agents).toContain("hot-e2e-agent-1");
    },
    RPC_FAST_MS * 3,
  );

  // -------------------------------------------------------------------------
  // TEST-05-02: Creates multiple agents without restart
  // -------------------------------------------------------------------------

  it(
    "TEST-05-02: creates multiple agents without restart",
    async () => {
      // Create 3 agents sequentially
      for (const agentId of ["hot-e2e-agent-2", "hot-e2e-agent-3", "hot-e2e-agent-4"]) {
        const result = await rpcCall("agents.create", {
          agentId,
          config: { name: `Hot E2E ${agentId}` },
          _trustLevel: "admin",
        }) as { created: boolean };

        expect(result.created).toBe(true);
      }

      // Verify all agents (including default + agent-1 from TEST-05-01) appear in list
      const listResult = await rpcCall("agents.list", {}) as {
        agents: string[];
      };

      expect(listResult.agents).toContain("default");
      expect(listResult.agents).toContain("hot-e2e-agent-2");
      expect(listResult.agents).toContain("hot-e2e-agent-3");
      expect(listResult.agents).toContain("hot-e2e-agent-4");

      // Should have at least 4 agents total (default + 3 new, plus agent-1 from previous test)
      expect(listResult.agents.length).toBeGreaterThanOrEqual(4);
    },
    RPC_FAST_MS * 5,
  );

  // -------------------------------------------------------------------------
  // TEST-05-03: SSE stream delivers agent:hot_added event on create
  // -------------------------------------------------------------------------

  it(
    "TEST-05-03: SSE stream delivers agent:hot_added event on create",
    async () => {
      const controller = new AbortController();

      try {
        // Open SSE stream
        const response = await fetch(`${handle.gatewayUrl}/api/events`, {
          headers: { Authorization: `Bearer ${handle.authToken}` },
          signal: controller.signal,
        });

        expect(response.status).toBe(200);

        // Wait 500ms for stream to be established, then create an agent
        setTimeout(async () => {
          try {
            await rpcCall("agents.create", {
              agentId: "hot-e2e-sse-agent",
              config: { name: "SSE Agent" },
              _trustLevel: "admin",
            });
          } catch {
            // Best effort -- event may still propagate
          }
        }, 500);

        // Read SSE events
        const events = await readSseEvents(response, 10, 10_000);

        // Assert at least one event has event === "agent:hot_added"
        const hotAddedEvents = events.filter((e) => e.event === "agent:hot_added");
        expect(hotAddedEvents.length).toBeGreaterThanOrEqual(1);

        // Parse its data and assert correct shape
        const data = JSON.parse(hotAddedEvents[0]!.data) as {
          agentId: string;
          timestamp: number;
        };
        expect(data.agentId).toBe("hot-e2e-sse-agent");
        expect(typeof data.timestamp).toBe("number");
      } finally {
        controller.abort();

        // Clean up: delete the SSE agent (best-effort)
        try {
          await rpcCall("agents.delete", {
            agentId: "hot-e2e-sse-agent",
            _trustLevel: "admin",
          });
        } catch {
          // Agent may not exist if create failed
        }
      }
    },
    30_000,
  );

  // -------------------------------------------------------------------------
  // TEST-05-04: SSE stream delivers agent:hot_removed event on delete
  // -------------------------------------------------------------------------

  it(
    "TEST-05-04: SSE stream delivers agent:hot_removed event on delete",
    async () => {
      // Create agent first
      const createResult = await rpcCall("agents.create", {
        agentId: "hot-e2e-del-agent",
        config: { name: "Del Agent" },
        _trustLevel: "admin",
      }) as { created: boolean };

      expect(createResult.created).toBe(true);

      const controller = new AbortController();

      try {
        // Open SSE stream
        const response = await fetch(`${handle.gatewayUrl}/api/events`, {
          headers: { Authorization: `Bearer ${handle.authToken}` },
          signal: controller.signal,
        });

        expect(response.status).toBe(200);

        // Wait 500ms for stream to be established, then delete the agent
        setTimeout(async () => {
          try {
            await rpcCall("agents.delete", {
              agentId: "hot-e2e-del-agent",
              _trustLevel: "admin",
            });
          } catch {
            // Best effort
          }
        }, 500);

        // Read SSE events
        const events = await readSseEvents(response, 10, 10_000);

        // Assert at least one event has event === "agent:hot_removed"
        const hotRemovedEvents = events.filter((e) => e.event === "agent:hot_removed");
        expect(hotRemovedEvents.length).toBeGreaterThanOrEqual(1);

        // Parse its data and assert correct shape
        const data = JSON.parse(hotRemovedEvents[0]!.data) as {
          agentId: string;
        };
        expect(data.agentId).toBe("hot-e2e-del-agent");
      } finally {
        controller.abort();
      }
    },
    30_000,
  );

  // -------------------------------------------------------------------------
  // TEST-05-05: Deleted agent is no longer in agents.list
  // -------------------------------------------------------------------------

  it(
    "TEST-05-05: deleted agent is no longer in agents.list",
    async () => {
      // Create agent
      const createResult = await rpcCall("agents.create", {
        agentId: "hot-e2e-gone-agent",
        config: { name: "Gone Agent" },
        _trustLevel: "admin",
      }) as { created: boolean };

      expect(createResult.created).toBe(true);

      // Verify it appears in agents.list
      const listBefore = await rpcCall("agents.list", {}) as {
        agents: string[];
      };
      expect(listBefore.agents).toContain("hot-e2e-gone-agent");

      // Delete it
      await rpcCall("agents.delete", {
        agentId: "hot-e2e-gone-agent",
        _trustLevel: "admin",
      });

      // Verify it does NOT appear in agents.list
      const listAfter = await rpcCall("agents.list", {}) as {
        agents: string[];
      };
      expect(listAfter.agents).not.toContain("hot-e2e-gone-agent");
    },
    RPC_FAST_MS * 4,
  );
});
