// SPDX-License-Identifier: Apache-2.0
/**
 * `SignalEmulator` — the signal-cli wire backend (CHAN2-01, Phase 209), built ON
 * the Plan-01 generalized `http-backend` base and `extends ChannelEmulator`
 * (foundation-real-from-day-one, design §3A.7).
 *
 * This is the fake signal-cli daemon the REAL production Signal adapter hits over
 * loopback HTTP. The rig (Plan 05/06) boots an isolated Comis daemon pointed at
 * this emulator via `channels.signal.baseUrl`; an injected inbound message
 * round-trips through the daemon and the bot's reply lands in `outbound()`.
 *
 * It composes the shared loopback server (`createHttpBackend()`) and registers
 * the Signal wire surface on the base's GENERALIZED route surfaces — it does NOT
 * spin up its own `node:http` server (SEC-02 success-criterion #5: built ON the
 * base, not a bespoke server). The base owns the loopback bind (127.0.0.1 only,
 * SEC-01), the raw-body read, and the 404-on-unmatched hardening.
 *
 * Wire surface (the subset of signal-cli's JSON-RPC + SSE interface the adapter
 * consumes — mirrored from the proven `test/e2e/mocks/signal/mock-signal-server.ts`):
 *   - GET  /api/v1/check  — the boot health-check (`signalHealthCheck` AWAITS it
 *     → blocks `start()`); returns `{ ok: true }`. Registered via the base's
 *     `registerPathRoute` (Plan 01, CHAN2-02 FIX #1).
 *   - POST /api/v1/rpc    — JSON-RPC 2.0:
 *       - `send`         — mints a monotonic `timestamp` (the Signal messageId —
 *         the adapter reads `String(result.timestamp)`, signal-adapter.ts:256),
 *         records a `RecordedOutbound { method:"send", messageId, text }` to the
 *         per-chat oracle, and returns `{ jsonrpc, id, result:{ timestamp } }`.
 *       - `sendReaction` — records the outbound reaction (the react FLOW Signal
 *         supports), returns `result:{}`.
 *       - `listAccounts` — returns the configured account list.
 *       - any other      — the generic `result:{}` envelope (never crashes).
 *   - GET  /api/v1/events — the SSE inbound stream (the Signal analog of
 *     Telegram's getUpdates long-poll). Registered via `registerStreamRoute`
 *     (Plan 01, CHAN2-02 FIX #2). `injectMessage`/`injectReaction` emit a
 *     `SignalEnvelope` on the open stream (queue-or-emit). [Task 2.]
 *
 * The genuinely-new mechanic over the proven `mock-signal-server.ts` is the I4
 * discipline: the inbound envelopes are built by the `signal-payloads.ts` typed
 * builders (return-annotated against the adapter's OWN `SignalEnvelope`), so a
 * wire-shape drift is a COMPILE error (Task 2).
 *
 * The structural twin of `tg-emulator.ts`: where Telegram mints a `message_id`
 * on `sendMessage` and queues an `Update` for `getUpdates`, Signal mints a
 * `timestamp` on `send` and emits a `SignalEnvelope` on the SSE stream. The
 * per-chat oracle, the `outbound()`/`lastBotReply()`/`resetChat()` read/reset
 * verbs, and the object-literal-delegating-to-the-base shape are mirrored.
 *
 * TEST-HARNESS — lives under `test/`, never `packages`; ZERO production code
 * change. `test/` is outside every `packages` source-tree ESLint/architecture
 * rule.
 *
 * @module
 */

import type { ServerResponse } from "node:http";
import {
  createHttpBackend,
  type HttpBackend,
  type RouteResult,
} from "../../harness/backends/http-backend.js";
import type { ChannelCaps, ChannelEmulator } from "../../harness/channel-emulator.js";
import type { RecordedOutbound } from "../../harness/recorded-outbound.js";
import type { SignalEnvelope } from "@comis/channels";
import { makeMessageEnvelope, makeReactionEnvelope, nextSignalTimestamp } from "./signal-payloads.js";
import { signalCaps } from "./signal-caps.js";

