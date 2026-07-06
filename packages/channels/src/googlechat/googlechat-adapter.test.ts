// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import type { ComisLogger, NormalizedMessage } from "@comis/core";
import { generateKeyPair, exportPKCS8 } from "jose";
import {
  createGoogleChatAdapter,
  type GoogleChatAdapterDeps,
} from "./googlechat-adapter.js";
import { GOOGLECHAT_APPROVAL_FUNCTION } from "./googlechat-actions.js";
import { classifyGoogleChatRenderError } from "./googlechat-activity.js";
import type {
  PubSubSource,
  PubSubSourceDeps,
} from "./pubsub-source.js";

const SA_EMAIL = "comis-bot@my-project.iam.gserviceaccount.com";
const MINTED_TOKEN = "ya29.minted-access-token-xyz";
const SUBSCRIPTION = "projects/my-project/subscriptions/comis-sub";
const NOW = 1_000_000;

/** A logger whose spies record every argument to every level for redaction asserts. */
function makeLoggerSpy() {
  const info = vi.fn();
  const warn = vi.fn();
  const debug = vi.fn();
  const error = vi.fn();
  const noop = vi.fn();
  const logger = {
    level: "debug",
    trace: noop,
    debug,
    info,
    warn,
    error,
    fatal: noop,
    audit: noop,
    child: vi.fn().mockReturnThis(),
  } as unknown as ComisLogger;
  const serialized = () =>
    JSON.stringify([
      ...info.mock.calls,
      ...warn.mock.calls,
      ...debug.mock.calls,
      ...error.mock.calls,
    ]);
  return { logger, serialized, info, warn, error, debug };
}

/**
 * A real RS256 service-account key JSON an operator would supply — the mint and
 * the credential validator parse it for `client_email` + `private_key`.
 */
async function makeServiceAccountKey(clientEmail = SA_EMAIL) {
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  const privateKeyPem = await exportPKCS8(privateKey);
  return JSON.stringify({
    type: "service_account",
    client_email: clientEmail,
    private_key: privateKeyPem,
    token_uri: "https://oauth2.googleapis.com/token",
  });
}

/** A fetch stub returning a successful token exchange; captures its calls. */
function makeTokenFetch(token = MINTED_TOKEN) {
  const spy = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ access_token: token, expires_in: 3600 }),
  }));
  return spy as unknown as typeof fetch;
}

/**
 * A fetch stub that answers the token exchange with a bearer, then the Chat
 * `messages` endpoint with a created message resource — routed by URL so one
 * spy captures both the mint and the send.
 */
function makeChatFetch(
  opts: {
    sendStatus?: number;
    sendName?: string;
    sendThrows?: boolean;
    /** A per-attempt status sequence for successive `/messages` hits (models a 429-then-200 resend). */
    sendStatuses?: number[];
    /** The `retry-after` header value returned on a `/messages` response. */
    retryAfter?: string;
  } = {},
) {
  const sendName = opts.sendName ?? "spaces/AAAA/messages/CCC";
  let sendHits = 0;
  const spy = vi.fn(async (url: string, _init?: RequestInit) => {
    if (String(url).includes("/messages")) {
      if (opts.sendThrows) throw new Error("connect ECONNREFUSED");
      // A status sequence models successive send attempts; the last entry repeats
      // once the sequence is exhausted so a bounded-retry test can keep 429-ing.
      const status = opts.sendStatuses
        ? opts.sendStatuses[Math.min(sendHits, opts.sendStatuses.length - 1)]
        : (opts.sendStatus ?? 200);
      sendHits += 1;
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: {
          get: (name: string) =>
            name.toLowerCase() === "retry-after" ? (opts.retryAfter ?? null) : null,
        },
        json: async () => ({ name: sendName }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: MINTED_TOKEN, expires_in: 3600 }),
    };
  });
  return { fetchImpl: spy as unknown as typeof fetch, spy };
}

/** Drain the microtask queue so an awaited async send can make progress. */
async function flushMicrotasks(n = 40): Promise<void> {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
}

/**
 * A deterministic timer seam. It CAPTURES each scheduled delay and parks the
 * callback (never firing on real time); `fireNext()` resolves the parked wait so
 * an awaited pace-wait or retry backoff advances without any real wait. `cleared`
 * records the handles passed to the canceller so a stop()-cancels-pace-wait
 * assertion can read them. Mirrors the fake-timers `unrefRecord` intent.
 */
function makeFakeTimers() {
  const delays: number[] = [];
  const cleared: unknown[] = [];
  let pending: Array<{ id: number; cb: () => void }> = [];
  let seq = 0;
  const setTimeoutImpl = ((cb: () => void, ms: number) => {
    const id = (seq += 1);
    delays.push(ms);
    pending.push({ id, cb });
    return id;
  }) as unknown as GoogleChatAdapterDeps["setTimeoutImpl"];
  const clearTimeoutImpl = ((handle: unknown) => {
    cleared.push(handle);
    pending = pending.filter((p) => p.id !== handle);
  }) as unknown as GoogleChatAdapterDeps["clearTimeoutImpl"];
  async function fireNext(): Promise<void> {
    const next = pending.shift();
    if (!next) throw new Error("no pending timer to fire");
    next.cb();
    await flushMicrotasks();
  }
  return {
    setTimeoutImpl,
    clearTimeoutImpl,
    delays,
    cleared,
    fireNext,
    pendingCount: () => pending.length,
  };
}

/** Yield to the REAL event loop (a macrotask) so genuinely-async work — e.g. the
 * JWT crypto in the token mint — can advance; microtask flushing alone cannot. */
function realTick(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/**
 * Await a send while draining parked timers deterministically: tick the real event
 * loop (so the token-mint crypto and fetch stubs settle), fire any pending backoff,
 * and repeat until the send resolves. The adapter's own timer is the injected fake,
 * so the retry backoff itself never waits real time — only the harness ticks do,
 * and each is ~0ms.
 */
async function settleWithTimers<T>(
  p: Promise<T>,
  timers: ReturnType<typeof makeFakeTimers>,
): Promise<T> {
  let settled = false;
  void p.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let i = 0; i < 500 && !settled; i += 1) {
    await realTick();
    if (!settled && timers.pendingCount() > 0) await timers.fireNext();
  }
  return p;
}

/** A fake pull-loop source recording start/stop so lifecycle is testable loop-free. */
function makeFakeSource(over: Partial<PubSubSource> = {}) {
  const start = vi.fn();
  const stop = vi.fn(async () => {});
  const pollOnce = vi.fn(async () => ({
    receivedCount: 0,
    ackedCount: 0,
    skippedCount: 0,
    pullFailed: false,
  }));
  const source: PubSubSource = {
    start,
    stop,
    pollOnce,
    lastError: undefined,
    running: false,
    ...over,
  };
  return { source, start, stop };
}

/** Build adapter deps with injected logger, SA key, token fetch, and a fake source. */
async function makeDeps(overrides: Partial<GoogleChatAdapterDeps> = {}) {
  const loggerSpy = makeLoggerSpy();
  const serviceAccountKey = await makeServiceAccountKey();
  const fake = makeFakeSource();
  const holder: { sourceDeps?: PubSubSourceDeps } = {};
  const deps: GoogleChatAdapterDeps = {
    serviceAccountKey,
    subscriptionName: SUBSCRIPTION,
    allowFrom: [],
    allowMode: "allowlist",
    logger: loggerSpy.logger,
    fetchImpl: makeTokenFetch(),
    now: () => NOW,
    createSource: (d: PubSubSourceDeps) => {
      holder.sourceDeps = d;
      return fake.source;
    },
    ...overrides,
  };
  return { deps, loggerSpy, fake, holder, serviceAccountKey };
}

/** Build a classic Chat MESSAGE interaction event. */
function makeEvent(
  over: {
    type?: string;
    senderName?: string;
    spaceName?: string;
    spaceType?: string;
    text?: string;
    messageName?: string;
  } = {},
): unknown {
  const spaceName = over.spaceName ?? "spaces/AAAA";
  const space = { name: spaceName, spaceType: over.spaceType ?? "SPACE" };
  return {
    type: over.type ?? "MESSAGE",
    space,
    message: {
      name: over.messageName ?? "spaces/AAAA/messages/CCC",
      sender: { name: over.senderName ?? "users/123" },
      text: over.text ?? "hello there",
      space,
    },
  };
}

/**
 * Build a CARD_CLICKED interaction event: a verified clicker (`user.name`), a
 * rendered action method, and an opaque `cb` parameter. `cb: null` omits the
 * callback param (a malformed click); `omitClicker` drops the verified user
 * envelope; `forgedUserId` plants a client-controllable id under
 * `action.parameters` (which the normalizer must ignore).
 */
function makeCardClickEvent(
  over: {
    clickerName?: string;
    method?: string;
    cb?: string | null;
    spaceName?: string;
    messageName?: string;
    forgedUserId?: string;
    omitClicker?: boolean;
  } = {},
): unknown {
  const parameters: Array<{ key: string; value: string }> = [];
  if (over.cb !== null) {
    parameters.push({ key: "cb", value: over.cb ?? "v1.allow.shortid.hmac" });
  }
  if (over.forgedUserId !== undefined) {
    parameters.push({ key: "userId", value: over.forgedUserId });
  }
  return {
    type: "CARD_CLICKED",
    ...(over.omitClicker
      ? {}
      : { user: { name: over.clickerName ?? "users/123" } }),
    space: { name: over.spaceName ?? "spaces/AAAA" },
    message: { name: over.messageName ?? "spaces/AAAA/messages/CCC" },
    action: {
      actionMethodName: over.method ?? GOOGLECHAT_APPROVAL_FUNCTION,
      parameters,
    },
  };
}

