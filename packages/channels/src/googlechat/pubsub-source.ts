// SPDX-License-Identifier: Apache-2.0
/**
 * Google Chat inbound transport: a REST long-poll pull loop over a Pub/Sub
 * subscription.
 *
 * In the no-public-IP mode the subscription IS the inbound boundary — only the
 * service account (via the subscription ACL) can pull it, so there is no
 * forgeable public endpoint. This module owns the loop:
 *
 *   `subscription:pull` (long-poll) -> base64-decode each `message.data` ->
 *   `JSON.parse` the classic Chat interaction event -> dedup on the event's
 *   `message.name` -> dispatch to the injected `onEvent` -> `subscription:acknowledge`.
 *
 * Ack discipline is the load-bearing correctness property: a message is acked
 * ONLY after `onEvent` resolves. A rejecting `onEvent` (a full/failed inbound
 * queue) SKIPS the ack, so Pub/Sub redelivers the message. Redelivery is safe
 * because a duplicate is deduped on the stable `message.name` (the Chat resource
 * name, not the per-delivery Pub/Sub messageId) before it reaches `onEvent`, and
 * a name is marked seen ONLY on the ack path — so a message whose enqueue failed
 * is re-dispatched on redelivery rather than silently dropped.
 *
 * Transport-only and framework-agnostic: `fetch`, the clock, and the backoff
 * timers are all injectable seams, so the whole loop is unit-testable without a
 * real network, real time, or a gRPC client. The `data` payload is STANDARD
 * base64 (`Buffer.from(data, "base64")`) — not the URL-safe alphabet — and
 * decodes directly to the interaction event; there is no CloudEvents envelope
 * on this path.
 *
 * Secret discipline: the pubsub Bearer token is only ever placed on the request
 * `authorization` header. It is NEVER written to a log field — failure branches
 * log only `errorKind` + `hint` via the shared classifier.
 *
 * @module
 */

import { fromPromise, type Result } from "@comis/shared";
import {
  systemNowMs,
  systemSetTimeout,
  systemClearTimeout,
  type ComisLogger,
} from "@comis/core";
import { classifyGoogleChatError } from "./errors.js";

/** The Pub/Sub REST v1 base URL the pull/ack requests target. */
const DEFAULT_PUBSUB_BASE_URL = "https://pubsub.googleapis.com/v1";

/** How many messages to request per long-poll. */
const DEFAULT_MAX_MESSAGES = 10;

/** Upper bound on the dedup seen-set before oldest-first eviction. */
const DEFAULT_SEEN_SET_MAX = 1000;

/** Backoff floor after the first pull failure, in ms. */
const DEFAULT_BACKOFF_FLOOR_MS = 1000;

/** Backoff ceiling the exponential doubling saturates at, in ms. */
const DEFAULT_BACKOFF_CAP_MS = 30_000;

/** Consecutive pull failures before the loop logs a loud ERROR. */
const DEFAULT_ERROR_LOG_THRESHOLD = 3;

/** Upper bound on the additive backoff jitter, in ms. */
const JITTER_MS = 500;

/** Dependencies for the Pub/Sub pull-loop source. */
export interface PubSubSourceDeps {
  /** The subscription resource: `projects/{project}/subscriptions/{sub}`. */
  subscriptionName: string;
  /** Mints a pubsub-scope Bearer token; the loop never caches it itself. */
  getPubSubToken: () => Promise<Result<string, Error>>;
  /**
   * The inbound dispatch. RESOLVE means the message was enqueued and may be
   * acked; REJECT means the enqueue failed and the ack must be skipped so
   * Pub/Sub redelivers.
   */
  onEvent: (event: unknown) => Promise<void>;
  /** Logger for the pull-cycle summary and each failure branch. */
  logger: ComisLogger;
  /** Injected fetch, defaulting to the global; lets a unit test stub the pull/ack. */
  fetchImpl?: typeof fetch;
  /** Injected clock in ms, defaulting to systemNowMs; makes timing deterministic. */
  now?: () => number;
  /** Pub/Sub base-URL override — a test-only seam. */
  pubsubBaseUrl?: string;
  /** Max messages per long-poll. Defaults to 10. */
  maxMessages?: number;
  /** Bounded dedup-set size before oldest-first eviction. Defaults to 1000. */
  seenSetMax?: number;
  /** Injected one-shot timer for backoff, defaulting to systemSetTimeout. */
  setTimeoutImpl?: typeof systemSetTimeout;
  /** Injected timer canceller, defaulting to systemClearTimeout. */
  clearTimeoutImpl?: typeof systemClearTimeout;
  /** Backoff floor in ms. Defaults to 1000. */
  backoffFloorMs?: number;
  /** Backoff cap in ms. Defaults to 30000. */
  backoffCapMs?: number;
  /** Jitter randomness, defaulting to Math.random. */
  rng?: () => number;
  /** Consecutive pull failures before a loud ERROR. Defaults to 3. */
  errorLogThreshold?: number;
}

