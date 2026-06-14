// SPDX-License-Identifier: Apache-2.0
// @allow-throw: CLI helper consumed by command entry points; throws caught at Commander.js boundary (CLI user-facing flows exception).
/**
 * WebSocket JSON-RPC 2.0 client for communicating with the Comis daemon gateway.
 *
 * Provides a thin client that sends JSON-RPC requests over WebSocket and resolves
 * responses via a pending request map. Handles connection timeouts, ECONNREFUSED
 * with descriptive error, and message parse errors.
 *
 * **Typed RPC wrapper:**
 * `callTyped(client, contract, params)` is the typed entry point. It ALWAYS
 * runs `contract.request.parse(...)` + `contract.response.parse(...)` (the
 * gate location is THIS file specifically, not a sibling `typed-rpc.ts`).
 * Validation is unconditional on the CLI side — matching the daemon side
 * which also always parses. The Zod parse cost is sub-ms per call at the
 * current registry scale, so cold-start budget impact is negligible.
 *
 * `test/architecture/cli-uses-typed-rpc.test.ts` allowlists this file as
 * the sole CLI source that may invoke `client.call(...)` directly; every
 * other CLI call site must go through `callTyped(...)`.
 *
 * @module
 */

import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import WebSocket from "ws";
import type { z, ZodTypeAny } from "zod";
import { loadEnvFile, systemClearTimeout, systemGetEnv, systemSetTimeout, type ApiContract } from "@comis/core";
import { offlineSecretGet } from "../util/offline-secrets-store.js";

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

// ---------------------------------------------------------------------------
// Typed-RPC wrapper (always-on contract validation)
// ---------------------------------------------------------------------------

/**
 * Typed RPC wrapper. Send a contract-defined RPC call and always parse
 * both the request and response against the contract's Zod schemas.
 *
 * Consumers replace `client.call("<method>", <params>)` with
 * `callTyped(client, <DomainContract>, params)`. The `cli-uses-typed-rpc`
 * architecture test prevents regressions by forbidding raw `client.call(`
 * anywhere in `packages/cli/src/` outside this file.
 *
 * Validation is unconditional — the daemon side already always parses,
 * so this closes the previously-asymmetric CLI-side bypass surface.
 */
