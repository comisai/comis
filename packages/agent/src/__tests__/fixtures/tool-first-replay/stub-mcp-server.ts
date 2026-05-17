// SPDX-License-Identifier: Apache-2.0
/**
 * Programmatic stub of a finance-themed MCP server with a connection-state toggle.
 *
 * Why structural types and no cross-package skills import:
 *   The agent package has no dependency on the skills package (see
 *   `packages/agent/package.json:44-60`). We redeclare the relevant pieces of
 *   `McpToolDefinition` and `McpConnectionStatus` (defined in
 *   `packages/skills/src/skills/integrations/mcp-client/mcp-client-types.ts`)
 *   inline so this fixture stays self-contained. Precedent:
 *   `packages/agent/src/executor/__test-helpers/capturing-provider-stub.ts:1-50`
 *   redeclares pi-ai's Message types inline for the same reason.
 *
 * Why no real MCP SDK Server/Client pair:
 *   The MCP SDK is a transitive peer dep not resolvable from the test
 *   workspace's package.json. Precedent:
 *   `test/integration/skills/mcp-server-lifecycle.test.ts:1-12` documents the
 *   same constraint and uses a stub instead.
 *
 * Downstream consumers:
 *   - install-detour parser overlap detection.
 *   - `getConnectedMcpServers()` filters by status.
 *   - Full provider-gated replay round.
 */

interface StubMcpToolDefinition {
  readonly name: string;
  readonly qualifiedName: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
}

type StubMcpConnectionStatus = "connected" | "disconnected";

export interface StubMcpServer {
  readonly name: string;
  readonly tools: readonly StubMcpToolDefinition[];
  getStatus(): StubMcpConnectionStatus;
  setConnected(connected: boolean): void;
}

const tickerSchema = { type: "object", properties: { ticker: { type: "string" } }, required: ["ticker"] } as const;

const FINANCE_TOOLS: readonly StubMcpToolDefinition[] = [
  { name: "get_price", qualifiedName: "mcp:finance-data/get_price", description: "Latest price for a ticker.", inputSchema: tickerSchema },
  { name: "get_history", qualifiedName: "mcp:finance-data/get_history", description: "Historical OHLCV by date range.", inputSchema: { type: "object", properties: { ticker: { type: "string" }, from: { type: "string" }, to: { type: "string" } }, required: ["ticker", "from", "to"] } },
  { name: "get_fundamentals", qualifiedName: "mcp:finance-data/get_fundamentals", description: "Company fundamentals snapshot.", inputSchema: tickerSchema },
  { name: "get_dividends", qualifiedName: "mcp:finance-data/get_dividends", description: "Dividend payment history.", inputSchema: tickerSchema },
  { name: "get_splits", qualifiedName: "mcp:finance-data/get_splits", description: "Stock split history.", inputSchema: tickerSchema },
  { name: "search_tickers", qualifiedName: "mcp:finance-data/search_tickers", description: "Symbol lookup by name.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "get_quote", qualifiedName: "mcp:finance-data/get_quote", description: "Real-time bid/ask quote.", inputSchema: tickerSchema },
  { name: "get_options", qualifiedName: "mcp:finance-data/get_options", description: "Option chain for an expiry.", inputSchema: { type: "object", properties: { ticker: { type: "string" }, expiry: { type: "string" } }, required: ["ticker", "expiry"] } },
  { name: "get_indicators", qualifiedName: "mcp:finance-data/get_indicators", description: "Technical indicators (SMA, EMA, RSI).", inputSchema: { type: "object", properties: { ticker: { type: "string" }, indicator: { type: "string" } }, required: ["ticker", "indicator"] } },
  { name: "list_exchanges", qualifiedName: "mcp:finance-data/list_exchanges", description: "Supported exchanges and their hours.", inputSchema: { type: "object", properties: {} } },
];

export function createStubMcpServer(initialConnected: boolean = true): StubMcpServer {
  let connected: StubMcpConnectionStatus = initialConnected ? "connected" : "disconnected";
  return {
    name: "finance-data",
    tools: FINANCE_TOOLS,
    getStatus: () => connected,
    setConnected: (next: boolean) => {
      connected = next ? "connected" : "disconnected";
    },
  };
}
