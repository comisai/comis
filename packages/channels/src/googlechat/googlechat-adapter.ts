// SPDX-License-Identifier: Apache-2.0
/**
 * Google Chat Channel Adapter: a pull-driven ChannelPort implementation.
 *
 * This is the composition point — it wires the service-account token provider,
 * the Pub/Sub REST pull loop, the message mapper, and the allowlist gate into a
 * working inbound+outbound text round-trip with no public inbound endpoint.
 *
 * `start()` validates credentials and OPENS the pull loop; inbound events arrive
 * through `handleChatEvent`, which the loop calls once per decoded event. Each
 * event is mapped, gated against the sender allowlist, and — for an admitted
 * sender — fanned out to the registered message handlers under a fresh request
 * context. The fanout is AWAITED and rethrows on a handler failure: that rejection
 * is the loop's skip-ack signal, so a failed enqueue is redelivered rather than
 * dropped.
 *
 * Outbound `sendMessage` posts to the Chat REST API with a chat.bot bearer token
 * minted through the service-account provider; the token is never logged.
 *
 * The adapter delivers a clean NormalizedMessage — external-content fencing is a
 * shared executor concern applied to every channel, deliberately not duplicated
 * here.
 *
 * Outbound edit and delete mutate the bot's own message in place. Reaction and
 * attachment methods are OMITTED: a service-account app cannot reach those
 * method/auth surfaces, so advertising them would be dishonest — the daemon
 * capability gate blocks any call the (false) capability flags forbid.
 *
 * @module
 */

import { randomUUID } from "node:crypto";
import {
  runWithContext,
  systemNowMs,
  systemSetTimeout,
  systemClearTimeout,
} from "@comis/core";
import type {
  ChannelPort,
  ChannelStatus,
  ComisLogger,
  MessageHandler,
  NormalizedMessage,
  ReconcileSendOutcome,
  ReconcileSendQuery,
  SendMessageOptions,
} from "@comis/core";
import { ok, err, fromPromise, type Result } from "@comis/shared";
import {
  createGoogleChatTokenProvider,
  CHAT_SCOPE,
  PUBSUB_SCOPE,
  type GoogleChatTokenProvider,
} from "./googlechat-auth.js";
import { classifyGoogleChatError, parseRetryAfterSeconds } from "./errors.js";
import { createSendPacer } from "./send-pacer.js";
import {
  createPubSubSource,
  type PubSubSource,
  type PubSubSourceDeps,
} from "./pubsub-source.js";
import {
  mapGoogleChatEventToNormalized,
  extractGoogleChatAttachments,
  type GoogleChatEvent,
} from "./message-mapper.js";
import {
  normalizeGoogleChatCardAction,
  type GoogleChatCardClickEvent,
} from "./googlechat-actions.js";
import {
  renderGoogleChatCards,
  renderGoogleChatButtons,
} from "./googlechat-rich-renderer.js";

// ---------------------------------------------------------------------------
// Send-safety knobs for the 429-only bounded resend
// ---------------------------------------------------------------------------

/** Resends the send makes on top of the first attempt before surfacing the failure. */
const MAX_RETRIES = 4;
/** Exponential-backoff base + ceiling used when a 429 carries no Retry-After. */
const RETRY_BACKOFF_BASE_MS = 500;
const RETRY_BACKOFF_CAP_MS = 8_000;
/**
 * Ceiling on a server-supplied Retry-After. The value is operator-untrusted, so a
 * large or hostile Retry-After is clamped rather than awaited verbatim — otherwise
 * the outbound send would park pending for hours, and could repeat up to
 * {@link MAX_RETRIES} times.
 */
const RETRY_AFTER_CAP_MS = 60_000;

// ---------------------------------------------------------------------------
// Path safety for edit/delete resource names
// ---------------------------------------------------------------------------

/**
 * Reject a Chat resource name before it is interpolated into a REST path.
 *
 * A valid Chat resource name (`spaces/{space}/messages/{id}` or `spaces/{space}`)
 * is drawn from a strict charset — letters, digits, and `._/-` only. Allowlisting
 * that charset rejects every query/fragment metacharacter (`?`, `&`, `#`, space,
 * control chars) in one check, so a caller-supplied name can never carry its own
 * query string to defeat a pinned query parameter — the edit path pins
 * `updateMask=text`, and a name like `…/CCC?updateMask=*` would otherwise widen
 * it to a full-field patch. The explicit `..` check still stands because the
 * charset permits `.`; `/` is legitimately part of the resource name.
 */
function isSafeMessageName(id: string): boolean {
  return id.length > 0 && !id.includes("..") && /^[A-Za-z0-9._/-]+$/.test(id);
}

