// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { getEventListeners } from "node:events";
import type { ComisLogger } from "@comis/core";
import { ok, err } from "@comis/shared";
import {
  createPubSubSource,
  type PubSubSourceDeps,
} from "./pubsub-source.js";
import { mapGoogleChatEventToNormalized } from "./message-mapper.js";

const SUB = "projects/my-project/subscriptions/comis-sub";
const BASE = "https://pubsub.googleapis.com/v1";
const PULL_URL = `${BASE}/${SUB}:pull`;
const ACK_URL = `${BASE}/${SUB}:acknowledge`;
const PUBSUB_TOKEN = "ya29.pubsub-access-token";

/** A logger whose spies record every argument to every level. */
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
  return { logger, serialized, info, warn, debug, error };
}

/** A classic Chat interaction event with a stable message resource name. */
function makeChatEvent(name: string, text = "hello") {
  return {
    type: "MESSAGE",
    eventTime: "2026-07-05T00:00:00Z",
    user: { name: "users/1" },
    space: { name: "spaces/AAAA", spaceType: "SPACE" },
    message: {
      name,
      sender: { name: "users/1" },
      text,
    },
  };
}

/** STANDARD base64 (not base64url) of the JSON-serialized event. */
function encodeEvent(event: unknown): string {
  return Buffer.from(JSON.stringify(event), "utf8").toString("base64");
}

interface ReceivedMessageFixture {
  ackId: string;
  message: { data: string; messageId?: string };
}
interface PullBodyFixture {
  receivedMessages?: ReceivedMessageFixture[];
}

/**
 * A plain-HTTP fake that answers `:pull` from a queue and records `:acknowledge`
 * request bodies + pull request inits. No gRPC, no real network.
 */
function makeFetch(pullQueue: PullBodyFixture[]) {
  const ackBodies: Array<{ ackIds: string[] }> = [];
  const pullInits: RequestInit[] = [];
  const impl = vi.fn(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith(":pull")) {
      pullInits.push(init ?? {});
      const body = pullQueue.shift() ?? { receivedMessages: [] };
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    }
    if (u.endsWith(":acknowledge")) {
      const parsed = JSON.parse(String(init?.body ?? "{}")) as { ackIds: string[] };
      ackBodies.push(parsed);
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }
    throw new Error(`unexpected url ${u}`);
  });
  const allAckedIds = () => ackBodies.flatMap((b) => b.ackIds ?? []);
  return {
    fetchImpl: impl as unknown as typeof fetch,
    ackBodies,
    pullInits,
    allAckedIds,
    impl,
  };
}

function makeDeps(over: Partial<PubSubSourceDeps> = {}): {
  deps: PubSubSourceDeps;
  loggerSpy: ReturnType<typeof makeLoggerSpy>;
} {
  const loggerSpy = makeLoggerSpy();
  const deps: PubSubSourceDeps = {
    subscriptionName: SUB,
    getPubSubToken: vi.fn(async () => ok(PUBSUB_TOKEN)),
    onEvent: vi.fn(async () => {}),
    logger: loggerSpy.logger,
    ...over,
  };
  return { deps, loggerSpy };
}

