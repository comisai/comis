import type { RpcMethodMap, RpcMethodName } from "./method-router.js";

/**
 * Logger interface for RPC adapters (minimal pino-compatible).
 */
export interface RpcAdapterLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  info(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  error(msg: string): void;
}

/**
 * Function-based dependency interface for RPC method adapters.
 *
 * Uses function callbacks instead of concrete class imports to keep
 * the gateway decoupled from agent/memory/config internals. The daemon
 * wires thin adapter functions that delegate to actual service instances.
 */
export interface RpcAdapterDeps {
  /** Execute an agent turn. Returns the response text. */
  executeAgent: (params: {
    message: string;
    agentId?: string;
    sessionKey?: { userId: string; channelId: string; peerId: string };
    connectionId?: string;
    scopes?: readonly string[];
    onDelta?: (delta: string) => void;
    directives?: Record<string, unknown>;
  }) => Promise<{ response: string; tokensUsed: { input: number; output: number; total: number }; finishReason: string }>;

  /** Search memory. */
  searchMemory: (params: {
    query: string;
    limit?: number;
    tenantId?: string;
  }) => Promise<{ results: Array<{ id: string; content: string; score: number }> }>;

  /** Inspect memory (stats or single entry). */
  inspectMemory: (params: {
    id?: string;
    tenantId?: string;
  }) => Promise<{ stats?: Record<string, unknown>; entry?: Record<string, unknown> }>;

  /** Get config section(s). */
  getConfig: (params: { section?: string }) => Promise<Record<string, unknown>>;

  /** Set config value (returns acknowledgment). */
  setConfig: (params: {
    section: string;
    key: string;
    value: unknown;
  }) => Promise<{ ok: boolean; previous?: unknown }>;

  /** Load chat session history. */
  getSessionHistory: (params: {
    channelId?: string;
  }) => Promise<{ messages: Array<{ role: string; content: string; timestamp: number }> }>;

  /** Intercept slash commands before sending to LLM. */
  handleSlashCommand?: (params: {
    message: string;
    agentId?: string;
    sessionKey?: { userId: string; channelId: string; peerId: string };
    scopes?: readonly string[];
  }) => Promise<{ handled: boolean; response?: string; directives?: Record<string, unknown> }> | { handled: boolean; response?: string; directives?: Record<string, unknown> } | undefined;

  /** Check whether an agent ID exists in the current config. */
  isValidAgentId?: (agentId: string) => boolean;

  /** Logger */
  logger: RpcAdapterLogger;
}

// ---------------------------------------------------------------------------
// Shared agent request handler
// ---------------------------------------------------------------------------

/**
 * Shared handler for agent.execute and agent.stream RPC methods.
 *
 * Performs parameter validation, slash command interception, agent execution,
 * and error handling. Both methods share identical logic except agent.stream
 * logs a streaming-fallback info message before calling this function.
 */
