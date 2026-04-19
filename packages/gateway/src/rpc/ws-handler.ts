import type { WSContext, WSEvents } from "hono/ws";
import type { JSONRPCServer, JSONRPCRequest } from "json-rpc-2.0";
import type { RpcContext } from "./method-router.js";

/**
 * Logger interface for WebSocket handler (minimal pino-compatible).
 */
export interface WsLogger {
  debug(msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
  info(msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/**
 * A tracked WebSocket connection.
 */
interface WsConnection {
  readonly clientId: string;
  readonly ws: WSContext;
  readonly connectedAt: number;
  heartbeatTimer?: ReturnType<typeof setInterval>;
}

/**
 * Manages active WebSocket connections with heartbeat and lifecycle tracking.
 */
export class WsConnectionManager {
  private readonly connections = new Map<string, WsConnection>();

  /** Number of active connections */
  get size(): number {
    return this.connections.size;
  }

  /**
   * Register a new connection.
   *
   * @param connectionId - Unique ID for this connection
   * @param clientId - The authenticated client ID
   * @param ws - The WebSocket context
   */
  add(connectionId: string, clientId: string, ws: WSContext): void {
    this.connections.set(connectionId, {
      clientId,
      ws,
      connectedAt: Date.now(),
    });
  }

  /**
   * Remove a connection and clean up its heartbeat timer.
   */
  remove(connectionId: string): void {
    const conn = this.connections.get(connectionId);
    if (conn?.heartbeatTimer) {
      clearInterval(conn.heartbeatTimer);
    }
    this.connections.delete(connectionId);
  }

  /**
   * Set the heartbeat timer for a connection.
   */
  setHeartbeat(connectionId: string, timer: ReturnType<typeof setInterval>): void {
    const conn = this.connections.get(connectionId);
    if (conn) {
      conn.heartbeatTimer = timer;
    }
  }

  /**
   * Get a connection by ID.
   */
  get(connectionId: string): WsConnection | undefined {
    return this.connections.get(connectionId);
  }

  /**
   * Check if a connection exists.
   */
  has(connectionId: string): boolean {
    return this.connections.has(connectionId);
  }

  /**
   * Send a JSON-RPC notification to all connections matching the given clientId.
   *
   * @param clientId - The authenticated client ID to target
   * @param method - JSON-RPC notification method name
   * @param params - Notification parameters
   * @returns true if at least one send succeeded, false otherwise
   */
  sendToClientId(clientId: string, method: string, params: unknown): boolean {
    let sent = false;
    for (const conn of this.connections.values()) {
      if (conn.clientId === clientId) {
        try {
          conn.ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
          sent = true;
        } catch {
          // Connection may be stale — skip
        }
      }
    }
    return sent;
  }

  /**
   * Broadcast a JSON-RPC notification to ALL active connections.
   *
   * Used for sub-agent completion announcements where the session UUID
   * cannot be mapped to a specific clientId.
   *
   * @param method - JSON-RPC notification method name
   * @param params - Notification parameters
   * @returns true if at least one send succeeded, false otherwise
   */
  broadcast(method: string, params: unknown): boolean {
    let sent = false;
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params });
    for (const conn of this.connections.values()) {
      try {
        conn.ws.send(payload);
        sent = true;
      } catch {
        // Connection may be stale — skip
      }
    }
    return sent;
  }

  /**
   * Close all connections and clean up all heartbeat timers.
   * Waits for close handshakes to complete (with timeout) so that
   * clients receive the 1001 close frame before the server shuts down.
   */
  async closeAll(timeoutMs = 500): Promise<void> {
    if (this.connections.size === 0) return;

    const closePromises: Promise<void>[] = [];

    for (const [id, conn] of this.connections) {
      if (conn.heartbeatTimer) {
        clearInterval(conn.heartbeatTimer);
      }

      // Listen for close completion on the raw ws before initiating close
      const raw = conn.ws.raw as unknown as { on?: (event: string, cb: () => void) => void } | undefined;
      if (raw && typeof raw.on === "function") {
        closePromises.push(
          new Promise<void>((resolve) => {
            raw.on!("close", () => resolve());
          }),
        );
      }

      try {
        conn.ws.close(1001, "Server shutting down");
      } catch {
        // Connection may already be closed
      }
      this.connections.delete(id);
    }

    if (closePromises.length > 0) {
      await Promise.race([
        Promise.all(closePromises),
        new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
    }
  }
}

/**
 * Dependencies for the WebSocket handler.
 */
export interface WsHandlerDeps {
  /** JSON-RPC method router */
  readonly rpcServer: JSONRPCServer<RpcContext>;
  /** Connection manager instance */
  readonly connections: WsConnectionManager;
  /** Logger */
  readonly logger: WsLogger;
  /** Maximum batch size for JSON-RPC batch requests */
  readonly maxBatchSize: number;
  /** Heartbeat interval in milliseconds (0 to disable) */
  readonly heartbeatMs: number;
  /** Maximum WebSocket message size in characters before JSON.parse */
  readonly maxMessageBytes: number;
  /** Per-connection message rate limiting */
  readonly messageRateLimit: { maxMessages: number; windowMs: number };
}

/**
 * Classify a WebSocket close code into a human-readable category.
 */
function classifyCloseCode(code: number): string {
  if (code === 1000) return "normal";
  if (code === 1001) return "going-away";
  if (code === 1005) return "no-status";
  if (code === 1006) return "abnormal";
  if (code >= 4000) return "app-error";
  return "protocol-error";
}

/**
 * Unique connection ID counter.
 */
let connectionCounter = 0;

/**
 * Create WebSocket event handlers for a JSON-RPC connection.
 *
 * Handles:
 * - Connection registration on open
 * - JSON-RPC message dispatch (single and batch)
 * - Batch size enforcement
 * - Heartbeat ping/pong for leak prevention
 * - Clean disconnection with resource cleanup
 *
 * @param deps - Handler dependencies
 * @param rpcContext - The authenticated RPC context for this connection
 * @returns WSEvents compatible with Hono's upgradeWebSocket
 */
export function createWsHandler(deps: WsHandlerDeps, rpcContext: RpcContext): WSEvents {
  const { rpcServer, connections, logger, maxBatchSize, heartbeatMs, maxMessageBytes, messageRateLimit } = deps;
  const connectionId = `ws-${++connectionCounter}-${Date.now()}`;

  // Per-connection sliding window rate limiter
  const messageTimestamps: number[] = [];

  // Enrich RPC context with connectionId so RPC call logs can reference it
  const enrichedContext: RpcContext = { ...rpcContext, connectionId };

  return {
    onOpen(_evt: Event, ws: WSContext) {
      connections.add(connectionId, rpcContext.clientId, ws);
      logger.debug(
        { connectionId, clientId: rpcContext.clientId, activeConnections: connections.size },
        `WebSocket connected: ${rpcContext.clientId}`,
      );

      // Set up heartbeat ping if enabled
      if (heartbeatMs > 0) {
        const timer = setInterval(() => {
          try {
            // Send a JSON-RPC notification as heartbeat ping
            ws.send(
              JSON.stringify({ jsonrpc: "2.0", method: "heartbeat", params: { ts: Date.now() } }),
            );
          } catch {
            // Connection may be closed; cleanup will happen in onClose
          }
        }, heartbeatMs);

        // Prevent heartbeat timer from keeping process alive
        if (typeof timer === "object" && "unref" in timer) {
          timer.unref();
        }

        connections.setHeartbeat(connectionId, timer);
      }
    },

    async onMessage(evt: MessageEvent, ws: WSContext) {
      let raw: string;

      if (typeof evt.data === "string") {
        raw = evt.data;
      } else {
        // Binary messages not supported for JSON-RPC
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32700, message: "Binary messages not supported" },
            id: null,
          }),
        );
        return;
      }

      // Per-connection message rate limiting (sliding window)
      const now = Date.now();
      const { maxMessages, windowMs } = messageRateLimit;
      // Remove timestamps outside the window
      while (messageTimestamps.length > 0 && messageTimestamps[0]! <= now - windowMs) {
        messageTimestamps.shift();
      }
      if (messageTimestamps.length >= maxMessages) {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Message rate limit exceeded" },
            id: null,
          }),
        );
        return;
      }
      messageTimestamps.push(now);

      // Message size validation before JSON.parse
      if (raw.length > maxMessageBytes) {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32600, message: `Message size ${raw.length} bytes exceeds maximum of ${maxMessageBytes}` },
            id: null,
          }),
        );
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32700, message: "Parse error" },
            id: null,
          }),
        );
        return;
      }

      // Check batch size limit
      if (Array.isArray(parsed)) {
        if (parsed.length > maxBatchSize) {
          ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              error: {
                code: -32600,
                message: `Batch size ${parsed.length} exceeds maximum of ${maxBatchSize}`,
              },
              id: null,
            }),
          );
          return;
        }
      }

      try {
        const response = await rpcServer.receive(
          parsed as JSONRPCRequest | JSONRPCRequest[],
          enrichedContext,
        );

        // Notifications (no id) return null — don't send anything back
        if (response !== null) {
          ws.send(JSON.stringify(response));
        }
      } catch (error) {
        logger.error(
          {
            connectionId,
            err: String(error),
            hint: "Check RPC method handler for unhandled exceptions",
            errorKind: "internal" as const,
          },
          "RPC dispatch error",
        );
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal error" },
            id: null,
          }),
        );
      }
    },

     
    onClose(evt: CloseEvent, _ws: WSContext) {
      const conn = connections.get(connectionId);
      const connectionDurationMs = conn ? Date.now() - conn.connectedAt : undefined;
      connections.remove(connectionId);
      const isAbnormal = evt.code !== 1000 && evt.code !== 1001 && evt.code !== 1005;
      const logFn = isAbnormal ? logger.info.bind(logger) : logger.debug.bind(logger);
      logFn(
        {
          connectionId,
          clientId: rpcContext.clientId,
          ...(connectionDurationMs !== undefined ? { connectionDurationMs } : {}),
          activeConnections: connections.size,
          closeCode: evt.code,
          closeType: classifyCloseCode(evt.code),
          ...(evt.reason ? { closeReason: evt.reason } : {}),
        },
        `WebSocket disconnected: ${rpcContext.clientId}`,
      );
    },

     
    onError(evt: Event, _ws: WSContext) {
      logger.error(
        {
          connectionId,
          clientId: rpcContext.clientId,
          err: String(evt),
          hint: "Check network connectivity or client-side WebSocket implementation",
          errorKind: "network" as const,
        },
        "WebSocket error",
      );
    },
  };
}