describe("createPubSubSource — pull + ack-on-enqueue + dedup (pollOnce)", () => {
  it("POSTs subscription:pull with a pubsub Bearer and a maxMessages body carrying no returnImmediately", async () => {
    const fetch = makeFetch([{ receivedMessages: [] }]);
    const { deps } = makeDeps({ fetchImpl: fetch.fetchImpl });
    const source = createPubSubSource(deps);

    await source.pollOnce();

    const pullCall = fetch.impl.mock.calls.find(([u]) =>
      String(u).endsWith(":pull"),
    );
    expect(pullCall).toBeDefined();
    const [url, init] = pullCall as unknown as [string, RequestInit];
    expect(url).toBe(PULL_URL);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${PUBSUB_TOKEN}`);
    expect(headers["content-type"]).toBe("application/json");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toEqual({ maxMessages: 10 });
    expect("returnImmediately" in body).toBe(false);
    // The long-poll carries an abort signal so stop() can cancel it.
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("decodes standard base64 message.data, JSON.parses the classic event, and dispatches onEvent exactly once", async () => {
    const event = makeChatEvent("spaces/AAAA/messages/m1");
    const fetch = makeFetch([
      { receivedMessages: [{ ackId: "ack-1", message: { data: encodeEvent(event) } }] },
    ]);
    const onEvent = vi.fn(async () => {});
    const { deps } = makeDeps({ fetchImpl: fetch.fetchImpl, onEvent });
    const source = createPubSubSource(deps);

    const out = await source.pollOnce();

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith(event);
    expect(out.receivedCount).toBe(1);
    expect(out.pullFailed).toBe(false);
  });

  it("decodes a payload whose STANDARD base64 contains + or / (proving standard, not base64url, decoding)", async () => {
    // A payload engineered so its standard-base64 form carries + and/or /.
    const event = makeChatEvent(
      "spaces/AAAA/messages/m1",
      ">>>???~~~ÿþ payload with padding bytes >>>",
    );
    const data = encodeEvent(event);
    // Precondition: this payload's standard base64 uses the +// alphabet, which
    // base64url would render as -/_ — a base64url decode here would corrupt it.
    expect(data).toMatch(/[+/]/);
    const onEvent = vi.fn(async () => {});
    const fetch = makeFetch([
      { receivedMessages: [{ ackId: "ack-1", message: { data } }] },
    ]);
    const { deps } = makeDeps({ fetchImpl: fetch.fetchImpl, onEvent });
    const source = createPubSubSource(deps);

    await source.pollOnce();

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith(event);
  });

  it("acknowledges the ackId only after onEvent resolves (ack-on-enqueue)", async () => {
    const event = makeChatEvent("spaces/AAAA/messages/m1");
    const fetch = makeFetch([
      { receivedMessages: [{ ackId: "ack-1", message: { data: encodeEvent(event) } }] },
    ]);
    const { deps } = makeDeps({
      fetchImpl: fetch.fetchImpl,
      onEvent: vi.fn(async () => {}),
    });
    const source = createPubSubSource(deps);

    const out = await source.pollOnce();

    expect(fetch.allAckedIds()).toContain("ack-1");
    const ackCall = fetch.impl.mock.calls.find(([u]) =>
      String(u).endsWith(":acknowledge"),
    );
    const [url, init] = ackCall as unknown as [string, RequestInit];
    expect(url).toBe(ACK_URL);
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${PUBSUB_TOKEN}`,
    );
    expect(out.ackedCount).toBe(1);
  });

  it("skips the ack when onEvent rejects so Pub/Sub redelivers, logging a WARN with errorKind and hint", async () => {
    const event = makeChatEvent("spaces/AAAA/messages/m1");
    const fetch = makeFetch([
      { receivedMessages: [{ ackId: "ack-1", message: { data: encodeEvent(event) } }] },
    ]);
    const onEvent = vi.fn(async () => {
      throw new Error("inbound queue full");
    });
    const { deps, loggerSpy } = makeDeps({ fetchImpl: fetch.fetchImpl, onEvent });
    const source = createPubSubSource(deps);

    const out = await source.pollOnce();

    expect(fetch.allAckedIds()).not.toContain("ack-1");
    expect(out.skippedCount).toBe(1);
    const warn = loggerSpy.warn.mock.calls
      .map((c) => c[0])
      .find(
        (p) =>
          p !== null &&
          typeof p === "object" &&
          typeof (p as { hint?: unknown }).hint === "string" &&
          typeof (p as { errorKind?: unknown }).errorKind === "string",
      );
    expect(warn).toBeDefined();
  });

  it("dedupes a redelivered duplicate on message.name — dispatches once and acks the duplicate without re-dispatch", async () => {
    const name = "spaces/AAAA/messages/dupe";
    const event = makeChatEvent(name);
    const fetch = makeFetch([
      { receivedMessages: [{ ackId: "ack-first", message: { data: encodeEvent(event) } }] },
      { receivedMessages: [{ ackId: "ack-redeliver", message: { data: encodeEvent(event) } }] },
    ]);
    const onEvent = vi.fn(async () => {});
    const { deps } = makeDeps({ fetchImpl: fetch.fetchImpl, onEvent });
    const source = createPubSubSource(deps);

    await source.pollOnce();
    await source.pollOnce();

    // Dispatched exactly once across both deliveries...
    expect(onEvent).toHaveBeenCalledTimes(1);
    // ...but BOTH ackIds acked, so the duplicate stops redelivering.
    expect(fetch.allAckedIds()).toContain("ack-first");
    expect(fetch.allAckedIds()).toContain("ack-redeliver");
  });

  it("re-dispatches a redelivery when the first delivery's onEvent rejected (name marked seen only on the ack path)", async () => {
    const name = "spaces/AAAA/messages/retry";
    const event = makeChatEvent(name);
    const fetch = makeFetch([
      { receivedMessages: [{ ackId: "ack-1", message: { data: encodeEvent(event) } }] },
      { receivedMessages: [{ ackId: "ack-2", message: { data: encodeEvent(event) } }] },
    ]);
    let calls = 0;
    const onEvent = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient enqueue failure");
    });
    const { deps } = makeDeps({ fetchImpl: fetch.fetchImpl, onEvent });
    const source = createPubSubSource(deps);

    await source.pollOnce(); // rejects → skip ack, NOT marked seen
    await source.pollOnce(); // same name re-dispatched (not deduped)

    expect(onEvent).toHaveBeenCalledTimes(2);
    // First was skipped; second succeeded and was acked.
    expect(fetch.allAckedIds()).not.toContain("ack-1");
    expect(fetch.allAckedIds()).toContain("ack-2");
  });

  it("acks-and-drops a message whose data decodes to JSON null (mapper rejects it) — never skip-acks it into infinite redelivery", async () => {
    // base64("null") JSON.parses to the literal null, so the decode catch is
    // bypassed. Wired to the real map-then-drop dispatch contract (the adapter's
    // handleChatEvent), a payload the mapper rejects must resolve → be ACKed,
    // NOT rejected into the enqueue-backpressure skip-ack (redeliver) path.
    const nullData = Buffer.from("null", "utf8").toString("base64");
    const fetch = makeFetch([
      { receivedMessages: [{ ackId: "ack-null", message: { data: nullData } }] },
    ]);
    // Mirror handleChatEvent's contract: map the untrusted event; a null map is
    // a benign drop (resolve → ack), only a real enqueue failure rejects.
    const onEvent = vi.fn(async (event: unknown) => {
      const normalized = mapGoogleChatEventToNormalized(
        event as Parameters<typeof mapGoogleChatEventToNormalized>[0],
      );
      if (!normalized) return;
    });
    const { deps } = makeDeps({ fetchImpl: fetch.fetchImpl, onEvent });
    const source = createPubSubSource(deps);

    const out = await source.pollOnce();

    expect(out.skippedCount).toBe(0);
    expect(out.ackedCount).toBe(1);
    expect(fetch.allAckedIds()).toContain("ack-null");
  });

  it("acks and skips an unparseable data payload without dispatching or throwing", async () => {
    const bad = Buffer.from("not json {{{", "utf8").toString("base64");
    const fetch = makeFetch([
      { receivedMessages: [{ ackId: "ack-bad", message: { data: bad } }] },
    ]);
    const onEvent = vi.fn(async () => {});
    const { deps } = makeDeps({ fetchImpl: fetch.fetchImpl, onEvent });
    const source = createPubSubSource(deps);

    const out = await source.pollOnce();

    expect(onEvent).not.toHaveBeenCalled();
    expect(fetch.allAckedIds()).toContain("ack-bad");
    expect(out.pullFailed).toBe(false);
  });

  it("reports pullFailed and does not pull when the pubsub token mint fails", async () => {
    const fetch = makeFetch([]);
    const { deps } = makeDeps({
      fetchImpl: fetch.fetchImpl,
      getPubSubToken: vi.fn(async () => err(new Error("mint failed"))),
    });
    const source = createPubSubSource(deps);

    const out = await source.pollOnce();

    expect(out.pullFailed).toBe(true);
    expect(fetch.impl).not.toHaveBeenCalled();
    expect(source.lastError).toBeDefined();
  });

  it("reports pullFailed and sets lastError on a non-ok pull status", async () => {
    const impl = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    }));
    const { deps } = makeDeps({ fetchImpl: impl as unknown as typeof fetch });
    const source = createPubSubSource(deps);

    const out = await source.pollOnce();

    expect(out.pullFailed).toBe(true);
    expect(typeof source.lastError).toBe("string");
  });

  it("evicts the oldest entry when the bounded seen-set exceeds seenSetMax", async () => {
    // seenSetMax=1: after m1 is seen, m2 evicts m1; a redelivery of m1 is then
    // re-dispatched (no longer deduped) because it was evicted from the set.
    const e1 = makeChatEvent("spaces/AAAA/messages/m1");
    const e2 = makeChatEvent("spaces/AAAA/messages/m2");
    const fetch = makeFetch([
      { receivedMessages: [{ ackId: "a1", message: { data: encodeEvent(e1) } }] },
      { receivedMessages: [{ ackId: "a2", message: { data: encodeEvent(e2) } }] },
      { receivedMessages: [{ ackId: "a3", message: { data: encodeEvent(e1) } }] },
    ]);
    const onEvent = vi.fn(async () => {});
    const { deps } = makeDeps({
      fetchImpl: fetch.fetchImpl,
      onEvent,
      seenSetMax: 1,
    });
    const source = createPubSubSource(deps);

    await source.pollOnce(); // m1 seen
    await source.pollOnce(); // m2 seen → evicts m1
    await source.pollOnce(); // m1 redelivered → re-dispatched (evicted)

    expect(onEvent).toHaveBeenCalledTimes(3);
  });
});

