// SPDX-License-Identifier: Apache-2.0
/**
 * IMAP lifecycle manager — connection, IDLE cycling, reconnect with backoff.
 *
 * Creates an IMAP connection that enters IDLE mode with a 25-minute restart
 * cycle (RFC 2177 recommends re-issuing IDLE every 29 minutes; we use 25
 * for safety margin). Falls back to polling when IDLE is unsupported.
 * Supports OAuth2 (XOAUTH2) and password authentication.
 *
 * @module
 */

import { ImapFlow } from "imapflow";
import { ok, err, fromPromise, type Result } from "@comis/shared";
import type { ComisLogger } from "@comis/core";
import { systemClearInterval, systemClearTimeout, systemNowMs, systemSetInterval, systemSetTimeout, runWithContext } from "@comis/core";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default IDLE restart interval: 25 minutes (RFC 2177 safety margin). */
const DEFAULT_MAX_IDLE_TIME_MS = 25 * 60 * 1000;

/** Default polling interval when IDLE is unsupported. */
const DEFAULT_POLLING_INTERVAL_MS = 60_000;

/** Initial reconnect delay in ms. */
const RECONNECT_BASE_MS = 1_000;

/** Maximum reconnect delay in ms (5 minutes). */
const RECONNECT_MAX_MS = 300_000;

/** Time a connection must survive before backoff resets. */
const STABLE_CONNECTION_MS = 60_000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ImapLifecycleOpts {
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass?: string; accessToken?: string };
  maxIdleTimeMs?: number;
  pollingIntervalMs?: number;
  logger: ComisLogger;
  /**
   * Optional full proxy URL (credential-bearing) for IMAP egress.
   *
   * When set, passed as imapflow's native `proxy:` option, routing the IMAP
   * connection through the configured proxy. The full URL (including any
   * credentials) is passed directly — do NOT sanitize here; sanitizeProxyUrl
   * is reserved for logs.
   *
   * The daemon's setup-channels-adapters.ts populates this field by calling
   * resolveProxyUrl(opts.host, mergedEnv). Production callers without a proxy
   * leave it undefined — the adapter behaves byte-identically to before.
   */
  proxyUrl?: string;
}

