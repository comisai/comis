// SPDX-License-Identifier: Apache-2.0
/**
 * WebSocket JSON-RPC 2.0 client for communicating with the Comis daemon gateway.
 *
 * Provides a thin client that sends JSON-RPC requests over WebSocket and resolves
 * responses via a pending request map. Handles connection timeouts, ECONNREFUSED
 * with descriptive error, and message parse errors.
 *
 * @module
 */

import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import WebSocket from "ws";
import { loadEnvFile } from "@comis/core";

/**
 * JSON-RPC client interface for making RPC calls to the daemon.
 */
export interface RpcClient {
  /** Send a JSON-RPC request and await the result. */
  call(method: string, params?: unknown): Promise<unknown>;
  /** Close the WebSocket connection. */
  close(): void;
  /** Register a handler for server-pushed JSON-RPC notifications. */
  onNotification(handler: (method: string, params: unknown) => void): void;
}

/** Default connection timeout in milliseconds. */
const CONNECTION_TIMEOUT_MS = 2000;

/** Fallback gateway WebSocket URL when no config is found. */
const FALLBACK_GATEWAY_URL = "ws://localhost:4766/ws";

/** Whether we have already loaded ~/.comis/.env into process.env. */
let envFileLoaded = false;

/**
 * Ensure ~/.comis/.env is loaded into process.env (once).
 *
 * The daemon calls loadEnvFile() at startup, but the CLI does not.
 * Config values like `${COMIS_GATEWAY_TOKEN}` reference env vars that
 * live in the .env file, so the CLI must load it too before resolving.
 */
function ensureEnvFileLoaded(): void {
  if (envFileLoaded) return;
  envFileLoaded = true;
  const envPath = os.homedir() + "/.comis/.env";
  loadEnvFile(envPath);
}

/**
 * Resolve `${VAR}` references in a string using process.env.
 *
 * Returns the original string if it contains no references or if the
 * referenced variable is not set.
 */
function resolveEnvRef(value: string): string {
  const match = value.match(/^\$\{([A-Z_][A-Z0-9_]*)\}$/);
  if (!match) return value;
  // eslint-disable-next-line no-restricted-syntax -- CLI bootstrap before SecretManager
  const resolved = process.env[match[1]!];
  return resolved ?? value;
}

/**
 * Resolve gateway URL, token, and TLS status from config file on disk.
 *
 * Reads ~/.comis/config.yaml (matching daemon defaults) to extract
 * gateway.host, gateway.port, TLS configuration, and the first token secret.
 * Uses a minimal line-based parser to avoid importing the full YAML library.
 * Resolves `${VAR}` references in token values via ~/.comis/.env.
 */
