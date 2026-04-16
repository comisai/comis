/**
 * WebSocket JSON-RPC 2.0 client with auto-reconnect and heartbeat.
 *
 * Connects to the Comis daemon via WebSocket, sends JSON-RPC 2.0
 * requests, and provides observable connection status for UI components.
 *
 * Protocol: JSON-RPC 2.0 over WebSocket
 * URL format: ws(s)://host/ws?token=TOKEN
 * Heartbeat: ping every 30s, dead if no pong within 10s
 * Reconnect: exponential backoff (1s, 2s, 4s, ... max 30s), max 10 retries
 */

import type { ConnectionStatus } from "./types/index.js";

/** Pending RPC request tracker */
interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** JSON-RPC 2.0 response shape */
interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id?: number | null;
  readonly result?: unknown;
  readonly error?: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
  readonly method?: string;
}

/**
 * WebSocket JSON-RPC 2.0 client interface.
 *
 * Provides connection management, RPC method invocation, and
 * observable connection status for the web console.
 */
export interface RpcClient {
  /** Open a WebSocket connection to the daemon. */
  connect(url: string, token: string): void;
  /** Disconnect and clean up all resources. */
  disconnect(): void;
  /**
   * Send a JSON-RPC 2.0 request and await the response.
   *
   * For compile-time method name checking, use `createTypedRpc(rpc)` from
   * `api/types/rpc-registry.js` which wraps this method with full type safety.
   */
  call<T>(method: string, params?: unknown): Promise<T>;
  /** Subscribe to connection status changes. Returns an unsubscribe function. */
  onStatusChange(handler: (status: ConnectionStatus) => void): () => void;
  /** Subscribe to server-pushed notifications (method present, no id). Returns an unsubscribe function. */
  onNotification(handler: (method: string, params: unknown) => void): () => void;
  /** Current connection status. */
  readonly status: ConnectionStatus;
}

/** Request timeout in milliseconds */
const REQUEST_TIMEOUT_MS = 30_000;
/** Heartbeat ping interval in milliseconds */
const HEARTBEAT_INTERVAL_MS = 30_000;
/** Heartbeat pong timeout in milliseconds */
const HEARTBEAT_TIMEOUT_MS = 10_000;
/** Base delay for exponential backoff in milliseconds */
const BACKOFF_BASE_MS = 1_000;
/** Maximum backoff delay in milliseconds */
const BACKOFF_MAX_MS = 30_000;
/** Maximum number of reconnect attempts */
const MAX_RETRIES = 10;

/**
 * Create a WebSocket JSON-RPC 2.0 client.
 *
 * @returns An RpcClient instance for communicating with the daemon
 */
