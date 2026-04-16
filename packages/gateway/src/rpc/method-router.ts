import type { SimpleJSONRPCMethod } from "json-rpc-2.0";
import { JSONRPCServer, JSONRPCErrorException } from "json-rpc-2.0";
import { checkScope } from "../auth/token-auth.js";
import { tryGetContext } from "@comis/core";

/**
 * RPC context passed as serverParams to JSON-RPC handlers.
 * Contains the authenticated client identity for scope checking.
 */
export interface RpcContext {
  readonly clientId: string;
  readonly scopes: readonly string[];
  readonly connectionId?: string;
}

/**
 * The set of JSON-RPC methods the gateway exposes.
 */
export type RpcMethodName =
  | "agent.execute"
  | "agent.stream"
  | "memory.search"
  | "memory.inspect"
  | "config.get"
  | "config.set";

/**
 * Map of method names to their required scope.
 */
const METHOD_SCOPES: Record<RpcMethodName, string> = {
  "agent.execute": "rpc",
  "agent.stream": "rpc",
  "memory.search": "rpc",
  "memory.inspect": "rpc",
  "config.get": "admin",
  "config.set": "admin",
};

/**
 * Handler function type for JSON-RPC methods.
 */
export type RpcMethodHandler = SimpleJSONRPCMethod<RpcContext>;

/**
 * Map of method names to their handler functions.
 */
export type RpcMethodMap = Partial<Record<RpcMethodName, RpcMethodHandler>>;

/**
 * Create a JSON-RPC method router with scope-based authorization.
 *
 * Each method is registered with the json-rpc-2.0 JSONRPCServer and
 * wrapped with scope checking middleware. Unauthorized calls receive
 * a JSON-RPC error with code -32603.
 *
 * @param methods - Map of method names to handler functions
 * @returns A JSONRPCServer configured with scope-checking middleware
 */
export function createMethodRouter(methods: RpcMethodMap): JSONRPCServer<RpcContext> {
  const server = new JSONRPCServer<RpcContext>();

  for (const [name, handler] of Object.entries(methods)) {
    const methodName = name as RpcMethodName;
    const requiredScope = METHOD_SCOPES[methodName];

    if (!handler || !requiredScope) continue;

    // Wrap handler with scope checking
    server.addMethod(methodName, (params, context) => {
      if (!checkScope(context.scopes, requiredScope)) {
        throw new JSONRPCErrorException(`Insufficient scope: requires '${requiredScope}'`, -32603, {
          clientId: context.clientId,
          required: requiredScope,
        });
      }

      return handler(params, context);
    });
  }

  return server;
}

// ---------------------------------------------------------------------------
// Dynamic method registration
// ---------------------------------------------------------------------------

/**
 * The core method names that are allowed without namespace validation.
 */
const CORE_METHODS: ReadonlySet<string> = new Set<string>([
  "agent.execute",
  "agent.stream",
  "memory.search",
  "memory.inspect",
  "config.get",
  "config.set",
]);

/**
 * A method router that supports runtime registration of new RPC methods.
 *
 * Dynamic methods must use namespace prefixes (dot-separated names like "cron.list").
 * Core methods (the original 6) are exempt from this requirement.
 */
export interface DynamicMethodRouter {
  /** Register a new RPC method with scope enforcement. */
  registerMethod(name: string, scope: string, handler: RpcMethodHandler): void;
  /** Check if a method is registered. */
  hasMethod(name: string): boolean;
  /** Get the underlying JSONRPCServer for receive() calls. */
  readonly server: JSONRPCServer<RpcContext>;
}

/**
 * Minimal logger interface accepted by the dynamic method router.
 * Compatible with Pino and any structured logger.
 */
