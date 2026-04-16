import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createMdnsAdvertiser } from "@comis/gateway";
import {
  startTestDaemon,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import { openAuthenticatedWebSocket, sendJsonRpc } from "../support/ws-helpers.js";
import { RPC_FAST_MS, ASYNC_SETTLE_MS } from "../support/timeouts.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = resolve(__dirname, "../config/config.test-ws-discovery.yaml");

/**
 * wsHeartbeatMs from the test config — must match config.test-ws-discovery.yaml.
 */
const WS_HEARTBEAT_MS = 3000;

// ---------------------------------------------------------------------------
// Heartbeat collection helper
// ---------------------------------------------------------------------------

/**
 * Collect heartbeat notifications from a WebSocket connection.
 *
 * Listens for JSON-RPC notifications with method "heartbeat" and no id.
 * Resolves when `count` heartbeats are collected, rejects on timeout.
 */
function collectHeartbeats(
  ws: WebSocket,
  count: number,
  timeoutMs: number,
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const collected: Record<string, unknown>[] = [];
    const timer = setTimeout(() => {
      ws.removeEventListener("message", handler);
      reject(new Error(`Heartbeat timeout: collected ${collected.length}/${count}`));
    }, timeoutMs);

    function handler(evt: MessageEvent): void {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(typeof evt.data === "string" ? evt.data : "");
      } catch {
        return;
      }
      if (msg.method === "heartbeat" && msg.id === undefined) {
        collected.push(msg);
        if (collected.length >= count) {
          clearTimeout(timer);
          ws.removeEventListener("message", handler);
          resolve(collected);
        }
      }
    }
    ws.addEventListener("message", handler);
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("WS Protocol Advanced and mDNS Discovery", () => {
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
  // WebSocket protocol advanced
  // -------------------------------------------------------------------------

  describe("WebSocket protocol advanced", () => {
    it(
      "receives heartbeat notification within configured interval",
      async () => {
        const ws = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);
        try {
          const heartbeats = await collectHeartbeats(ws, 1, WS_HEARTBEAT_MS + 5_000);

          expect(heartbeats.length).toBeGreaterThanOrEqual(1);
          expect(heartbeats[0]).toHaveProperty("jsonrpc", "2.0");
          expect(heartbeats[0]).toHaveProperty("method", "heartbeat");
          expect(heartbeats[0]).toHaveProperty("params");
          expect(typeof (heartbeats[0].params as Record<string, unknown>).ts).toBe("number");
        } finally {
          ws.close();
        }
      },
      15_000,
    );

    it(
      "heartbeat params.ts is a valid timestamp",
      async () => {
        const ws = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);
        try {
          const heartbeats = await collectHeartbeats(ws, 1, WS_HEARTBEAT_MS + 5_000);

          expect(heartbeats.length).toBeGreaterThanOrEqual(1);
          const params = heartbeats[0].params as Record<string, unknown>;
          const ts = params.ts as number;
          expect(typeof ts).toBe("number");
          // Timestamp should be within 10 seconds of current time
          expect(Date.now() - ts).toBeLessThan(10_000);
        } finally {
          ws.close();
        }
      },
      15_000,
    );

    it("batch RPC request returns batch response", async () => {
      const ws = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);
      try {
        const batch = [
          { jsonrpc: "2.0", method: "config.get", params: {}, id: 1 },
          { jsonrpc: "2.0", method: "config.get", params: {}, id: 2 },
        ];

        const responsePromise = new Promise<unknown[]>((resolve, reject) => {
          const timer = setTimeout(
            () => {
              ws.removeEventListener("message", handler);
              reject(new Error("Batch response timeout"));
            },
            RPC_FAST_MS,
          );

          function handler(evt: MessageEvent): void {
            let msg: unknown;
            try {
              msg = JSON.parse(typeof evt.data === "string" ? evt.data : "");
            } catch {
              return;
            }

            // Skip heartbeat notifications
            if (
              typeof msg === "object" &&
              msg !== null &&
              (msg as Record<string, unknown>).method === "heartbeat"
            ) {
              return;
            }

            // Batch response is an array
            if (Array.isArray(msg)) {
              clearTimeout(timer);
              ws.removeEventListener("message", handler);
              resolve(msg as unknown[]);
            }
          }

          ws.addEventListener("message", handler);
        });

        ws.send(JSON.stringify(batch));
        const responses = await responsePromise;

        expect(responses).toHaveLength(2);
        for (const res of responses) {
          const r = res as Record<string, unknown>;
          expect(r).toHaveProperty("jsonrpc", "2.0");
          expect(r).toHaveProperty("result");
          expect([1, 2]).toContain(r.id);
        }
      } finally {
        ws.close();
      }
    });

    it("binary message returns parse error", async () => {
      const ws = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);
      try {
        const responsePromise = new Promise<Record<string, unknown>>((resolve, reject) => {
          const timer = setTimeout(
            () => {
              ws.removeEventListener("message", handler);
              reject(new Error("Binary error response timeout"));
            },
            RPC_FAST_MS,
          );

          function handler(evt: MessageEvent): void {
            let msg: Record<string, unknown>;
            try {
              msg = JSON.parse(typeof evt.data === "string" ? evt.data : "");
            } catch {
              return;
            }

            // Skip heartbeat notifications
            if (msg.method === "heartbeat" && msg.id === undefined) {
              return;
            }

            // Error response for binary message
            if (msg.error) {
              clearTimeout(timer);
              ws.removeEventListener("message", handler);
              resolve(msg);
            }
          }

          ws.addEventListener("message", handler);
        });

        // Send binary data
        ws.send(new Uint8Array([1, 2, 3]).buffer);
        const response = await responsePromise;

        expect(response).toHaveProperty("jsonrpc", "2.0");
        expect(response).toHaveProperty("id", null);
        const error = response.error as Record<string, unknown>;
        expect(error.code).toBe(-32700);
        expect(typeof error.message).toBe("string");
        expect((error.message as string).toLowerCase()).toMatch(/binary|not supported/);
      } finally {
        ws.close();
      }
    });

    it("reconnection after close succeeds with valid RPC", async () => {
      // First connection
      const ws1 = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);
      const res1 = (await sendJsonRpc(ws1, "config.get", {}, 1, {
        timeoutMs: RPC_FAST_MS,
      })) as Record<string, unknown>;
      expect(res1.jsonrpc).toBe("2.0");
      expect(res1.id).toBe(1);
      expect(res1.result).toBeDefined();
      ws1.close();

      // Wait for server to process close
      await new Promise((resolve) => setTimeout(resolve, ASYNC_SETTLE_MS));

      // Reconnect
      const ws2 = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);
      try {
        const res2 = (await sendJsonRpc(ws2, "config.get", {}, 2, {
          timeoutMs: RPC_FAST_MS,
        })) as Record<string, unknown>;
        expect(res2.jsonrpc).toBe("2.0");
        expect(res2.id).toBe(2);
        expect(res2.result).toBeDefined();
      } finally {
        ws2.close();
      }
    });
  });

  // -------------------------------------------------------------------------
  // mDNS advertiser lifecycle
  // -------------------------------------------------------------------------

  describe("mDNS advertiser lifecycle", () => {
    it(
      "advertiser starts and reports isAdvertising true",
      async () => {
        const advertiser = createMdnsAdvertiser({
          port: 9999,
          logger: { info: vi.fn(), error: vi.fn() },
        });
        try {
          await advertiser.advertise();
          expect(advertiser.isAdvertising()).toBe(true);
        } finally {
          await advertiser.stop();
        }
      },
      10_000,
    );

    it(
      "advertiser stops cleanly and reports isAdvertising false",
      async () => {
        const advertiser = createMdnsAdvertiser({
          port: 9999,
          logger: { info: vi.fn(), error: vi.fn() },
        });
        await advertiser.advertise();
        expect(advertiser.isAdvertising()).toBe(true);

        await advertiser.stop();
        expect(advertiser.isAdvertising()).toBe(false);
      },
      10_000,
    );

    it(
      "stop before advertise is a no-op",
      async () => {
        const advertiser = createMdnsAdvertiser({
          port: 9999,
          logger: { info: vi.fn(), error: vi.fn() },
        });

        // stop() before advertise() should be a no-op
        await advertiser.stop();
        expect(advertiser.isAdvertising()).toBe(false);
      },
      10_000,
    );
  });
});
