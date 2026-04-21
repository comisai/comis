// SPDX-License-Identifier: Apache-2.0
/**
 * iMessage JSON-RPC Client: Spawns `imsg rpc` as a child process and
 * communicates via JSON-RPC 2.0 over stdin/stdout.
 *
 * Adapted from Comis's IMessageRpcClient for Comis's hexagonal
 * architecture with Result-based error handling.
 *
 * Lifecycle:
 * 1. `start()` spawns `imsg rpc` child process
 * 2. `request(method, params)` sends JSON-RPC requests via stdin
 * 3. `onNotification(handler)` registers handlers for incoming events
 * 4. `close()` kills child process gracefully (SIGTERM, then SIGKILL)
 *
 * @module
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { ok, err, type Result } from "@comis/shared";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** JSON-RPC 2.0 notification from the imsg child process. */
export interface ImsgNotification {
  method: string;
  params?: unknown;
}

/** Options for creating an imsg client. */
export interface ImsgClientOptions {
  /** Path to the imsg binary (defaults to "imsg"). */
  binaryPath?: string;
  /** Logger interface for debug/error output. */
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
  };
}

/** The imsg JSON-RPC client interface. */
export interface ImsgClient {
  /** Send a JSON-RPC request and await the response. */
  request(method: string, params?: Record<string, unknown>): Promise<Result<unknown, Error>>;
  /** Register a handler for JSON-RPC notifications (incoming messages). */
  onNotification(handler: (notification: ImsgNotification) => void): void;
  /** Start the imsg child process. */
  start(): Promise<Result<void, Error>>;
  /** Kill the child process gracefully. */
  close(): Promise<Result<void, Error>>;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: string | number | null;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
  method?: string;
  params?: unknown;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 10_000;
const SHUTDOWN_TIMEOUT_MS = 2_000;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a JSON-RPC over stdin/stdout client for the imsg binary.
 *
 * The client spawns `imsg rpc` as a child process and multiplexes
 * request/response pairs using JSON-RPC 2.0 IDs. Notifications
 * (lines without an id) are dispatched to registered handlers.
 */
export function createImsgClient(opts: ImsgClientOptions): ImsgClient {
  const binaryPath = opts.binaryPath ?? "imsg";
  const logger = opts.logger;

  let child: ChildProcessWithoutNullStreams | null = null;
  let reader: Interface | null = null;
  let nextId = 1;
  const pending = new Map<string, PendingRequest>();
  const notificationHandlers: Array<(notification: ImsgNotification) => void> = [];

  function handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed: JsonRpcResponse;
    try {
      parsed = JSON.parse(trimmed) as JsonRpcResponse;
    } catch {
      logger.debug({ raw: trimmed }, "imsg rpc: failed to parse line");
      return;
    }

    // Response to a pending request (has id)
    if (parsed.id !== undefined && parsed.id !== null) {
      const key = String(parsed.id);
      const req = pending.get(key);
      if (!req) return;

      if (req.timer) clearTimeout(req.timer);
      pending.delete(key);

      if (parsed.error) {
        const msg = parsed.error.message ?? "imsg rpc error";
        req.reject(new Error(msg));
        return;
      }
      req.resolve(parsed.result);
      return;
    }

    // Notification (no id, has method)
    if (parsed.method) {
      const notification: ImsgNotification = {
        method: parsed.method,
        params: parsed.params,
      };
      for (const handler of notificationHandlers) {
        try {
          handler(notification);
        } catch (handlerErr) {
          logger.error({ err: handlerErr, hint: "Check imsg notification handler for unhandled errors", errorKind: "internal" as const }, "imsg notification handler error");
        }
      }
    }
  }

  function failAll(error: Error): void {
    for (const [key, req] of pending.entries()) {
      if (req.timer) clearTimeout(req.timer);
      req.reject(error);
      pending.delete(key);
    }
  }

  const client: ImsgClient = {
    async start(): Promise<Result<void, Error>> {
      if (child) return ok(undefined);

      try {
        const proc = spawn(binaryPath, ["rpc"], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        child = proc;

        reader = createInterface({ input: proc.stdout });
        reader.on("line", handleLine);

        proc.stderr?.on("data", (chunk: Buffer) => {
          const lines = chunk.toString().split(/\r?\n/);
          for (const line of lines) {
            if (line.trim()) {
              logger.debug(`imsg stderr: ${line.trim()}`);
            }
          }
        });

        proc.on("error", (procErr) => {
          failAll(procErr instanceof Error ? procErr : new Error(String(procErr)));
          logger.error({ err: procErr, hint: "Check imsg binary availability and permissions", errorKind: "dependency" as const }, "imsg child process error");
        });

        proc.on("close", (code, signal) => {
          const reason = signal ? `signal ${signal}` : `code ${code}`;
          failAll(new Error(`imsg rpc exited (${reason})`));
          child = null;
          reader = null;
        });

        logger.info({ binaryPath }, "imsg rpc child process started");
        return ok(undefined);
      } catch (spawnErr) {
        const message = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
        return err(new Error(`Failed to spawn imsg rpc: ${message}`));
      }
    },

    async request(
      method: string,
      params?: Record<string, unknown>,
    ): Promise<Result<unknown, Error>> {
      if (!child || !child.stdin) {
        return err(new Error("imsg rpc not running"));
      }

      const id = nextId++;
      const payload = {
        jsonrpc: "2.0",
        id,
        method,
        params: params ?? {},
      };
      const line = `${JSON.stringify(payload)}\n`;

      return new Promise<Result<unknown, Error>>((resolve) => {
        const key = String(id);
        const timer = setTimeout(() => {
          pending.delete(key);
          resolve(err(new Error(`imsg rpc timeout (${method})`)));
        }, DEFAULT_TIMEOUT_MS);

        pending.set(key, {
          resolve: (value) => {
            resolve(ok(value));
          },
          reject: (error) => {
            resolve(err(error));
          },
          timer,
        });

        child!.stdin!.write(line);
      });
    },

    onNotification(handler: (notification: ImsgNotification) => void): void {
      notificationHandlers.push(handler);
    },

    async close(): Promise<Result<void, Error>> {
      if (!child) return ok(undefined);

      try {
        reader?.close();
        reader = null;

        const proc = child;
        child = null;

        // Try graceful stdin close first
        proc.stdin?.end();

        // Wait for graceful exit, then force kill
        await new Promise<void>((resolve) => {
          const forceKillTimer = setTimeout(() => {
            if (!proc.killed) {
              proc.kill("SIGTERM");
              // Final SIGKILL after additional timeout
              setTimeout(() => {
                if (!proc.killed) {
                  proc.kill("SIGKILL");
                }
                resolve();
              }, 1000);
            } else {
              resolve();
            }
          }, SHUTDOWN_TIMEOUT_MS);

          proc.on("close", () => {
            clearTimeout(forceKillTimer);
            resolve();
          });
        });

        failAll(new Error("imsg rpc closed"));
        logger.info("imsg rpc child process stopped");
        return ok(undefined);
      } catch (closeErr) {
        const message = closeErr instanceof Error ? closeErr.message : String(closeErr);
        return err(new Error(`Failed to stop imsg rpc: ${message}`));
      }
    },
  };

  return client;
}
