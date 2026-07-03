// SPDX-License-Identifier: Apache-2.0
// @allow-throw: JSON-RPC method-router; JSONRPCErrorException + scope-check throws caught by json-rpc-2.0 library and converted to JSON-RPC error response (mirror of rpc-dispatch.ts:306-321 path).
import type { SimpleJSONRPCMethod } from "json-rpc-2.0";
import { JSONRPCServer, JSONRPCErrorException } from "json-rpc-2.0";
import { checkScope } from "../auth/token-auth.js";
import { classifyTypedRpcError, tryGetContext } from "@comis/core";

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
 * Supports adding new methods after construction via `registerMethod()`.
 * New methods must use namespace prefixes (e.g., "cron.list",
 * "sessions.history"). Core methods are registered at construction time
 * from the provided `initialMethods` map.
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
    errorKind: "config" | "auth" | "validation" | "precondition" | "internal";
    hint: string;
  } {
    // Typed policy/security/validation refusals → non-internal (warn) via the
    // SINGLE source of truth in `@comis/core`, which the daemon's `classifyRpcError`
    // (rpc-dispatch.ts) ALSO delegates to. They reach this outer trace wrapper with
    // their `Error.name` intact; this package cannot `instanceof` the daemon/@comis/agent
    // error classes (dependency direction), and `classifyTypedRpcError` keys off that
    // name — so the two log layers cannot drift and log the same refusal at different
    // levels. A refusal must NOT log error(50) — a health sweep counts it.
    const typed = classifyTypedRpcError(err);
    if (typed) return { errorKind: typed.errorKind, hint: typed.hint };
    // Unrecognized errors keep the gateway's own message-substring fallbacks, then internal.
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
