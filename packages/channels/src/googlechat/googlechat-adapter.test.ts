// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import type { ComisLogger } from "@comis/core";
import { generateKeyPair, exportPKCS8 } from "jose";
import {
  createGoogleChatAdapter,
  type GoogleChatAdapterDeps,
} from "./googlechat-adapter.js";
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
  opts: { sendStatus?: number; sendName?: string; sendThrows?: boolean } = {},
) {
  const sendStatus = opts.sendStatus ?? 200;
  const sendName = opts.sendName ?? "spaces/AAAA/messages/CCC";
  const spy = vi.fn(async (url: string, _init?: RequestInit) => {
    if (String(url).includes("/messages")) {
      if (opts.sendThrows) throw new Error("connect ECONNREFUSED");
      return {
        ok: sendStatus >= 200 && sendStatus < 300,
        status: sendStatus,
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
      "editMessage",
      "deleteMessage",
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

  it("returns err classified network when the send transport rejects", async () => {
    const { fetchImpl } = makeChatFetch({ sendThrows: true });
    const { deps, loggerSpy } = await makeDeps({ fetchImpl });
    const adapter = createGoogleChatAdapter(deps);

    const result = await adapter.sendMessage("spaces/AAAA", "hi");

    expect(result.ok).toBe(false);
    expect(findByErrorKind(loggerSpy.error, "network")).toBeDefined();
  });

  it("does NOT bump lastInboundAt on an outbound send (bumps lastMessageAt only)", async () => {
    const { fetchImpl } = makeChatFetch();
    const { deps } = await makeDeps({ fetchImpl });
    const adapter = createGoogleChatAdapter(deps);

    await adapter.sendMessage("spaces/AAAA", "hello");

    expect(adapter.getStatus?.().lastInboundAt).toBeUndefined();
    expect(adapter.getStatus?.().lastMessageAt).toBe(NOW);
  });
});