/**
 * Options for {@link createSignalEmulator}.
 *
 * `account` is the signal-cli account the emulator reports from `listAccounts`
 * (the adapter's `validateSignalConnection` skips `listAccounts` when no account
 * is configured, credential-validator.ts:56 — so the rig boots account-less).
 * Defaults to the proven `mock-signal-server.ts` account so an account-less rig
 * still gets a realistic list.
 */
export interface CreateSignalEmulatorOptions {
  /** The signal-cli account reported by `listAccounts`. Defaults to `+15555550100`. */
  readonly account?: string;
}

/**
 * Addressing options for {@link SignalEmulator.injectMessage}. Every field is
 * OPTIONAL — an absent/empty `InjectMessageOpts` is the plain DM/group text
 * inject. Threads through to the `signal-payloads.ts` builder (the I4 typed
 * envelope source).
 */
export interface InjectMessageOpts {
  /** The sender's Signal UUID (`envelope.sourceUuid`). Defaults to the all-zero placeholder. */
  readonly sourceUuid?: string;
  /** A display name (`envelope.sourceName` → `metadata.signalSenderName`). Defaults to `from`. */
  readonly sourceName?: string;
}

/**
 * `SignalEmulator` — `ChannelEmulator` + the Signal-specific inject/read verbs
 * the rig and scenario tests drive. `start()`/`stop()` (from `ChannelEmulator`)
 * delegate to the http-backend base.
 *
 * A Signal "chat" is a STRING — a bare recipient (a phone number / uuid, the
 * adapter wraps it as `recipient: [chatId]`) or a `group:<id>` (routed to
 * `groupId`). The per-chat ORACLE state keys on that string (vs Telegram's
 * numeric `chatId`).
 */
export interface SignalEmulator extends ChannelEmulator {
  /**
   * The SHARED loopback http-backend base this emulator composes. Exposed so the
   * rig / control API can register additional routes on the SAME loopback port
   * (SEC-01: one port). The emulator still owns the base's lifecycle —
   * `start()`/`stop()` delegate to it; callers MUST NOT call
   * `backend.start()`/`stop()` directly.
   */
  readonly backend: HttpBackend;
  /**
   * Inject an inbound text message from `from` in `chat` by EMITTING a
   * `SignalEnvelope` on the open `/api/v1/events` SSE stream (the structural
   * twin of `tgEmulator.injectMessage` queuing an `Update` for `getUpdates` —
   * the Signal adapter pulls inbound autonomously from the stream). When NO SSE
   * client is connected the envelope is QUEUED and drained on the next connect
   * (the queue-or-emit discipline — an inject before any connect is not lost).
   *
   * `chat` is the channel: a `group:<id>` sets `dataMessage.groupInfo.groupId`
   * (the group inbound path); any other value is a DM (the channel id is the
   * sender). `from` is the sender's Signal identifier (for a DM, typically the
   * same as `chat`).
   *
   * @returns the Signal-shaped message id (the emitted envelope's `timestamp`),
   *   minted from the SAME monotonic source as the outbound oracle.
   */
  injectMessage(
    chat: string,
    from: string,
    text: string,
    opts?: InjectMessageOpts,
  ): number;
  /**
   * Inject an inbound REACTION from `from` in `chat` targeting an existing
   * message (`targetSentTimestamp`), by emitting a `SignalEnvelope` carrying
   * `dataMessage.reaction { emoji, targetSentTimestamp }` on the SSE stream (the
   * WS1-relevant react FLOW Signal supports — NOT a button callback). Queue-or-
   * emit like {@link injectMessage}.
   *
   * @returns the emitted reaction envelope's own `timestamp`.
   */
  injectReaction(chat: string, from: string, targetSentTimestamp: number, emoji: string): number;
  /**
   * The full recorded outbound log for a chat, in send order (the channel
   * oracle). `chat` is the Signal chat string (the bare recipient for a DM, or
   * `group:<id>` for a group). An unseen chat returns `[]` (an honest empty,
   * never a silent cross-chat leak).
   */
  outbound(chat: string): readonly RecordedOutbound[];
  /**
   * The most recent recorded outbound for a chat, or `undefined` if none — the
   * structural subset the dual-oracle (`assert/channel-trace.ts`) reads
   * (`{ text? }`). `chat` is the Signal chat string.
   */
  lastBotReply(chat: string): RecordedOutbound | undefined;
  /** Clear a chat's recorded outbound (per-test isolation). `chat` is the Signal chat string. */
  resetChat(chat: string): void;
}