/** Find a logged record at a level whose object arg has the given errorKind. */
function findByErrorKind(
  spy: ReturnType<typeof vi.fn>,
  kind: string,
): Record<string, unknown> | undefined {
  return spy.mock.calls
    .map((c) => c[0])
    .find(
      (p) =>
        p !== null &&
        typeof p === "object" &&
        (p as { errorKind?: string }).errorKind === kind,
    ) as Record<string, unknown> | undefined;
}

describe("createGoogleChatAdapter — inbound gate + dispatch", () => {
  it("calls each registered handler with the mapped message for an allowed sender", async () => {
    const { deps } = await makeDeps({ allowFrom: ["users/123"] });
    const adapter = createGoogleChatAdapter(deps);
    const handler = vi.fn();
    adapter.onMessage(handler);

    await adapter.handleChatEvent(makeEvent());

    expect(handler).toHaveBeenCalledTimes(1);
    const msg = handler.mock.calls[0][0] as {
      senderId: string;
      channelId: string;
      text: string;
      channelType: string;
    };
    expect(msg.senderId).toBe("users/123");
    expect(msg.channelId).toBe("spaces/AAAA");
    expect(msg.text).toBe("hello there");
    expect(msg.channelType).toBe("googlechat");
  });

  it("drops a non-allowlisted users/... sender BEFORE any handler runs and resolves (ack)", async () => {
    const { deps, loggerSpy } = await makeDeps({ allowFrom: [] });
    const adapter = createGoogleChatAdapter(deps);
    const handler = vi.fn();
    adapter.onMessage(handler);

    await expect(
      adapter.handleChatEvent(makeEvent({ senderName: "users/999" })),
    ).resolves.toBeUndefined();

    expect(handler).not.toHaveBeenCalled();
    const warn = findByErrorKind(loggerSpy.warn, "precondition");
    expect(warn).toBeDefined();
    expect(String(warn?.hint)).toContain("channels.googlechat.allowFrom");
  });

  it("admits any sender when allowMode is 'open'", async () => {
    const { deps } = await makeDeps({ allowMode: "open", allowFrom: [] });
    const adapter = createGoogleChatAdapter(deps);
    const handler = vi.fn();
    adapter.onMessage(handler);

    await adapter.handleChatEvent(makeEvent({ senderName: "users/anyone" }));

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("admits an inbound whose channelId (space) is on the allowlist even if the sender is not", async () => {
    const { deps } = await makeDeps({ allowFrom: ["spaces/AAAA"] });
    const adapter = createGoogleChatAdapter(deps);
    const handler = vi.fn();
    adapter.onMessage(handler);

    await adapter.handleChatEvent(makeEvent({ senderName: "users/999" }));

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("resolves without calling a handler for a non-MESSAGE event (mapper returns null)", async () => {
    const { deps } = await makeDeps({ allowMode: "open" });
    const adapter = createGoogleChatAdapter(deps);
    const handler = vi.fn();
    adapter.onMessage(handler);

    await expect(
      adapter.handleChatEvent(makeEvent({ type: "ADDED_TO_SPACE" })),
    ).resolves.toBeUndefined();

    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects (skip-ack signal) when a handler rejects, but still runs the sibling handler", async () => {
    const { deps, loggerSpy } = await makeDeps({ allowFrom: ["users/123"] });
    const adapter = createGoogleChatAdapter(deps);
    const rejecting = vi.fn(async () => {
      throw new Error("inbound queue full");
    });
    const sibling = vi.fn();
    adapter.onMessage(rejecting);
    adapter.onMessage(sibling);

    await expect(adapter.handleChatEvent(makeEvent())).rejects.toThrow(
      "inbound queue full",
    );

    // Per-handler isolation: the sibling still ran even though the first rejected.
    expect(sibling).toHaveBeenCalledTimes(1);
    expect(findByErrorKind(loggerSpy.error, "internal")).toBeDefined();
  });

  it("rejects (skip-ack signal) when a handler throws synchronously, and the sibling still runs", async () => {
    const { deps } = await makeDeps({ allowFrom: ["users/123"] });
    const adapter = createGoogleChatAdapter(deps);
    const throwing = vi.fn(() => {
      throw new Error("sync boom");
    });
    const sibling = vi.fn();
    adapter.onMessage(throwing);
    adapter.onMessage(sibling);

    await expect(adapter.handleChatEvent(makeEvent())).rejects.toThrow(
      "sync boom",
    );
    expect(sibling).toHaveBeenCalledTimes(1);
  });

  it("resolves (ack, not skip-ack) for a decoded literal JSON null — never throws a TypeError into the redelivery path", async () => {
    const { deps } = await makeDeps({ allowMode: "open" });
    const adapter = createGoogleChatAdapter(deps);
    const handler = vi.fn();
    adapter.onMessage(handler);

    // A payload of the literal JSON null reaches the mapper un-guarded (it
    // JSON.parses fine, so the pull loop's decode catch is bypassed). It must
    // resolve so the pull loop ACKs it, not reject into infinite redelivery.
    await expect(adapter.handleChatEvent(null)).resolves.toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
  });

  it("skip-acks (rejects) an admitted inbound when no handler is registered yet, so it redelivers", async () => {
    const { deps } = await makeDeps({ allowMode: "open" });
    const adapter = createGoogleChatAdapter(deps);

    // A pull channel drains the subscription backlog immediately on start(); a
    // message that arrives before onMessage() must redeliver, not be acked-and-
    // dropped. No liveness bump — a never-wired ingress must look stale.
    await expect(adapter.handleChatEvent(makeEvent())).rejects.toThrow();
    expect(adapter.getStatus?.().lastInboundAt).toBeUndefined();
  });

  it("processes the redelivery once a handler is registered", async () => {
    const { deps } = await makeDeps({ allowMode: "open" });
    const adapter = createGoogleChatAdapter(deps);
    const handler = vi.fn();
    adapter.onMessage(handler);

    await expect(adapter.handleChatEvent(makeEvent())).resolves.toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("createGoogleChatAdapter — status + lastInboundAt semantics", () => {
  it("reports connectionMode 'polling', channelType 'googlechat', and disconnected before start", async () => {
    const { deps } = await makeDeps();
    const adapter = createGoogleChatAdapter(deps);
    const status = adapter.getStatus?.();
    expect(status?.connectionMode).toBe("polling");
    expect(status?.channelType).toBe("googlechat");
    expect(status?.connected).toBe(false);
    expect(status?.lastInboundAt).toBeUndefined();
  });

  it("sets lastInboundAt after an allowed inbound", async () => {
    const { deps } = await makeDeps({ allowFrom: ["users/123"] });
    const adapter = createGoogleChatAdapter(deps);
    adapter.onMessage(vi.fn());
    await adapter.handleChatEvent(makeEvent());
    expect(adapter.getStatus?.().lastInboundAt).toBe(NOW);
  });

  it("does NOT set lastInboundAt when the only inbound was dropped by the gate", async () => {
    const { deps } = await makeDeps({ allowFrom: [] });
    const adapter = createGoogleChatAdapter(deps);
    adapter.onMessage(vi.fn());
    await adapter.handleChatEvent(makeEvent({ senderName: "users/999" }));
    expect(adapter.getStatus?.().lastInboundAt).toBeUndefined();
  });

  it("surfaces the source lastError in getStatus.error", async () => {
    const fake = makeFakeSource({ lastError: "pubsub token mint failed" });
    const { deps } = await makeDeps({ createSource: () => fake.source });
    const adapter = createGoogleChatAdapter(deps);
    await adapter.start();
    expect(adapter.getStatus?.().error).toBe("pubsub token mint failed");
  });
});

describe("createGoogleChatAdapter — lifecycle", () => {
  it("start() with a blank service-account key returns err, logs ERROR, and does NOT boot the loop", async () => {
    const { deps, loggerSpy, fake } = await makeDeps({ serviceAccountKey: "" });
    const adapter = createGoogleChatAdapter(deps);

    const result = await adapter.start();

    expect(result.ok).toBe(false);
    expect(fake.start).not.toHaveBeenCalled();
    expect(adapter.getStatus?.().connected).toBe(false);
    expect(loggerSpy.error).toHaveBeenCalled();
  });

  it("start() with valid creds returns ok, marks connected, and boots the source wired to handleChatEvent", async () => {
    const { deps, fake, holder } = await makeDeps();
    const adapter = createGoogleChatAdapter(deps);

    const result = await adapter.start();

    expect(result.ok).toBe(true);
    expect(fake.start).toHaveBeenCalledTimes(1);
    expect(adapter.getStatus?.().connected).toBe(true);
    // The loop dispatches inbound through the same gated handler the unit drives.
    expect(holder.sourceDeps?.onEvent).toBe(adapter.handleChatEvent);
    expect(holder.sourceDeps?.subscriptionName).toBe(SUBSCRIPTION);
    expect(typeof holder.sourceDeps?.getPubSubToken).toBe("function");
  });

  it("start() in webhook mode with valid creds and NO subscriptionName returns ok, marks connected, and never opens the pull loop", async () => {
    // Webhook mode has no Pub/Sub subscription — inbound arrives through the
    // gateway ingress driving handleChatEvent — so start() must skip the pull
    // loop entirely and must NOT require a subscriptionName.
    const createSource = vi.fn((): PubSubSource => makeFakeSource().source);
    const { deps } = await makeDeps({
      mode: "webhook",
      subscriptionName: "",
      createSource,
    });
    const adapter = createGoogleChatAdapter(deps);

    const result = await adapter.start();

    expect(result.ok).toBe(true);
    expect(createSource).not.toHaveBeenCalled();
    expect(adapter.getStatus?.().connected).toBe(true);
  });

  it("start() in webhook mode skips the pull loop even when a subscriptionName is present (the transport is the only mode difference)", async () => {
    const createSource = vi.fn((): PubSubSource => makeFakeSource().source);
    const { deps } = await makeDeps({ mode: "webhook", createSource });
    const adapter = createGoogleChatAdapter(deps);

    const result = await adapter.start();

    expect(result.ok).toBe(true);
    // Even with a subscription configured, webhook mode never opens the loop.
    expect(createSource).not.toHaveBeenCalled();
  });

  it("start() in webhook mode with a blank service-account key returns err and never opens the pull loop (webhook still sends replies, so it needs the key)", async () => {
    const createSource = vi.fn((): PubSubSource => makeFakeSource().source);
    const { deps, loggerSpy } = await makeDeps({
      mode: "webhook",
      serviceAccountKey: "",
      createSource,
    });
    const adapter = createGoogleChatAdapter(deps);

    const result = await adapter.start();

    expect(result.ok).toBe(false);
    expect(createSource).not.toHaveBeenCalled();
    expect(adapter.getStatus?.().connected).toBe(false);
    expect(loggerSpy.error).toHaveBeenCalled();
  });

  it("start() in pubsub mode with a blank subscriptionName still returns err (the pull subscription precondition is unchanged)", async () => {
    const createSource = vi.fn((): PubSubSource => makeFakeSource().source);
    const { deps } = await makeDeps({ subscriptionName: "", createSource });
    const adapter = createGoogleChatAdapter(deps);

    const result = await adapter.start();

    expect(result.ok).toBe(false);
    expect(createSource).not.toHaveBeenCalled();
  });

  it("start() is idempotent: a second start() without an intervening stop() does not create/boot a second source", async () => {
    let created = 0;
    const starts: number[] = [];
    const createSource = (): PubSubSource => {
      created += 1;
      return {
        start: () => {
          starts.push(1);
        },
        stop: async () => {},
        pollOnce: async () => ({
          receivedCount: 0,
          ackedCount: 0,
          skippedCount: 0,
          pullFailed: false,
        }),
        lastError: undefined,
        running: false,
      } as PubSubSource;
    };
    const { deps } = await makeDeps({ createSource });
    const adapter = createGoogleChatAdapter(deps);

    const r1 = await adapter.start();
    const r2 = await adapter.start();

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    // Exactly one source — a second start() must not orphan the first (which
    // would keep polling forever: double-pull + leak).
    expect(created).toBe(1);
    expect(starts.length).toBe(1);
  });

  it("stop() stops the source and marks disconnected", async () => {
    const { deps, fake } = await makeDeps();
    const adapter = createGoogleChatAdapter(deps);
    await adapter.start();

    const result = await adapter.stop();

    expect(result.ok).toBe(true);
    expect(fake.stop).toHaveBeenCalledTimes(1);
    expect(adapter.getStatus?.().connected).toBe(false);
  });
});

describe("createGoogleChatAdapter — reconcile + platformAction + capability honesty", () => {
  it("reconcileSend always resolves ok({ kind: 'unresolved' }) — never not_sent", async () => {
    const { deps } = await makeDeps();
    const adapter = createGoogleChatAdapter(deps);
    const result = await adapter.reconcileSend?.({
      channelId: "spaces/AAAA",
      contentDigest: "abc",
      sentAfterMs: 1,
      sentBeforeMs: 2,
    });
    expect(result?.ok).toBe(true);
    if (result?.ok) expect(result.value.kind).toBe("unresolved");
  });

  // Inbound-only liveness (polling connectionMode + inbound-only lastInboundAt)
  // is locked by the "status + lastInboundAt semantics" cases above: polling
  // mode, set only on an admitted inbound, and never bumped on a gate-dropped
  // inbound or an outbound send. This case locks the complementary contract —
  // a restart-recovery pass over the outward-send ledger never replays a send.
  it("never re-sends a committed or unknown_after_send ledger row on a simulated restart (ledger dedup + unresolved parks)", async () => {
    const { fetchImpl, spy } = makeChatFetch();
    const { deps } = await makeDeps({ fetchImpl });
    const adapter = createGoogleChatAdapter(deps);

    const reconcileQuery = (contentDigest: string) => ({
      channelId: "spaces/AAAA",
      contentDigest,
      sentAfterMs: NOW - 60_000,
      sentBeforeMs: NOW,
    });

    // A tiny in-memory model of the outward-send ledger — digest → lifecycle
    // state. The LEDGER (not reconcileSend) is the exactly-once authority.
    type LedgerStatus = "committed" | "unknown_after_send";
    const ledger = new Map<string, LedgerStatus>([
      ["digest-committed", "committed"],
      ["digest-unknown", "unknown_after_send"],
    ]);

    // The restart-recovery pass: a committed row short-circuits (dedup — no
    // re-POST); an unknown_after_send row consults reconcileSend → unresolved →
    // parked, never replayed. Neither path fires a second Chat send.
    for (const [digest, status] of ledger) {
      if (status === "committed") continue; // ledger dedup: no re-send
      const verdict = await adapter.reconcileSend?.(reconcileQuery(digest));
      expect(verdict?.ok).toBe(true);
      if (verdict?.ok) expect(verdict.value.kind).toBe("unresolved");
      // unresolved → park + escalate; NEVER a replay.
    }

    // No Chat send POST fired during the whole recovery pass.
    expect(
      spy.mock.calls.find(([u]) => String(u).includes("/messages")),
    ).toBeUndefined();
  });

  it("platformAction resolves err naming the unsupported action on googlechat", async () => {
    const { deps } = await makeDeps();
    const adapter = createGoogleChatAdapter(deps);
    const result = await adapter.platformAction("pin", {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("Unsupported action: pin on googlechat");
    }
  });

  it("omits every unbacked optional method (no silent capability)", async () => {
    const { deps } = await makeDeps();
    const adapter = createGoogleChatAdapter(deps) as Record<string, unknown>;
    for (const method of [
      "onReaction",
      "reactToMessage",
      "removeReaction",
      "fetchMessages",
      "sendAttachment",
    ]) {
      expect(typeof adapter[method]).toBe("undefined");
    }
  });

  it("exposes the pub/sub token provider for the send path and later wiring", async () => {
    const { deps } = await makeDeps();
    const adapter = createGoogleChatAdapter(deps);
    expect(typeof adapter.getPubSubTokenProvider().getToken).toBe("function");
  });
});

describe("createGoogleChatAdapter — sendMessage (messages.create)", () => {
  it("mints a chat.bot bearer and POSTs {text} to the space messages endpoint, returning the message name", async () => {
    const { fetchImpl, spy } = makeChatFetch();
    const { deps } = await makeDeps({ fetchImpl });
    const adapter = createGoogleChatAdapter(deps);

    const result = await adapter.sendMessage("spaces/AAAA", "hello");

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("spaces/AAAA/messages/CCC");

    const sendCall = spy.mock.calls.find(([u]) =>
      String(u).includes("/messages"),
    ) as [string, RequestInit] | undefined;
    expect(sendCall).toBeDefined();
    const [url, init] = sendCall as [string, RequestInit];
    expect(url).toBe("https://chat.googleapis.com/v1/spaces/AAAA/messages");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${MINTED_TOKEN}`);
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({ text: "hello" });
  });

  it("threads the send: {text, thread:{name}} body + messageReplyOption query when options.threadId is set", async () => {
    const { fetchImpl, spy } = makeChatFetch();
    const { deps } = await makeDeps({ fetchImpl });
    const adapter = createGoogleChatAdapter(deps);

    const result = await adapter.sendMessage("spaces/AAAA", "hi", {
      threadId: "spaces/AAAA/threads/TTTT",
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("spaces/AAAA/messages/CCC");

    const sendCall = spy.mock.calls.find(([u]) =>
      String(u).includes("/messages"),
    ) as [string, RequestInit] | undefined;
    expect(sendCall).toBeDefined();
    const [url, init] = sendCall as [string, RequestInit];
    // The thread name is a BODY value and the reply option is a QUERY param —
    // the untrusted thread resource name is never interpolated into the URL path.
    expect(url).toBe(
      "https://chat.googleapis.com/v1/spaces/AAAA/messages?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD",
    );
    expect(JSON.parse(String(init.body))).toEqual({
      text: "hi",
      thread: { name: "spaces/AAAA/threads/TTTT" },
    });
  });

  it("does not thread the send when options carries no threadId (plain {text}, un-parameterised URL)", async () => {
    const { fetchImpl, spy } = makeChatFetch();
    const { deps } = await makeDeps({ fetchImpl });
    const adapter = createGoogleChatAdapter(deps);

    await adapter.sendMessage("spaces/AAAA", "hi", { replyTo: "spaces/AAAA/messages/ZZ" });

    const sendCall = spy.mock.calls.find(([u]) =>
      String(u).includes("/messages"),
    ) as [string, RequestInit] | undefined;
    expect(sendCall).toBeDefined();
    const [url, init] = sendCall as [string, RequestInit];
    expect(url).toBe("https://chat.googleapis.com/v1/spaces/AAAA/messages");
    expect(JSON.parse(String(init.body))).toEqual({ text: "hi" });
  });

  it("returns err on a non-ok status, logs an ERROR with errorKind+hint, and never logs the token", async () => {
    const { fetchImpl } = makeChatFetch({ sendStatus: 403 });
    const { deps, loggerSpy } = await makeDeps({ fetchImpl });
    const adapter = createGoogleChatAdapter(deps);

    const result = await adapter.sendMessage("spaces/AAAA", "denied");

    expect(result.ok).toBe(false);
    const errRec = findByErrorKind(loggerSpy.error, "auth");
    expect(errRec).toBeDefined();
    expect(String(errRec?.hint).length).toBeGreaterThan(0);
    expect(loggerSpy.serialized()).not.toContain(MINTED_TOKEN);
  });

  it("returns err classified network when the send transport rejects, attaching the underlying err (never the token)", async () => {
    const { fetchImpl } = makeChatFetch({ sendThrows: true });
    const { deps, loggerSpy } = await makeDeps({ fetchImpl });
    const adapter = createGoogleChatAdapter(deps);

    const result = await adapter.sendMessage("spaces/AAAA", "hi");

    expect(result.ok).toBe(false);
    const errRec = findByErrorKind(loggerSpy.error, "network");
    expect(errRec).toBeDefined();
    // The transport cause is attached so an operator can tell ECONNREFUSED from
    // a DNS/TLS failure; the token lives only in init.headers, never in err.
    expect(errRec?.err).toBeInstanceOf(Error);
    expect(loggerSpy.serialized()).not.toContain(MINTED_TOKEN);
  });

  it("does NOT bump lastInboundAt on an outbound send (bumps lastMessageAt only)", async () => {
    const { fetchImpl } = makeChatFetch();
    const { deps } = await makeDeps({ fetchImpl });
    const adapter = createGoogleChatAdapter(deps);

    await adapter.sendMessage("spaces/AAAA", "hello");

    expect(adapter.getStatus?.().lastInboundAt).toBeUndefined();
    expect(adapter.getStatus?.().lastMessageAt).toBe(NOW);
  });

  it("rejects an agent-supplied channelId with a .. traversal or query/path metacharacter BEFORE any token mint or fetch", async () => {
    // channelId is interpolated into `${chatBase}/${channelId}/messages` and is
    // agent-controlled (message.send's channel_id), so it gets the same allowlist
    // guard the edit/delete resource names get — a traversal like
    // spaces/A/../../v1beta1/spaces/B would otherwise normalise to a different
    // Chat API path under the bot's bearer. Rejected before the bearer is minted.
    for (const bad of [
      "spaces/A/../../v1beta1/spaces/B",
      "spaces/AAAA?foo=bar",
      "spaces/AAAA&x=1",
      "spaces/AAAA messages",
    ]) {
      const { fetchImpl, spy } = makeChatFetch();
      const { deps } = await makeDeps({ fetchImpl });
      const adapter = createGoogleChatAdapter(deps);

      const result = await adapter.sendMessage(bad, "hi");

      expect(result.ok).toBe(false);
      // No bearer minted, no POST fired for the unsafe space name.
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it("does NOT reject a legitimate space channelId", async () => {
    const { fetchImpl } = makeChatFetch();
    const { deps } = await makeDeps({ fetchImpl });
    const adapter = createGoogleChatAdapter(deps);

    const result = await adapter.sendMessage("spaces/AAAA", "hi");

    expect(result.ok).toBe(true);
  });
});

/** Find the single /messages REST call captured by the fetch spy (asserts it fired). */
function sendCallOf(spy: ReturnType<typeof vi.fn>): [string, RequestInit] {
  const call = spy.mock.calls.find(([u]) => String(u).includes("/messages")) as
    | [string, RequestInit]
    | undefined;
  expect(call).toBeDefined();
  return call as [string, RequestInit];
}

/** Flatten every widget across all cardsV2 entries' sections of a request body. */
function cardsV2Widgets(body: unknown): Array<Record<string, unknown>> {
  const cardsV2 = (body as { cardsV2?: unknown }).cardsV2;
  if (!Array.isArray(cardsV2)) return [];
  const widgets: Array<Record<string, unknown>> = [];
  for (const entry of cardsV2) {
    const sections = (entry as { card?: { sections?: unknown } }).card?.sections;
    if (!Array.isArray(sections)) continue;
    for (const section of sections) {
      const ws = (section as { widgets?: unknown }).widgets;
      if (Array.isArray(ws)) widgets.push(...(ws as Array<Record<string, unknown>>));
    }
  }
  return widgets;
}

describe("createGoogleChatAdapter — sendMessage cardsV2 (cards/buttons)", () => {
  const SIGNED_CB = "v1.approve.abc123.deadbeefcafe";

  it("attaches a cardsV2 buttonList carrying the interactive button when options.buttons is present", async () => {
    const { fetchImpl, spy } = makeChatFetch();
    const { deps } = await makeDeps({ fetchImpl });
    const adapter = createGoogleChatAdapter(deps);

    const result = await adapter.sendMessage("spaces/AAAA", "hi", {
      buttons: [[{ text: "Approve", callback_data: SIGNED_CB }]],
    });

    expect(result.ok).toBe(true);
    const [, init] = sendCallOf(spy);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    const cardsV2 = body.cardsV2 as Array<{ cardId?: unknown }> | undefined;
    expect(Array.isArray(cardsV2)).toBe(true);
    // Each cardsV2 entry carries a non-empty cardId.
    for (const entry of cardsV2 ?? []) {
      expect(typeof entry.cardId).toBe("string");
      expect(String(entry.cardId).length).toBeGreaterThan(0);
    }
    // The widget tree contains a buttonList carrying the interactive button, and
    // the button stamps the shared rendered function + rides the opaque callback.
    const buttonList = cardsV2Widgets(body).find(
      (w) => (w as { buttonList?: unknown }).buttonList,
    ) as { buttonList: { buttons: Array<Record<string, unknown>> } } | undefined;
    expect(buttonList).toBeDefined();
    const btn = buttonList?.buttonList.buttons[0] as {
      text?: string;
      onClick?: {
        action?: { function?: string; parameters?: Array<{ key?: string; value?: string }> };
      };
    };
    expect(btn?.text).toBe("Approve");
    expect(btn?.onClick?.action?.function).toBe(GOOGLECHAT_APPROVAL_FUNCTION);
    expect(
      btn?.onClick?.action?.parameters?.find((p) => p.key === "cb")?.value,
    ).toBe(SIGNED_CB);
  });

  it("attaches a cardsV2 card with title/description text-paragraph widgets when options.cards is present", async () => {
    const { fetchImpl, spy } = makeChatFetch();
    const { deps } = await makeDeps({ fetchImpl });
    const adapter = createGoogleChatAdapter(deps);

    const result = await adapter.sendMessage("spaces/AAAA", "hi", {
      cards: [{ title: "T", description: "D" }],
    });

    expect(result.ok).toBe(true);
    const [, init] = sendCallOf(spy);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(Array.isArray(body.cardsV2)).toBe(true);
    const paragraphs = cardsV2Widgets(body)
      .map((w) => (w as { textParagraph?: { text?: string } }).textParagraph?.text)
      .filter((t): t is string => typeof t === "string");
    expect(paragraphs).toContain("<b>T</b>");
    expect(paragraphs).toContain("D");
  });

  it("a plain send (no cards/buttons) stays the bare { text } body — no cardsV2 key", async () => {
    const { fetchImpl, spy } = makeChatFetch();
    const { deps } = await makeDeps({ fetchImpl });
    const adapter = createGoogleChatAdapter(deps);

    await adapter.sendMessage("spaces/AAAA", "hello");

    const [, init] = sendCallOf(spy);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toEqual({ text: "hello" });
    expect("cardsV2" in body).toBe(false);
  });

  it("sends the message text field byte-identical — Chat text is markdown, not HTML, so &/</> are NEVER entity-escaped", async () => {
    const { fetchImpl, spy } = makeChatFetch();
    const { deps } = await makeDeps({ fetchImpl });
    const adapter = createGoogleChatAdapter(deps);

    // A plain agent message with an ampersand, an angle span, and an mrkdwn
    // marker. The Chat `text` field is Chat-markdown and does NOT decode HTML
    // entities, so entity-escaping it (&amp; / &lt; / &gt;) would surface the
    // literal entities and corrupt ordinary output. It must pass through verbatim.
    await adapter.sendMessage("spaces/AAAA", "Tom & Jerry <tag> _x_");

    const [, init] = sendCallOf(spy);
    const body = JSON.parse(String(init.body)) as { text?: string };
    expect(body.text).toBe("Tom & Jerry <tag> _x_");
  });

  it("threads a card send: thread{name} + reply query alongside cardsV2 when threadId and buttons are both set", async () => {
    const { fetchImpl, spy } = makeChatFetch();
    const { deps } = await makeDeps({ fetchImpl });
    const adapter = createGoogleChatAdapter(deps);

    await adapter.sendMessage("spaces/AAAA", "hi", {
      threadId: "spaces/AAAA/threads/TTTT",
      buttons: [[{ text: "Approve", callback_data: SIGNED_CB }]],
    });

    const [url, init] = sendCallOf(spy);
    // The thread name stays a BODY value and the reply option a QUERY param —
    // the cardsV2 payload rides the same POST alongside them.
    expect(url).toBe(
      "https://chat.googleapis.com/v1/spaces/AAAA/messages?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD",
    );
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.thread).toEqual({ name: "spaces/AAAA/threads/TTTT" });
    expect(Array.isArray(body.cardsV2)).toBe(true);
  });
});

describe("createGoogleChatAdapter — editMessage (messages.patch)", () => {
  it("mints a chat.bot bearer and PATCHes {text} with updateMask=text to the message resource, returning ok(undefined)", async () => {
    const { fetchImpl, spy } = makeChatFetch();
    const { deps } = await makeDeps({ fetchImpl });
    const adapter = createGoogleChatAdapter(deps);

    const result = await adapter.editMessage?.(
      "spaces/AAAA",
      "spaces/AAAA/messages/CCC",
      "new text",
    );

    expect(result?.ok).toBe(true);
    if (result?.ok) expect(result.value).toBeUndefined();

    const patchCall = spy.mock.calls.find(([u]) =>
      String(u).includes("/messages"),
    ) as [string, RequestInit] | undefined;
    expect(patchCall).toBeDefined();
    const [url, init] = patchCall as [string, RequestInit];
    // updateMask is pinned to `text` — never `*`, which would wipe unspecified
    // fields — and the resource name is the full spaces/{space}/messages/{id}.
    expect(url).toBe(
      "https://chat.googleapis.com/v1/spaces/AAAA/messages/CCC?updateMask=text",
    );
    expect(init.method).toBe("PATCH");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${MINTED_TOKEN}`);
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({ text: "new text" });
  });

  it("returns err on a non-2xx PATCH, logs an ERROR with errorKind+hint, and never logs the token", async () => {
    const { fetchImpl } = makeChatFetch({ sendStatus: 403 });
    const { deps, loggerSpy } = await makeDeps({ fetchImpl });
    const adapter = createGoogleChatAdapter(deps);

    const result = await adapter.editMessage?.(
      "spaces/AAAA",
      "spaces/AAAA/messages/CCC",
      "denied",
    );

    expect(result?.ok).toBe(false);
    const errRec = findByErrorKind(loggerSpy.error, "auth");
    expect(errRec).toBeDefined();
    expect(String(errRec?.hint).length).toBeGreaterThan(0);
    expect(loggerSpy.serialized()).not.toContain(MINTED_TOKEN);
  });

  it("rejects an unsafe messageId (empty, .. traversal, or control char) BEFORE any token mint or fetch", async () => {
    for (const bad of ["", "spaces/../secret", "spaces/AAAA/messages/\u0007"]) {
      const { fetchImpl, spy } = makeChatFetch();
      const { deps } = await makeDeps({ fetchImpl });
      const adapter = createGoogleChatAdapter(deps);

      const result = await adapter.editMessage?.("spaces/AAAA", bad, "x");

      expect(result?.ok).toBe(false);
      // The guard short-circuits before the token mint and the fetch — zero
      // network calls of any kind fired for the rejected resource name.
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it("rejects a messageId carrying query/path metacharacters (?, &, #, space) BEFORE any token mint or fetch", async () => {
    for (const bad of [
      "spaces/AAAA/messages/CCC?updateMask=*",
      "spaces/AAAA/messages/CCC&x=1",
      "spaces/AAAA/messages/CCC#frag",
      "spaces/AAAA/messages/ CCC",
    ]) {
      const { fetchImpl, spy } = makeChatFetch();
      const { deps } = await makeDeps({ fetchImpl });
      const adapter = createGoogleChatAdapter(deps);

      const result = await adapter.editMessage?.("spaces/AAAA", bad, "x");

      expect(result?.ok).toBe(false);
      // Rejected before the token mint and the fetch — zero network calls fired.
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it("rejects a messageId carrying its own query string BEFORE any token mint or fetch — the pinned updateMask=text cannot be swallowed", async () => {
    // The name is interpolated ahead of the pinned `?updateMask=text`, so a name
    // carrying its own query (`…/CCC?updateMask=*&x=1`) would push the pin into
    // `x`'s value and leave `updateMask=*` as the sole effective mask — wiping
    // every unspecified field. The allowlist guard must reject it up front.
    const { fetchImpl, spy } = makeChatFetch();
    const { deps } = await makeDeps({ fetchImpl });
    const adapter = createGoogleChatAdapter(deps);

    const result = await adapter.editMessage?.(
      "spaces/AAAA",
      "spaces/AAAA/messages/CCC?updateMask=*&x=1",
      "pwned",
    );

    expect(result?.ok).toBe(false);
    // Rejected before the token mint and the fetch — the injected updateMask
    // never reached the PATCH URL.
    expect(spy).not.toHaveBeenCalled();
  });

  it("does NOT reject a legitimate resource name that contains '/'", async () => {
    const { fetchImpl } = makeChatFetch();
    const { deps } = await makeDeps({ fetchImpl });
    const adapter = createGoogleChatAdapter(deps);

    const result = await adapter.editMessage?.(
      "spaces/AAAA",
      "spaces/AAAA/messages/CCC",
      "ok",
    );

    expect(result?.ok).toBe(true);
  });

  it("attaches the underlying err on an edit transport fault (diagnosable) while never logging the token", async () => {
    const { fetchImpl } = makeChatFetch({ sendThrows: true });
    const { deps, loggerSpy } = await makeDeps({ fetchImpl });
    const adapter = createGoogleChatAdapter(deps);

    const result = await adapter.editMessage?.(
      "spaces/AAAA",
      "spaces/AAAA/messages/CCC",
      "hi",
    );

    expect(result?.ok).toBe(false);
    const errRec = findByErrorKind(loggerSpy.error, "network");
    expect(errRec).toBeDefined();
    expect(errRec?.err).toBeInstanceOf(Error);
    expect(loggerSpy.serialized()).not.toContain(MINTED_TOKEN);
  });

  it("exposes editMessage as a function on the adapter handle", async () => {
    const { deps } = await makeDeps();
    const adapter = createGoogleChatAdapter(deps);
    expect(typeof adapter.editMessage).toBe("function");
  });

  it("a 429 PATCH returns an Error carrying structural .status + .retryAfter so the render classifier yields rate_limited (not internal)", async () => {
    // Drive a REAL 429 (with a Retry-After) through the REAL adapter — no
    // injected `.status`. The returned error must carry the numeric HTTP status
    // and the parsed Retry-After seconds as STRUCTURAL fields; the render-error
    // classifier reads those, never the message string. Without them the whole
    // edit-path 429 retry buffer is dead in production.
    const { fetchImpl } = makeChatFetch({ sendStatus: 429, retryAfter: "3" });
    const { deps } = await makeDeps({ fetchImpl });
    const adapter = createGoogleChatAdapter(deps);

    const result = await adapter.editMessage?.(
      "spaces/AAAA",
      "spaces/AAAA/messages/CCC",
      "retry me",
    );

    expect(result?.ok).toBe(false);
    if (result && !result.ok) {
      expect((result.error as { status?: number }).status).toBe(429);
      expect((result.error as { retryAfter?: number }).retryAfter).toBe(3);
      // The REAL classifier, fed the REAL adapter error, must pick rate_limited.
      expect(classifyGoogleChatRenderError(result.error)).toEqual({
        kind: "rate_limited",
        retryAfterMs: 3000,
      });
    }
  });

  it("a 404 PATCH (message gone) returns an Error carrying .status so the classifier yields not_supported:edit (drop further edits)", async () => {
    const { fetchImpl } = makeChatFetch({ sendStatus: 404 });
    const { deps } = await makeDeps({ fetchImpl });
    const adapter = createGoogleChatAdapter(deps);

    const result = await adapter.editMessage?.(
      "spaces/AAAA",
      "spaces/AAAA/messages/CCC",
      "gone",
    );

    expect(result?.ok).toBe(false);
    if (result && !result.ok) {
      expect((result.error as { status?: number }).status).toBe(404);
      // 404 → the render classifier drops all further edits in place.
      expect(classifyGoogleChatRenderError(result.error)).toEqual({
        kind: "not_supported",
        capability: "edit",
      });
    }
  });
});

describe("createGoogleChatAdapter — editMessage cardsV2 patch", () => {
  it("patches text,cardsV2 with a button-less resolved card when options.cards is present (buttons retired)", async () => {
    const { fetchImpl, spy } = makeChatFetch();
    const { deps } = await makeDeps({ fetchImpl });
    const adapter = createGoogleChatAdapter(deps);

    const result = await adapter.editMessage?.(
      "spaces/AAAA",
      "spaces/AAAA/messages/CCC",
      "Approved",
      { cards: [{ description: "Approved" }] },
    );

    expect(result?.ok).toBe(true);
    const [url, init] = sendCallOf(spy);
    // The field-mask is pinned to text,cardsV2 — never `*`, which would clear
    // every unspecified field on the message.
    expect(url).toBe(
      "https://chat.googleapis.com/v1/spaces/AAAA/messages/CCC?updateMask=text,cardsV2",
    );
    expect(url).not.toContain("updateMask=*");
    expect(init.method).toBe("PATCH");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.text).toBe("Approved");
    expect(Array.isArray(body.cardsV2)).toBe(true);
    // The resolved card the caller supplied carries no buttons, so the patched
    // card has no buttonList widget — the original buttons are retired.
    expect(
      cardsV2Widgets(body).some((w) => (w as { buttonList?: unknown }).buttonList),
    ).toBe(false);
  });

  it("keeps the text-only edit path byte-identical (updateMask=text, body { text }) when no cards are supplied", async () => {
    const { fetchImpl, spy } = makeChatFetch();
    const { deps } = await makeDeps({ fetchImpl });
    const adapter = createGoogleChatAdapter(deps);

    const result = await adapter.editMessage?.(
      "spaces/AAAA",
      "spaces/AAAA/messages/CCC",
      "typing…",
    );

    expect(result?.ok).toBe(true);
    const [url, init] = sendCallOf(spy);
    expect(url).toBe(
      "https://chat.googleapis.com/v1/spaces/AAAA/messages/CCC?updateMask=text",
    );
    expect(JSON.parse(String(init.body))).toEqual({ text: "typing…" });
  });

  it("rejects an unsafe messageId on the cardsV2 patch path BEFORE any token mint or fetch (spy never called)", async () => {
    for (const bad of [
      "spaces/../secret",
      "spaces/AAAA/messages/CCC?updateMask=*",
      "spaces/AAAA/messages/ CCC",
    ]) {
      const { fetchImpl, spy } = makeChatFetch();
      const { deps } = await makeDeps({ fetchImpl });
      const adapter = createGoogleChatAdapter(deps);

      const result = await adapter.editMessage?.("spaces/AAAA", bad, "x", {
        cards: [{ description: "d" }],
      });

      expect(result?.ok).toBe(false);
      // The reused isSafeMessageName guard short-circuits before the token mint
      // and the fetch on the cardsV2 patch path too — no bearer, no PATCH.
      expect(spy).not.toHaveBeenCalled();
    }
  });
});

describe("createGoogleChatAdapter — deleteMessage (messages.delete)", () => {
  it("mints a chat.bot bearer and DELETEs the message resource with no body, returning ok(undefined)", async () => {
    const { fetchImpl, spy } = makeChatFetch();
    const { deps } = await makeDeps({ fetchImpl });
    const adapter = createGoogleChatAdapter(deps);

    const result = await adapter.deleteMessage?.(
      "spaces/AAAA",
      "spaces/AAAA/messages/CCC",
    );

    expect(result?.ok).toBe(true);
    if (result?.ok) expect(result.value).toBeUndefined();

    const deleteCall = spy.mock.calls.find(([u]) =>
      String(u).includes("/messages"),
    ) as [string, RequestInit] | undefined;
    expect(deleteCall).toBeDefined();
    const [url, init] = deleteCall as [string, RequestInit];
    expect(url).toBe("https://chat.googleapis.com/v1/spaces/AAAA/messages/CCC");
    expect(init.method).toBe("DELETE");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${MINTED_TOKEN}`);
    // A delete carries no request body.
    expect(init.body).toBeUndefined();
  });

  it("returns err on a non-2xx DELETE, logs an ERROR with errorKind+hint, and never logs the token", async () => {
    const { fetchImpl } = makeChatFetch({ sendStatus: 403 });
    const { deps, loggerSpy } = await makeDeps({ fetchImpl });
    const adapter = createGoogleChatAdapter(deps);

    const result = await adapter.deleteMessage?.(
      "spaces/AAAA",
      "spaces/AAAA/messages/CCC",
    );

    expect(result?.ok).toBe(false);
    const errRec = findByErrorKind(loggerSpy.error, "auth");
    expect(errRec).toBeDefined();
    expect(String(errRec?.hint).length).toBeGreaterThan(0);
    expect(loggerSpy.serialized()).not.toContain(MINTED_TOKEN);
  });

  it("rejects an unsafe messageId (empty, .. traversal, or control char) BEFORE any token mint or fetch", async () => {
    for (const bad of ["", "spaces/../secret", "spaces/AAAA/messages/\u0007"]) {
      const { fetchImpl, spy } = makeChatFetch();
      const { deps } = await makeDeps({ fetchImpl });
      const adapter = createGoogleChatAdapter(deps);

      const result = await adapter.deleteMessage?.("spaces/AAAA", bad);

      expect(result?.ok).toBe(false);
      // The reused isSafeMessageName guard short-circuits before token+fetch.
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it("rejects a messageId carrying query/path metacharacters (?, &, #, space) BEFORE any token mint or fetch", async () => {
    for (const bad of [
      "spaces/AAAA/messages/CCC?foo=bar",
      "spaces/AAAA/messages/CCC&x=1",
      "spaces/AAAA/messages/CCC#frag",
      "spaces/AAAA/messages/ CCC",
    ]) {
      const { fetchImpl, spy } = makeChatFetch();
      const { deps } = await makeDeps({ fetchImpl });
      const adapter = createGoogleChatAdapter(deps);

      const result = await adapter.deleteMessage?.("spaces/AAAA", bad);

      expect(result?.ok).toBe(false);
      // The shared allowlist guard short-circuits before token+fetch.
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it("attaches the underlying err on a delete transport fault (diagnosable) while never logging the token", async () => {
    const { fetchImpl } = makeChatFetch({ sendThrows: true });
    const { deps, loggerSpy } = await makeDeps({ fetchImpl });
    const adapter = createGoogleChatAdapter(deps);

    const result = await adapter.deleteMessage?.(
      "spaces/AAAA",
      "spaces/AAAA/messages/CCC",
    );

    expect(result?.ok).toBe(false);
    const errRec = findByErrorKind(loggerSpy.error, "network");
    expect(errRec).toBeDefined();
    expect(errRec?.err).toBeInstanceOf(Error);
    expect(loggerSpy.serialized()).not.toContain(MINTED_TOKEN);
  });

  it("exposes deleteMessage as a function on the adapter handle", async () => {
    const { deps } = await makeDeps();
    const adapter = createGoogleChatAdapter(deps);
    expect(typeof adapter.deleteMessage).toBe("function");
  });
});

describe("createGoogleChatAdapter — per-space send pacing", () => {
  it("paces two sends to the SAME space by the remaining interval, while a DIFFERENT space is unblocked", async () => {
    const timers = makeFakeTimers();
    let clock = NOW;
    const { fetchImpl } = makeChatFetch();
    const { deps } = await makeDeps({
      fetchImpl,
      now: () => clock,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    });
    const adapter = createGoogleChatAdapter(deps);

    // First send to spaces/AAAA: no prior write to that space → zero pace-wait,
    // so no timer is scheduled.
    await adapter.sendMessage("spaces/AAAA", "one");
    expect(timers.delays).toHaveLength(0);

    // 300ms later a second send to the SAME space must wait the remaining ~700ms
    // of the 1s interval — asserted via the captured timer delay, never a real wait.
    clock = NOW + 300;
    const second = adapter.sendMessage("spaces/AAAA", "two");
    await flushMicrotasks();
    expect(timers.delays).toContain(700);
    await timers.fireNext(); // release the pace-wait so the POST proceeds
    await second;

    // A send to a DIFFERENT space is independent: it schedules no pace-wait.
    const delaysBefore = timers.delays.length;
    await adapter.sendMessage("spaces/BBBB", "b");
    expect(timers.delays.length).toBe(delaysBefore);
  });

  it("stop() cancels a pending pace-wait: the scheduled timer is cleared on shutdown (no hang)", async () => {
    const timers = makeFakeTimers();
    let clock = NOW;
    const { fetchImpl } = makeChatFetch();
    const { deps } = await makeDeps({
      fetchImpl,
      now: () => clock,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    });
    const adapter = createGoogleChatAdapter(deps);

    // Prime the space so a second same-space send incurs a pace-wait.
    await adapter.sendMessage("spaces/AAAA", "one");
    clock = NOW + 100;
    const pending = adapter.sendMessage("spaces/AAAA", "two");
    await flushMicrotasks();
    expect(timers.pendingCount()).toBe(1); // a pace-wait is parked
    expect(timers.cleared).toHaveLength(0);

    // Shutdown must cancel the pending pace-wait (abort the pacer's signal).
    await adapter.stop();
    await flushMicrotasks();
    expect(timers.cleared.length).toBeGreaterThan(0);

    await pending; // the send resolves after the abandoned wait
  });

  it("re-paces sends after a stop()->start() cycle — the send-abort signal is refreshed, not left aborted", async () => {
    const timers = makeFakeTimers();
    let clock = NOW;
    const { fetchImpl } = makeChatFetch();
    const { deps } = await makeDeps({
      fetchImpl,
      now: () => clock,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    });
    const adapter = createGoogleChatAdapter(deps);

    // deactivate -> reactivate lifecycle (config reload). stop() aborts the send
    // signal; start() must install a fresh one, or every later pace-wait rides a
    // stale aborted signal and the pacer short-circuits — silently unpaced.
    await adapter.start();
    await adapter.stop();
    await adapter.start();

    // First send after restart primes the space (no prior write → no wait).
    await adapter.sendMessage("spaces/AAAA", "one");
    // 300ms later, a second same-space send must STILL wait the remaining ~700ms.
    clock = NOW + 300;
    const second = adapter.sendMessage("spaces/AAAA", "two");
    await flushMicrotasks();
    expect(timers.delays).toContain(700); // paced again — the signal was refreshed
    await timers.fireNext(); // release the pace-wait so the POST proceeds
    await second;
  });
});

describe("createGoogleChatAdapter — 429 auto-resend (send-safety)", () => {
  it("resends ONLY on a 429: a 429-then-200 fires exactly 2 POSTs, returns the name, and backs off the clamped Retry-After", async () => {
    const timers = makeFakeTimers();
    const { fetchImpl, spy } = makeChatFetch({
      sendStatuses: [429, 200],
      retryAfter: "1",
    });
    const { deps, loggerSpy } = await makeDeps({
      fetchImpl,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    });
    const adapter = createGoogleChatAdapter(deps);

    // A retry backoff of Retry-After*1000 (=1000ms, under the 60s cap) is parked
    // after the first 429; draining fires it so the second attempt (200) proceeds.
    const result = await settleWithTimers(
      adapter.sendMessage("spaces/AAAA", "hi"),
      timers,
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("spaces/AAAA/messages/CCC");
    const posts = spy.mock.calls.filter(([u]) => String(u).includes("/messages"));
    expect(posts).toHaveLength(2);
    expect(timers.delays).toContain(1000);
    // No token on any retry/failure branch.
    expect(loggerSpy.serialized()).not.toContain(MINTED_TOKEN);
  });

  it("falls back to capped exponential backoff on a 429 with no Retry-After header", async () => {
    const timers = makeFakeTimers();
    const { fetchImpl } = makeChatFetch({ sendStatuses: [429, 200] });
    const { deps } = await makeDeps({
      fetchImpl,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    });
    const adapter = createGoogleChatAdapter(deps);

    const result = await settleWithTimers(
      adapter.sendMessage("spaces/AAAA", "hi"),
      timers,
    );

    expect(result.ok).toBe(true);
    // Attempt 0 backoff: RETRY_BACKOFF_BASE_MS * 2**0 = 500ms.
    expect(timers.delays).toContain(500);
  });

  it("clamps a hostile Retry-After to the ceiling rather than awaiting it verbatim", async () => {
    const timers = makeFakeTimers();
    const { fetchImpl } = makeChatFetch({
      sendStatuses: [429, 200],
      retryAfter: "86400",
    });
    const { deps } = await makeDeps({
      fetchImpl,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    });
    const adapter = createGoogleChatAdapter(deps);

    const result = await settleWithTimers(
      adapter.sendMessage("spaces/AAAA", "hi"),
      timers,
    );

    expect(result.ok).toBe(true);
    // RETRY_AFTER_CAP_MS is 60_000 — a 86400s header is clamped, not awaited raw.
    expect(timers.delays).toContain(60_000);
    expect(timers.delays).not.toContain(86_400_000);
  });

  it("bounds the retries: repeated 429s stop after the max and return err (never loops forever)", async () => {
    const timers = makeFakeTimers();
    const { fetchImpl, spy } = makeChatFetch({
      sendStatuses: [429, 429, 429, 429, 429, 429],
      retryAfter: "1",
    });
    const { deps } = await makeDeps({
      fetchImpl,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    });
    const adapter = createGoogleChatAdapter(deps);

    // MAX_RETRIES is 4 retries on top of the first attempt; draining fires each
    // parked backoff until the send gives up rather than looping forever.
    const result = await settleWithTimers(
      adapter.sendMessage("spaces/AAAA", "hi"),
      timers,
    );

    expect(result.ok).toBe(false);
    const posts = spy.mock.calls.filter(([u]) => String(u).includes("/messages"));
    expect(posts).toHaveLength(5); // 1 initial attempt + 4 bounded retries
  });

  it("does NOT resend a 5xx (non-idempotent create): one POST, err, no backoff scheduled", async () => {
    const timers = makeFakeTimers();
    const { fetchImpl, spy } = makeChatFetch({ sendStatus: 500 });
    const { deps, loggerSpy } = await makeDeps({
      fetchImpl,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    });
    const adapter = createGoogleChatAdapter(deps);

    const result = await adapter.sendMessage("spaces/AAAA", "hi");

    expect(result.ok).toBe(false);
    const posts = spy.mock.calls.filter(([u]) => String(u).includes("/messages"));
    expect(posts).toHaveLength(1); // a 5xx may already have landed → never resent
    expect(timers.delays).toHaveLength(0); // no retry backoff for a 5xx
    expect(findByErrorKind(loggerSpy.error, "platform")).toBeDefined();
    expect(loggerSpy.serialized()).not.toContain(MINTED_TOKEN);
  });

  it("does NOT resend a status-less transport reject: one POST, err classified network", async () => {
    const timers = makeFakeTimers();
    const { fetchImpl, spy } = makeChatFetch({ sendThrows: true });
    const { deps, loggerSpy } = await makeDeps({
      fetchImpl,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    });
    const adapter = createGoogleChatAdapter(deps);

    const result = await adapter.sendMessage("spaces/AAAA", "hi");

    expect(result.ok).toBe(false);
    const posts = spy.mock.calls.filter(([u]) => String(u).includes("/messages"));
    expect(posts).toHaveLength(1); // a transport fault may already have landed → never resent
    expect(timers.delays).toHaveLength(0);
    expect(findByErrorKind(loggerSpy.error, "network")).toBeDefined();
  });

  it("stop() during a 429 retry backoff cancels the pending resend — no POST lands after shutdown", async () => {
    const timers = makeFakeTimers();
    const { fetchImpl, spy } = makeChatFetch({
      sendStatuses: [200, 429, 200],
      retryAfter: "1",
    });
    const { deps } = await makeDeps({
      fetchImpl,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    });
    const adapter = createGoogleChatAdapter(deps);

    // Warm the token cache with a send to a DIFFERENT space so the target send's
    // token mint resolves without a real-time tick and the only parked timer is
    // the retry backoff (not a pace-wait).
    await settleWithTimers(adapter.sendMessage("spaces/WARM", "warm"), timers);
    const postsAfterWarm = spy.mock.calls.filter(([u]) =>
      String(u).includes("/messages"),
    ).length;
    expect(postsAfterWarm).toBe(1);

    // This send hits a 429 and parks a retry backoff (Retry-After 1s, under cap).
    const pending = adapter.sendMessage("spaces/AAAA", "hi");
    await flushMicrotasks();
    const postsAfterFirst = spy.mock.calls.filter(([u]) =>
      String(u).includes("/messages"),
    ).length;
    expect(postsAfterFirst).toBe(2); // the first attempt fired and got a 429
    expect(timers.pendingCount()).toBe(1); // a retry backoff is parked
    expect(timers.cleared).toHaveLength(0);

    // Shutdown must cancel the parked retry backoff — mirror the abort-awareness
    // the pace-wait already has, so a resend never lands after the adapter stops.
    await adapter.stop();
    await flushMicrotasks();
    expect(timers.cleared.length).toBeGreaterThan(0); // the retry timer was cancelled

    const result = await pending;
    expect(result.ok).toBe(false); // aborted during backoff → err, not a late send
    const finalPosts = spy.mock.calls.filter(([u]) =>
      String(u).includes("/messages"),
    ).length;
    expect(finalPosts).toBe(2); // no third POST — the resend was cancelled by stop()
  });
});

describe("createGoogleChatAdapter — CARD_CLICKED routing + default-deny", () => {
  const CB = "v1.allow.shortid.hmachmac";

  it("routes an allowlisted clicker's rendered card click into onMessage as a button callback and bumps liveness", async () => {
    const { deps } = await makeDeps({ allowFrom: ["users/123"] });
    const adapter = createGoogleChatAdapter(deps);
    const handler = vi.fn();
    adapter.onMessage(handler);

    await expect(
      adapter.handleChatEvent(
        makeCardClickEvent({ clickerName: "users/123", cb: CB }),
      ),
    ).resolves.toBeUndefined();

    expect(handler).toHaveBeenCalledTimes(1);
    const msg = handler.mock.calls[0][0] as NormalizedMessage;
    // Routed through the normalizer into the button-callback message shape the
    // inbound approval path consumes — BEFORE the message mapper (which is null).
    expect(msg.channelType).toBe("googlechat");
    expect(msg.channelId).toBe("spaces/AAAA");
    expect(msg.senderId).toBe("users/123");
    expect(msg.metadata.isButtonCallback).toBe(true);
    expect(msg.metadata.callbackData).toBe(CB);
    expect(typeof msg.metadata.traceId).toBe("string");
    // An admitted card click bumps inbound liveness, exactly like a message.
    expect(adapter.getStatus?.().lastInboundAt).toBe(NOW);
  });

  it("DENIES a well-formed card click from a non-allowFrom clicker via the one reused gate, never calling the handler, and RESOLVES (ack — no redelivery)", async () => {
    const { deps, loggerSpy } = await makeDeps({ allowFrom: ["users/good"] });
    const adapter = createGoogleChatAdapter(deps);
    const handler = vi.fn();
    adapter.onMessage(handler);

    await expect(
      adapter.handleChatEvent(
        makeCardClickEvent({ clickerName: "users/evil", cb: CB }),
      ),
    ).resolves.toBeUndefined();

    expect(handler).not.toHaveBeenCalled();
    const warn = findByErrorKind(loggerSpy.warn, "precondition");
    expect(warn).toBeDefined();
    expect(String(warn?.hint)).toContain("channels.googlechat.allowFrom");
    // A default-deny drop must never bump inbound liveness.
    expect(adapter.getStatus?.().lastInboundAt).toBeUndefined();
  });

  it("keys the default-deny gate on the VERIFIED user.name, ignoring a forged users/... id planted in action.parameters (drop side)", async () => {
    // The verified clicker is users/evil; the payload forges the allowlisted
    // users/good under action.parameters. The gate reads the envelope id only,
    // so the click is still denied.
    const { deps } = await makeDeps({ allowFrom: ["users/good"] });
    const adapter = createGoogleChatAdapter(deps);
    const handler = vi.fn();
    adapter.onMessage(handler);

    await adapter.handleChatEvent(
      makeCardClickEvent({
        clickerName: "users/evil",
        forgedUserId: "users/good",
        cb: CB,
      }),
    );

    expect(handler).not.toHaveBeenCalled();
  });

  it("admits on the VERIFIED user.name even when a forged id rides action.parameters, and the fanned senderId is the envelope id (admit side)", async () => {
    const { deps } = await makeDeps({ allowFrom: ["users/good"] });
    const adapter = createGoogleChatAdapter(deps);
    const handler = vi.fn();
    adapter.onMessage(handler);

    await adapter.handleChatEvent(
      makeCardClickEvent({
        clickerName: "users/good",
        forgedUserId: "users/attacker",
        cb: CB,
      }),
    );

    expect(handler).toHaveBeenCalledTimes(1);
    const msg = handler.mock.calls[0][0] as NormalizedMessage;
    // The verified envelope id, never the forged action.parameters value.
    expect(msg.senderId).toBe("users/good");
    expect(msg.metadata.isButtonCallback).toBe(true);
    expect(msg.metadata.callbackData).toBe(CB);
  });

  it("drops a card click naming an unrendered method with a validation WARN and RESOLVES (ack — no redelivery); the callback never rides the log", async () => {
    const { deps, loggerSpy } = await makeDeps({ allowFrom: ["users/123"] });
    const adapter = createGoogleChatAdapter(deps);
    const handler = vi.fn();
    adapter.onMessage(handler);

    await expect(
      adapter.handleChatEvent(
        makeCardClickEvent({
          clickerName: "users/123",
          method: "attacker.arbitrary.method",
          cb: CB,
        }),
      ),
    ).resolves.toBeUndefined();

    expect(handler).not.toHaveBeenCalled();
    expect(findByErrorKind(loggerSpy.warn, "validation")).toBeDefined();
    // The opaque signed callback must never be logged on a security drop.
    expect(loggerSpy.serialized()).not.toContain(CB);
  });

  it("drops a card click carrying no opaque callback with a validation WARN and RESOLVES", async () => {
    const { deps, loggerSpy } = await makeDeps({ allowFrom: ["users/123"] });
    const adapter = createGoogleChatAdapter(deps);
    const handler = vi.fn();
    adapter.onMessage(handler);

    await expect(
      adapter.handleChatEvent(
        makeCardClickEvent({ clickerName: "users/123", cb: null }),
      ),
    ).resolves.toBeUndefined();

    expect(handler).not.toHaveBeenCalled();
    expect(findByErrorKind(loggerSpy.warn, "validation")).toBeDefined();
  });

  it("drops a card click with no verified clicker id with a precondition WARN and RESOLVES", async () => {
    const { deps, loggerSpy } = await makeDeps({ allowFrom: ["users/123"] });
    const adapter = createGoogleChatAdapter(deps);
    const handler = vi.fn();
    adapter.onMessage(handler);

    await expect(
      adapter.handleChatEvent(makeCardClickEvent({ omitClicker: true, cb: CB })),
    ).resolves.toBeUndefined();

    expect(handler).not.toHaveBeenCalled();
    expect(findByErrorKind(loggerSpy.warn, "precondition")).toBeDefined();
  });

  it("never throws (ack — no redelivery amplification) on ANY security drop", async () => {
    // Only a genuine handler rejection skip-acks; every rejected click resolves.
    const { deps } = await makeDeps({ allowFrom: ["users/good"] });
    const adapter = createGoogleChatAdapter(deps);
    adapter.onMessage(vi.fn());

    await expect(
      adapter.handleChatEvent(
        makeCardClickEvent({ clickerName: "users/evil", cb: CB }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      adapter.handleChatEvent(
        makeCardClickEvent({ clickerName: "users/good", method: "x.y", cb: CB }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      adapter.handleChatEvent(
        makeCardClickEvent({ clickerName: "users/good", cb: null }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      adapter.handleChatEvent(makeCardClickEvent({ omitClicker: true, cb: CB })),
    ).resolves.toBeUndefined();
  });

  it("skip-acks (rejects → redelivers) a rendered card click that arrives before a handler is wired, and does not bump liveness", async () => {
    const { deps } = await makeDeps({ allowFrom: ["users/123"] });
    const adapter = createGoogleChatAdapter(deps);
    // No onMessage handler registered yet — a click must redeliver, not drop.

    await expect(
      adapter.handleChatEvent(
        makeCardClickEvent({ clickerName: "users/123", cb: CB }),
      ),
    ).rejects.toThrow();
    expect(adapter.getStatus?.().lastInboundAt).toBeUndefined();
  });

  it("lets a benign non-card event fall through to the message path unchanged", async () => {
    const { deps } = await makeDeps({ allowFrom: ["users/123"] });
    const adapter = createGoogleChatAdapter(deps);
    const handler = vi.fn();
    adapter.onMessage(handler);

    // A normal MESSAGE is not a CARD_CLICKED; it flows through the mapper + gate.
    await adapter.handleChatEvent(
      makeEvent({ senderName: "users/123", text: "hi there" }),
    );

    expect(handler).toHaveBeenCalledTimes(1);
    const msg = handler.mock.calls[0][0] as NormalizedMessage;
    expect(msg.text).toBe("hi there");
    expect(msg.metadata.isButtonCallback).toBeUndefined();
  });
});

describe("createGoogleChatAdapter — inbound Drive-picker skip WARN", () => {
  /** A MESSAGE event from `sender` carrying the given raw attachment objects. */
  function messageEventWithAttachments(
    attachment: unknown[],
    over: { senderName?: string; text?: string } = {},
  ): unknown {
    const space = { name: "spaces/AAAA", spaceType: "SPACE" };
    return {
      type: "MESSAGE",
      space,
      message: {
        name: "spaces/AAAA/messages/CCC",
        sender: { name: over.senderName ?? "users/123" },
        text: over.text ?? "see attached",
        space,
        attachment,
      },
    };
  }

  /** The Drive-picker skip WARN calls (distinct from the non-allowlisted-sender WARN). */
  function skipWarns(spy: ReturnType<typeof vi.fn>): unknown[][] {
    return spy.mock.calls.filter(
      ([, msg]) =>
        typeof msg === "string" && msg.includes("Drive-file attachment"),
    );
  }

  it("emits ONE aggregate skip WARN (skippedCount, distinct sources, errorKind precondition, OAuth+Drive-scope hint) for a resource-name-less share on an allowlisted message, and still fans out", async () => {
    const { deps, loggerSpy } = await makeDeps({ allowFrom: ["users/123"] });
    const adapter = createGoogleChatAdapter(deps);
    const handler = vi.fn();
    adapter.onMessage(handler);

    await adapter.handleChatEvent(
      messageEventWithAttachments([
        { source: "DRIVE_FILE", contentName: "shared.pdf", driveDataRef: { driveFileId: "DRIVE_SECRET_ID" } },
      ]),
    );

    const warns = skipWarns(loggerSpy.warn);
    expect(warns).toHaveLength(1);
    const obj = warns[0][0] as Record<string, unknown>;
    expect(obj.channelType).toBe("googlechat");
    // Aggregate shape: a count + the distinct sources, not one WARN per share.
    expect(obj.skippedCount).toBe(1);
    expect(obj.sources).toEqual(["DRIVE_FILE"]);
    expect(obj.errorKind).toBe("precondition");
    expect(String(obj.hint).toLowerCase()).toContain("oauth");
    expect(String(obj.hint).toLowerCase()).toContain("drive");
    // The message still reaches the handler despite the un-fetchable share.
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does NOT emit a skip WARN when every attachment carries a resolvable resource name", async () => {
    const { deps, loggerSpy } = await makeDeps({ allowFrom: ["users/123"] });
    const adapter = createGoogleChatAdapter(deps);
    const handler = vi.fn();
    adapter.onMessage(handler);

    await adapter.handleChatEvent(
      messageEventWithAttachments([
        { contentType: "image/png", attachmentDataRef: { resourceName: "spaces/AAAA/attachments/C" } },
      ]),
    );

    expect(skipWarns(loggerSpy.warn)).toHaveLength(0);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does NOT emit a skip WARN for a resource-name-less share from a NON-allowlisted sender (dropped by the gate first)", async () => {
    const { deps, loggerSpy } = await makeDeps({ allowFrom: [] });
    const adapter = createGoogleChatAdapter(deps);
    const handler = vi.fn();
    adapter.onMessage(handler);

    await adapter.handleChatEvent(
      messageEventWithAttachments(
        [{ source: "DRIVE_FILE", driveDataRef: { driveFileId: "x" } }],
        { senderName: "users/999" },
      ),
    );

    // The WARN sits AFTER the allowlist gate, so a dropped message announces no media.
    expect(skipWarns(loggerSpy.warn)).toHaveLength(0);
    expect(handler).not.toHaveBeenCalled();
  });

  it("the skip WARN carries only content-free diagnostic keys — no resource name, message text, driveFileId, or token", async () => {
    const { deps, loggerSpy } = await makeDeps({ allowFrom: ["users/123"] });
    const adapter = createGoogleChatAdapter(deps);
    adapter.onMessage(vi.fn());

    await adapter.handleChatEvent(
      messageEventWithAttachments(
        [{ source: "DRIVE_FILE", contentName: "shared.pdf", driveDataRef: { driveFileId: "DRIVE_SECRET_ID" } }],
        { text: "SENSITIVE_MESSAGE_BODY" },
      ),
    );

    const warns = skipWarns(loggerSpy.warn);
    expect(warns).toHaveLength(1);
    const obj = warns[0][0] as Record<string, unknown>;
    expect(Object.keys(obj).sort()).toEqual([
      "channelType",
      "errorKind",
      "hint",
      "skippedCount",
      "sources",
    ]);
    const serialized = JSON.stringify(warns);
    expect(serialized).not.toContain("DRIVE_SECRET_ID");
    expect(serialized).not.toContain("SENSITIVE_MESSAGE_BODY");
    expect(serialized).not.toContain(MINTED_TOKEN);
  });

  it("aggregates multiple resource-name-less shares into ONE WARN carrying the count and the distinct sources (routine Drive shares must not inflate the fleet WARN rate)", async () => {
    const { deps, loggerSpy } = await makeDeps({ allowFrom: ["users/123"] });
    const adapter = createGoogleChatAdapter(deps);
    adapter.onMessage(vi.fn());

    await adapter.handleChatEvent(
      messageEventWithAttachments([
        { source: "DRIVE_FILE", contentName: "a.pdf", driveDataRef: { driveFileId: "x" } },
        { source: "DRIVE_FILE", contentName: "b.pdf", driveDataRef: { driveFileId: "y" } },
      ]),
    );

    const warns = skipWarns(loggerSpy.warn);
    // ONE WARN for the whole message, not one per share.
    expect(warns).toHaveLength(1);
    const obj = warns[0][0] as Record<string, unknown>;
    expect(obj.skippedCount).toBe(2);
    // Distinct sources only (both were DRIVE_FILE → a single entry).
    expect(obj.sources).toEqual(["DRIVE_FILE"]);
  });
});

describe("createGoogleChatAdapter — non-array message.attachment (untrusted)", () => {
  /** A MESSAGE event from an allowlisted sender whose message.attachment field is `raw`. */
  function messageEventWithRawAttachment(raw: unknown): unknown {
    const space = { name: "spaces/AAAA", spaceType: "SPACE" };
    return {
      type: "MESSAGE",
      space,
      message: {
        name: "spaces/AAAA/messages/CCC",
        sender: { name: "users/123" },
        text: "see attached",
        space,
        attachment: raw,
      },
    };
  }

  // handleChatEvent calls the mapper UNWRAPPED (mapping the event) and then the
  // pure extractor AGAIN for the skip WARN — two sites that iterate
  // `message.attachment`. A truthy non-iterable container would throw at either,
  // escape handleChatEvent (the pull loop's onEvent boundary), and be counted as
  // an enqueue failure → skip-ack → infinite redelivery. It must instead degrade
  // to empty: no throw, and the message still fans out to the handler.
  it.each([
    ["an empty object", {}],
    ["a number", 42],
    ["a boolean", true],
  ])(
    "does not throw and still fans out when message.attachment is a non-array container (%s)",
    async (_label, raw) => {
      const { deps } = await makeDeps({ allowFrom: ["users/123"] });
      const adapter = createGoogleChatAdapter(deps);
      const handler = vi.fn();
      adapter.onMessage(handler);

      await expect(
        adapter.handleChatEvent(messageEventWithRawAttachment(raw)),
      ).resolves.not.toThrow();

      expect(handler).toHaveBeenCalledTimes(1);
      const msg = handler.mock.calls[0][0] as NormalizedMessage;
      expect(msg.attachments).toEqual([]);
    },
  );
});