export async function callTyped<Req extends ZodTypeAny, Res extends ZodTypeAny>(
  client: RpcClient,
  contract: ApiContract<Req, Res>,
  params: z.input<Req>,
): Promise<z.output<Res>> {
  const validatedReq = contract.request.parse(params);
  const raw = await client.call(
    contract.method,
    validatedReq as Record<string, unknown>,
  );
  return contract.response.parse(raw);
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
  const resolved = systemGetEnv(match[1]!);
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

    // Resolve ${VAR} references in the token (e.g. ${COMIS_GATEWAY_TOKEN}).
    if (token && token.startsWith("${")) {
      ensureEnvFileLoaded();
      const fromEnv = resolveEnvRef(token);
      if (!fromEnv.startsWith("${")) {
        token = fromEnv;
      } else {
        // env / ~/.comis/.env did not define it. The install.sh wizard
        // persists COMIS_GATEWAY_TOKEN into the ENCRYPTED secrets store
        // (secrets.db), NOT into ~/.comis/.env — so a daemon-host CLI must
        // read it from the store to authenticate, otherwise every authed
        // command fails with WS close 4001. Mirrors the env→.env→store
        // resolution chain doctor's config-resolve already uses. Off-host
        // (no SECRETS_MASTER_KEY) offlineSecretGet fails and we fall through
        // to no token (unchanged behavior).
        const varName = token.slice(2, -1);
        const dataDir = os.homedir() + "/.comis";
        const fromStore = offlineSecretGet({
          name: varName,
          dataDir,
          envFilePath: dataDir + "/.env",
        });
        token = fromStore.ok && fromStore.value ? fromStore.value : undefined;
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
/**
 * Stable prefix of the gateway token-rejection error (W13 obs-llm-troubleshooting).
 * The gateway closes an unauthorized WebSocket with code 4001 (hono-server.ts);
 * mapping that close onto this named error lets `isDaemonRunning` treat an
 * auth-rejection as PROOF the daemon is up — the old path collapsed it into
 * "Connection closed unexpectedly" and the liveness probe reported a healthy
 * daemon as "not running".
 */
export const GATEWAY_AUTH_REJECTED_PREFIX = "Gateway rejected the token";

/** True when an error is the gateway token-rejection (WS close 4001/4003). */
export function isGatewayAuthRejection(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith(GATEWAY_AUTH_REJECTED_PREFIX);
}

/** Map a WebSocket close code onto the user-facing rejection error. */
function closeCodeError(code: number | undefined, reason: string): Error {
  if (code === 4001) {
    return new Error(
      GATEWAY_AUTH_REJECTED_PREFIX +
        " (WS close 4001 Unauthorized) — the daemon IS running and listening. " +
        "Set COMIS_GATEWAY_TOKEN (env var or ~/.comis/.env) to a token matching a gateway.tokens entry.",
    );
  }
  if (code === 4003) {
    return new Error(
      GATEWAY_AUTH_REJECTED_PREFIX +
        ` (WS close 4003) — ${reason.length > 0 ? reason : "this token's scope must use POST /mcp/v1, not /ws"}.`,
    );
  }
  return new Error("Connection closed unexpectedly");
}

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
    const timeout = systemSetTimeout(() => {
      ws.terminate();
      reject(
        new Error(
          `Connection to daemon timed out after ${CONNECTION_TIMEOUT_MS}ms. Is the daemon running?`,
        ),
      );
    }, CONNECTION_TIMEOUT_MS);

    let opened = false;

    ws.on("open", () => {
      systemClearTimeout(timeout);
      opened = true;

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
      systemClearTimeout(timeout);

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

    ws.on("close", (code?: number, reason?: Buffer) => {
      systemClearTimeout(timeout);
      closed = true;
      // W13: surface WHY. The gateway closes 4001/4003 for token problems —
      // collapsing those into the generic message sent operators (and the
      // live investigation) chasing a daemon that was up the whole time.
      const closeErr = closeCodeError(code, reason?.toString() ?? "");
      // A close BEFORE open (handshake-stage rejection) must reject the
      // connection promise instead of hanging until the timeout.
      if (!opened) {
        reject(closeErr);
      }
      // Reject all pending requests on unexpected close
      for (const [, p] of pending) {
        p.reject(closeErr);
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
  // Under VITEST=true, refuse to open a real WebSocket unless the test
  // author opted in via COMIS_CLI_E2E=true. A previous regression let
  // CLI tests silently open ws://localhost:4766 every 75s, leaving
  // connection-refused noise in the operator's ~/.comis/logs/.
  // CLI tests should mock the RPC client (see test/support/factories.ts);
  // genuine end-to-end tests set COMIS_CLI_E2E=true explicitly.
  if (systemGetEnv("VITEST") === "true" && systemGetEnv("COMIS_CLI_E2E") !== "true") {
    throw new Error(
      "withClient(): refusing real WebSocket under VITEST=true. " +
        "Mock the RPC client in your test (see test/support/factories.ts), " +
        "or set COMIS_CLI_E2E=true if this is an intentional E2E test.",
    );
  }

  ensureEnvFileLoaded();
  const configDefaults = resolveFromConfig();
  const url = systemGetEnv("COMIS_GATEWAY_URL") ?? configDefaults.url;
  const token = systemGetEnv("COMIS_GATEWAY_TOKEN") ?? configDefaults.token;

  // Hard-fail if sending bearer token over cleartext WebSocket to non-localhost
  const allowInsecure = systemGetEnv("COMIS_INSECURE") === "1";
  checkTransportSecurity(url, token, allowInsecure);

  const client = await createRpcClient(url, token);
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}