/**
 * Per-chat ORACLE state (the outbound log). Keyed on the Signal chat string.
 * Signal's outbound has no per-message reaction-set the way Telegram's
 * setMessageReaction tracks emoji per message id — a `sendReaction` is recorded
 * as its own outbound record (method `"sendReaction"`), so the oracle is just
 * the ordered outbound log.
 */
interface ChatOracle {
  /** Recorded outbounds, in send order. */
  outbound: RecordedOutbound[];
}

/** The default signal-cli account the emulator reports (the mock-signal-server account). */
const DEFAULT_ACCOUNT = "+15555550100";

/**
 * A minimal JSON-RPC 2.0 request shape (the fields the emulator reads from the
 * `/api/v1/rpc` body). `params` is read defensively — a malformed body yields an
 * empty object so the base never crashes (V5; mirrors mock-signal-server.ts:132).
 */
interface RpcRequest {
  readonly jsonrpc?: string;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly id?: number;
}

/**
 * Resolve the Signal CHAT STRING the oracle keys on from an rpc `params` body.
 *
 * The real adapter's `parseTarget` (signal-adapter.ts:71-76) produces EITHER
 * `{ recipient: [chatId] }` (a DM — a bare recipient) OR `{ groupId }` (a group).
 * The emulator inverts that: a `groupId` maps back to the `group:<id>` chat
 * string; a single-element `recipient` array maps back to the bare recipient.
 * The chat string is the oracle key (so `outbound(chat)` reads what the adapter
 * sent to `chat`).
 */
function resolveChatKey(params: Record<string, unknown>): string {
  const groupId = params["groupId"];
  if (typeof groupId === "string" && groupId.length > 0) {
    return `group:${groupId}`;
  }
  const recipient = params["recipient"];
  if (Array.isArray(recipient) && recipient.length > 0 && typeof recipient[0] === "string") {
    return recipient[0];
  }
  if (typeof recipient === "string" && recipient.length > 0) {
    return recipient;
  }
  // No resolvable target — an honest sentinel key (never silently drop the record).
  return "unknown";
}

/**
 * Create the Signal wire emulator on the shared http-backend base.
 *
 * Mirrors `createTgEmulator`: composes `createHttpBackend()`, registers the
 * Signal wire surface on the base's generalized route surfaces, and returns an
 * object literal whose `caps`/`start`/`stop` delegate to the base + the
 * per-chat oracle read/reset verbs.
 */