export interface ImapLifecycleHandle {
  start(): Promise<Result<void, Error>>;
  stop(): Promise<Result<void, Error>>;
  onNewMessage(
    handler: (source: Buffer, uid: number, envelope: unknown) => void,
  ): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an IMAP lifecycle manager.
 *
 * @param opts - IMAP connection and lifecycle options
 * @returns Handle with start/stop/onNewMessage methods
 */
export function createImapLifecycle(opts: ImapLifecycleOpts): ImapLifecycleHandle {
  const maxIdleTime = opts.maxIdleTimeMs ?? DEFAULT_MAX_IDLE_TIME_MS;
  const pollingInterval = opts.pollingIntervalMs ?? DEFAULT_POLLING_INTERVAL_MS;

  let client: ImapFlow | undefined;
  let lock: { release: () => void } | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let pollingTimer: ReturnType<typeof setInterval> | undefined;
  let reconnectDelay = RECONNECT_BASE_MS;
  let connectedAt = 0;
  let stopped = false;
  let prevCount = 0;

  const handlers: Array<
    (source: Buffer, uid: number, envelope: unknown) => void
  > = [];

  // Build auth object for ImapFlow
  const imapAuth = opts.auth.accessToken
    ? { user: opts.auth.user, accessToken: opts.auth.accessToken }
    : { user: opts.auth.user, pass: opts.auth.pass };

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  function createClient(): ImapFlow {
    return new ImapFlow({
      host: opts.host,
      port: opts.port,
      secure: opts.secure,
      auth: imapAuth,
      // Disable ImapFlow's built-in logger — we use Pino via opts.logger
      logger: false as never,
      maxIdleTime,
      // Pass full credential-bearing proxy URL when configured.
      // Do NOT sanitize here — sanitizeProxyUrl is reserved for logs.
      ...(opts.proxyUrl ? { proxy: opts.proxyUrl } : {}),
    });
  }

  async function fetchNewMessages(c: ImapFlow, from: number): Promise<void> {
    try {
      const range = `${from}:*`;
      for await (const msg of c.fetch(range, {
        envelope: true,
        source: true,
        uid: true,
      })) {
        const source = msg.source as Buffer;
        const uid = msg.uid;
        const envelope = msg.envelope;
        // Wrap the raw-IMAP handler dispatch in runWithContext.
        // This is a pre-normalization dispatch (handlers receive Buffer, uid,
        // envelope — not NormalizedMessage). The email-adapter handler that
        // runs inside this wrap will mint a proper traceId after normalization
        // and override the context with a second runWithContext call. The wrap
        // ensures every `for (const handler of handlers)` dispatch site runs
        // inside runWithContext.
        const preTraceId = randomUUID();
        void runWithContext(
          { traceId: preTraceId, startedAt: systemNowMs(), channelType: "email", tenantId: "default", trustLevel: "admin" },
          () => {
            for (const handler of handlers) {
              handler(source, uid, envelope);
            }
          },
        );
      }
    } catch (e) {
      opts.logger.warn(
        { err: e, channelType: "email", submodule: "imap", hint: "Fetch failed, will retry on next event", errorKind: "network" as const },
        "Failed to fetch new messages",
      );
    }
  }

  function scheduleReconnect(): void {
    if (stopped) return;

    // Add jitter: random 0-500ms
    const jitter = Math.floor(Math.random() * 500);
    const delay = reconnectDelay + jitter;

    opts.logger.info(
      { channelType: "email", submodule: "imap", delayMs: delay },
      "Scheduling IMAP reconnect",
    );

    reconnectTimer = systemSetTimeout(() => {
      if (stopped) return;
      void connectAndListen();
    }, delay);

    // Exponential backoff: double, cap at max
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  }

  async function connectAndListen(): Promise<Result<void, Error>> {
    client = createClient();

    // Register event listeners before connecting
    client.on("exists", (data: { path: string; count: number; prevCount: number }) => {
      if (data.count > data.prevCount) {
        prevCount = data.count;
        void fetchNewMessages(client!, data.prevCount + 1);
      }
    });

    client.on("close", () => {
      if (!stopped) {
        opts.logger.info(
          { channelType: "email", submodule: "imap" },
          "IMAP connection closed, scheduling reconnect",
        );
        scheduleReconnect();
      }
    });

    client.on("error", (e: Error) => {
      // Check if this is an IDLE-related error for polling fallback
      if (e.message && /idle/i.test(e.message)) {
        opts.logger.warn(
          { channelType: "email", submodule: "imap", hint: "Falling back to polling", errorKind: "platform" as const },
          "IDLE not supported, switching to polling fallback",
        );
        startPolling();
      }
    });

    const connectResult = await fromPromise(client.connect());
    if (!connectResult.ok) {
      opts.logger.error(
        { err: connectResult.error, channelType: "email", submodule: "imap", hint: "Check IMAP credentials and host", errorKind: "network" as const },
        "IMAP connection failed",
      );
      scheduleReconnect();
      return err(connectResult.error instanceof Error ? connectResult.error : new Error(String(connectResult.error)));
    }

    connectedAt = systemNowMs();

    // Reset backoff if stable
    systemSetTimeout(() => {
      if (connectedAt > 0 && systemNowMs() - connectedAt >= STABLE_CONNECTION_MS) {
        reconnectDelay = RECONNECT_BASE_MS;
      }
    }, STABLE_CONNECTION_MS + 1000);

    const lockResult = await fromPromise(client.getMailboxLock("INBOX"));
    if (!lockResult.ok) {
      opts.logger.error(
        { err: lockResult.error, channelType: "email", submodule: "imap", hint: "Could not lock INBOX", errorKind: "network" as const },
        "Failed to get INBOX lock",
      );
      return err(lockResult.error instanceof Error ? lockResult.error : new Error(String(lockResult.error)));
    }

    lock = lockResult.value as { release: () => void };
    opts.logger.info(
      { channelType: "email", submodule: "imap", host: opts.host },
      "IMAP connected and listening",
    );

    return ok(undefined);
  }

  function startPolling(): void {
    if (pollingTimer || stopped) return;
    pollingTimer = systemSetInterval(() => {
      if (client) {
        void fetchNewMessages(client, prevCount + 1);
      }
    }, pollingInterval);
  }

  // -----------------------------------------------------------------------
  // Public interface
  // -----------------------------------------------------------------------

  return {
    async start(): Promise<Result<void, Error>> {
      stopped = false;
      return connectAndListen();
    },

    async stop(): Promise<Result<void, Error>> {
      stopped = true;

      if (reconnectTimer) {
        systemClearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }

      if (pollingTimer) {
        systemClearInterval(pollingTimer);
        pollingTimer = undefined;
      }

      if (lock) {
        lock.release();
        lock = undefined;
      }

      if (client) {
        const logoutResult = await fromPromise(client.logout());
        client = undefined;
        if (!logoutResult.ok) {
          return err(
            logoutResult.error instanceof Error
              ? logoutResult.error
              : new Error(String(logoutResult.error)),
          );
        }
      }

      return ok(undefined);
    },

    onNewMessage(
      handler: (source: Buffer, uid: number, envelope: unknown) => void,
    ): void {
      handlers.push(handler);
    },
  };
}