function resolveFromConfig(): { url: string; token: string | undefined; tls: boolean } {
  const configPath = os.homedir() + "/.comis/config.yaml";
  if (!existsSync(configPath)) {
    return { url: FALLBACK_GATEWAY_URL, token: undefined, tls: false };
  }

  try {
    const content = readFileSync(configPath, "utf-8");
    const lines = content.split("\n");

    let host = "localhost";
    let port = "4766";
    let token: string | undefined;
    let tls = false;
    let inGateway = false;
    let inTokens = false;
    let inTls = false;
    let foundSecret = false;

    for (const line of lines) {
      const trimmed = line.trimStart();

      // Track top-level sections
      if (!line.startsWith(" ") && !line.startsWith("\t") && trimmed.length > 0 && !trimmed.startsWith("#")) {
        inGateway = trimmed.startsWith("gateway:");
        if (!inGateway) {
          inTokens = false;
          inTls = false;
        }
      }

      if (inGateway) {
        const hostMatch = trimmed.match(/^host:\s*(.+)/);
        if (hostMatch) host = hostMatch[1]!.trim();

        const portMatch = trimmed.match(/^port:\s*(\d+)/);
        if (portMatch) port = portMatch[1]!;

        if (trimmed.startsWith("tokens:")) {
          inTokens = true;
          inTls = false;
          continue;
        }

        // Detect TLS configuration under gateway
        if (trimmed.startsWith("tls:")) {
          inTls = true;
          inTokens = false;
          continue;
        }

        if (inTls) {
          // TLS is enabled if cert: or enabled: true is present
          const certMatch = trimmed.match(/^cert:\s*(.+)/);
          if (certMatch && certMatch[1]!.trim().length > 0) {
            tls = true;
          }
          const enabledMatch = trimmed.match(/^enabled:\s*(true|yes)/i);
          if (enabledMatch) {
            tls = true;
          }
        }

        if (inTokens && !foundSecret) {
          const secretMatch = trimmed.match(/^secret:\s*(.+)/);
          if (secretMatch) {
            token = secretMatch[1]!.trim();
            foundSecret = true;
          }
        }
      }
    }

    // Resolve ${VAR} references in the token (e.g. ${COMIS_GATEWAY_TOKEN})
    if (token && token.startsWith("${")) {
      ensureEnvFileLoaded();
      token = resolveEnvRef(token);
      // If still unresolved, treat as no token
      if (token.startsWith("${")) {
        token = undefined;
      }
    }

    // gateway.host is a *bind* address. As a *connect* host, the wildcard
    // values (0.0.0.0 / ::) aren't valid — remap to loopback so the CLI
    // can reach a daemon that's binding all interfaces (the default for
    // LAN / Docker deployments).
    const connectHost = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
    const protocol = tls ? "wss" : "ws";
    return { url: `${protocol}://${connectHost}:${port}/ws`, token, tls };
  } catch {
    return { url: FALLBACK_GATEWAY_URL, token: undefined, tls: false };
  }
}

/**
 * Error thrown when attempting to send a bearer token over an unencrypted
 * WebSocket connection to a non-localhost host.
 *
 * Use `COMIS_INSECURE=1` env var to override.
 */
export class InsecureTransportError extends Error {
  constructor(host: string) {
    super(
      `Refusing to send authentication token over unencrypted WebSocket to ${host}.\n` +
      "This would expose your credentials to network observers.\n" +
      "Options:\n" +
      "  1. Configure TLS in gateway settings (recommended)\n" +
      "  2. Use wss:// protocol\n" +
      "  3. Set COMIS_INSECURE=1 to override (NOT recommended for production)",
    );
    this.name = "InsecureTransportError";
  }
}

/**
 * Check transport security and throw if sending a bearer token over cleartext
 * WebSocket to a non-localhost host.
 *
 * When `allowInsecure` is true, logs a warning instead of throwing.
 *
 * Exported for testing.
 *
 * @param url - WebSocket URL being connected to
 * @param token - Bearer token being sent (if any)
 * @param allowInsecure - When true, warn instead of throw (default: false)
 */
export function checkTransportSecurity(url: string, token: string | undefined, allowInsecure = false): void {
  if (!token || !url.startsWith("ws://")) {
    return;
  }

  try {
    const urlObj = new URL(url);
    const host = urlObj.hostname;
    const isLocalhost = host === "localhost" || host === "127.0.0.1" || host === "::1";

    if (!isLocalhost) {
      if (allowInsecure) {
        console.warn(
          "WARNING: Sending authentication token over unencrypted WebSocket to non-localhost host.\n" +
          "         This is insecure. Configure TLS in gateway settings for production use.",
        );
        return;
      }
      throw new InsecureTransportError(host);
    }
  } catch (e) {
    // Re-throw InsecureTransportError; ignore URL parse errors
    if (e instanceof InsecureTransportError) throw e;
  }
}

/**
 * Create an RPC client connected to the daemon gateway via WebSocket.
 *
 * @param url - WebSocket URL for the gateway (e.g. ws://localhost:3100/ws)
 * @param token - Optional bearer token for authentication
 * @returns A connected RpcClient ready for calls
 * @throws Error if connection times out or is refused
 */
