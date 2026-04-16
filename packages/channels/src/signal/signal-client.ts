/**
 * Signal JSON-RPC HTTP + SSE Client.
 *
 * Communicates with the signal-cli daemon running in HTTP mode
 * (`signal-cli daemon --http`). Provides:
 * - `signalRpcRequest()` — JSON-RPC 2.0 POST to /api/v1/rpc
 * - `signalHealthCheck()` — GET /api/v1/check
 * - `createSignalEventStream()` — SSE async iterator from /api/v1/events
 *
 * Adapted from Comis's signal/client.ts for Comis's Result-based API.
 *
 * @module
 */

import { ok, err, type Result } from "@comis/shared";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SignalRpcOptions {
  baseUrl: string;
  account?: string;
  timeoutMs?: number;
}

export interface SignalEnvelope {
  source?: string;
  sourceUuid?: string;
  sourceName?: string;
  sourceNumber?: string;
  timestamp?: number;
  dataMessage?: {
    message?: string | null;
    groupInfo?: {
      groupId?: string;
      groupName?: string;
      type?: string;
    } | null;
    attachments?: SignalAttachment[] | null;
    reaction?: {
      emoji?: string;
      targetAuthor?: string;
      targetAuthorUuid?: string;
      targetSentTimestamp?: number;
      isRemove?: boolean;
    } | null;
    quote?: {
      id?: number;
      author?: string;
      authorUuid?: string;
      text?: string;
    } | null;
  } | null;
  typingMessage?: {
    action?: string;
    timestamp?: number;
    groupId?: string;
  } | null;
  receiptMessage?: {
    type?: string;
    timestamps?: number[];
  } | null;
}

export interface SignalAttachment {
  id?: string;
  contentType?: string;
  filename?: string;
  size?: number;
}

interface SignalRpcResponse<T = unknown> {
  jsonrpc?: string;
  result?: T;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
  id?: string | number | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 10_000;

function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) {
    throw new Error("Signal base URL is required");
  }
  // If protocol already specified, keep it (user override)
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed.replace(/\/+$/, "");
  }
  // Default to http for localhost (signal-cli daemon runs locally)
  // Default to https for all other hosts (security: no cleartext over network)
  const hostPart = trimmed.split(":")[0].split("/")[0].toLowerCase();
  const isLocalhost = hostPart === "localhost" || hostPart === "127.0.0.1" || hostPart === "::1" || hostPart === "[::1]";
  const protocol = isLocalhost ? "http" : "https";
  return `${protocol}://${trimmed}`.replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// JSON-RPC request
// ---------------------------------------------------------------------------

/**
 * Execute a JSON-RPC 2.0 request against the signal-cli daemon.
 *
 * @param method - The RPC method name (e.g. "send", "listAccounts")
 * @param params - Method parameters
 * @param opts - Connection options (baseUrl, account, timeoutMs)
 * @returns The RPC result on success, or an Error
 */