/** The outcome of a single pull cycle. */
export interface PollOutcome {
  /** Messages returned by the pull. */
  receivedCount: number;
  /** Messages acknowledged (enqueued, deduped, or unparseable). */
  ackedCount: number;
  /** Messages whose enqueue rejected and were left un-acked for redelivery. */
  skippedCount: number;
  /** True when the pull itself failed (token, transport, status, or body). */
  pullFailed: boolean;
}

/** The long-poll pull-loop source. */
export interface PubSubSource {
  /** Start the self-rescheduling pull loop. Idempotent while running. */
  start(): void;
  /** Abort any in-flight long-poll, cancel a pending backoff, and stop the loop. */
  stop(): Promise<void>;
  /** Run one pull/decode/dedup/dispatch/ack cycle. */
  pollOnce(): Promise<PollOutcome>;
  /** The most recent failure hint, for adapter status degradation. */
  readonly lastError: string | undefined;
  /** Whether the loop is currently running. */
  readonly running: boolean;
}

/** The Pub/Sub-assigned envelope around one pulled message. */
interface ReceivedMessage {
  ackId?: string;
  message?: { data?: string; messageId?: string };
}

/** The `subscription:pull` response body. */
interface PullResponse {
  receivedMessages?: ReceivedMessage[];
}

const EMPTY_OUTCOME: PollOutcome = {
  receivedCount: 0,
  ackedCount: 0,
  skippedCount: 0,
  pullFailed: true,
};

/**
 * Extract the dedup key — the decoded Chat event's `message.name` (the stable
 * `spaces/X/messages/Y` resource name, constant across redeliveries) — from an
 * untrusted decoded payload, or undefined when absent.
 */