// ---------------------------------------------------------------------------
// Structural REST error (the edit-in-place render classifier reads it)
// ---------------------------------------------------------------------------

/**
 * A Chat REST failure carrying the numeric HTTP `status` — and, on a 429, the
 * parsed `Retry-After` seconds — as STRUCTURAL fields. The EditPlace render
 * classifier (`classifyGoogleChatRenderError`) picks its variant off these
 * (429 → back off and retry the latest text, 404 → drop further edits, 401/403
 * → permission); a bare `Error(message)` with the status only in the string
 * classifies as `internal`, so neither the rate-limit retry buffer nor the
 * message-gone drop would ever engage. Mirrors the MS Teams connector's
 * structural REST error.
 */
interface GoogleChatRestError extends Error {
  status: number;
  retryAfter?: number;
}

/** Build a {@link GoogleChatRestError} carrying the status (+ Retry-After seconds on a 429). */
function googleChatRestError(
  message: string,
  status: number,
  retryAfter?: number,
): GoogleChatRestError {
  const error = new Error(message) as GoogleChatRestError;
  error.status = status;
  if (retryAfter !== undefined) error.retryAfter = retryAfter;
  return error;
}

/** Dependencies for the Google Chat adapter. */
export interface GoogleChatAdapterDeps {
  /** The resolved service-account key JSON string (a SecretRef resolved upstream); never logged. */
  serviceAccountKey: string;
  /** The Pub/Sub pull subscription resource: `projects/{project}/subscriptions/{sub}`. */
  subscriptionName: string;
  /** Sender ids (`users/{id}`) and/or space ids (`spaces/{id}`) allowed to reach handlers. */
  allowFrom: string[];
  /** "allowlist" (default) drops unknown senders; "open" processes any sender. */
  allowMode: "allowlist" | "open";
  /** Logger for the inbound/outbound boundary matrix. */
  logger: ComisLogger;
  /** Inbound transport mode. Only "pubsub" ingress is available here; absent → pubsub. */
  mode?: "pubsub" | "webhook";
  /** Injected fetch, defaulting to the global; lets a unit test stub the exchange/send. */
  fetchImpl?: typeof fetch;
  /** Injected clock in ms, defaulting to systemNowMs; makes timing deterministic. */
  now?: () => number;
  /** Chat REST base-URL override — a test-only seam. */
  chatBaseUrl?: string;
  /** Pub/Sub base-URL override — a test-only seam. */
  pubsubBaseUrl?: string;
  /** Token-endpoint URL override — a test-only seam. */
  tokenUrl?: string;
  /** Injected one-shot timer for the pull-loop backoff. */
  setTimeoutImpl?: typeof import("@comis/core").systemSetTimeout;
  /** Injected timer canceller for the pull-loop backoff. */
  clearTimeoutImpl?: typeof import("@comis/core").systemClearTimeout;
  /**
   * Pull-loop source factory. Defaults to {@link createPubSubSource}; a unit test
   * injects a fake source so lifecycle is exercised without a real network loop.
   */
  createSource?: (deps: PubSubSourceDeps) => PubSubSource;
}

/**
 * The adapter handle: the ChannelPort surface plus the loop's inbound dispatch
 * and the token-provider accessor the send path (and later wiring) reuse.
 */
export interface GoogleChatAdapterHandle extends ChannelPort {
  /** The inbound dispatch the pull loop calls once per decoded event. */
  handleChatEvent(event: unknown): Promise<void>;
  /** The per-scope service-account token provider. */
  getPubSubTokenProvider(): GoogleChatTokenProvider;
}

/**
 * Build a Google Chat adapter. `start()` validates credentials and opens the pull
 * loop; inbound flows through {@link GoogleChatAdapterHandle.handleChatEvent}.
 */
