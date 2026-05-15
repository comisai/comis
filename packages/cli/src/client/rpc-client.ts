// SPDX-License-Identifier: Apache-2.0
// @allow-throw: CLI helper consumed by command entry points; throws caught at Commander.js boundary per AGENTS.md §2.1 (Phase 41 TS-HYG-07).
/**
 * WebSocket JSON-RPC 2.0 client for communicating with the Comis daemon gateway.
 *
 * Provides a thin client that sends JSON-RPC requests over WebSocket and resolves
 * responses via a pending request map. Handles connection timeouts, ECONNREFUSED
 * with descriptive error, and message parse errors.
 *
 * **Typed RPC wrapper** (Phase 35 Wave C — Plan 35-06):
 * `callTyped(client, contract, params)` is the typed entry point. It runs
 * `contract.request.parse(...)` + `contract.response.parse(...)` under the
 * `VALIDATE` gate (D-10 LOCKED — gate location is THIS file specifically,
 * not a sibling `typed-rpc.ts`). VALIDATE is on when `NODE_ENV ===
 * "development"` OR `COMIS_CLI_VALIDATE === "1"`; production builds skip
 * the parse hop for cold-start budget compliance (WEB-CONTRACTS-17). The
 * daemon side ALWAYS parses — the trust boundary lives there.
 *
 * `test/architecture/cli-uses-typed-rpc.test.ts` (WEB-CONTRACTS-09)
 * allowlists this file as the sole CLI source that may invoke
 * `client.call(...)` directly; every other CLI call site must go
 * through `callTyped(...)`. Wave C Plan 35-19 closes the gate by
 * unskipping the violation-detection assertion.
 *
 * @module
 */

import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import WebSocket from "ws";
import type { z, ZodTypeAny } from "zod";
import { loadEnvFile, systemClearTimeout, systemGetEnv, systemSetTimeout, type ApiContract } from "@comis/core";

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
// VALIDATE gate + typed-RPC wrapper (D-10 LOCKED — Plan 35-06)
// ---------------------------------------------------------------------------

/**
 * Whether `callTyped` runs `contract.request/response.parse(...)`.
 *
 * D-10 LOCKED (35-CONTEXT.md): production builds skip Zod parse to keep
 * the CLI cold-start budget (WEB-CONTRACTS-17: <= 50ms median regression).
 * Development AND opt-in `COMIS_CLI_VALIDATE=1` runs always validate. The
 * daemon side always parses regardless of this flag (trust boundary —
 * gate does not apply server-side).
 *
 * BLOCKER 10 enforcement: this gate (and the `callTyped` wrapper below)
 * lives in `packages/cli/src/client/rpc-client.ts` SPECIFICALLY. The
 * sibling `typed-rpc.ts` file mentioned in 35-RESEARCH.md §"Pattern 3"
 * is NOT created — `test/architecture/cli-uses-typed-rpc.test.ts`
 * allowlists both paths so a future split is still architecturally
 * permitted, but the canonical location for Wave C is this file.
 *
 * Empirical perf baseline (Plan 35-22; pre-state `28abe6b` → post-state
 * `3b6291d4`): post-Phase-35 CLI cold-start is **~226–235 ms faster** than
 * pre-Phase-35 across all 6 cells (3 commands × {daemon-up, daemon-down}).
 * Phase 35's dep-cut (D-01 widened: `@comis/agent` + `@comis/infra` removed
 * from cli/package.json) dominates the budget; the contract-parse cost is
 * sub-ms per call at the 190-contract scale. The 50 ms budget is satisfied
 * with a large negative margin — see
 * `.planning/phases/35-gateway-cli-web-contracts/35-PERF-BASELINE.md` for
 * the full 6-cell matrix + raw samples + gate-verification smoke results.
 * The gate is NOT load-bearing for the budget today; it remains in place
 * as defense-in-depth for any future expansion of the registry.
 */
const VALIDATE_DEV = systemGetEnv("NODE_ENV") === "development";
const VALIDATE_OPT_IN = systemGetEnv("COMIS_CLI_VALIDATE") === "1";
const VALIDATE = VALIDATE_DEV || VALIDATE_OPT_IN;

/**
 * Typed RPC wrapper. Send a contract-defined RPC call and parse the
 * response under the `VALIDATE` gate (D-10).
 *
 * Wave C consumers replace `client.call("<method>", <params>)` with
 * `callTyped(client, <DomainContract>, params)`. The `cli-uses-typed-rpc`
 * architecture test prevents regressions by forbidding raw `client.call(`
 * anywhere in `packages/cli/src/` outside this file.
 */
export async function callTyped<Req extends ZodTypeAny, Res extends ZodTypeAny>(
  client: RpcClient,
  contract: ApiContract<Req, Res>,
  params: z.input<Req>,
): Promise<z.output<Res>> {
  const validatedReq = VALIDATE ? contract.request.parse(params) : params;
  const raw = await client.call(
    contract.method,
    validatedReq as Record<string, unknown>,
  );
  return VALIDATE ? contract.response.parse(raw) : (raw as z.output<Res>);
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
    const timeout = systemSetTimeout(() => {
      ws.terminate();
      reject(
        new Error(
          `Connection to daemon timed out after ${CONNECTION_TIMEOUT_MS}ms. Is the daemon running?`,
        ),
      );
    }, CONNECTION_TIMEOUT_MS);

    ws.on("open", () => {
      systemClearTimeout(timeout);

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

    ws.on("close", () => {
      systemClearTimeout(timeout);
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
  const url = systemGetEnv("COMIS_GATEWAY_URL") ?? configDefaults.url;
  const token = systemGetEnv("COMIS_GATEWAY_TOKEN") ?? configDefaults.token;

  // Hard-fail if sending bearer token over cleartext WebSocket to non-localhost (H-3)
  const allowInsecure = systemGetEnv("COMIS_INSECURE") === "1";
  checkTransportSecurity(url, token, allowInsecure);

  const client = await createRpcClient(url, token);
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}