function extractMessageName(event: unknown): string | undefined {
  if (event === null || typeof event !== "object") return undefined;
  const message = (event as { message?: unknown }).message;
  if (message === null || typeof message !== "object") return undefined;
  const name = (message as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

/**
 * Build a Pub/Sub pull-loop source. The returned source can `pollOnce()` a
 * single cycle (used by the tests and by the loop) or `start()` the
 * self-rescheduling loop; `stop()` aborts an in-flight long-poll and cancels a
 * pending backoff.
 */
export function createPubSubSource(deps: PubSubSourceDeps): PubSubSource {
  const now = deps.now ?? systemNowMs;
  const doFetch = deps.fetchImpl ?? fetch;
  const base = deps.pubsubBaseUrl ?? DEFAULT_PUBSUB_BASE_URL;
  const maxMessages = deps.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const seenSetMax = deps.seenSetMax ?? DEFAULT_SEEN_SET_MAX;

  // Insertion-ordered dedup set. `markSeen` evicts the oldest key once the set
  // grows past its bound, so a long-lived loop cannot leak memory.
  const seen = new Map<string, true>();

  let lastError: string | undefined;
  let running = false;
  // Consecutive `pullFailed` cycles; drives the loud-ERROR threshold and resets
  // to 0 after any good pull.
  let consecutiveFailures = 0;
  // The in-flight backoff timer handle, so `stop()` can cancel a pending sleep.
  let pendingBackoff: ReturnType<typeof systemSetTimeout> | undefined;
  // Recreated in `start()`; passed to both the pull fetch and the ack fetch so a
  // `stop()` aborts an in-flight long-poll immediately.
  let controller = new AbortController();

  function markSeen(name: string): void {
    seen.set(name, true);
    if (seen.size > seenSetMax) {
      const oldest = seen.keys().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
  }

  async function acknowledge(ackIds: string[], token: string): Promise<void> {
    const acked = await fromPromise(
      doFetch(`${base}/${deps.subscriptionName}:acknowledge`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ ackIds }),
        signal: controller.signal,
      }),
    );
    if (!acked.ok) {
      const classified = classifyGoogleChatError(undefined, acked.error);
      deps.logger.warn(
        {
          channelType: "googlechat" as const,
          hint: "Acknowledge failed; the messages will redeliver and dedup on the next pull",
          errorKind: classified.errorKind,
        },
        "Pub/Sub acknowledge request failed",
      );
      return;
    }
    if (!acked.value.ok) {
      const classified = classifyGoogleChatError(acked.value.status);
      deps.logger.warn(
        {
          channelType: "googlechat" as const,
          status: acked.value.status,
          hint: "Acknowledge returned a non-ok status; the messages will redeliver and dedup on the next pull",
          errorKind: classified.errorKind,
        },
        "Pub/Sub acknowledge returned a non-ok status",
      );
    }
  }

  async function pollOnce(): Promise<PollOutcome> {
    const startedAt = now();

    const tokenRes = await deps.getPubSubToken();
    if (!tokenRes.ok) {
      lastError = "pubsub token mint failed";
      return { ...EMPTY_OUTCOME };
    }
    const token = tokenRes.value;

    const pulled = await fromPromise(
      doFetch(`${base}/${deps.subscriptionName}:pull`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ maxMessages }),
        signal: controller.signal,
      }),
    );
    if (!pulled.ok) {
      // An aborted long-poll is an expected stop, not a failure to log loudly.
      if (controller.signal.aborted) return { ...EMPTY_OUTCOME };
      const classified = classifyGoogleChatError(undefined, pulled.error);
      lastError = classified.hint;
      deps.logger.warn(
        {
          channelType: "googlechat" as const,
          hint: classified.hint,
          errorKind: classified.errorKind,
        },
        "Pub/Sub pull failed at the transport level",
      );
      return { ...EMPTY_OUTCOME };
    }

    const res = pulled.value;
    if (!res.ok) {
      const classified = classifyGoogleChatError(res.status);
      lastError = classified.hint;
      deps.logger.warn(
        {
          channelType: "googlechat" as const,
          status: res.status,
          hint: classified.hint,
          errorKind: classified.errorKind,
        },
        "Pub/Sub pull returned a non-ok status",
      );
      return { ...EMPTY_OUTCOME };
    }

    const parsed = await fromPromise(res.json() as Promise<PullResponse>);
    if (!parsed.ok) {
      lastError = "pull response body was not valid JSON";
      deps.logger.warn(
        {
          channelType: "googlechat" as const,
          hint: "The pull response was not valid JSON — verify the subscription endpoint",
          errorKind: "platform" as const,
        },
        "Pub/Sub pull returned an unreadable body",
      );
      return { ...EMPTY_OUTCOME };
    }

    const received = parsed.value.receivedMessages ?? [];
    const ackIds: string[] = [];
    let skipped = 0;

    for (const rm of received) {
      const ackId = rm.ackId;
      const data = rm.message?.data;
      if (typeof ackId !== "string" || typeof data !== "string") {
        // A malformed envelope carries no ackId/data — nothing to dispatch or ack.
        continue;
      }

      let decoded: unknown;
      try {
        // STANDARD base64 (not the URL-safe alphabet): the Chat event decodes here.
        decoded = JSON.parse(Buffer.from(data, "base64").toString("utf8"));
      } catch {
        // Undecodable payload — ack it so it stops redelivering; nothing to dispatch.
        ackIds.push(ackId);
        continue;
      }

      // Dedup on the decoded event's message.name (stable across redeliveries).
      const name = extractMessageName(decoded);
      if (name !== undefined && seen.has(name)) {
        ackIds.push(ackId);
        continue;
      }

      try {
        await deps.onEvent(decoded);
        // Mark seen ONLY after a successful dispatch, so a redelivery following a
        // failed enqueue is re-dispatched rather than dropped as a duplicate.
        if (name !== undefined) markSeen(name);
        ackIds.push(ackId);
      } catch {
        skipped += 1;
        lastError = "inbound enqueue failed; message will redeliver";
        deps.logger.warn(
          {
            channelType: "googlechat" as const,
            hint: "Inbound enqueue failed; ack skipped so Pub/Sub redelivers (dedup on the message name makes this safe)",
            errorKind: "internal" as const,
          },
          "Pub/Sub message enqueue failed; skipping ack",
        );
      }
    }

    if (ackIds.length > 0) {
      await acknowledge(ackIds, token);
    }

    deps.logger.debug(
      {
        step: "googlechat-pubsub-pull",
        channelType: "googlechat" as const,
        receivedCount: received.length,
        ackedCount: ackIds.length,
        skippedCount: skipped,
        durationMs: now() - startedAt,
      },
      "Pub/Sub pull cycle complete",
    );

    return {
      receivedCount: received.length,
      ackedCount: ackIds.length,
      skippedCount: skipped,
      pullFailed: false,
    };
  }

  // Sleep for `ms`, resolving early if the controller aborts. The same signal
  // drives both the pull fetch and this sleep, so `stop()` cancels an in-flight
  // long-poll AND a pending backoff at once.
  async function abortableSleep(ms: number): Promise<void> {
    if (controller.signal.aborted) return;
    const setT = deps.setTimeoutImpl ?? systemSetTimeout;
    const clearT = deps.clearTimeoutImpl ?? systemClearTimeout;
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setT>;
      const onAbort = (): void => {
        clearT(timer);
        resolve();
      };
      timer = setT(() => {
        // Normal completion: drop the abort listener so it does not accumulate
        // on the shared signal across every backoff cycle (the persistent-
        // failure path is exactly where this would otherwise leak).
        controller.signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      pendingBackoff = timer;
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    pendingBackoff = undefined;
  }

  // The self-rescheduling pull loop: poll, and on failure back off with a
  // bounded jittered exponential delay (reset after a good pull); on persistent
  // failure log loudly so an operator sees a truly-dead loop.
  async function runLoop(): Promise<void> {
    const floorMs = deps.backoffFloorMs ?? DEFAULT_BACKOFF_FLOOR_MS;
    const capMs = deps.backoffCapMs ?? DEFAULT_BACKOFF_CAP_MS;
    const threshold = deps.errorLogThreshold ?? DEFAULT_ERROR_LOG_THRESHOLD;
    const rng = deps.rng ?? Math.random;
    let backoff = floorMs;

    while (running && !controller.signal.aborted) {
      const out = await pollOnce();
      // A stop() during the poll must not schedule another backoff.
      if (!running || controller.signal.aborted) break;

      if (out.pullFailed) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= threshold) {
          deps.logger.error(
            {
              channelType: "googlechat" as const,
              hint: "Pub/Sub pull is persistently failing; verify the service account has roles/pubsub.subscriber and the subscription exists",
              errorKind: "network" as const,
              consecutiveFailures,
            },
            "Pub/Sub pull loop persistently failing",
          );
        }
        const jitter = Math.floor(rng() * JITTER_MS);
        await abortableSleep(Math.min(backoff, capMs) + jitter);
        backoff = Math.min(backoff * 2, capMs);
      } else {
        consecutiveFailures = 0;
        backoff = floorMs;
      }
    }
  }

  function start(): void {
    if (running) return;
    running = true;
    controller = new AbortController();
    consecutiveFailures = 0;
    deps.logger.debug(
      { step: "googlechat-pubsub-start", channelType: "googlechat" as const },
      "Pub/Sub pull loop starting",
    );
    void runLoop();
  }

  async function stop(): Promise<void> {
    running = false;
    controller.abort();
    if (pendingBackoff !== undefined) {
      (deps.clearTimeoutImpl ?? systemClearTimeout)(pendingBackoff);
      pendingBackoff = undefined;
    }
    deps.logger.info(
      { channelType: "googlechat" as const },
      "Pub/Sub source stopped",
    );
  }

  return {
    start,
    stop,
    pollOnce,
    get lastError() {
      return lastError;
    },
    get running() {
      return running;
    },
  };
}
