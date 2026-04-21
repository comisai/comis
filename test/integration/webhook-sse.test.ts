// SPDX-License-Identifier: Apache-2.0
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  startTestDaemon,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import { ASYNC_SETTLE_MS } from "../support/timeouts.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = resolve(__dirname, "../config/config.test-webhook-sse.yaml");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Must match webhooks.token in config.test-webhook-sse.yaml */
const WEBHOOK_SECRET = "test-webhook-secret-for-e2e-pad32";

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Compute HMAC-SHA256 signature for a webhook payload.
 * Matches the verification logic in packages/gateway/src/webhook/hmac-verifier.ts.
 */
function signPayload(body: string, secret = WEBHOOK_SECRET): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SseEvent {
  event?: string;
  data: string;
  id?: string;
}

// ---------------------------------------------------------------------------
// SSE helpers (inline per decision 103-01)
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
          // retry: directives are part of the SSE spec but we capture event name
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

describe("Webhook delivery and SSE advanced", () => {
  let handle: TestDaemonHandle;

  beforeAll(async () => {
    handle = await startTestDaemon({ configPath: CONFIG_PATH });
  }, 60_000);

  afterAll(async () => {
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
  // Webhook delivery tests
  // -------------------------------------------------------------------------

  describe("Webhook delivery", () => {
    it("signed webhook to wake mapping returns 200", async () => {
      const body = JSON.stringify({ ping: true });
      const signature = signPayload(body);

      const response = await fetch(`${handle.gatewayUrl}/hooks/wake`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-webhook-signature": signature,
        },
        body,
      });

      expect(response.status).toBe(200);
      const json = (await response.json()) as Record<string, unknown>;
      expect(json.received).toBe(true);
      expect(json.mapping).toBe("wake-test");
    });

    it("invalid HMAC signature returns 401", async () => {
      const body = JSON.stringify({ ping: true });

      const response = await fetch(`${handle.gatewayUrl}/hooks/wake`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-webhook-signature": "bad-signature-value",
        },
        body,
      });

      expect(response.status).toBe(401);
      const json = (await response.json()) as Record<string, unknown>;
      expect(json.error).toBeDefined();
      expect(typeof json.error).toBe("string");
      expect((json.error as string).toLowerCase()).toContain("signature");
    });

    it("no matching path returns 404", async () => {
      const body = JSON.stringify({ ping: true });
      const signature = signPayload(body);

      const response = await fetch(`${handle.gatewayUrl}/hooks/nonexistent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-webhook-signature": signature,
        },
        body,
      });

      expect(response.status).toBe(404);
      const json = (await response.json()) as Record<string, unknown>;
      expect(json.error).toBeDefined();
      expect(typeof json.error).toBe("string");
      expect((json.error as string).toLowerCase()).toContain("matching");
    });

    it("invalid JSON body returns 400", async () => {
      const body = "not json {";
      const signature = signPayload(body);

      const response = await fetch(`${handle.gatewayUrl}/hooks/wake`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-webhook-signature": signature,
        },
        body,
      });

      expect(response.status).toBe(400);
      const json = (await response.json()) as Record<string, unknown>;
      expect(json.error).toBeDefined();
      expect(typeof json.error).toBe("string");
      expect((json.error as string).toLowerCase()).toContain("json");
    });

    it("webhook without signature when token required returns 401", async () => {
      const body = JSON.stringify({ ping: true });

      const response = await fetch(`${handle.gatewayUrl}/hooks/wake`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body,
      });

      expect(response.status).toBe(401);
      const json = (await response.json()) as Record<string, unknown>;
      expect(json.error).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // SSE advanced tests
  // -------------------------------------------------------------------------

  describe("SSE advanced", () => {
    it(
      "SSE stream receives keepalive ping within 20 seconds",
      async () => {
        const controller = new AbortController();
        try {
          const response = await fetch(`${handle.gatewayUrl}/api/events`, {
            headers: { Authorization: `Bearer ${handle.authToken}` },
            signal: controller.signal,
          });

          expect(response.status).toBe(200);

          // Collect up to 3 events over 20s -- expect retry directive + at least one ping
          // The SSE keepalive interval is 15s (KEEPALIVE_MS in sse-endpoint.ts)
          const events = await readSseEvents(response, 3, 20_000);

          // Should have at least the retry directive
          expect(events.length).toBeGreaterThanOrEqual(1);

          // The first event should be the retry directive
          const retryEvent = events.find((e) => e.event === "retry");
          expect(retryEvent).toBeDefined();

          // Should receive a ping event within 20 seconds (15s keepalive + margin)
          const pingEvent = events.find((e) => e.event === "ping");
          expect(pingEvent).toBeDefined();
        } finally {
          controller.abort();
        }
      },
      30_000,
    );

    it(
      "SSE stream remains functional during webhook processing",
      async () => {
        // Note: scheduler:wake and diagnostic:webhook_delivered are NOT in the
        // SSE_EVENTS list (sse-endpoint.ts lines 11-26), so we cannot observe
        // webhook-triggered events on the SSE stream. Instead, we verify that
        // the SSE stream stays alive and receives keepalive pings even while
        // the daemon processes webhook traffic.

        const controller = new AbortController();
        try {
          const response = await fetch(`${handle.gatewayUrl}/api/events`, {
            headers: { Authorization: `Bearer ${handle.authToken}` },
            signal: controller.signal,
          });

          expect(response.status).toBe(200);

          // Wait briefly for SSE connection to be established
          await new Promise((resolve) => setTimeout(resolve, ASYNC_SETTLE_MS));

          // Fire a signed webhook to generate traffic through the daemon
          const webhookBody = JSON.stringify({ trigger: "sse-test" });
          const webhookSig = signPayload(webhookBody);
          const webhookResponse = await fetch(`${handle.gatewayUrl}/hooks/wake`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-webhook-signature": webhookSig,
            },
            body: webhookBody,
          });

          expect(webhookResponse.status).toBe(200);

          // Collect events -- the keepalive ping proves the SSE stream survived
          // webhook processing without disconnection
          const events = await readSseEvents(response, 3, 20_000);

          // Should get at least the retry directive and a keepalive ping
          expect(events.length).toBeGreaterThanOrEqual(1);

          // Verify at least one ping arrived (stream stayed alive)
          const pingEvent = events.find((e) => e.event === "ping");
          expect(pingEvent).toBeDefined();
        } finally {
          controller.abort();
        }
      },
      30_000,
    );

    it(
      "two concurrent SSE streams both receive events",
      async () => {
        const controller1 = new AbortController();
        const controller2 = new AbortController();

        try {
          // Open two concurrent SSE streams
          const [response1, response2] = await Promise.all([
            fetch(`${handle.gatewayUrl}/api/events`, {
              headers: { Authorization: `Bearer ${handle.authToken}` },
              signal: controller1.signal,
            }),
            fetch(`${handle.gatewayUrl}/api/events`, {
              headers: { Authorization: `Bearer ${handle.authToken}` },
              signal: controller2.signal,
            }),
          ]);

          expect(response1.status).toBe(200);
          expect(response2.status).toBe(200);

          // Collect events from both streams in parallel
          const [events1, events2] = await Promise.all([
            readSseEvents(response1, 3, 20_000),
            readSseEvents(response2, 3, 20_000),
          ]);

          // Both streams should receive at least the retry directive
          expect(events1.length).toBeGreaterThanOrEqual(1);
          expect(events2.length).toBeGreaterThanOrEqual(1);

          // Both streams should receive a keepalive ping independently
          const ping1 = events1.find((e) => e.event === "ping");
          const ping2 = events2.find((e) => e.event === "ping");
          expect(ping1).toBeDefined();
          expect(ping2).toBeDefined();
        } finally {
          controller1.abort();
          controller2.abort();
        }
      },
      30_000,
    );
  });
});
