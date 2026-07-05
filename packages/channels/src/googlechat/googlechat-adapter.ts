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
 * Only the text-only surface is declared. Edit, delete, reaction, and attachment
 * methods are OMITTED: a service-account app cannot reach those method/auth
 * surfaces, so advertising them would be dishonest — the daemon capability gate
 * blocks any call the (false) capability flags forbid.
 *
 * @module
 */

import { randomUUID } from "node:crypto";
import { runWithContext, systemNowMs } from "@comis/core";
import type {
  ChannelPort,
  ChannelStatus,
  ComisLogger,
  MessageHandler,
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
import { classifyGoogleChatError } from "./errors.js";
import {
  createPubSubSource,
  type PubSubSource,
  type PubSubSourceDeps,
} from "./pubsub-source.js";
import {
  mapGoogleChatEventToNormalized,
  type GoogleChatEvent,
} from "./message-mapper.js";
import { validateGoogleChatCredentials } from "./credential-validator.js";

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
  const _channelId = "googlechat";

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

  async function handleChatEvent(event: unknown): Promise<void> {
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
          // @allow-throw: handleChatEvent is the pull loop's onEvent boundary — a
          // rejected promise IS the skip-ack (redeliver) signal, which the loop
          // catches and translates. Rethrow so the failed enqueue redelivers
          // rather than being acked-and-dropped.
          throw failed.reason instanceof Error
            ? failed.reason
            : new Error(String(failed.reason));
        }
      },
    );
  }

  const adapter: GoogleChatAdapterHandle = {
    channelId: _channelId,
    channelType: "googlechat",

    onMessage(handler: MessageHandler): void {
      handlers.push(handler);
    },

    handleChatEvent,

    getPubSubTokenProvider(): GoogleChatTokenProvider {
      return tokens;
    },

    async start(): Promise<Result<void, Error>> {
      const v = validateGoogleChatCredentials({
        serviceAccountKey: deps.serviceAccountKey,
        subscriptionName: deps.subscriptionName,
        allowFrom: deps.allowFrom,
        logger: deps.logger,
      });
      if (!v.ok) {
        deps.logger.error(
          {
            channelType: "googlechat" as const,
            err: v.error,
            hint: "Set channels.googlechat.serviceAccountKey (SecretRef) or GOOGLECHAT_SA_KEY, and subscriptionName",
            errorKind: "auth" as const,
          },
          "Adapter start failed",
        );
        _lastError = v.error.message;
        return err(v.error);
      }

      if (deps.mode && deps.mode !== "pubsub") {
        deps.logger.warn(
          {
            channelType: "googlechat" as const,
            hint: "Webhook-mode ingress is not available yet; only pubsub pull is supported",
            errorKind: "precondition" as const,
          },
          "Requested mode not available; using pubsub pull",
        );
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
      _options?: SendMessageOptions,
    ): Promise<Result<string, Error>> {
      const tok = await tokens.getToken(CHAT_SCOPE);
      if (!tok.ok) return err(tok.error); // auth already logged a secret-free WARN
      const chatBase = deps.chatBaseUrl ?? "https://chat.googleapis.com/v1";
      const doFetch = deps.fetchImpl ?? fetch;
      const responded = await fromPromise(
        doFetch(`${chatBase}/${channelId}/messages`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${tok.value}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ text }),
        }),
      );
      if (!responded.ok) {
        const c = classifyGoogleChatError(undefined, responded.error);
        deps.logger.error(
          {
            channelType: "googlechat" as const,
            hint: c.hint,
            errorKind: c.errorKind,
          },
          "Google Chat send failed: no response",
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
          "Google Chat send failed: error status",
        );
        return err(new Error(`chat messages.create returned status ${res.status}`));
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
    },

    getStatus(): ChannelStatus {
      return {
        connected: _connected,
        channelId: _channelId,
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