export interface MethodRouterLogger {
  debug(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/**
 * Create a dynamic JSON-RPC method router with runtime registration support.
 *
 * Unlike `createMethodRouter`, this router supports adding new methods after
 * construction via `registerMethod()`. New methods must use namespace prefixes
 * (e.g., "cron.list", "sessions.history"). Core methods are registered at
 * construction time from the provided `initialMethods` map.
 *
 * @param initialMethods - Optional initial method map (uses METHOD_SCOPES for scope lookup)
 * @param logger - Optional logger for debug tracing of RPC calls
 * @returns A DynamicMethodRouter with registerMethod, hasMethod, and server
 */
export function createDynamicMethodRouter(initialMethods?: RpcMethodMap, logger?: MethodRouterLogger): DynamicMethodRouter {
  const server = new JSONRPCServer<RpcContext>();
  const registeredScopes = new Map<string, string>();

  /**
   * Classify an RPC method error for structured logging.
   */
  function classifyRpcMethodError(err: unknown): {
    errorKind: "config" | "auth" | "validation" | "internal";
    hint: string;
  } {
    const msg = err instanceof Error ? err.message : String(err);
    const excerpt = msg.length > 120 ? msg.slice(0, 120) + "..." : msg;
    if (msg.includes("immutable")) return { errorKind: "config", hint: `This config path requires daemon restart: ${excerpt}` };
    if (msg.includes("Admin access") || msg.includes("Unauthorized")) return { errorKind: "auth", hint: `Insufficient permissions: ${excerpt}` };
    if (msg.includes("not found") || msg.includes("Unknown") || msg.includes("Invalid")) return { errorKind: "validation", hint: `Invalid request: ${excerpt}` };
    return { errorKind: "internal", hint: `Handler error: ${excerpt}` };
  }

  /**
   * RPC methods whose polling frequency makes per-call logging pure noise.
   * These are called every 20-30s by the web dashboard and produce 56% of all log volume.
   * Errors on these methods are still logged via the normal error path.
   */
  const SUPPRESS_LOG_METHODS: ReadonlySet<string> = new Set([
    "system.ping",
    "obs.billing.total",
    "obs.billing.byAgent",
    "heartbeat.states",
    "skills.list",
  ]);

  /**
   * Wrap an RPC handler with debug trace logging.
   * Logs method name, clientId, duration on success, and err on failure.
   * Polling methods in SUPPRESS_LOG_METHODS skip trace logging entirely.
   */
  function wrapWithTrace(name: string, handler: RpcMethodHandler): RpcMethodHandler {
    if (!logger) return handler;
    // Skip trace wrapper for high-frequency polling methods
    if (SUPPRESS_LOG_METHODS.has(name)) return handler;
    return async (params, context) => {
      const startMs = performance.now();
      logger.debug({ method: name, clientId: context.clientId, ...(context.connectionId ? { connectionId: context.connectionId } : {}) }, `RPC call: ${name}`);
      try {
        const result = await handler(params, context);
        const durationMs = Math.round(performance.now() - startMs);
        const traceId = tryGetContext()?.traceId;
        logger.debug({ method: name, durationMs, clientId: context.clientId, ...(traceId && { traceId }), ...(context.connectionId ? { connectionId: context.connectionId } : {}) }, `RPC call completed: ${name}`);
        return result;
      } catch (err) {
        const durationMs = Math.round(performance.now() - startMs);
        const classified = classifyRpcMethodError(err);
        const logFn = classified.errorKind === "internal" ? logger.error.bind(logger) : logger.warn.bind(logger);
        logFn(
          {
            method: name,
            err,
            durationMs,
            clientId: context.clientId,
            hint: classified.hint,
            errorKind: classified.errorKind,
            ...(context.connectionId ? { connectionId: context.connectionId } : {}),
          },
          `RPC call failed: ${name}`,
        );
        throw err;
      }
    };
  }

  // Register initial methods using METHOD_SCOPES
  if (initialMethods) {
    for (const [name, handler] of Object.entries(initialMethods)) {
      const methodName = name as RpcMethodName;
      const requiredScope = METHOD_SCOPES[methodName];

      if (!handler || !requiredScope) continue;

      registeredScopes.set(methodName, requiredScope);

      const traced = wrapWithTrace(methodName, handler);
      server.addMethod(methodName, (params, context) => {
        if (!checkScope(context.scopes, requiredScope)) {
          throw new JSONRPCErrorException(`Insufficient scope: requires '${requiredScope}'`, -32603, {
            clientId: context.clientId,
            required: requiredScope,
          });
        }
        return traced(params, context);
      });
    }
  }

  function registerMethod(name: string, scope: string, handler: RpcMethodHandler): void {
    // Validate namespace for non-core methods
    if (!CORE_METHODS.has(name) && !name.includes(".")) {
      throw new Error(`Method name must use namespace prefix (e.g., 'cron.list'), got: ${name}`);
    }

    // Check for collisions
    if (registeredScopes.has(name)) {
      throw new Error(`Method '${name}' is already registered`);
    }

    registeredScopes.set(name, scope);

    const traced = wrapWithTrace(name, handler);
    server.addMethod(name, (params, context) => {
      if (!checkScope(context.scopes, scope)) {
        throw new JSONRPCErrorException(`Insufficient scope: requires '${scope}'`, -32603, {
          clientId: context.clientId,
          required: scope,
        });
      }
      return traced(params, context);
    });
  }

  function hasMethod(name: string): boolean {
    return registeredScopes.has(name);
  }

  return { registerMethod, hasMethod, server };
}

/**
 * Create stub method handlers for all RPC methods.
 *
 * Returns placeholder implementations that return method name confirmation.
 * Used during development and integration testing before real adapters are wired.
 */
export function createStubMethods(): Record<RpcMethodName, RpcMethodHandler> {
  return {
    "agent.execute": (params) => ({
      stub: true,
      method: "agent.execute",
      params,
    }),
    "agent.stream": (params) => ({
      stub: true,
      method: "agent.stream",
      params,
    }),
    "memory.search": (params) => ({
      stub: true,
      method: "memory.search",
      params,
    }),
    "memory.inspect": (params) => ({
      stub: true,
      method: "memory.inspect",
      params,
    }),
    "config.get": (params) => ({
      stub: true,
      method: "config.get",
      params,
    }),
    "config.set": (params) => ({
      stub: true,
      method: "config.set",
      params,
    }),
  };
}