export function createGoogleChatAdapter(
  deps: GoogleChatAdapterDeps,
): GoogleChatAdapterHandle {
  const now = deps.now ?? systemNowMs;
  const tokens = createGoogleChatTokenProvider({
    serviceAccountKey: deps.serviceAccountKey,
    logger: deps.logger,
    ...(deps.fetchImpl && { fetchImpl: deps.fetchImpl }),
    ...(deps.now && { now: deps.now }),
    ...(deps.tokenUrl && { tokenUrl: deps.tokenUrl }),
  });

  const handlers: MessageHandler[] = [];
  const CHANNEL_ID = "googlechat";

  // Per-space write pacer: Google Chat caps message creation at one write per
  // second per space, so a chunked reply that fans several sends into one space
  // must space its writes or trip a 429. Built once on the adapter's injected
  // clock+timer; different spaces stay independent.
  const pacer = createSendPacer({
    now,
    setTimeout: deps.setTimeoutImpl ?? systemSetTimeout,
    // Default the canceller too (not only when a test injects one), so an
    // aborted pace-wait actively cancels its unref'd timer in production rather
    // than leaving it to fire as a late no-op — mirrors the pull source.
    clearTimeout: deps.clearTimeoutImpl ?? systemClearTimeout,
  });
  // Aborted on stop() so a send parked in a pending pace-wait OR a 429 retry
  // backoff cancels its wait promptly rather than holding shutdown. Abort is
  // terminal for a given controller instance, so start() installs a fresh one
  // (see below) — otherwise a reactivated adapter would pace every send against
  // an already-aborted signal.
  let sendAbort = new AbortController();

  // Resolve after `ms`, or promptly if `signal` aborts — the same abort-aware
  // shape the pacer's pace-wait uses. The timer handle is unref'd so a pending
  // wait never holds the event loop open at shutdown, and the abort listener is
  // dropped on normal completion so it cannot accumulate across a retry loop
  // that shares one signal.
  function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    const setT = deps.setTimeoutImpl ?? systemSetTimeout;
    const clearT = deps.clearTimeoutImpl ?? systemClearTimeout;
    return new Promise<void>((resolve) => {
      // onAbort closes over `handle`; it only runs on the abort event, by which
      // point `handle` is assigned — so the forward reference is safe.
      const onAbort = (): void => {
        clearT(handle);
        resolve();
      };
      const handle = setT(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      handle.unref?.();
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  let _connected = false;
  let _startedAt: number | undefined;
  let _lastMessageAt: number | undefined;
  // Inbound-only liveness: bumped ONLY on an admitted inbound, never on an
  // outbound send or a dropped inbound — so a send-only bot cannot mask a dead
  // ingress the way an outbound-polluted timestamp would.
  let _lastInboundAt: number | undefined;
  let _lastError: string | undefined;
  let source: PubSubSource | undefined;

  /**
   * The single sender-authorization gate the inbound path uses. In allowlist mode
   * an inbound is admitted only when its sender id OR its space id is on the
   * allowlist; "open" mode admits all. One authoritative gate: the default-deny
   * decision is made in exactly one place.
   */
  function isAllowedSender(senderId: string, channelId: string): boolean {
    if (deps.allowMode !== "allowlist") return true;
    return (
      deps.allowFrom.includes(senderId) || deps.allowFrom.includes(channelId)
    );
  }

  /**
   * Admit a gated inbound and fan it out to the registered handlers under a fresh
   * request context. An inbound that arrives before onMessage() has wired a
   * handler skip-acks (throws) so the pull loop redelivers it rather than
   * acking-and-dropping; a handler failure likewise skip-acks. Shared by the
   * message path and the card-click path so both traverse one fanout — one
   * liveness bump, one skip-ack boundary, no duplicated dispatch.
   */
  async function fanOutMessage(normalized: NormalizedMessage): Promise<void> {
    if (handlers.length === 0) {
      // A pull channel drains the backlog immediately on start(); an inbound that
      // arrives before onMessage() has wired a handler must redeliver, not be
      // acked-and-dropped. No liveness bump — a never-wired ingress must look
      // stale to the health monitor rather than falsely healthy.
      deps.logger.warn(
        {
          channelType: "googlechat" as const,
          hint: "No inbound handler registered yet; ack skipped so Pub/Sub redelivers once onMessage() has wired a handler",
          errorKind: "internal" as const,
        },
        "Inbound arrived before a handler was registered; skipping ack",
      );
      // Skip-ack via the same pull-loop boundary as a handler failure (the file
      // carries the @allow-throw annotation) so the inbound redelivers.
      throw new Error("no inbound handler registered");
    }

    _lastMessageAt = now();
    _lastInboundAt = now();

    const traceId = randomUUID();
    normalized.metadata.traceId = traceId;

    await runWithContext(
      {
        traceId,
        startedAt: now(),
        channelType: "googlechat",
        tenantId: "default",
        trustLevel: "admin",
      },
      async () => {
        // Defer each handler into its own microtask so a synchronous throw becomes
        // a rejected promise and never aborts a sibling; allSettled runs them all.
        const results = await Promise.allSettled(
          handlers.map((h) => Promise.resolve().then(() => h(normalized))),
        );
        const failed = results.find((r) => r.status === "rejected");
        if (failed && failed.status === "rejected") {
          deps.logger.error(
            {
              channelType: "googlechat" as const,
              err: failed.reason,
              hint: "Inbound handler failed; ack is skipped so Pub/Sub redelivers",
              errorKind: "internal" as const,
            },
            "Inbound message handler error",
          );
          // @allow-throw: fanOutMessage runs inside handleChatEvent, the pull
          // loop's onEvent boundary — a rejected promise IS the skip-ack
          // (redeliver) signal, which the loop catches and translates. Rethrow so
          // the failed enqueue redelivers rather than being acked-and-dropped.
          throw failed.reason instanceof Error
            ? failed.reason
            : new Error(String(failed.reason));
        }
      },
    );
  }

  async function handleChatEvent(event: unknown): Promise<void> {
    // A card click arrives as a CARD_CLICKED event on the same ingress; route it
    // through the card-action normalizer BEFORE the message mapper (which yields
    // null for it), so it traverses the same default-deny gate the message path
    // uses. A null/undefined or primitive payload safely misses this branch and
    // flows to the mapper, which already handles it.
    const clickEvent = event as GoogleChatCardClickEvent | null | undefined;
    if (clickEvent?.type === "CARD_CLICKED") {
      const result = normalizeGoogleChatCardAction(clickEvent);
      if (result.message === null) {
        // Distinguish the benign non-click drop (silent) from the security-
        // relevant rejects, each carrying a distinct errorKind + hint and NO
        // secret/callback, so a probe naming a method the bot never rendered, a
        // malformed click, or a click that cannot be authorized is diagnosable —
        // mirrors the non-allowlisted-sender WARN below.
        switch (result.reason) {
          case "ignored":
            // Unreachable in this branch: the normalizer returns "ignored" ONLY
            // for a non-CARD_CLICKED event, but this switch runs inside the
            // `type === "CARD_CLICKED"` guard above. Kept so the switch stays
            // total over the closed CardActionDropReason union — a benign,
            // silent drop either way.
            break;
          case "unrendered-method":
            deps.logger.warn(
              {
                channelType: "googlechat" as const,
                hint: "Card-action method is not in the rendered set; a click cannot invoke a method the bot never rendered",
                errorKind: "validation" as const,
              },
              "Inbound card action dropped: unrendered method",
            );
            break;
          case "missing-callback":
            deps.logger.warn(
              {
                channelType: "googlechat" as const,
                hint: "Card-action click carried no opaque callback; the action is malformed",
                errorKind: "validation" as const,
              },
              "Inbound card action dropped: missing callback",
            );
            break;
          case "missing-clicker":
            deps.logger.warn(
              {
                channelType: "googlechat" as const,
                hint: "Card-action click carried no verified user.name; the clicker cannot be authorized",
                errorKind: "precondition" as const,
              },
              "Inbound card action dropped: no verified clicker id",
            );
            break;
        }
        return; // every card-action drop acks (resolves) — never redelivers
      }

      const clicked = result.message;
      // Authorize the click through the SAME default-deny gate the message path
      // uses — on the VERIFIED clicker id the normalizer read from user.name,
      // never a payload field. One authoritative gate, no parallel allowlist.
      if (!isAllowedSender(clicked.senderId, clicked.channelId)) {
        deps.logger.warn(
          {
            channelType: "googlechat" as const,
            senderId: clicked.senderId,
            hint: "Add the sender users/{id} or the space spaces/{id} to channels.googlechat.allowFrom",
            errorKind: "precondition" as const,
          },
          "Inbound from non-allowlisted sender dropped",
        );
        return; // drop BEFORE any processing → ack (resolve)
      }

      await fanOutMessage(clicked);
      return;
    }

    const normalized = mapGoogleChatEventToNormalized(event as GoogleChatEvent);
    if (!normalized) return; // non-MESSAGE → nothing to dispatch → ack (resolve)

    if (!isAllowedSender(normalized.senderId, normalized.channelId)) {
      deps.logger.warn(
        {
          channelType: "googlechat" as const,
          senderId: normalized.senderId,
          hint: "Add the sender users/{id} or the space spaces/{id} to channels.googlechat.allowFrom",
          errorKind: "precondition" as const,
        },
        "Inbound from non-allowlisted sender dropped",
      );
      return; // drop BEFORE any processing → ack (resolve)
    }

    // Surface an honest degrade when a message carries shares with no
    // downloadable resource name. The mapper already used the extractor's `attachments` half
    // to populate the message; calling the pure extractor again here for the
    // `skipped` half keeps ONE source of truth for the extraction while the
    // mapper stays logger-free (the skip half is never threaded through the
    // NormalizedMessage). Placed AFTER the allowlist gate so media in a dropped
    // message is never announced; the WARN carries no resource name, body, or
    // token — only the content-free diagnostic fields an operator acts on.
    const { skipped } = extractGoogleChatAttachments(
      (event as GoogleChatEvent).message,
    );
    if (skipped.length > 0) {
      // Aggregate to ONE WARN per message. Sharing Drive files in Chat is
      // routine, not exceptional; a WARN per share would let an ordinary user
      // action dominate the cross-session degraded rate + top-errorKind tallies
      // the fleet lens aggregates, masking an acute signal. The count + the
      // distinct sources keep the diagnostic while staying content-free (no
      // resource name, body, or token), and the hint still names the unlock.
      deps.logger.warn(
        {
          channelType: "googlechat" as const,
          skippedCount: skipped.length,
          sources: [...new Set(skipped.map((s) => s.source))],
          errorKind: "precondition" as const,
          hint: "Google Drive shared files need user-OAuth mode with a Drive scope; a service-account app can only download uploaded (drag-drop / paste) content",
        },
        "Inbound Drive-file attachment(s) skipped: no downloadable resource name",
      );
    }

    await fanOutMessage(normalized);
  }

  const adapter: GoogleChatAdapterHandle = {
    channelId: CHANNEL_ID,
    channelType: "googlechat",

    onMessage(handler: MessageHandler): void {
      handlers.push(handler);
    },

    handleChatEvent,

    getPubSubTokenProvider(): GoogleChatTokenProvider {
      return tokens;
    },

    async start(): Promise<Result<void, Error>> {
      // Idempotency: a second start() without an intervening stop() must not
      // build and boot a fresh source that orphans the first (the source's own
      // `if (running) return` guard is bypassed by creating a new source each
      // call), which would double-pull the subscription and leak the old loop.
      if (_connected) return ok(undefined);

      // A prior stop() left sendAbort aborted; install a fresh controller for
      // this run so the pacer and the retry backoff are not short-circuited by a
      // stale aborted signal. Mirrors the pull source recreating its controller.
      sendAbort = new AbortController();

      // The token provider already parsed the service-account key once at
      // construction; reuse that result rather than re-parsing here. Both modes
      // need a valid key: webhook mode opens no pull loop but still sends replies
      // via the Chat REST API with the chat.bot bearer.
      const credErr = tokens.credentialError();

      if (deps.mode === "webhook") {
        // Webhook mode opens no Pub/Sub pull loop — inbound arrives through the
        // gateway ingress driving handleChatEvent — so it has no subscription
        // precondition. It still needs the service-account key to send replies,
        // so a missing or invalid key fails start() exactly as the pull path does.
        if (credErr) {
          const startErr = new Error(
            `Google Chat credentials invalid: ${credErr.hint}`,
          );
          deps.logger.error(
            {
              channelType: "googlechat" as const,
              err: startErr,
              hint: "Set channels.googlechat.serviceAccountKey (SecretRef) or GOOGLECHAT_SA_KEY",
              errorKind: "auth" as const,
            },
            "Adapter start failed",
          );
          _lastError = startErr.message;
          return err(startErr);
        }
        _connected = true;
        _startedAt = now();
        deps.logger.info(
          { channelType: "googlechat" as const, mode: "webhook" },
          "Adapter started",
        );
        return ok(undefined);
      }

      // Pull (Pub/Sub) mode: the subscription is the only additional precondition
      // (it is not a parse).
      const subMissing =
        !deps.subscriptionName || deps.subscriptionName.trim() === "";
      if (credErr || subMissing) {
        const startErr = new Error(
          credErr
            ? `Google Chat credentials invalid: ${credErr.hint}`
            : "Google Chat credentials invalid: subscriptionName must not be empty",
        );
        deps.logger.error(
          {
            channelType: "googlechat" as const,
            err: startErr,
            hint: "Set channels.googlechat.serviceAccountKey (SecretRef) or GOOGLECHAT_SA_KEY, and channels.googlechat.subscriptionName",
            errorKind: "auth" as const,
          },
          "Adapter start failed",
        );
        _lastError = startErr.message;
        return err(startErr);
      }

      const make = deps.createSource ?? createPubSubSource;
      source = make({
        subscriptionName: deps.subscriptionName,
        getPubSubToken: () => tokens.getToken(PUBSUB_SCOPE),
        onEvent: handleChatEvent,
        logger: deps.logger,
        ...(deps.fetchImpl && { fetchImpl: deps.fetchImpl }),
        ...(deps.now && { now: deps.now }),
        ...(deps.pubsubBaseUrl && { pubsubBaseUrl: deps.pubsubBaseUrl }),
        ...(deps.setTimeoutImpl && { setTimeoutImpl: deps.setTimeoutImpl }),
        ...(deps.clearTimeoutImpl && { clearTimeoutImpl: deps.clearTimeoutImpl }),
      });
      source.start();
      _connected = true;
      _startedAt = now();
      deps.logger.info(
        { channelType: "googlechat" as const, mode: "pubsub" },
        "Adapter started",
      );
      return ok(undefined);
    },

    async stop(): Promise<Result<void, Error>> {
      // Cancel any pending pace-wait so a parked send does not hold shutdown.
      sendAbort.abort();
      await source?.stop();
      _connected = false;
      deps.logger.info(
        { channelType: "googlechat" as const },
        "Adapter stopped",
      );
      return ok(undefined);
    },

    async sendMessage(
      channelId: string,
      text: string,
      options?: SendMessageOptions,
    ): Promise<Result<string, Error>> {
      // Guard the agent-supplied space name before it reaches the token mint,
      // the pacer, or the REST path — it is interpolated into
      // `${chatBase}/${channelId}/messages`, so a traversal or query
      // metacharacter would otherwise redirect the write under the bot's bearer.
      if (!isSafeMessageName(channelId)) {
        deps.logger.warn(
          {
            channelType: "googlechat" as const,
            hint: "channelId must be a spaces/{space} resource name — letters, digits, and ._/- only, with no query, fragment, or traversal characters",
            errorKind: "validation" as const,
          },
          "Rejected an unsafe space resource name",
        );
        return err(new Error("unsafe space resource name"));
      }
      // Bind this send to the abort controller current at its start. A stop()
      // aborts it (cancelling the pace-wait / retry backoff); a later start()
      // installs a NEW controller for future sends and must never silently
      // un-abort this in-flight one — the post-backoff resend stays cancelled.
      const abortSignal = sendAbort.signal;
      const tok = await tokens.getToken(CHAT_SCOPE);
      if (!tok.ok) return err(tok.error); // auth already logged a secret-free WARN
      const chatBase = deps.chatBaseUrl ?? "https://chat.googleapis.com/v1";
      const doFetch = deps.fetchImpl ?? fetch;
      // A reply to a threaded inbound rides its thread. The thread resource name
      // is a BODY value (never interpolated into the URL path); the reply option
      // is a query param. REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD makes the platform
      // start a new thread when the target thread is gone rather than failing the
      // send, so no dead-thread branch is needed here.
      const threadName =
        typeof options?.threadId === "string" && options.threadId.length > 0
          ? options.threadId
          : undefined;
      const url = threadName
        ? `${chatBase}/${channelId}/messages?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`
        : `${chatBase}/${channelId}/messages`;
      // The message `text` field is Chat-markdown (`*bold*`, `_italic_`,
      // `` `code` ``, `<url|text>`, `<users/{id}>`) and does NOT decode HTML
      // entities — entity-escaping it would surface literal `&amp;`/`&lt;` and
      // corrupt ordinary output — so the agent text passes through verbatim. The
      // HTML subset (and thus escaping) lives on the card `textParagraph` surface,
      // handled in the rich renderer, not here. Attach a cardsV2 body ONLY when
      // the caller supplies cards or button rows; otherwise the body stays the
      // bare { text } (optionally with a thread) shape rather than carrying an
      // empty cardsV2 key.
      const body: Record<string, unknown> = threadName
        ? { text, thread: { name: threadName } }
        : { text };
      const hasButtons = (options?.buttons?.length ?? 0) > 0;
      const hasCards = (options?.cards?.length ?? 0) > 0;
      if (hasButtons || hasCards) {
        // Each supplied card renders to its own cardsV2 entry; top-level button
        // rows ride a trailing single-section card so the interactive widgets are
        // never dropped when no card body accompanies them.
        const cardsV2 = renderGoogleChatCards(options?.cards ?? []);
        if (hasButtons) {
          cardsV2.push({
            cardId: randomUUID(),
            card: {
              sections: [
                { widgets: [renderGoogleChatButtons(options?.buttons ?? [])] },
              ],
            },
          });
        }
        body.cardsV2 = cardsV2;
      }
      const init: RequestInit = {
        method: "POST",
        headers: {
          authorization: `Bearer ${tok.value}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      };

      // Pace the write against the per-space 1/s ceiling ONCE before the send. A
      // pending wait cancels promptly on stop() through the shared abort signal.
      await pacer.acquire(channelId, abortSignal);

      // Bounded resend loop. ONLY a 429 is safe to auto-resend: rate limiting
      // rejects the request BEFORE the message lands, so it definitively created
      // nothing. A status-less transport fault OR a 5xx may already have created
      // the message, and messages.create is non-idempotent (no client message id),
      // so resending either would duplicate — both surface on the first attempt.
      // The send-safety axis is deliberately narrower than the classifier's
      // transience axis, which still marks 5xx/network retryable.
      for (let attempt = 0; ; attempt++) {
        const responded = await fromPromise(doFetch(url, init));
        if (!responded.ok) {
          const c = classifyGoogleChatError(undefined, responded.error);
          deps.logger.error(
            {
              channelType: "googlechat" as const,
              err: responded.error,
              hint: c.hint,
              errorKind: c.errorKind,
            },
            "Google Chat send failed: no response",
          );
          return err(responded.error);
        }
        const res = responded.value;
        if (!res.ok) {
          if (res.status === 429 && attempt < MAX_RETRIES) {
            const retryAfter = parseRetryAfterSeconds(res, now());
            const delayMs =
              retryAfter !== undefined
                ? Math.min(retryAfter * 1000, RETRY_AFTER_CAP_MS)
                : Math.min(
                    RETRY_BACKOFF_BASE_MS * 2 ** attempt,
                    RETRY_BACKOFF_CAP_MS,
                  );
            const c = classifyGoogleChatError(res.status);
            deps.logger.debug(
              {
                step: "channels-outbound",
                channelType: "googlechat" as const,
                status: res.status,
                attempt: attempt + 1,
                durationMs: delayMs,
                hint: c.hint,
                errorKind: c.errorKind,
              },
              "Google Chat send retry scheduled after rate limiting",
            );
            // The retry wait observes sendAbort so stop() cancels a parked
            // resend — a non-idempotent create must not fire a POST after the
            // adapter has been stopped. Bail on abort rather than continue.
            if (abortSignal.aborted) {
              return err(new Error("send aborted during retry backoff"));
            }
            await abortableSleep(delayMs, abortSignal);
            if (abortSignal.aborted) {
              return err(new Error("send aborted during retry backoff"));
            }
            continue;
          }
          const c = classifyGoogleChatError(res.status);
          deps.logger.error(
            {
              channelType: "googlechat" as const,
              status: res.status,
              hint: c.hint,
              errorKind: c.errorKind,
            },
            "Google Chat send failed: error status",
          );
          // Attach the structural status (+ Retry-After on a 429) so a send that
          // exhausts its bounded 429 resends surfaces as rate_limited to the
          // activity renderer rather than a status-less internal fault.
          const retryAfter =
            res.status === 429 ? parseRetryAfterSeconds(res, now()) : undefined;
          return err(
            googleChatRestError(
              `chat messages.create returned status ${res.status}`,
              res.status,
              retryAfter,
            ),
          );
        }
        const parsed = await fromPromise(
          res.json() as Promise<{ name?: string }>,
        );
        if (!parsed.ok || !parsed.value.name) {
          deps.logger.error(
            {
              channelType: "googlechat" as const,
              hint: "messages.create returned no message name",
              errorKind: "platform" as const,
            },
            "Google Chat send failed: unreadable response",
          );
          return err(new Error("messages.create returned no name"));
        }
        _lastMessageAt = now();
        return ok(parsed.value.name);
      }
    },

    async editMessage(
      _channelId: string,
      messageId: string,
      text: string,
      options?: SendMessageOptions,
    ): Promise<Result<void, Error>> {
      // Guard the caller-supplied resource name before it ever reaches the token
      // mint or the REST path — an unsafe name mints no bearer and fires no fetch.
      if (!isSafeMessageName(messageId)) {
        deps.logger.warn(
          {
            channelType: "googlechat" as const,
            hint: "messageId must be a spaces/{space}/messages/{id} resource name — letters, digits, and ._/- only, with no query, fragment, or traversal characters",
            errorKind: "validation" as const,
          },
          "Rejected an unsafe message resource name",
        );
        return err(new Error("unsafe message resource name"));
      }
      const tok = await tokens.getToken(CHAT_SCOPE);
      if (!tok.ok) return err(tok.error); // auth already logged a secret-free WARN
      const chatBase = deps.chatBaseUrl ?? "https://chat.googleapis.com/v1";
      const doFetch = deps.fetchImpl ?? fetch;
      // updateMask is pinned to a literal field list — never `*`, which would
      // clear every unspecified field. A supplied card re-renders the message in
      // place through the `text,cardsV2` mask; the resolved card the caller hands
      // in carries no buttons, so patching it retires the original interactive
      // widgets. With no card the text-only path is unchanged (mask `text`).
      const hasCards = (options?.cards?.length ?? 0) > 0;
      const url = hasCards
        ? `${chatBase}/${messageId}?updateMask=text,cardsV2`
        : `${chatBase}/${messageId}?updateMask=text`;
      const body = hasCards
        ? { text, cardsV2: renderGoogleChatCards(options?.cards ?? []) }
        : { text };
      const init: RequestInit = {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${tok.value}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      };
      const responded = await fromPromise(doFetch(url, init));
      if (!responded.ok) {
        const c = classifyGoogleChatError(undefined, responded.error);
        deps.logger.error(
          {
            channelType: "googlechat" as const,
            err: responded.error,
            hint: c.hint,
            errorKind: c.errorKind,
          },
          "Google Chat edit failed: no response",
        );
        return err(responded.error);
      }
      const res = responded.value;
      if (!res.ok) {
        const c = classifyGoogleChatError(res.status);
        deps.logger.error(
          {
            channelType: "googlechat" as const,
            status: res.status,
            hint: c.hint,
            errorKind: c.errorKind,
          },
          "Google Chat edit failed: error status",
        );
        // Attach the structural status (+ Retry-After on a 429) so the render
        // classifier picks the variant: 429 → rate_limited (retry the latest
        // text), 404 → not_supported (drop further edits), 401/403 → permission.
        const retryAfter =
          res.status === 429 ? parseRetryAfterSeconds(res, now()) : undefined;
        return err(
          googleChatRestError(
            `chat messages.patch returned status ${res.status}`,
            res.status,
            retryAfter,
          ),
        );
      }
      return ok(undefined);
    },

    async deleteMessage(
      _channelId: string,
      messageId: string,
    ): Promise<Result<void, Error>> {
      // Removes the bot's own message. The resource name is guarded before it
      // reaches the token mint or the REST path, exactly as the edit path does.
      if (!isSafeMessageName(messageId)) {
        deps.logger.warn(
          {
            channelType: "googlechat" as const,
            hint: "messageId must be a spaces/{space}/messages/{id} resource name — letters, digits, and ._/- only, with no query, fragment, or traversal characters",
            errorKind: "validation" as const,
          },
          "Rejected an unsafe message resource name",
        );
        return err(new Error("unsafe message resource name"));
      }
      const tok = await tokens.getToken(CHAT_SCOPE);
      if (!tok.ok) return err(tok.error); // auth already logged a secret-free WARN
      const chatBase = deps.chatBaseUrl ?? "https://chat.googleapis.com/v1";
      const doFetch = deps.fetchImpl ?? fetch;
      // A delete carries no request body — the resource name is the whole request.
      const url = `${chatBase}/${messageId}`;
      const init: RequestInit = {
        method: "DELETE",
        headers: { authorization: `Bearer ${tok.value}` },
      };
      const responded = await fromPromise(doFetch(url, init));
      if (!responded.ok) {
        const c = classifyGoogleChatError(undefined, responded.error);
        deps.logger.error(
          {
            channelType: "googlechat" as const,
            err: responded.error,
            hint: c.hint,
            errorKind: c.errorKind,
          },
          "Google Chat delete failed: no response",
        );
        return err(responded.error);
      }
      const res = responded.value;
      if (!res.ok) {
        const c = classifyGoogleChatError(res.status);
        deps.logger.error(
          {
            channelType: "googlechat" as const,
            status: res.status,
            hint: c.hint,
            errorKind: c.errorKind,
          },
          "Google Chat delete failed: error status",
        );
        // The delete failure is consumed by the same render classifier as edit;
        // attach the structural status (+ Retry-After on a 429) so it is
        // classified rather than collapsed to a status-less internal fault.
        const retryAfter =
          res.status === 429 ? parseRetryAfterSeconds(res, now()) : undefined;
        return err(
          googleChatRestError(
            `chat messages.delete returned status ${res.status}`,
            res.status,
            retryAfter,
          ),
        );
      }
      return ok(undefined);
    },

    getStatus(): ChannelStatus {
      return {
        connected: _connected,
        channelId: CHANNEL_ID,
        channelType: "googlechat",
        uptime:
          _connected && _startedAt !== undefined
            ? now() - _startedAt
            : undefined,
        lastMessageAt: _lastMessageAt,
        lastInboundAt: _lastInboundAt,
        error: _lastError ?? source?.lastError,
        connectionMode: "polling",
      };
    },

    async reconcileSend(
      _query: ReconcileSendQuery,
    ): Promise<Result<ReconcileSendOutcome, Error>> {
      // A service-account app cannot query the platform for "did this send land?",
      // so unresolved is the only honest verdict: recovery parks it (never a replay
      // → never a double-send), and exactly-once is the outward-send ledger's
      // write-ahead dedup, not this oracle. Never claim a definitive absence.
      deps.logger.debug(
        {
          channelType: "googlechat" as const,
          hint: "No app-auth history oracle; exactly-once is the outward-send ledger's write-ahead dedup",
        },
        "reconcileSend unresolved",
      );
      return ok({ kind: "unresolved" });
    },

    async platformAction(
      action: string,
      _params: Record<string, unknown>,
    ): Promise<Result<unknown, Error>> {
      const e = new Error(`Unsupported action: ${action} on googlechat`);
      deps.logger.warn(
        {
          channelType: "googlechat" as const,
          err: e,
          hint: `Action '${action}' is not supported by the Google Chat adapter`,
          errorKind: "validation" as const,
        },
        "Unsupported platform action",
      );
      return err(e);
    },
  };

  return adapter;
}