/** Drain the microtask queue so an awaited async loop can make progress. */
async function flushMicrotasks(n = 40): Promise<void> {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
}

/**
 * A deterministic timer seam. It CAPTURES each scheduled delay and parks the
 * callback (never firing on real time); `fireNext()` resolves the parked backoff
 * so the loop advances one cycle without any real wait. `cleared` records the
 * handles passed to the canceller so a stop()-cancels-backoff assertion can read
 * them. Mirrors the fake-timers `unrefRecord` intent for leak assertions.
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
  }) as unknown as PubSubSourceDeps["setTimeoutImpl"];
  const clearTimeoutImpl = ((handle: unknown) => {
    cleared.push(handle);
    pending = pending.filter((p) => p.id !== handle);
  }) as unknown as PubSubSourceDeps["clearTimeoutImpl"];
  async function fireNext(): Promise<void> {
    const next = pending.shift();
    if (!next) throw new Error("no pending backoff timer to fire");
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

/** A fetch that always fails with a retryable non-ok status. */
function failingFetch() {
  return vi.fn(async () => ({
    ok: false,
    status: 503,
    json: async () => ({}),
  })) as unknown as typeof fetch;
}

/** A failing fetch that captures the abort signal passed on each pull init. */
function capturingFailingFetch() {
  let signal: AbortSignal | undefined;
  const impl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    signal = init?.signal ?? undefined;
    return { ok: false, status: 503, json: async () => ({}) } as unknown as Response;
  });
  return { impl: impl as unknown as typeof fetch, getSignal: () => signal };
}