export async function signalRpcRequest(
  method: string,
  params: Record<string, unknown> | undefined,
  opts: SignalRpcOptions,
): Promise<Result<unknown, Error>> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const id = randomUUID();

  const effectiveParams = params ? { ...params } : undefined;
  if (effectiveParams && opts.account && !effectiveParams.account) {
    effectiveParams.account = opts.account;
  }

  const body = JSON.stringify({
    jsonrpc: "2.0",
    method,
    params: effectiveParams,
    id,
  });

  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${baseUrl}/api/v1/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });

    if (res.status === 201) {
      return ok(undefined);
    }

    const text = await res.text();
    if (!text) {
      return err(new Error(`Signal RPC empty response (status ${res.status})`));
    }

    const parsed: SignalRpcResponse = JSON.parse(text);
    if (parsed.error) {
      const code = parsed.error.code ?? "unknown";
      const msg = parsed.error.message ?? "Signal RPC error";
      return err(new Error(`Signal RPC ${code}: ${msg}`));
    }

    return ok(parsed.result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(new Error(`Signal RPC request failed: ${message}`));
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

/**
 * Check if the signal-cli daemon is reachable.
 *
 * @param baseUrl - The signal-cli HTTP base URL
 * @param timeoutMs - Request timeout in milliseconds
 * @returns void on success, Error if unreachable
 */
export async function signalHealthCheck(
  baseUrl: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Result<void, Error>> {
  const normalized = normalizeBaseUrl(baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${normalized}/api/v1/check`, {
      method: "GET",
      signal: controller.signal,
    });

    if (!res.ok) {
      return err(new Error(`Signal health check failed: HTTP ${res.status}`));
    }

    return ok(undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(new Error(`Signal health check failed: ${message}`));
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// SSE event stream
// ---------------------------------------------------------------------------

export interface SignalSseEvent {
  event?: string;
  data?: string;
  id?: string;
}

/**
 * Create an async iterator over SSE events from the signal-cli daemon.
 *
 * Connects to GET /api/v1/events and yields parsed SSE events.
 * Handles reconnection with exponential backoff (1s, 2s, 4s, max 30s).
 * Accepts AbortSignal for cancellation.
 *
 * @param baseUrl - The signal-cli HTTP base URL
 * @param signal - Optional AbortSignal to cancel the stream
 * @param account - Optional account filter
 * @returns An async iterable of SignalSseEvent objects
 */
export async function* createSignalEventStream(
  baseUrl: string,
  signal?: AbortSignal,
  account?: string,
): AsyncGenerator<SignalSseEvent, void, undefined> {
  const normalized = normalizeBaseUrl(baseUrl);
  let backoff = 1000;
  const maxBackoff = 30_000;

  while (!signal?.aborted) {
    try {
      const url = new URL(`${normalized}/api/v1/events`);
      if (account) {
        url.searchParams.set("account", account);
      }

      const res = await fetch(url, {
        method: "GET",
        headers: { Accept: "text/event-stream" },
        signal,
      });

      if (!res.ok || !res.body) {
        throw new Error(`Signal SSE failed (${res.status} ${res.statusText || "error"})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let currentEvent: SignalSseEvent = {};

      // Reset backoff on successful connection
      backoff = 1000;

      try {
        while (!signal?.aborted) {
          const { value, done } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          let lineEnd = buffer.indexOf("\n");

          while (lineEnd !== -1) {
            let line = buffer.slice(0, lineEnd);
            buffer = buffer.slice(lineEnd + 1);

            if (line.endsWith("\r")) {
              line = line.slice(0, -1);
            }

            if (line === "") {
              // Empty line = end of event
              if (currentEvent.data || currentEvent.event || currentEvent.id) {
                yield currentEvent;
                currentEvent = {};
              }
              lineEnd = buffer.indexOf("\n");
              continue;
            }

            // Skip comments
            if (line.startsWith(":")) {
              lineEnd = buffer.indexOf("\n");
              continue;
            }

            const colonIdx = line.indexOf(":");
            if (colonIdx === -1) {
              lineEnd = buffer.indexOf("\n");
              continue;
            }

            const field = line.slice(0, colonIdx).trim();
            const rawValue = line.slice(colonIdx + 1);
            const fieldValue = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;

            if (field === "event") {
              currentEvent.event = fieldValue;
            } else if (field === "data") {
              currentEvent.data = currentEvent.data
                ? `${currentEvent.data}\n${fieldValue}`
                : fieldValue;
            } else if (field === "id") {
              currentEvent.id = fieldValue;
            }

            lineEnd = buffer.indexOf("\n");
          }
        }

        // Flush any remaining event
        if (currentEvent.data || currentEvent.event || currentEvent.id) {
          yield currentEvent;
        }
      } finally {
        reader.releaseLock();
      }
    } catch {
      if (signal?.aborted) return;

      // Exponential backoff reconnection
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, backoff);
          if (signal) {
            const onAbort = () => {
              clearTimeout(timer);
              reject(new Error("Aborted"));
            };
            signal.addEventListener("abort", onAbort, { once: true });
          }
        });
      } catch {
        // Aborted during backoff — expected when signal fires
      }

      if (signal?.aborted) return;

      backoff = Math.min(backoff * 2, maxBackoff);
    }
  }
}