export async function createRpcClient(url: string, token?: string): Promise<RpcClient> {
  return new Promise<RpcClient>((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (token) {
      headers["authorization"] = `Bearer ${token}`;
    }

    const ws = new WebSocket(url, { headers });

    let nextId = 1;
    let closed = false;
    const pending = new Map<
      number,
      { resolve: (value: unknown) => void; reject: (reason: Error) => void }
    >();
    const notificationHandlers: Array<(method: string, params: unknown) => void> = [];

    // Connection timeout
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(
        new Error(
          `Connection to daemon timed out after ${CONNECTION_TIMEOUT_MS}ms. Is the daemon running?`,
        ),
      );
    }, CONNECTION_TIMEOUT_MS);

    ws.on("open", () => {
      clearTimeout(timeout);

      resolve({
        call(method: string, params?: unknown): Promise<unknown> {
          if (closed) {
            return Promise.reject(new Error("Connection closed unexpectedly"));
          }
          const id = nextId++;
          return new Promise<unknown>((res, rej) => {
            pending.set(id, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
          });
        },

        close() {
          closed = true;
          // Reject all pending requests
          for (const [, p] of pending) {
            p.reject(new Error("Client closed"));
          }
          pending.clear();
          ws.close();
        },

        onNotification(handler: (method: string, params: unknown) => void): void {
          notificationHandlers.push(handler);
        },
      });
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as {
          id?: number;
          method?: string;
          params?: unknown;
          result?: unknown;
          error?: { code: number; message: string; data?: unknown };
        };

        if (msg.id == null) {
          // JSON-RPC notification (server-pushed, no id)
          const method = msg.method;
          if (typeof method === "string" && method !== "heartbeat") {
            for (const handler of notificationHandlers) {
              try {
                handler(method, msg.params);
              } catch {
                // Notification handler errors must not crash the client
              }
            }
          }
          return;
        }

        const p = pending.get(msg.id);
        if (!p) return;

        pending.delete(msg.id);

        if (msg.error) {
          p.reject(new Error(msg.error.message));
        } else {
          p.resolve(msg.result);
        }
      } catch {
        // Parse error — ignore malformed messages
      }
    });

    ws.on("error", (error: Error & { code?: string }) => {
      clearTimeout(timeout);

      if (error.code === "ECONNREFUSED") {
        reject(
          new Error(
            `Cannot connect to daemon at ${url}. ` +
            "Possible causes: daemon not running, gateway disabled in config, or wrong port. " +
            "Start with: comis daemon start",
          ),
        );
      } else {
        reject(error);
      }
    });

    ws.on("close", () => {
      clearTimeout(timeout);
      closed = true;
      // Reject all pending requests on unexpected close
      for (const [, p] of pending) {
        p.reject(new Error("Connection closed unexpectedly"));
      }
      pending.clear();
    });
  });
}

/**
 * Convenience wrapper that creates a client, runs a function, then closes.
 *
 * Reads gateway URL from COMIS_GATEWAY_URL env var (default: ws://localhost:3100/ws).
 * Reads token from COMIS_GATEWAY_TOKEN env var (default: none).
 *
 * @param fn - Async function to execute with the connected client
 * @returns The result of fn
 */
export async function withClient<T>(fn: (client: RpcClient) => Promise<T>): Promise<T> {
  ensureEnvFileLoaded();
  const configDefaults = resolveFromConfig();
  // eslint-disable-next-line no-restricted-syntax -- CLI bootstrap before SecretManager
  const url = process.env["COMIS_GATEWAY_URL"] ?? configDefaults.url;
  // eslint-disable-next-line no-restricted-syntax -- CLI bootstrap before SecretManager
  const token = process.env["COMIS_GATEWAY_TOKEN"] ?? configDefaults.token;

  // Hard-fail if sending bearer token over cleartext WebSocket to non-localhost (H-3)
  // eslint-disable-next-line no-restricted-syntax -- CLI bootstrap before SecretManager
  const allowInsecure = process.env["COMIS_INSECURE"] === "1";
  checkTransportSecurity(url, token, allowInsecure);

  const client = await createRpcClient(url, token);
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}
