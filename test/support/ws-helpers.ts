/**
 * Shared WebSocket helpers for integration tests.
 *
 * Provides two utility functions used across all integration test files
 * that communicate with the daemon via WebSocket JSON-RPC:
 *
 * - `openAuthenticatedWebSocket()` — connect to the gateway /ws endpoint
 * - `sendJsonRpc()` — send a JSON-RPC 2.0 request and wait for the response
 *
 * Timeout defaults come from the shared `timeouts.ts` module.
 *
 * @module
 */

import { WS_CONNECT_MS, RPC_LLM_MS } from "./timeouts.js";

/**
 * Open an authenticated WebSocket connection to the gateway /ws endpoint.
 *
 * The gateway accepts a bearer token as the `token` query parameter.
 * Returns a Promise that resolves when the connection opens, rejects on
 * error or timeout.
 *
 * @param gatewayUrl - Base URL of the gateway (e.g., "http://127.0.0.1:4766")
 * @param token - Bearer token for authentication
 * @param options - Optional configuration
 * @param options.timeoutMs - Connection timeout (default: WS_CONNECT_MS = 10s)
 */
export function openAuthenticatedWebSocket(
  gatewayUrl: string,
  token: string,
  options?: { timeoutMs?: number },
): Promise<WebSocket> {
  const timeoutMs = options?.timeoutMs ?? WS_CONNECT_MS;

  return new Promise<WebSocket>((resolve, reject) => {
    const url = new URL(gatewayUrl);
    const wsUrl = `ws://${url.hostname}:${url.port}/ws?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(wsUrl);

    const timeout = setTimeout(() => {
      ws.close();
      reject(
        new Error(
          `WebSocket connection timed out after ${timeoutMs / 1000}s`,
        ),
      );
    }, timeoutMs);

    ws.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve(ws);
    });

    ws.addEventListener("error", (evt) => {
      clearTimeout(timeout);
      reject(new Error(`WebSocket error: ${String(evt)}`));
    });
  });
}

/**
 * Send a JSON-RPC 2.0 request over WebSocket and wait for the matching response.
 *
 * Heartbeat notifications (method: "heartbeat") are filtered out so only
 * the actual response to the given request ID is returned.
 *
 * @param ws - Open WebSocket connection
 * @param method - JSON-RPC method name
 * @param params - Method parameters
 * @param id - Request ID (numeric or string) for response matching
 * @param options - Optional configuration
 * @param options.timeoutMs - Response timeout (default: RPC_LLM_MS = 90s)
 */
export function sendJsonRpc(
  ws: WebSocket,
  method: string,
  params: Record<string, unknown>,
  id: number | string,
  options?: { timeoutMs?: number },
): Promise<unknown> {
  const timeoutMs = options?.timeoutMs ?? RPC_LLM_MS;

  return new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.removeEventListener("message", handler);
      reject(
        new Error(
          `JSON-RPC response timed out after ${timeoutMs / 1000}s for method: ${method}`,
        ),
      );
    }, timeoutMs);

    function handler(evt: MessageEvent): void {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(
          typeof evt.data === "string" ? evt.data : String(evt.data),
        );
      } catch {
        return; // Ignore non-JSON messages
      }

      // Skip heartbeat notifications (no id, method === "heartbeat")
      if (msg.method === "heartbeat" && msg.id === undefined) {
        return;
      }

      // Match on response id
      if (msg.id === id) {
        clearTimeout(timeout);
        ws.removeEventListener("message", handler);
        resolve(msg);
      }
    }

    ws.addEventListener("message", handler);

    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params,
      }),
    );
  });
}