export function createSignalEmulator(opts: CreateSignalEmulatorOptions = {}): SignalEmulator {
  const backend: HttpBackend = createHttpBackend();
  const account = opts.account ?? DEFAULT_ACCOUNT;

  // Per-chat ORACLE state (the outbound log), keyed on the Signal chat string.
  const chats = new Map<string, ChatOracle>();

  // SSE inbound state (the Signal analog of Telegram's getUpdates queue). The
  // adapter pulls inbound from a kept-open `GET /api/v1/events` stream; an inject
  // EMITS a SignalEnvelope on every connected client, or QUEUES it when none is
  // connected so an inject before any connect is not lost (the queue-or-emit
  // discipline, mock-signal-server.ts:261-270). The base tracks each live
  // response in its own `openStreams` set and drains it on stop(), so a kept-open
  // stream cannot hang stop() (Plan 01, T-209-09).
  const sseClients = new Set<ServerResponse>();
  const queuedEnvelopes: SignalEnvelope[] = [];

  function chatOracle(chat: string): ChatOracle {
    let st = chats.get(chat);
    if (st === undefined) {
      st = { outbound: [] };
      chats.set(chat, st);
    }
    return st;
  }

  /** Append an outbound record to a chat's oracle. */
  function record(chat: string, ro: RecordedOutbound): void {
    chatOracle(chat).outbound.push(ro);
  }

  /**
   * EMIT a `SignalEnvelope` on every connected SSE client as an `event: receive`
   * frame (the exact wire shape the adapter's `createSignalEventStream` parses —
   * signal-client.ts:316-321 reads `event`/`data`; the adapter JSON.parses the
   * `data` into a `SignalEnvelope`). When NO client is connected the envelope is
   * QUEUED and drained on the next connect (mock-signal-server.ts:261-270).
   */
  function emit(envelope: SignalEnvelope): void {
    if (sseClients.size > 0) {
      const json = JSON.stringify(envelope);
      for (const res of sseClients) {
        res.write(`event: receive\n`);
        res.write(`data: ${json}\n\n`);
      }
    } else {
      queuedEnvelopes.push(envelope);
    }
  }

  /** Parse the `/api/v1/rpc` body defensively (a malformed body → empty request). */
  function parseRpc(body: string): RpcRequest {
    if (body.length === 0) return {};
    try {
      return JSON.parse(body) as RpcRequest;
    } catch {
      return {};
    }
  }

  // The JSON-RPC 2.0 reply envelopes (mock-signal-server.ts:148/172/186). A
  // `send` returns `{ result:{ timestamp } }`; every other recorded method
  // returns `{ result:{} }`; `listAccounts` returns the account list.
  const rpcResult = (id: number, result: unknown): RouteResult => ({
    status: 200,
    body: { jsonrpc: "2.0", id, result },
  });

  /**
   * Handle a single JSON-RPC `send` (signal-adapter.ts:237 — the OUTBOUND oracle
   * the dual oracle keys on). Mint a monotonic `timestamp` (the Signal messageId
   * — the adapter reads `String(result.timestamp)`), record the outbound, and
   * return `{ result:{ timestamp } }`.
   */
  function handleSend(req: RpcRequest): RouteResult {
    const params = req.params ?? {};
    const chat = resolveChatKey(params);
    const text = typeof params["message"] === "string" ? (params["message"] as string) : "";
    const timestamp = nextSignalTimestamp();
    const ro: RecordedOutbound = { method: "send", messageId: timestamp, text };
    record(chat, ro);
    return rpcResult(req.id ?? 1, { timestamp });
  }

  /**
   * Handle a JSON-RPC `sendReaction` (signal-adapter.ts:269 reactToMessage — the
   * react FLOW Signal supports). Record the outbound reaction keyed on the
   * `targetTimestamp` (the reacted-to message id) so the react flow is provable
   * via the oracle, and return `result:{}`. A reaction carries no `text` (the
   * dual oracle's text field is absent on a reaction-only outbound).
   */
  function handleSendReaction(req: RpcRequest): RouteResult {
    const params = req.params ?? {};
    const chat = resolveChatKey(params);
    const target = params["targetTimestamp"];
    const messageId = typeof target === "number" ? target : Number(target ?? 0) || 0;
    const ro: RecordedOutbound = { method: "sendReaction", messageId };
    record(chat, ro);
    return rpcResult(req.id ?? 1, {});
  }

  // -------------------------------------------------------------------------
  // Register the Signal wire surface on the generalized http-backend base.
  // -------------------------------------------------------------------------

  // GET /api/v1/check — the boot health-check (mock-signal-server.ts:95-104).
  // Registered via the arbitrary-path matcher (Plan 01, CHAN2-02 FIX #1). The
  // base only routes the path (no query); the matcher is a string prefix so
  // `/api/v1/check?account=…` matches too.
  backend.registerPathRoute("/api/v1/check", () => ({ status: 200, body: { ok: true } }));

  // POST /api/v1/rpc — the JSON-RPC 2.0 dispatch (mock-signal-server.ts:130-188).
  backend.registerPathRoute("/api/v1/rpc", (ctx): RouteResult => {
    const req = parseRpc(ctx.body);
    const method = req.method ?? "";
    switch (method) {
      case "send":
        return handleSend(req);
      case "sendReaction":
        return handleSendReaction(req);
      case "listAccounts":
        return rpcResult(req.id ?? 1, [{ account }]);
      default:
        // sendTyping / sendReceipt / version / … → the generic ok envelope
        // (mock-signal-server.ts:186). Never a crash on an unknown method.
        return rpcResult(req.id ?? 1, {});
    }
  });

  // GET /api/v1/events — the SSE inbound stream (mock-signal-server.ts:106-128).
  // Registered via the base's `registerStreamRoute` (Plan 01, CHAN2-02 FIX #2):
  // the base hands the raw (req, res), keeps the connection OPEN (does NOT route
  // it through send()), tracks the live response for stop()-drain, and fires the
  // on-close cleanup. The emulator sets the text/event-stream content-type +
  // writes the initial flush, registers the client, drains any queued envelopes,
  // and un-registers on close.
  backend.registerStreamRoute(
    (path) => path === "/api/v1/events",
    (req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream");
      res.setHeader("cache-control", "no-cache");
      res.setHeader("connection", "keep-alive");
      res.write("\n"); // initial flush — does NOT end the response (the stream stays open).
      sseClients.add(res);
      // Drain any pre-queued envelopes (an inject before this connect).
      for (const env of queuedEnvelopes) {
        res.write(`event: receive\n`);
        res.write(`data: ${JSON.stringify(env)}\n\n`);
      }
      queuedEnvelopes.length = 0;
      // Untrack on disconnect (the base also untracks its own openStreams entry).
      req.on("close", () => {
        sseClients.delete(res);
      });
    },
  );

  const emulator: SignalEmulator = {
    caps: signalCaps satisfies ChannelCaps,
    // The shared base — the rig (Plan 06) writes channels.signal.baseUrl =
    // apiRoot so the real adapter's RPC + SSE hit this loopback port (SEC-01).
    backend,

    start() {
      return backend.start();
    },

    async stop() {
      // The base drains every tracked open SSE response on stop() (Plan 01
      // stop-drain via openStreams), so stop() cannot hang on a kept-open
      // /api/v1/events connection (T-209-09). Clear the local registry too so a
      // post-stop inject is a no-op (queued, never written to a dead socket).
      sseClients.clear();
      queuedEnvelopes.length = 0;
      await backend.stop();
    },

    injectMessage(chat, from, text, opts) {
      // Build the I4-typed envelope (signal-payloads.ts — return-annotated
      // against the adapter's OWN SignalEnvelope) and EMIT it on the open SSE
      // stream (else queue). `chat` is the channel (a group:<id> sets groupInfo;
      // a DM's channel id IS the sender). Mints the Signal message id from the
      // SAME monotonic source as the outbound oracle.
      const envelope = makeMessageEnvelope({
        from,
        content: text,
        channel: chat,
        ...(opts?.sourceUuid !== undefined ? { sourceUuid: opts.sourceUuid } : {}),
        ...(opts?.sourceName !== undefined ? { sourceName: opts.sourceName } : {}),
      });
      emit(envelope);
      // The envelope timestamp is the Signal message id (always set by the builder).
      return envelope.timestamp as number;
    },

    injectReaction(chat, from, targetSentTimestamp, emoji) {
      // The react FLOW (the WS1-relevant verb Signal supports): a SignalEnvelope
      // carrying dataMessage.reaction { emoji, targetSentTimestamp }, emitted the
      // same way (queue-or-emit). NOT a button callback.
      const envelope = makeReactionEnvelope({
        from,
        emoji,
        targetSentTimestamp,
        channel: chat,
      });
      emit(envelope);
      return envelope.timestamp as number;
    },

    outbound(chat) {
      return chats.get(chat)?.outbound ?? [];
    },

    lastBotReply(chat) {
      const log = chats.get(chat)?.outbound;
      return log && log.length > 0 ? log[log.length - 1] : undefined;
    },

    resetChat(chat) {
      chats.delete(chat);
    },
  };

  return emulator;
}