describe("createPubSubSource — bounded jittered backoff + AbortController stop + loud failure", () => {
  it("backs off within [floor, floor+500] after the first pull failure (jitter bounded)", async () => {
    const timers = makeFakeTimers();
    const { deps } = makeDeps({
      fetchImpl: failingFetch(),
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
      rng: () => 0.5,
      backoffFloorMs: 1000,
      backoffCapMs: 30_000,
    });
    const source = createPubSubSource(deps);

    source.start();
    await flushMicrotasks();

    expect(timers.delays.length).toBeGreaterThanOrEqual(1);
    expect(timers.delays[0]).toBe(1250); // 1000 + floor(0.5 * 500)
    expect(timers.delays[0]).toBeGreaterThanOrEqual(1000);
    expect(timers.delays[0]).toBeLessThanOrEqual(1500);

    await source.stop();
  });

  it("doubles the backoff base per consecutive failure and caps it at backoffCapMs", async () => {
    const timers = makeFakeTimers();
    const { deps } = makeDeps({
      fetchImpl: failingFetch(),
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
      rng: () => 0.5,
      backoffFloorMs: 1000,
      backoffCapMs: 30_000,
    });
    const source = createPubSubSource(deps);

    source.start();
    await flushMicrotasks(); // failure #1 → delays[0]
    for (let i = 0; i < 6; i += 1) await timers.fireNext(); // 6 more failures
    await source.stop();

    const bases = timers.delays.map((d) => d - 250); // strip the fixed 250 jitter
    expect(bases.slice(0, 7)).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000,
    ]);
  });

  it("resets the backoff to the floor after a successful pull", async () => {
    let call = 0;
    const impl = vi.fn(async () => {
      call += 1;
      if (call === 3) {
        return { ok: true, status: 200, json: async () => ({ receivedMessages: [] }) };
      }
      return { ok: false, status: 503, json: async () => ({}) };
    });
    const timers = makeFakeTimers();
    const { deps } = makeDeps({
      fetchImpl: impl as unknown as typeof fetch,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
      rng: () => 0.5,
      backoffFloorMs: 1000,
      backoffCapMs: 30_000,
    });
    const source = createPubSubSource(deps);

    source.start();
    await flushMicrotasks(); // #1 fail → 1250 (base 1000), backoff→2000
    await timers.fireNext(); // #2 fail → 2250 (base 2000), backoff→4000
    await timers.fireNext(); // #3 success → reset; #4 fail → 1250 (base 1000)
    await source.stop();

    expect(timers.delays[0]).toBe(1250);
    expect(timers.delays[1]).toBe(2250);
    expect(timers.delays[2]).toBe(1250); // floor again after the success
  });

  it("aborts the in-flight long-poll when stop() is called", async () => {
    let capturedSignal: AbortSignal | undefined;
    const impl = vi.fn((_url: unknown, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        capturedSignal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    });
    const timers = makeFakeTimers();
    const { deps } = makeDeps({
      fetchImpl: impl as unknown as typeof fetch,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    });
    const source = createPubSubSource(deps);

    source.start();
    await flushMicrotasks();
    expect(source.running).toBe(true);
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal?.aborted).toBe(false);

    await source.stop();

    expect(source.running).toBe(false);
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("cancels a pending backoff timer when stop() is called", async () => {
    const timers = makeFakeTimers();
    const { deps } = makeDeps({
      fetchImpl: failingFetch(),
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
      rng: () => 0.5,
    });
    const source = createPubSubSource(deps);

    source.start();
    await flushMicrotasks(); // fail → parked in a backoff sleep
    expect(timers.pendingCount()).toBe(1);

    await source.stop();

    expect(timers.cleared.length).toBeGreaterThanOrEqual(1);
    expect(timers.pendingCount()).toBe(0);
    expect(source.running).toBe(false);
  });

  it("logs a loud ERROR with errorKind and hint after errorLogThreshold consecutive failures and sets lastError", async () => {
    const timers = makeFakeTimers();
    const { deps, loggerSpy } = makeDeps({
      fetchImpl: failingFetch(),
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
      rng: () => 0.5,
      errorLogThreshold: 3,
    });
    const source = createPubSubSource(deps);

    source.start();
    await flushMicrotasks(); // failure #1
    await timers.fireNext(); // failure #2
    await timers.fireNext(); // failure #3 → loud ERROR
    await source.stop();

    const errCall = loggerSpy.error.mock.calls
      .map((c) => c[0])
      .find(
        (p) =>
          p !== null &&
          typeof p === "object" &&
          typeof (p as { hint?: unknown }).hint === "string" &&
          typeof (p as { errorKind?: unknown }).errorKind === "string",
      );
    expect(errCall).toBeDefined();
    expect(typeof source.lastError).toBe("string");
  });

  it("does not accumulate an abort listener per backoff cycle on the shared signal", async () => {
    const timers = makeFakeTimers();
    const fetchCap = capturingFailingFetch();
    const { deps } = makeDeps({
      fetchImpl: fetchCap.impl,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
      rng: () => 0.5,
    });
    const source = createPubSubSource(deps);

    source.start();
    await flushMicrotasks(); // fail #1 → parked in a backoff sleep
    for (let i = 0; i < 5; i += 1) await timers.fireNext(); // 5 more fail→park cycles

    const signal = fetchCap.getSignal();
    expect(signal).toBeInstanceOf(AbortSignal);
    // A normal timer completion must remove its abort listener, so only the
    // currently-parked sleep's single listener remains on the shared signal.
    // Pre-fix, one leaked per cycle (6 here) and accumulates toward Node's
    // MaxListenersExceededWarning over a long-lived failing loop.
    expect(
      getEventListeners(signal as AbortSignal, "abort").length,
    ).toBeLessThanOrEqual(1);

    await source.stop();
  });

  it("logs the loud ERROR once on the threshold crossing, not on every failing cycle past it", async () => {
    const timers = makeFakeTimers();
    const { deps, loggerSpy } = makeDeps({
      fetchImpl: failingFetch(),
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
      rng: () => 0.5,
      errorLogThreshold: 3,
    });
    const source = createPubSubSource(deps);

    source.start();
    await flushMicrotasks(); // failure #1
    for (let i = 0; i < 5; i += 1) await timers.fireNext(); // failures #2..#6
    await source.stop();

    // The threshold is crossed once (at #3); #4/#5/#6 must NOT re-emit the loud
    // ERROR — otherwise a dead loop floods one ERROR per 30s cap indefinitely.
    // lastError still reflects the ongoing failure for status degradation.
    expect(loggerSpy.error).toHaveBeenCalledTimes(1);
    expect(typeof source.lastError).toBe("string");
  });

  it("resets the consecutive-failure count after a good pull so the loud ERROR does not re-fire", async () => {
    let call = 0;
    const impl = vi.fn(async () => {
      call += 1;
      if (call === 4) {
        return { ok: true, status: 200, json: async () => ({ receivedMessages: [] }) };
      }
      return { ok: false, status: 503, json: async () => ({}) };
    });
    const timers = makeFakeTimers();
    const { deps, loggerSpy } = makeDeps({
      fetchImpl: impl as unknown as typeof fetch,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
      rng: () => 0.5,
      errorLogThreshold: 3,
    });
    const source = createPubSubSource(deps);

    source.start();
    await flushMicrotasks(); // #1 fail (count 1)
    await timers.fireNext(); // #2 fail (count 2)
    await timers.fireNext(); // #3 fail (count 3 → ERROR)
    await timers.fireNext(); // #4 success (reset); #5 fail (count 1)
    await source.stop();

    expect(loggerSpy.error).toHaveBeenCalledTimes(1);
  });
});