export function createRpcClient(): RpcClient {
  let ws: WebSocket | null = null;
  let _status: ConnectionStatus = "disconnected";
  let nextId = 1;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let currentUrl = "";
  let currentToken = "";
  let intentionalDisconnect = false;

  const pending = new Map<number, PendingRequest>();
  const statusHandlers = new Set<(status: ConnectionStatus) => void>();
  const notificationHandlers = new Set<(method: string, params: unknown) => void>();

  function setStatus(newStatus: ConnectionStatus): void {
    if (_status === newStatus) return;
    _status = newStatus;
    for (const handler of statusHandlers) {
      handler(newStatus);
    }
  }

  function clearHeartbeat(): void {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (heartbeatTimeoutTimer !== null) {
      clearTimeout(heartbeatTimeoutTimer);
      heartbeatTimeoutTimer = null;
    }
  }

  function clearReconnectTimer(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function rejectAllPending(reason: string): void {
    for (const [id, req] of pending) {
      clearTimeout(req.timer);
      req.reject(new Error(reason));
      pending.delete(id);
    }
  }

  function startHeartbeat(): void {
    clearHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (ws === null || ws.readyState !== globalThis.WebSocket.OPEN) return;

      const pingId = nextId++;
      ws.send(JSON.stringify({ jsonrpc: "2.0", method: "system.ping", id: pingId }));

      // Set a timeout for the pong response
      heartbeatTimeoutTimer = setTimeout(() => {
        // No pong received -- connection is dead
        pending.delete(pingId);
        if (ws !== null) {
          ws.close();
        }
      }, HEARTBEAT_TIMEOUT_MS);

      // Track the ping as a pending request that clears the timeout on response
      pending.set(pingId, {
        resolve: () => {
          if (heartbeatTimeoutTimer !== null) {
            clearTimeout(heartbeatTimeoutTimer);
            heartbeatTimeoutTimer = null;
          }
        },
        reject: () => {
          // Any response (even error) proves the connection is alive - clear timeout
          if (heartbeatTimeoutTimer !== null) {
            clearTimeout(heartbeatTimeoutTimer);
            heartbeatTimeoutTimer = null;
          }
        },
        timer: setTimeout(() => {
          // Cleanup stale ping entry (should not normally fire since
          // heartbeat timeout handles it first)
          pending.delete(pingId);
        }, REQUEST_TIMEOUT_MS),
      });
    }, HEARTBEAT_INTERVAL_MS);
  }

  function scheduleReconnect(): void {
    if (intentionalDisconnect) return;

    if (reconnectAttempt >= MAX_RETRIES) {
      setStatus("disconnected");
      return;
    }

    setStatus("reconnecting");

    const delay = Math.min(BACKOFF_BASE_MS * Math.pow(2, reconnectAttempt), BACKOFF_MAX_MS);
    reconnectAttempt++;

    reconnectTimer = setTimeout(() => {
      openConnection(currentUrl, currentToken);
    }, delay);
  }

  function openConnection(url: string, token: string): void {
    const wsUrl = `${url}?token=${encodeURIComponent(token)}`;
    ws = new globalThis.WebSocket(wsUrl);

    ws.onopen = () => {
      reconnectAttempt = 0;
      setStatus("connected");
      startHeartbeat();
    };

    ws.onmessage = (event: MessageEvent) => {
      let response: JsonRpcResponse;
      try {
        response = JSON.parse(event.data as string) as JsonRpcResponse;
      } catch {
        // Ignore unparseable messages
        return;
      }

      // Server heartbeat notifications (no id) -- ignore
      if (response.method === "heartbeat" && response.id == null) {
        return;
      }

      // Server-pushed notifications (method present, no id) -- dispatch to handlers
      if (response.method && response.id == null) {
        console.debug("[rpc] notification received:", response.method);
        for (const handler of notificationHandlers) {
          try {
            handler(response.method, (response as Record<string, unknown>).params);
          } catch (err) {
            console.warn("[rpc] notification handler error:", err);
          }
        }
        return;
      }

      // Match response to pending request
      if (response.id != null) {
        const req = pending.get(response.id);
        if (req) {
          clearTimeout(req.timer);
          pending.delete(response.id);

          if (response.error) {
            req.reject(
              new Error(`RPC error (${response.error.code}): ${response.error.message}`),
            );
          } else {
            req.resolve(response.result);
          }
        }
      }
    };

    ws.onclose = (event: CloseEvent) => {
      clearHeartbeat();
      ws = null;

      // 4xxx = application-level rejection (e.g. 4001 = Unauthorized)
      // Retrying won't help - the token is invalid or the server rejected us.
      if (event.code >= 4000 && event.code < 5000) {
        rejectAllPending("Connection rejected: " + (event.reason || "auth error"));
        setStatus("disconnected");
        return;
      }

      if (!intentionalDisconnect) {
        scheduleReconnect();
      }
    };

    ws.onerror = () => {
      // Error is followed by close, so reconnect logic is handled in onclose
    };
  }

  return {
    get status(): ConnectionStatus {
      return _status;
    },

    connect(url: string, token: string): void {
      intentionalDisconnect = false;
      currentUrl = url;
      currentToken = token;
      reconnectAttempt = 0;
      openConnection(url, token);
    },

    disconnect(): void {
      intentionalDisconnect = true;
      clearReconnectTimer();
      clearHeartbeat();
      rejectAllPending("Client disconnected");
      setStatus("disconnected");

      if (ws !== null) {
        ws.close();
        ws = null;
      }
    },

    call<T>(method: string, params?: unknown): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        if (ws === null || ws.readyState !== globalThis.WebSocket.OPEN) {
          reject(new Error("Not connected"));
          return;
        }

        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`RPC request timed out after ${REQUEST_TIMEOUT_MS}ms`));
        }, REQUEST_TIMEOUT_MS);

        pending.set(id, {
          resolve: resolve as (value: unknown) => void,
          reject,
          timer,
        });

        const message = JSON.stringify({
          jsonrpc: "2.0",
          method,
          ...(params !== undefined ? { params } : {}),
          id,
        });

        try {
          ws.send(message);
        } catch (err) {
          clearTimeout(timer);
          pending.delete(id);
          reject(new Error("Send failed: " + (err instanceof Error ? err.message : String(err))));
        }
      });
    },

    onStatusChange(handler: (status: ConnectionStatus) => void): () => void {
      statusHandlers.add(handler);
      return () => {
        statusHandlers.delete(handler);
      };
    },

    onNotification(handler: (method: string, params: unknown) => void): () => void {
      notificationHandlers.add(handler);
      return () => {
        notificationHandlers.delete(handler);
      };
    },
  };
}