async function handleAgentRequest(
  deps: RpcAdapterDeps,
  params: unknown,
  context: { connectionId?: string; scopes?: readonly string[] },
  methodName: string,
): Promise<{ response: string; tokensUsed: { input: number; output: number; total: number }; finishReason: string } | { error: string }> {
  try {
    const p = params as Record<string, unknown> | undefined;
    if (!p || typeof p.message !== "string" || p.message.length === 0) {
      return { error: "Missing required parameter: message (string)" };
    }
    const agentId = typeof p.agentId === "string" ? p.agentId : undefined;
    const sessionKey =
      p.sessionKey && typeof p.sessionKey === "object"
        ? (p.sessionKey as { userId: string; channelId: string; peerId: string })
        : undefined;

    const cmdResult = await deps.handleSlashCommand?.({
      message: p.message as string,
      agentId,
      sessionKey,
      scopes: context.scopes,
    });
    if (cmdResult?.handled && cmdResult.response) {
      return { response: cmdResult.response, tokensUsed: { input: 0, output: 0, total: 0 }, finishReason: "command" };
    }

    return await deps.executeAgent({
      message: p.message as string,
      agentId,
      sessionKey,
      connectionId: context?.connectionId,
      scopes: context?.scopes,
      directives: cmdResult?.directives,
    });
  } catch (err) {
    deps.logger.warn(
      {
        err,
        method: methodName,
        hint: "Check agent executor logs for details or verify LLM provider connectivity",
        errorKind: "dependency" as const,
      },
      `RPC ${methodName} failed`,
    );
    return { error: "Internal error" };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create real RPC method adapter implementations for all 6 gateway methods.
 *
 * Each handler wraps its adapter call in try/catch, logging errors and
 * returning a clean error object. Parameter validation is performed before
 * dispatching to the underlying adapter function.
 *
 * @param deps - Function-based dependencies (not concrete class imports)
 * @returns RpcMethodMap suitable for createMethodRouter()
 */
export function createRpcAdapters(
  deps: RpcAdapterDeps,
): Record<RpcMethodName, NonNullable<RpcMethodMap[RpcMethodName]>> {
  const { logger } = deps;

  return {
    "agent.execute": async (params, context) => {
      return handleAgentRequest(deps, params, { connectionId: context.connectionId, scopes: context.scopes }, "agent.execute");
    },

    "agent.stream": async (params, context) => {
      // Streaming falls back to non-streaming via JSON-RPC (SSE is handled separately)
      logger.info(
        { method: "agent.stream" },
        "agent.stream: streaming not yet available via RPC, falling back to non-streaming",
      );
      return handleAgentRequest(deps, params, { connectionId: context.connectionId, scopes: context.scopes }, "agent.stream");
    },

    "memory.search": async (params) => {
      try {
        const p = params as Record<string, unknown> | undefined;
        if (!p || typeof p.query !== "string" || p.query.length === 0) {
          return { error: "Missing required parameter: query (string)" };
        }
        return await deps.searchMemory({
          query: p.query as string,
          limit: typeof p.limit === "number" ? p.limit : undefined,
          tenantId: typeof p.tenantId === "string" ? p.tenantId : undefined,
        });
      } catch (err) {
        logger.warn(
          {
            err,
            method: "memory.search",
            hint: "Verify memory database path and search index integrity",
            errorKind: "dependency" as const,
          },
          "RPC memory.search failed",
        );
        return { error: "Internal error" };
      }
    },

    "memory.inspect": async (params) => {
      try {
        const p = (params as Record<string, unknown> | undefined) ?? {};
        return await deps.inspectMemory({
          id: typeof p.id === "string" ? p.id : undefined,
          tenantId: typeof p.tenantId === "string" ? p.tenantId : undefined,
        });
      } catch (err) {
        logger.warn(
          {
            err,
            method: "memory.inspect",
            hint: "Verify memory database path and entry existence",
            errorKind: "dependency" as const,
          },
          "RPC memory.inspect failed",
        );
        return { error: "Internal error" };
      }
    },

    "config.get": async (params) => {
      try {
        const p = (params as Record<string, unknown> | undefined) ?? {};
        return await deps.getConfig({
          section: typeof p.section === "string" ? p.section : undefined,
        });
      } catch (err) {
        logger.warn(
          {
            err,
            method: "config.get",
            hint: "Check config file accessibility and schema validation",
            errorKind: "config" as const,
          },
          "RPC config.get failed",
        );
        return { error: "Internal error" };
      }
    },

    "config.set": async (params) => {
      try {
        const p = params as Record<string, unknown> | undefined;
        // Accept "path" as alias for "key" (web UI scheduler sends "path")
        const key = typeof p?.key === "string" ? p.key : typeof p?.path === "string" ? p.path : undefined;
        if (!p || typeof p.section !== "string" || typeof key !== "string") {
          return { error: "Missing required parameters: section (string), key (string)" };
        }
        return await deps.setConfig({
          section: p.section as string,
          key,
          value: p.value,
        });
      } catch (err) {
        logger.warn(
          {
            err,
            method: "config.set",
            hint: "Check config key path validity and immutable key restrictions",
            errorKind: "config" as const,
          },
          "RPC config.set failed",
        );
        return { error: "Internal error" };
      }
    },
  };
}
