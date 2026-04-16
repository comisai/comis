/**
 * WebSocket JSON-RPC mock server for Playwright e2e tests.
 *
 * Uses page.routeWebSocket() to intercept WebSocket connections
 * and respond with JSON-RPC 2.0 responses based on configurable
 * method handlers.
 */
import { type Page } from "@playwright/test";

/** JSON-RPC 2.0 request shape */
interface JsonRpcRequest {
  readonly jsonrpc: string;
  readonly method: string;
  readonly params?: unknown;
  readonly id?: number | null;
}

/**
 * Default RPC method handlers for common daemon RPC methods.
 *
 * Values match the TypeScript interfaces consumed by web components:
 * - gateway.status -> GatewayStatus (uptime, memoryUsage as fraction, eventLoopDelay, nodeVersion)
 * - obs.delivery.stats -> DeliveryStats (successRate, avgLatencyMs, totalDelivered, failed)
 * - obs.billing.total -> BillingTotal (totalTokens, totalCost)
 */
export const DEFAULT_RPC_HANDLERS: Record<string, unknown> = {
  "obs.health.check": {
    uptime: 86400,
    memoryUsage: { rss: 150000000, heapUsed: 100000000 },
    eventLoopDelay: 2.5,
  },
  "obs.billing.total": {
    totalTokens: 75000,
    totalCost: 1.25,
  },
  "obs.delivery.stats": {
    successRate: 98.0,
    avgLatencyMs: 150,
    totalDelivered: 490,
    failed: 10,
  },
  "config.read": {
    sections: {},
  },
  "agents.list": [
    {
      id: "agent-default",
      name: "TestAgent",
      status: "active",
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
    },
  ],
  "gateway.status": {
    uptime: 86400,
    memoryUsage: 0.65,
    eventLoopDelay: 2.5,
    nodeVersion: "v22.0.0",
    cpuUsage: 12,
  },
};

/**
 * Mock WebSocket JSON-RPC connections via page.routeWebSocket().
 *
 * Intercepts WebSocket connections matching /\/ws/ and responds to
 * JSON-RPC 2.0 requests using the provided handlers map.
 *
 * @param page - Playwright Page instance
 * @param handlers - Map of RPC method names to response values.
 *                   Falls back to DEFAULT_RPC_HANDLERS if not provided.
 */
export async function mockRpcRoutes(
  page: Page,
  handlers?: Record<string, unknown>,
): Promise<void> {
  const methodHandlers = handlers ?? DEFAULT_RPC_HANDLERS;

  await page.routeWebSocket(/\/ws/, (ws) => {
    ws.onMessage((message) => {
      let request: JsonRpcRequest;
      try {
        request = JSON.parse(message.toString()) as JsonRpcRequest;
      } catch {
        // Ignore unparseable messages
        return;
      }

      const { method, id } = request;

      // Handle ping/pong for heartbeat
      if (method === "ping") {
        ws.send(JSON.stringify({ jsonrpc: "2.0", result: "pong", id }));
        return;
      }

      // Look up handler for the method
      if (method in methodHandlers) {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            result: methodHandlers[method],
            id,
          }),
        );
        return;
      }

      // Method not found
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32601, message: "Method not found" },
          id,
        }),
      );
    });
  });
}
