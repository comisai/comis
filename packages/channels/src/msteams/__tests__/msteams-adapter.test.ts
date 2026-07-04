// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import type {
  ComisLogger,
  ConversationReference,
  MessageHandler,
  MsTeamsConversationStorePort,
  NormalizedMessage,
  NormalizedReaction,
  ReactionHandler,
} from "@comis/core";
import { ok } from "@comis/shared";
import { createMsTeamsAdapter, type MsTeamsAdapterDeps } from "../msteams-adapter.js";
import { createMsTeamsPlugin } from "../msteams-plugin.js";
import type { TeamsActivity } from "../message-mapper.js";
import { MSTEAMS_APPROVAL_VERB } from "../msteams-actions.js";
import type { TeamsReactionActivity } from "../msteams-reaction-binder.js";
import { classifyMSTeamsError } from "../msteams-activity.js";
import { createFakeTimers } from "../../../../../test/support/fake-timers.js";

/** Resolve after the current microtask queue drains (lets fire-and-forget POSTs land). */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** A fake conversation store: capture records upserts; get returns the seeded reference. */
function makeFakeStore(getValue?: ConversationReference) {
  const capture = vi.fn(async () => ok<void, Error>(undefined));
  const get = vi.fn(async () => ok<ConversationReference | undefined, Error>(getValue));
  const store = { capture, get } as unknown as MsTeamsConversationStorePort;
  return { store, capture, get };
}

/** The Connector typing POSTs a spy recorded — the {type:"typing"} activity sends. */
function typingPosts(spy: ReturnType<typeof vi.fn>): Array<[string, RequestInit]> {
  return spy.mock.calls.filter(([u, init]) => {
    if (!String(u).includes("/activities")) return false;
    const raw = (init as RequestInit | undefined)?.body;
    if (typeof raw !== "string") return false;
    return (JSON.parse(raw) as { type?: string }).type === "typing";
  }) as Array<[string, RequestInit]>;
}

// A fixed clock so lastMessageAt / uptime / durationMs are deterministic.
const FIXED_NOW = 1_700_000_000_000;
const TENANT = "00000000-1111-2222-3333-444444444444";
const APP_PASSWORD = "super-secret-pw";

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

/**
 * A fetch stub covering BOTH boundary calls the outbound path makes: the token
 * mint (login endpoint) and the Connector send. Branches on the request URL.
 */
function makeConnectorFetch(
  opts: {
    sendStatus?: number;
    sentId?: string;
    token?: string;
    retryAfter?: string;
  } = {},
) {
  const sendStatus = opts.sendStatus ?? 200;
  const sentId = opts.sentId ?? "sent-1";
  const token = opts.token ?? "connector-access-token";
  const spy = vi.fn(async (url: string) => {
    if (String(url).includes("/oauth2/v2.0/token")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ access_token: token, expires_in: 3600 }),
      };
    }
    return {
      ok: sendStatus >= 200 && sendStatus < 300,
      status: sendStatus,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "retry-after" ? (opts.retryAfter ?? null) : null,
      },
      json: async () => ({ id: sentId }),
    };
  });
  return { fetchImpl: spy as unknown as typeof fetch, spy, token };
}

/** Find the Connector send call (the POST to the v3 conversations REST path). */
function findSendCall(spy: ReturnType<typeof vi.fn>): [string, RequestInit] | undefined {
  return spy.mock.calls.find(([u]) => String(u).includes("/v3/conversations/")) as
    | [string, RequestInit]
    | undefined;
}

/** Find the edit/delete call — the PUT/DELETE to a specific activity under the path. */
function findActivityCall(spy: ReturnType<typeof vi.fn>): [string, RequestInit] | undefined {
  return spy.mock.calls.find(([u]) => String(u).includes("/activities/")) as
    | [string, RequestInit]
    | undefined;
}

const SERVICE_URL = "https://smba.trafficmanager.net/teams/";

function makeAdapterDeps(overrides: Partial<MsTeamsAdapterDeps> = {}) {
  const loggerSpy = makeLoggerSpy();
  const deps: MsTeamsAdapterDeps = {
    appId: "app-client-id",
    appPassword: APP_PASSWORD,
    tenantId: TENANT,
    allowFrom: ["allowed-aad"],
    allowMode: "allowlist",
    logger: loggerSpy.logger,
    now: () => FIXED_NOW,
    ...overrides,
  };
  return { deps, loggerSpy };
}

/** A well-formed inbound Teams message activity (allowlisted sender by default). */
function messageActivity(overrides: Partial<TeamsActivity> = {}): TeamsActivity {
  return {
    type: "message",
    id: "teams-activity-1",
    text: "hello teams",
    conversation: {
      id: "19:channel-convo@thread.tacv2",
      conversationType: "channel",
      tenantId: TENANT,
    },
    from: { id: "29:user", aadObjectId: "allowed-aad", name: "User" },
    serviceUrl: "https://smba.example.com/teams/",
    ...overrides,
  };
}

/** The opaque signed callback string a rendered approval button carries. */
const CB = "v1.approve.Abc123Def456.QWERTYuiop123456";

/** A well-formed inbound card-action invoke (allowlisted clicker, rendered verb). */
function invokeActivity(overrides: Partial<TeamsActivity> = {}): TeamsActivity {
  return {
    type: "invoke",
    id: "invoke-activity-1",
    name: "adaptiveCard/action",
    conversation: {
      id: "19:channel-convo@thread.tacv2",
      conversationType: "channel",
      tenantId: TENANT,
    },
    from: { id: "29:user", aadObjectId: "allowed-aad", name: "User" },
    value: { action: { verb: MSTEAMS_APPROVAL_VERB, data: { cb: CB } } },
    ...overrides,
  };
}

describe("createMsTeamsAdapter — route-driven lifecycle (start/stop/getStatus)", () => {
  it("returns err with an auth ERROR when the appId is empty, opening no socket", async () => {
    const { deps, loggerSpy } = makeAdapterDeps({ appId: "" });
    const adapter = createMsTeamsAdapter(deps);
    const result = await adapter.start();
    expect(result.ok).toBe(false);
    expect(adapter.getStatus?.().connected).toBe(false);
    const authError = loggerSpy.error.mock.calls
      .map((c) => c[0])
      .find(
        (p) =>
          p !== null &&
          typeof p === "object" &&
          (p as { errorKind?: string }).errorKind === "auth",
      );
    expect(authError).toBeDefined();
  });

  it("returns err when the appPassword is empty", async () => {
    const { deps } = makeAdapterDeps({ appPassword: "   " });
    const adapter = createMsTeamsAdapter(deps);
    expect((await adapter.start()).ok).toBe(false);
  });

  it("returns err when the tenantId is empty", async () => {
    const { deps } = makeAdapterDeps({ tenantId: "" });
    const adapter = createMsTeamsAdapter(deps);
    expect((await adapter.start()).ok).toBe(false);
  });

  it("marks the adapter connected in webhook mode when all three credentials are present", async () => {
    const { deps } = makeAdapterDeps();
    const adapter = createMsTeamsAdapter(deps);
    const result = await adapter.start();
    expect(result.ok).toBe(true);
    const status = adapter.getStatus?.();
    expect(status?.connected).toBe(true);
    expect(status?.channelType).toBe("msteams");
    expect(status?.connectionMode).toBe("webhook");
    // Route-driven: liveness is unknown until an inbound arrives.
    expect(status?.lastMessageAt).toBeUndefined();
  });

  it("clears the connected flag on stop", async () => {
    const { deps } = makeAdapterDeps();
    const adapter = createMsTeamsAdapter(deps);
    await adapter.start();
    const stopped = await adapter.stop();
    expect(stopped.ok).toBe(true);
    expect(adapter.getStatus?.().connected).toBe(false);
  });

  it("exposes a stable channelId and channelType as adapter properties", () => {
    const { deps } = makeAdapterDeps();
    const adapter = createMsTeamsAdapter(deps);
    expect(adapter.channelType).toBe("msteams");
    expect(adapter.channelId).toBe("msteams");
    expect(adapter.getStatus?.().channelId).toBe("msteams");
  });

  it("returns a validation err with a WARN for an unsupported platform action", async () => {
    const { deps, loggerSpy } = makeAdapterDeps();
    const adapter = createMsTeamsAdapter(deps);
    const result = await adapter.platformAction("pin", { messageId: "x" });
    expect(result.ok).toBe(false);
    const validationWarn = loggerSpy.warn.mock.calls
      .map((c) => c[0])
      .find(
        (p) =>
          p !== null &&
          typeof p === "object" &&
          (p as { errorKind?: string }).errorKind === "validation",
      );
    expect(validationWarn).toBeDefined();
  });
});

describe("createMsTeamsAdapter — inbound handleWebhookEvents → processEvent fanout", () => {
  it("drives an allowlisted message activity into the registered onMessage handler", () => {
    const { deps, loggerSpy } = makeAdapterDeps();
    const adapter = createMsTeamsAdapter(deps);
    const handler = vi.fn<MessageHandler>();
    adapter.onMessage(handler);

    const before = adapter.getStatus?.().lastMessageAt;
    adapter.handleWebhookEvents([messageActivity()]);

    expect(handler).toHaveBeenCalledOnce();
    const delivered = handler.mock.calls[0]?.[0] as NormalizedMessage;
    expect(delivered.channelType).toBe("msteams");
    expect(delivered.senderId).toBe("allowed-aad");
    expect(delivered.text).toBe("hello teams");
    expect(typeof delivered.metadata.traceId).toBe("string");

    // lastMessageAt advances from undefined to the injected clock.
    expect(before).toBeUndefined();
    const after = adapter.getStatus?.().lastMessageAt;
    expect(typeof after).toBe("number");
    expect(after).toBe(FIXED_NOW);

    // An INFO inbound line carries the pipeline step, messageId and traceId.
    const inboundInfo = loggerSpy.info.mock.calls
      .map((c) => c[0])
      .find(
        (p) =>
          p !== null &&
          typeof p === "object" &&
          (p as { step?: string }).step === "channels-inbound",
      );
    expect(inboundInfo).toBeDefined();
    expect((inboundInfo as { messageId?: unknown }).messageId).toBe(delivered.id);
    expect(typeof (inboundInfo as { traceId?: unknown }).traceId).toBe("string");
  });

  it("processes a sender allowlisted by conversation.id even when the aadObjectId is unknown", () => {
    const { deps } = makeAdapterDeps({ allowFrom: ["19:channel-convo@thread.tacv2"] });
    const adapter = createMsTeamsAdapter(deps);
    const handler = vi.fn<MessageHandler>();
    adapter.onMessage(handler);
    adapter.handleWebhookEvents([
      messageActivity({ from: { id: "29:stranger", aadObjectId: "stranger-aad" } }),
    ]);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("drops a non-allowlisted sender with a precondition WARN and never fans out", () => {
    const { deps, loggerSpy } = makeAdapterDeps();
    const adapter = createMsTeamsAdapter(deps);
    const handler = vi.fn<MessageHandler>();
    adapter.onMessage(handler);

    adapter.handleWebhookEvents([
      messageActivity({ from: { id: "29:stranger", aadObjectId: "stranger-aad" } }),
    ]);

    expect(handler).not.toHaveBeenCalled();
    const dropWarn = loggerSpy.warn.mock.calls
      .map((c) => c[0])
      .find(
        (p) =>
          p !== null &&
          typeof p === "object" &&
          (p as { errorKind?: string }).errorKind === "precondition",
      );
    expect(dropWarn).toBeDefined();
    expect((dropWarn as { hint?: string }).hint).toContain("allowFrom");
  });

  it("processes any sender when allowMode is open", () => {
    const { deps } = makeAdapterDeps({ allowMode: "open", allowFrom: [] });
    const adapter = createMsTeamsAdapter(deps);
    const handler = vi.fn<MessageHandler>();
    adapter.onMessage(handler);
    adapter.handleWebhookEvents([
      messageActivity({ from: { id: "29:anyone", aadObjectId: "anyone-aad" } }),
    ]);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("skips a non-message activity (mapper returns null) without throwing or fanning out", () => {
    const { deps } = makeAdapterDeps();
    const adapter = createMsTeamsAdapter(deps);
    const handler = vi.fn<MessageHandler>();
    adapter.onMessage(handler);
    adapter.handleWebhookEvents([
      { type: "conversationUpdate", conversation: { id: "19:convo" } },
    ]);
    expect(handler).not.toHaveBeenCalled();
    expect(adapter.getStatus?.().lastMessageAt).toBeUndefined();
  });

  it("continues the batch when one activity throws, still delivering the valid one", () => {
    const { deps, loggerSpy } = makeAdapterDeps();
    const adapter = createMsTeamsAdapter(deps);
    const handler = vi.fn<MessageHandler>();
    adapter.onMessage(handler);

    // The first activity has no `conversation` — the mapper dereferences it and
    // throws; handleWebhookEvents must catch per-activity and process the next.
    const malformed = { type: "message", text: "boom" } as unknown as TeamsActivity;
    adapter.handleWebhookEvents([malformed, messageActivity()]);

    expect(handler).toHaveBeenCalledOnce();
    const internalError = loggerSpy.error.mock.calls
      .map((c) => c[0])
      .find(
        (p) =>
          p !== null &&
          typeof p === "object" &&
          (p as { errorKind?: string }).errorKind === "internal",
      );
    expect(internalError).toBeDefined();
  });

  it("fans an inbound message out to every registered handler", () => {
    const { deps } = makeAdapterDeps();
    const adapter = createMsTeamsAdapter(deps);
    const first = vi.fn<MessageHandler>();
    const second = vi.fn<MessageHandler>();
    adapter.onMessage(first);
    adapter.onMessage(second);
    adapter.handleWebhookEvents([messageActivity()]);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  it("logs an internal error when a handler throws synchronously and still runs the next handler", () => {
    const { deps, loggerSpy } = makeAdapterDeps();
    const adapter = createMsTeamsAdapter(deps);
    const throwing: MessageHandler = () => {
      throw new Error("sync handler boom");
    };
    const survivor = vi.fn<MessageHandler>();
    adapter.onMessage(throwing);
    adapter.onMessage(survivor);

    adapter.handleWebhookEvents([messageActivity()]);

    expect(survivor).toHaveBeenCalledOnce();
    const internalError = loggerSpy.error.mock.calls
      .map((c) => c[0])
      .find(
        (p) =>
          p !== null &&
          typeof p === "object" &&
          (p as { errorKind?: string }).errorKind === "internal",
      );
    expect(internalError).toBeDefined();
  });

  it("logs an internal error when a handler rejects asynchronously", async () => {
    const { deps, loggerSpy } = makeAdapterDeps();
    const adapter = createMsTeamsAdapter(deps);
    adapter.onMessage(() => Promise.reject(new Error("async handler boom")));

    adapter.handleWebhookEvents([messageActivity()]);
    // Let the rejection microtask settle so the .catch handler runs.
    await new Promise((resolve) => setImmediate(resolve));

    const internalError = loggerSpy.error.mock.calls
      .map((c) => c[0])
      .find(
        (p) =>
          p !== null &&
          typeof p === "object" &&
          (p as { errorKind?: string }).errorKind === "internal",
      );
    expect(internalError).toBeDefined();
  });
});

describe("createMsTeamsAdapter — card-action invoke routing + default-deny", () => {
  it("routes an allowlisted clicker's card-action invoke into onMessage as a button callback", () => {
    const { deps } = makeAdapterDeps();
    const adapter = createMsTeamsAdapter(deps);
    const handler = vi.fn<MessageHandler>();
    adapter.onMessage(handler);

    adapter.handleWebhookEvents([invokeActivity()]);

    // The invoke traverses processCardAction → the shared allowFrom gate → onMessage.
    expect(handler).toHaveBeenCalledOnce();
    const delivered = handler.mock.calls[0]![0] as NormalizedMessage;
    expect(delivered.channelType).toBe("msteams");
    // The clicker id is the VERIFIED directory id off the activity.
    expect(delivered.senderId).toBe("allowed-aad");
    // The inbound-gate button-intercept contract: isButtonCallback + callbackData.
    expect(delivered.metadata.isButtonCallback).toBe(true);
    expect(delivered.metadata.callbackData).toBe(CB);
    expect(typeof delivered.metadata.traceId).toBe("string");
  });

  it("drops a card-action invoke from a non-allowlisted clicker at the same allowFrom gate, never reaching onMessage (default-deny)", () => {
    const { deps, loggerSpy } = makeAdapterDeps();
    const adapter = createMsTeamsAdapter(deps);
    const handler = vi.fn<MessageHandler>();
    adapter.onMessage(handler);

    adapter.handleWebhookEvents([
      invokeActivity({ from: { id: "29:stranger", aadObjectId: "stranger-aad" } }),
    ]);

    expect(handler).not.toHaveBeenCalled();
    const dropWarn = loggerSpy.warn.mock.calls
      .map((c) => c[0])
      .find(
        (p) =>
          p !== null &&
          typeof p === "object" &&
          (p as { errorKind?: string }).errorKind === "precondition",
      );
    expect(dropWarn).toBeDefined();
    expect((dropWarn as { hint?: string }).hint).toContain("allowFrom");
  });

  it("still drops the unlisted clicker when the payload forges data.userId as the allowlisted id (gate keys on from.aadObjectId, not the payload)", () => {
    const { deps } = makeAdapterDeps();
    const adapter = createMsTeamsAdapter(deps);
    const handler = vi.fn<MessageHandler>();
    adapter.onMessage(handler);

    // A hostile clicker cannot self-authorize by claiming the allowlisted id in the
    // client-controllable card data — the gate reads the verified from.aadObjectId.
    const forged = invokeActivity({
      from: { id: "29:stranger", aadObjectId: "stranger-aad" },
    });
    const forgedData = forged.value!.action!.data! as Record<string, unknown>;
    forgedData.userId = "allowed-aad";
    adapter.handleWebhookEvents([forged]);

    expect(handler).not.toHaveBeenCalled();
  });

  it("drops a card-action invoke carrying a verb this bot never rendered (normalizeCardAction returns null)", () => {
    const { deps } = makeAdapterDeps();
    const adapter = createMsTeamsAdapter(deps);
    const handler = vi.fn<MessageHandler>();
    adapter.onMessage(handler);

    adapter.handleWebhookEvents([
      invokeActivity({
        value: { action: { verb: "comis.card.unknown", data: { cb: CB } } },
      }),
    ]);

    expect(handler).not.toHaveBeenCalled();
  });
});

/**
 * The security-relevant card-action rejects must be observable: a T-6
 * arbitrary-verb probe against the approval gate and a legitimately dropped
 * clicker are each logged with a distinct errorKind, mirroring the allowlist-drop
 * WARN, so they are diagnosable via comis explain / fleet rather than vanishing
 * silently. The benign "not our activity" drop stays silent (no WARN noise).
 */
describe("createMsTeamsAdapter — card-action reject-class observability", () => {
  /** Find the first logged fields object at any level carrying the given errorKind. */
  function warnWithKind(
    loggerSpy: ReturnType<typeof makeLoggerSpy>,
    kind: string,
  ): Record<string, unknown> | undefined {
    return loggerSpy.warn.mock.calls
      .map((c) => c[0])
      .find(
        (p) =>
          p !== null &&
          typeof p === "object" &&
          (p as { errorKind?: string }).errorKind === kind,
      ) as Record<string, unknown> | undefined;
  }

  it("emits a validation WARN when a card-action invoke carries an unrendered verb (T-6 probe)", () => {
    const { deps, loggerSpy } = makeAdapterDeps();
    const adapter = createMsTeamsAdapter(deps);
    const handler = vi.fn<MessageHandler>();
    adapter.onMessage(handler);

    adapter.handleWebhookEvents([
      invokeActivity({
        value: { action: { verb: "attacker.arbitrary.method", data: { cb: CB } } },
      }),
    ]);

    expect(handler).not.toHaveBeenCalled();
    const dropWarn = warnWithKind(loggerSpy, "validation");
    expect(dropWarn).toBeDefined();
    expect(typeof dropWarn!.hint).toBe("string");
    // The signed callback must never ride the drop log.
    expect(loggerSpy.serialized()).not.toContain(CB);
  });

  it("emits a validation WARN when a card-action invoke carries no signed callback", () => {
    const { deps, loggerSpy } = makeAdapterDeps();
    const adapter = createMsTeamsAdapter(deps);
    const handler = vi.fn<MessageHandler>();
    adapter.onMessage(handler);

    adapter.handleWebhookEvents([
      invokeActivity({ value: { action: { verb: MSTEAMS_APPROVAL_VERB, data: {} } } }),
    ]);

    expect(handler).not.toHaveBeenCalled();
    expect(warnWithKind(loggerSpy, "validation")).toBeDefined();
  });

  it("emits a precondition WARN when a card-action invoke has no verified aadObjectId (guest/federated clicker)", () => {
    const { deps, loggerSpy } = makeAdapterDeps();
    const adapter = createMsTeamsAdapter(deps);
    const handler = vi.fn<MessageHandler>();
    adapter.onMessage(handler);

    // A guest/federated context may not populate from.aadObjectId; the clicker
    // cannot be authorized, and the deliberate refusal must be diagnosable.
    adapter.handleWebhookEvents([invokeActivity({ from: { id: "29:guest-no-aad" } })]);

    expect(handler).not.toHaveBeenCalled();
    const dropWarn = warnWithKind(loggerSpy, "precondition");
    expect(dropWarn).toBeDefined();
    expect(typeof dropWarn!.hint).toBe("string");
  });

  it("stays silent (no WARN) for a benign non-card invoke that is not an approval action", () => {
    const { deps, loggerSpy } = makeAdapterDeps();
    const adapter = createMsTeamsAdapter(deps);
    adapter.onMessage(vi.fn());

    adapter.handleWebhookEvents([invokeActivity({ name: "task/fetch" })]);

    // A non-card invoke is not an approval action; dropping it must not add WARN
    // noise that would drown out a real T-6 probe in the logs.
    expect(loggerSpy.warn).not.toHaveBeenCalled();
  });
});

describe("createMsTeamsAdapter — outbound sendMessage via the Connector REST", () => {
  it("posts a DM top-level activity with a Bearer token and no replyToId", async () => {
    const { fetchImpl, spy, token } = makeConnectorFetch();
    const { deps } = makeAdapterDeps({ fetchImpl });
    const adapter = createMsTeamsAdapter(deps);

    const result = await adapter.sendMessage("19:dm-convo", "hi there", {
      extra: { serviceUrl: SERVICE_URL },
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("sent-1");

    const sendCall = findSendCall(spy);
    expect(sendCall).toBeDefined();
    const [url, init] = sendCall!;
    expect(url).toBe(
      `${SERVICE_URL}v3/conversations/${encodeURIComponent("19:dm-convo")}/activities`,
    );
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${token}`);
    expect(headers["content-type"]).toBe("application/json");
    const body = JSON.parse(String(init.body)) as {
      type: string;
      text: string;
      replyToId?: string;
    };
    expect(body.type).toBe("message");
    expect(body.text).toBe("hi there");
    expect(body.replyToId).toBeUndefined();
  });

  it("threads a channel/group reply by including replyToId in the activity body", async () => {
    const { fetchImpl, spy } = makeConnectorFetch();
    const { deps } = makeAdapterDeps({ fetchImpl });
    const adapter = createMsTeamsAdapter(deps);

    const result = await adapter.sendMessage(
      "19:channel-convo@thread.tacv2",
      "reply text",
      { replyTo: "parent-activity-id", extra: { serviceUrl: SERVICE_URL } },
    );

    expect(result.ok).toBe(true);
    const sendCall = findSendCall(spy);
    expect(sendCall).toBeDefined();
    const body = JSON.parse(String(sendCall![1].body)) as { replyToId?: string };
    expect(body.replyToId).toBe("parent-activity-id");
  });

  it("keeps a DM reply top-level even when a replyTo is supplied (chatType dm)", async () => {
    const { fetchImpl, spy } = makeConnectorFetch();
    const { deps } = makeAdapterDeps({ fetchImpl });
    const adapter = createMsTeamsAdapter(deps);

    // The delivery layer stamps a replyToId on every inbound; a DM must still be
    // sent top-level (Teams 1:1 chats have no thread), so the dm signal wins.
    const result = await adapter.sendMessage("19:dm-convo", "hi", {
      replyTo: "parent-activity-id",
      extra: { serviceUrl: SERVICE_URL, chatType: "dm" },
    });

    expect(result.ok).toBe(true);
    const body = JSON.parse(String(findSendCall(spy)![1].body)) as {
      replyToId?: string;
    };
    expect(body.replyToId).toBeUndefined();
  });

  it("threads a channel reply under the parent when chatType is channel", async () => {
    const { fetchImpl, spy } = makeConnectorFetch();
    const { deps } = makeAdapterDeps({ fetchImpl });
    const adapter = createMsTeamsAdapter(deps);

    const result = await adapter.sendMessage(
      "19:channel-convo@thread.tacv2",
      "hi",
      {
        replyTo: "parent-activity-id",
        extra: { serviceUrl: SERVICE_URL, chatType: "channel" },
      },
    );

    expect(result.ok).toBe(true);
    const body = JSON.parse(String(findSendCall(spy)![1].body)) as {
      replyToId?: string;
    };
    expect(body.replyToId).toBe("parent-activity-id");
  });

  it("logs an outbound INFO completion carrying durationMs on success", async () => {
    const { fetchImpl } = makeConnectorFetch();
    const { deps, loggerSpy } = makeAdapterDeps({ fetchImpl });
    const adapter = createMsTeamsAdapter(deps);
    await adapter.sendMessage("19:dm-convo", "hi", { extra: { serviceUrl: SERVICE_URL } });
    const outboundInfo = loggerSpy.info.mock.calls
      .map((c) => c[0])
      .find(
        (p) =>
          p !== null &&
          typeof p === "object" &&
          (p as { step?: string }).step === "channels-outbound",
      );
    expect(outboundInfo).toBeDefined();
    expect(typeof (outboundInfo as { durationMs?: unknown }).durationMs).toBe("number");
  });

  it("errs on a proactive send (no serviceUrl) when no conversation store is wired", async () => {
    // A bare send with no serviceUrl is a proactive send; without a store to
    // recover the tenant-correct serviceUrl it must err, never fall to a default
    // host that would 403 (or leak the token to the wrong region).
    const { fetchImpl, spy } = makeConnectorFetch();
    const { deps } = makeAdapterDeps({ fetchImpl });
    const adapter = createMsTeamsAdapter(deps);
    const result = await adapter.sendMessage("19:dm-convo", "hi");
    expect(result.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns a classified err and warns when the Connector responds non-2xx", async () => {
    const { fetchImpl } = makeConnectorFetch({ sendStatus: 500 });
    const { deps, loggerSpy } = makeAdapterDeps({ fetchImpl });
    const adapter = createMsTeamsAdapter(deps);

    const result = await adapter.sendMessage("19:dm-convo", "hi", {
      extra: { serviceUrl: SERVICE_URL },
    });

    expect(result.ok).toBe(false);
    const platformWarn = loggerSpy.warn.mock.calls
      .map((c) => c[0])
      .find(
        (p) =>
          p !== null &&
          typeof p === "object" &&
          (p as { errorKind?: string }).errorKind === "platform",
      );
    expect(platformWarn).toBeDefined();
    expect(typeof (platformWarn as { hint?: unknown }).hint).toBe("string");
  });

  it("returns err and warns as network when the Connector send rejects at the transport level", async () => {
    const spy = vi.fn(async (url: string) => {
      if (String(url).includes("/oauth2/v2.0/token")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: "tok", expires_in: 3600 }),
        };
      }
      throw new Error("connect ECONNREFUSED");
    });
    const { deps, loggerSpy } = makeAdapterDeps({
      fetchImpl: spy as unknown as typeof fetch,
    });
    const adapter = createMsTeamsAdapter(deps);

    const result = await adapter.sendMessage("19:dm-convo", "hi", {
      extra: { serviceUrl: SERVICE_URL },
    });

    expect(result.ok).toBe(false);
    const networkWarn = loggerSpy.warn.mock.calls
      .map((c) => c[0])
      .find(
        (p) =>
          p !== null &&
          typeof p === "object" &&
          (p as { errorKind?: string }).errorKind === "network",
      );
    expect(networkWarn).toBeDefined();
  });

  it("returns err when the Connector token cannot be minted", async () => {
    const spy = vi.fn(async (url: string) => {
      if (String(url).includes("/oauth2/v2.0/token")) {
        return { ok: false, status: 401, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({ id: "unexpected" }) };
    });
    const { deps } = makeAdapterDeps({ fetchImpl: spy as unknown as typeof fetch });
    const adapter = createMsTeamsAdapter(deps);

    const result = await adapter.sendMessage("19:dm-convo", "hi", {
      extra: { serviceUrl: SERVICE_URL },
    });

    expect(result.ok).toBe(false);
    // The send REST call must never fire once the token mint fails.
    expect(findSendCall(spy)).toBeUndefined();
  });

  it("rejects a path-traversal conversation id with a precondition err before any fetch", async () => {
    const { fetchImpl, spy } = makeConnectorFetch();
    const { deps, loggerSpy } = makeAdapterDeps({ fetchImpl });
    const adapter = createMsTeamsAdapter(deps);

    const result = await adapter.sendMessage("../evil", "hi", {
      extra: { serviceUrl: SERVICE_URL },
    });

    expect(result.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    const preconditionWarn = loggerSpy.warn.mock.calls
      .map((c) => c[0])
      .find(
        (p) =>
          p !== null &&
          typeof p === "object" &&
          (p as { errorKind?: string }).errorKind === "precondition",
      );
    expect(preconditionWarn).toBeDefined();
  });

  it("URL-encodes a standard-base64 conversation id containing '/' and still sends", async () => {
    const { fetchImpl, spy } = makeConnectorFetch();
    const { deps } = makeAdapterDeps({ fetchImpl });
    const adapter = createMsTeamsAdapter(deps);

    // A meeting-chat @thread.v2 id whose thread component is standard base64
    // carries '/', '+' and '=' — all legitimate, none allowed to split the path.
    const convoId = "19:aB/cD+eF=@thread.v2";
    const result = await adapter.sendMessage(convoId, "hi", {
      extra: { serviceUrl: SERVICE_URL },
    });

    expect(result.ok).toBe(true);
    const sendCall = findSendCall(spy);
    expect(sendCall).toBeDefined();
    const [url] = sendCall!;
    expect(url).toBe(
      `${SERVICE_URL}v3/conversations/${encodeURIComponent(convoId)}/activities`,
    );
    // The raw '/' must be percent-encoded so it cannot introduce a path segment.
    expect(url).not.toContain("aB/cD");
  });

  it("still rejects a '..'-escaping conversation id after relaxing the charset", async () => {
    const { fetchImpl, spy } = makeConnectorFetch();
    const { deps } = makeAdapterDeps({ fetchImpl });
    const adapter = createMsTeamsAdapter(deps);

    const result = await adapter.sendMessage("19:../../evil", "hi", {
      extra: { serviceUrl: SERVICE_URL },
    });

    expect(result.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects a non-https service URL with a precondition err before any fetch", async () => {
    const { fetchImpl, spy } = makeConnectorFetch();
    const { deps } = makeAdapterDeps({ fetchImpl });
    const adapter = createMsTeamsAdapter(deps);

    const result = await adapter.sendMessage("19:dm-convo", "hi", {
      extra: { serviceUrl: "http://insecure.example.com/teams/" },
    });

    expect(result.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects a serviceUrl outside the Bot Framework host allowlist, never sending the token", async () => {
    const { fetchImpl, spy } = makeConnectorFetch();
    const { deps } = makeAdapterDeps({ fetchImpl });
    const adapter = createMsTeamsAdapter(deps);

    // A validly-signed inbound could carry a hostile serviceUrl; the freshly
    // minted Connector bearer token must never be transmitted to it.
    const result = await adapter.sendMessage("19:dm-convo", "hi", {
      extra: { serviceUrl: "https://attacker.example/" },
    });

    expect(result.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("accepts a legitimate Bot Framework service host", async () => {
    const { fetchImpl, spy } = makeConnectorFetch();
    const { deps } = makeAdapterDeps({ fetchImpl });
    const adapter = createMsTeamsAdapter(deps);

    const result = await adapter.sendMessage("19:dm-convo", "hi", {
      extra: { serviceUrl: "https://smba.trafficmanager.net/amer/" },
    });

    expect(result.ok).toBe(true);
    const sendCall = findSendCall(spy);
    expect(sendCall).toBeDefined();
    expect(sendCall![0].startsWith("https://smba.trafficmanager.net/amer/")).toBe(
      true,
    );
  });

  it("never logs the Connector bearer token on the outbound path", async () => {
    const { fetchImpl, token } = makeConnectorFetch();
    const { deps, loggerSpy } = makeAdapterDeps({ fetchImpl });
    const adapter = createMsTeamsAdapter(deps);
    await adapter.sendMessage("19:dm-convo", "hi", {
      extra: { serviceUrl: SERVICE_URL },
    });
    expect(loggerSpy.serialized()).not.toContain(token);
  });

  it("attaches one Adaptive Card carrying an Action.Execute when options.buttons are present", async () => {
    const { fetchImpl, spy } = makeConnectorFetch();
    const { deps } = makeAdapterDeps({ fetchImpl });
    const adapter = createMsTeamsAdapter(deps);

    // An approval frame ships its signed buttons: the outbound body must carry ONE
    // Adaptive Card attachment whose first action is the interactive Action.Execute.
    const result = await adapter.sendMessage("19:dm-convo", "approval required: bash", {
      extra: { serviceUrl: SERVICE_URL },
      buttons: [[{ text: "Approve", callback_data: CB, style: "primary" }]],
    });

    expect(result.ok).toBe(true);
    const body = JSON.parse(String(findSendCall(spy)![1].body)) as {
      type: string;
      text: string;
      attachments?: Array<{
        contentType: string;
        content: { actions: Array<{ type: string }> };
      }>;
    };
    expect(body.attachments).toBeDefined();
    expect(body.attachments!.length).toBe(1);
    expect(body.attachments![0]!.contentType).toBe(
      "application/vnd.microsoft.card.adaptive",
    );
    expect(body.attachments![0]!.content.actions[0]!.type).toBe("Action.Execute");
  });

  it("omits the attachments key for a plain text send, leaving the body byte-identical", async () => {
    const { fetchImpl, spy } = makeConnectorFetch();
    const { deps } = makeAdapterDeps({ fetchImpl });
    const adapter = createMsTeamsAdapter(deps);

    // No buttons and no cards: the body stays the bare { type, text } shape with no
    // attachments key, so a non-approval send is unaffected by the card path.
    const result = await adapter.sendMessage("19:dm-convo", "plain text", {
      extra: { serviceUrl: SERVICE_URL },
    });

    expect(result.ok).toBe(true);
    const body = JSON.parse(String(findSendCall(spy)![1].body)) as Record<
      string,
      unknown
    >;
    expect("attachments" in body).toBe(false);
    expect(body).toEqual({ type: "message", text: "plain text" });
  });
});

describe("createMsTeamsAdapter — outbound sendAttachment (base64-inline image) via the Connector REST", () => {
  /** A disk-free byte source: readFileImpl returns the given bytes as a Buffer. */
  const readingBytes = (bytes = "PNGBYTES") => vi.fn(async () => Buffer.from(bytes));

  it("posts a base64 data-URI image top-level in a DM with no replyToId", async () => {
    const { fetchImpl, spy } = makeConnectorFetch();
    const { deps } = makeAdapterDeps({ fetchImpl, readFileImpl: readingBytes() });
    const adapter = createMsTeamsAdapter(deps);

    const result = await adapter.sendAttachment!(
      "19:dm-convo",
      { type: "image", url: "/tmp/x.png", mimeType: "image/png", fileName: "x.png", caption: "hi" },
      { extra: { serviceUrl: SERVICE_URL, chatType: "dm" } },
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("sent-1");

    const sendCall = findSendCall(spy);
    expect(sendCall).toBeDefined();
    const [url, init] = sendCall!;
    expect(url).toBe(
      `${SERVICE_URL}v3/conversations/${encodeURIComponent("19:dm-convo")}/activities`,
    );
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    const body = JSON.parse(String(init.body)) as {
      type: string;
      text?: string;
      replyToId?: string;
      attachments: Array<{ contentType: string; contentUrl: string; name?: string }>;
    };
    expect(body.type).toBe("message");
    expect(body.text).toBe("hi");
    // A DM is always sent top-level: no replyToId even though inbound stamps one.
    expect(body.replyToId).toBeUndefined();
    expect(body.attachments.length).toBe(1);
    expect(body.attachments[0]!.contentType).toBe("image/png");
    expect(body.attachments[0]!.contentUrl).toBe(
      `data:image/png;base64,${Buffer.from("PNGBYTES").toString("base64")}`,
    );
    expect(body.attachments[0]!.name).toBe("x.png");
  });

  it("threads a channel attachment reply by including replyToId in the activity body", async () => {
    const { fetchImpl, spy } = makeConnectorFetch();
    const { deps } = makeAdapterDeps({ fetchImpl, readFileImpl: readingBytes() });
    const adapter = createMsTeamsAdapter(deps);

    const result = await adapter.sendAttachment!(
      "19:channel-convo@thread.tacv2",
      { type: "image", url: "/tmp/x.png", mimeType: "image/png" },
      { replyTo: "parent-activity-id", extra: { serviceUrl: SERVICE_URL, chatType: "channel" } },
    );

    expect(result.ok).toBe(true);
    const body = JSON.parse(String(findSendCall(spy)![1].body)) as { replyToId?: string };
    expect(body.replyToId).toBe("parent-activity-id");
  });

  it("keeps a DM attachment top-level even when a replyTo is supplied (chatType dm)", async () => {
    const { fetchImpl, spy } = makeConnectorFetch();
    const { deps } = makeAdapterDeps({ fetchImpl, readFileImpl: readingBytes() });
    const adapter = createMsTeamsAdapter(deps);

    const result = await adapter.sendAttachment!(
      "19:dm-convo",
      { type: "image", url: "/tmp/x.png", mimeType: "image/png" },
      { replyTo: "parent-activity-id", extra: { serviceUrl: SERVICE_URL, chatType: "dm" } },
    );

    expect(result.ok).toBe(true);
    const body = JSON.parse(String(findSendCall(spy)![1].body)) as { replyToId?: string };
    expect(body.replyToId).toBeUndefined();
  });

  it("defaults the attachment contentType to image/png and omits text/name when unspecified", async () => {
    const { fetchImpl, spy } = makeConnectorFetch();
    const { deps } = makeAdapterDeps({ fetchImpl, readFileImpl: readingBytes() });
    const adapter = createMsTeamsAdapter(deps);

    const result = await adapter.sendAttachment!(
      "19:dm-convo",
      { type: "image", url: "/tmp/x" },
      { extra: { serviceUrl: SERVICE_URL, chatType: "dm" } },
    );

    expect(result.ok).toBe(true);
    const body = JSON.parse(String(findSendCall(spy)![1].body)) as {
      text?: string;
      attachments: Array<{ contentType: string; contentUrl: string; name?: string }>;
    };
    expect(body.attachments[0]!.contentType).toBe("image/png");
    expect(body.attachments[0]!.contentUrl.startsWith("data:image/png;base64,")).toBe(true);
    // No caption → no text key; no fileName → no name key.
    expect(body.text).toBeUndefined();
    expect(body.attachments[0]!.name).toBeUndefined();
  });

  it("rejects a path-traversal conversation id on the attachment path before any Connector fetch", async () => {
    const { fetchImpl, spy } = makeConnectorFetch();
    const { deps, loggerSpy } = makeAdapterDeps({ fetchImpl, readFileImpl: readingBytes() });
    const adapter = createMsTeamsAdapter(deps);

    const result = await adapter.sendAttachment!(
      "../evil",
      { type: "image", url: "/tmp/x.png", mimeType: "image/png" },
      { extra: { serviceUrl: SERVICE_URL } },
    );

    expect(result.ok).toBe(false);
    // Neither the token mint nor the send POST may fire for an unsafe id.
    expect(spy).not.toHaveBeenCalled();
    const preconditionWarn = loggerSpy.warn.mock.calls
      .map((c) => c[0])
      .find(
        (p) =>
          p !== null &&
          typeof p === "object" &&
          (p as { errorKind?: string }).errorKind === "precondition",
      );
    expect(preconditionWarn).toBeDefined();
  });

  it("rejects a non-Bot-Framework serviceUrl on the attachment path, never minting the token", async () => {
    const { fetchImpl, spy } = makeConnectorFetch();
    const { deps } = makeAdapterDeps({ fetchImpl, readFileImpl: readingBytes() });
    const adapter = createMsTeamsAdapter(deps);

    const result = await adapter.sendAttachment!(
      "19:dm-convo",
      { type: "image", url: "/tmp/x.png", mimeType: "image/png" },
      { extra: { serviceUrl: "https://attacker.example/" } },
    );

    expect(result.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns a classified platform err and warns when the Connector rejects the attachment non-2xx", async () => {
    const { fetchImpl } = makeConnectorFetch({ sendStatus: 500 });
    const { deps, loggerSpy } = makeAdapterDeps({ fetchImpl, readFileImpl: readingBytes() });
    const adapter = createMsTeamsAdapter(deps);

    const result = await adapter.sendAttachment!(
      "19:dm-convo",
      { type: "image", url: "/tmp/x.png", mimeType: "image/png" },
      { extra: { serviceUrl: SERVICE_URL, chatType: "dm" } },
    );

    expect(result.ok).toBe(false);
    const platformWarn = loggerSpy.warn.mock.calls
      .map((c) => c[0])
      .find(
        (p) =>
          p !== null &&
          typeof p === "object" &&
          (p as { errorKind?: string }).errorKind === "platform",
      );
    expect(platformWarn).toBeDefined();
    expect(typeof (platformWarn as { hint?: unknown }).hint).toBe("string");
  });

  it("returns a resource err and warns when the attachment bytes cannot be read, never posting", async () => {
    const { fetchImpl, spy } = makeConnectorFetch();
    const failingRead = vi.fn(async () => {
      throw new Error("ENOENT: temp file missing");
    });
    const { deps, loggerSpy } = makeAdapterDeps({ fetchImpl, readFileImpl: failingRead });
    const adapter = createMsTeamsAdapter(deps);

    const result = await adapter.sendAttachment!(
      "19:dm-convo",
      { type: "image", url: "/tmp/missing.png", mimeType: "image/png" },
      { extra: { serviceUrl: SERVICE_URL, chatType: "dm" } },
    );

    expect(result.ok).toBe(false);
    // The connector POST must never fire when the bytes are unreadable.
    expect(findSendCall(spy)).toBeUndefined();
    const resourceWarn = loggerSpy.warn.mock.calls
      .map((c) => c[0])
      .find(
        (p) =>
          p !== null &&
          typeof p === "object" &&
          (p as { errorKind?: string }).errorKind === "resource",
      );
    expect(resourceWarn).toBeDefined();
  });

  it("never logs the Connector bearer token or the base64 data URI on the attachment path", async () => {
    const { fetchImpl, spy, token } = makeConnectorFetch();
    const secretBytes = "SECRET-PIXELS-DO-NOT-LOG";
    const { deps, loggerSpy } = makeAdapterDeps({
      fetchImpl,
      readFileImpl: readingBytes(secretBytes),
    });
    const adapter = createMsTeamsAdapter(deps);

    await adapter.sendAttachment!(
      "19:dm-convo",
      { type: "image", url: "/tmp/x.png", mimeType: "image/png", caption: "look" },
      { extra: { serviceUrl: SERVICE_URL, chatType: "dm" } },
    );

    // Sanity: the base64 payload really did ride the POST body.
    const b64 = Buffer.from(secretBytes).toString("base64");
    expect(String(findSendCall(spy)![1].body)).toContain(b64);
    // …but neither the token nor the base64 payload may appear in any log field (T-5).
    expect(loggerSpy.serialized()).not.toContain(token);
    expect(loggerSpy.serialized()).not.toContain(b64);
  });

  it("logs an outbound INFO completion carrying durationMs on a successful attachment send", async () => {
    const { fetchImpl } = makeConnectorFetch();
    const { deps, loggerSpy } = makeAdapterDeps({ fetchImpl, readFileImpl: readingBytes() });
    const adapter = createMsTeamsAdapter(deps);

    await adapter.sendAttachment!(
      "19:dm-convo",
      { type: "image", url: "/tmp/x.png", mimeType: "image/png" },
      { extra: { serviceUrl: SERVICE_URL, chatType: "dm" } },
    );

    const outboundInfo = loggerSpy.info.mock.calls
      .map((c) => c[0])
      .find(
        (p) =>
          p !== null &&
          typeof p === "object" &&
          (p as { step?: string }).step === "channels-outbound",
      );
    expect(outboundInfo).toBeDefined();
    expect(typeof (outboundInfo as { durationMs?: unknown }).durationMs).toBe("number");
  });

  it("delegates getConnectorToken to the cached Connector token provider", async () => {
    const { fetchImpl, token } = makeConnectorFetch();
    const { deps } = makeAdapterDeps({ fetchImpl });
    const adapter = createMsTeamsAdapter(deps);

    const result = await adapter.getConnectorToken();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(token);
  });
});

/** A shape-valid Bot Framework bot id (`28:<guid>`) — mentionable. */
const MENTIONABLE_BOT_ID = "28:6f2c8e1a-1b2c-3d4e-5f6a-7b8c9d0e1f2a";

/** A well-formed inbound Teams messageReaction activity (allowlisted reactor). */
function reactionActivity(overrides: Partial<TeamsReactionActivity> = {}): TeamsReactionActivity {
  return {
    type: "messageReaction",
    id: "reacted-activity",
    conversation: {
      id: "19:channel-convo@thread.tacv2",
      conversationType: "channel",
      tenantId: TENANT,
    },
    from: { id: "29:user", aadObjectId: "allowed-aad", name: "User" },
    replyToId: "parent-msg-id",
    reactionsAdded: [{ type: "like" }],
    serviceUrl: "https://smba.example.com/teams/",
    ...overrides,
  };
}

describe("createMsTeamsAdapter — inbound reaction fanout (onReaction)", () => {
  it("fans an inbound messageReaction out to the registered onReaction handler", () => {
    const { deps } = makeAdapterDeps();
    const adapter = createMsTeamsAdapter(deps);
    const handler = vi.fn<ReactionHandler>();
    expect(adapter.onReaction).toBeInstanceOf(Function);
    adapter.onReaction!(handler);

    adapter.handleWebhookEvents([reactionActivity()]);

    expect(handler).toHaveBeenCalledOnce();
    const reaction = handler.mock.calls[0]![0] as NormalizedReaction;
    expect(reaction.channelType).toBe("msteams");
    expect(reaction.emoji).toBe("\u{1F44D}");
    expect(reaction.reactorId).toBe("allowed-aad");
    expect(reaction.messageId).toBe("parent-msg-id");
  });

  it("does NOT invoke reaction handlers for a non-reaction message activity", () => {
    const { deps } = makeAdapterDeps();
    const adapter = createMsTeamsAdapter(deps);
    const onMsg = vi.fn<MessageHandler>();
    const onReact = vi.fn<ReactionHandler>();
    adapter.onMessage(onMsg);
    adapter.onReaction!(onReact);

    adapter.handleWebhookEvents([messageActivity()]);

    expect(onMsg).toHaveBeenCalledOnce();
    expect(onReact).not.toHaveBeenCalled();
  });

  it("drops a reaction from a non-allowlisted reactor and never fans out", () => {
    const { deps } = makeAdapterDeps();
    const adapter = createMsTeamsAdapter(deps);
    const handler = vi.fn<ReactionHandler>();
    adapter.onReaction!(handler);
    adapter.handleWebhookEvents([
      reactionActivity({ from: { id: "29:stranger", aadObjectId: "stranger-aad" } }),
    ]);
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not crash the fanout loop when a reaction handler throws or rejects", async () => {
    const { deps, loggerSpy } = makeAdapterDeps();
    const adapter = createMsTeamsAdapter(deps);
    adapter.onReaction!(() => {
      throw new Error("sync reaction boom");
    });
    adapter.onReaction!(() => Promise.reject(new Error("async reaction boom")));
    const survivor = vi.fn<ReactionHandler>();
    adapter.onReaction!(survivor);

    adapter.handleWebhookEvents([reactionActivity()]);
    await flush();

    expect(survivor).toHaveBeenCalledOnce();
    const internalError = loggerSpy.error.mock.calls
      .map((c) => c[0])
      .find(
        (p) =>
          p !== null &&
          typeof p === "object" &&
          (p as { errorKind?: string }).errorKind === "internal",
      );
    expect(internalError).toBeDefined();
  });
});

describe("createMsTeamsAdapter — typing keepalive over the injected TimerPort", () => {
  it("POSTs a typing activity on sendTyping and refreshes it on the fake timer", async () => {
    const timer = createFakeTimers();
    const { fetchImpl, spy } = makeConnectorFetch();
    const { deps } = makeAdapterDeps({ fetchImpl, timer });
    const adapter = createMsTeamsAdapter(deps);

    await adapter.platformAction("sendTyping", {
      chatId: "19:convo",
      serviceUrl: SERVICE_URL,
    });
    await flush();
    expect(typingPosts(spy).length).toBe(1);

    timer.advance(8_000);
    await flush();
    timer.advance(8_000);
    await flush();
    expect(typingPosts(spy).length).toBeGreaterThan(1);
  });

  it("cancels the keepalive on stopTyping so no further typing posts fire", async () => {
    const timer = createFakeTimers();
    const { fetchImpl, spy } = makeConnectorFetch();
    const { deps } = makeAdapterDeps({ fetchImpl, timer });
    const adapter = createMsTeamsAdapter(deps);

    await adapter.platformAction("sendTyping", { chatId: "19:convo", serviceUrl: SERVICE_URL });
    await flush();
    await adapter.platformAction("stopTyping", { chatId: "19:convo" });
    const before = typingPosts(spy).length;

    timer.advance(8_000 * 5);
    await flush();
    expect(typingPosts(spy).length).toBe(before);
  });

  it("caps the keepalive refresh so it stops rearming long after the turn (TTL backstop)", async () => {
    const timer = createFakeTimers();
    const { fetchImpl } = makeConnectorFetch();
    const { deps } = makeAdapterDeps({ fetchImpl, timer });
    const adapter = createMsTeamsAdapter(deps);

    await adapter.platformAction("sendTyping", { chatId: "19:convo", serviceUrl: SERVICE_URL });
    // Advance well past any plausible TTL, twice — a bounded keepalive stops
    // rearming, so the scheduled-timer count is identical across the two sweeps.
    timer.advance(24 * 60 * 60 * 1000);
    const c1 = timer.unrefRecord().filter((e) => e.kind === "timeout").length;
    timer.advance(24 * 60 * 60 * 1000);
    const c2 = timer.unrefRecord().filter((e) => e.kind === "timeout").length;
    expect(c1).toBeGreaterThan(1); // it did refresh repeatedly
    expect(c2).toBe(c1); // …but capped: no further rearming
  });

  it("does not start the keepalive when the streaming suppression flag is set", async () => {
    const timer = createFakeTimers();
    const { fetchImpl, spy } = makeConnectorFetch();
    const { deps } = makeAdapterDeps({ fetchImpl, timer });
    const adapter = createMsTeamsAdapter(deps);

    const result = await adapter.platformAction("sendTyping", {
      chatId: "19:convo",
      serviceUrl: SERVICE_URL,
      streaming: true,
    });
    await flush();

    expect(result.ok).toBe(true);
    expect(typingPosts(spy).length).toBe(0);
    expect(timer.unrefRecord().length).toBe(0);
  });

  it("is a no-op (no POST) when no TimerPort is injected", async () => {
    const { fetchImpl, spy } = makeConnectorFetch();
    const { deps } = makeAdapterDeps({ fetchImpl }); // no timer
    const adapter = createMsTeamsAdapter(deps);

    const result = await adapter.platformAction("sendTyping", {
      chatId: "19:convo",
      serviceUrl: SERVICE_URL,
    });
    await flush();

    expect(result.ok).toBe(true);
    expect(typingPosts(spy).length).toBe(0);
  });

  it("still returns a validation err for an unrelated unsupported action", async () => {
    const timer = createFakeTimers();
    const { deps } = makeAdapterDeps({ timer });
    const adapter = createMsTeamsAdapter(deps);
    const result = await adapter.platformAction("pin", { messageId: "x" });
    expect(result.ok).toBe(false);
  });
});

describe("createMsTeamsAdapter — conversation-reference capture", () => {
  it("captures the reference keyed by the stripped channelId (tenant from channelData) on a successful inbound", async () => {
    const { store, capture } = makeFakeStore();
    const { deps } = makeAdapterDeps({ conversationStore: store });
    const adapter = createMsTeamsAdapter(deps);
    adapter.onMessage(vi.fn());

    adapter.handleWebhookEvents([
      messageActivity({
        conversation: {
          id: "19:channel-convo@thread.tacv2;messageid=1700",
          conversationType: "channel",
          tenantId: TENANT,
        },
        channelData: { tenant: { id: "tenant-from-channeldata" } },
        serviceUrl: "https://smba.example.com/teams/",
      }),
    ]);
    await flush();

    expect(capture).toHaveBeenCalledOnce();
    const ref = capture.mock.calls[0]![0] as ConversationReference;
    // The key is the STRIPPED channelId (the ;messageid= suffix is the thread root,
    // captured separately as threadId) — it MUST equal the normalized channelId a
    // proactive send targets, or the store.get() misses on a threaded reference.
    expect(ref.conversationId).toBe("19:channel-convo@thread.tacv2");
    expect(ref.serviceUrl).toBe("https://smba.example.com/teams/");
    // channelData.tenant.id wins over conversation.tenantId.
    expect(ref.tenantId).toBe("tenant-from-channeldata");
    expect(ref.threadId).toBe("1700");
    expect(typeof ref.updatedAt).toBe("number");
  });

  it("keys capture by the SAME stripped id a later proactive send targets, so the get() hits", async () => {
    // End-to-end: an inbound channel reply carries a conversation.id WITH a
    // ;messageid= suffix, but the normalized channelId a session — and thus a
    // later proactive cron/heartbeat send — targets is the STRIPPED base id.
    // Capture must key by that same stripped id; otherwise the proactive get()
    // misses and the routing tuple cannot be recovered for a threaded reference.
    const stored = new Map<string, ConversationReference>();
    const store = {
      capture: vi.fn(async (ref: ConversationReference) => {
        stored.set(ref.conversationId, ref);
        return ok<void, Error>(undefined);
      }),
      get: vi.fn(async (id: string) =>
        ok<ConversationReference | undefined, Error>(stored.get(id)),
      ),
    } as unknown as MsTeamsConversationStorePort;

    const { fetchImpl, spy } = makeConnectorFetch();
    const { deps } = makeAdapterDeps({ fetchImpl, conversationStore: store });
    const adapter = createMsTeamsAdapter(deps);
    const captured: NormalizedMessage[] = [];
    adapter.onMessage((m) => {
      captured.push(m);
    });

    adapter.handleWebhookEvents([
      messageActivity({
        conversation: {
          id: "19:channel-convo@thread.tacv2;messageid=1700",
          conversationType: "channel",
          tenantId: TENANT,
        },
        serviceUrl: "https://smba.trafficmanager.net/teams/",
      }),
    ]);
    await flush();

    // The session/delivery layer targets the STRIPPED channelId.
    const target = captured[0]!.channelId;
    expect(target).toBe("19:channel-convo@thread.tacv2");

    // A proactive send to that stripped id must recover the captured reference and
    // thread under the captured thread root (the ;messageid= value).
    const result = await adapter.sendMessage(target, "cron notice", {});
    expect(result.ok).toBe(true);
    expect(store.get).toHaveBeenCalledWith("19:channel-convo@thread.tacv2");
    const body = JSON.parse(String(findSendCall(spy)![1].body)) as { replyToId?: string };
    expect(body.replyToId).toBe("1700");
  });

  it("falls back to conversation.tenantId when channelData carries no tenant", async () => {
    const { store, capture } = makeFakeStore();
    const { deps } = makeAdapterDeps({ conversationStore: store });
    const adapter = createMsTeamsAdapter(deps);
    adapter.onMessage(vi.fn());
    adapter.handleWebhookEvents([
      messageActivity({
        conversation: { id: "19:dm", conversationType: "personal", tenantId: TENANT },
        serviceUrl: "https://smba.example.com/teams/",
      }),
    ]);
    await flush();
    expect((capture.mock.calls[0]![0] as ConversationReference).tenantId).toBe(TENANT);
  });

  it("does not capture when the inbound carries no serviceUrl (cannot route a proactive send)", async () => {
    const { store, capture } = makeFakeStore();
    const { deps } = makeAdapterDeps({ conversationStore: store });
    const adapter = createMsTeamsAdapter(deps);
    adapter.onMessage(vi.fn());
    adapter.handleWebhookEvents([messageActivity({ serviceUrl: undefined })]);
    await flush();
    expect(capture).not.toHaveBeenCalled();
  });

  it("does not break inbound delivery when the store capture rejects", async () => {
    const capture = vi.fn(async () => {
      throw new Error("store write failed");
    });
    const get = vi.fn(async () => ok<ConversationReference | undefined, Error>(undefined));
    const store = { capture, get } as unknown as MsTeamsConversationStorePort;
    const { deps } = makeAdapterDeps({ conversationStore: store });
    const adapter = createMsTeamsAdapter(deps);
    const handler = vi.fn<MessageHandler>();
    adapter.onMessage(handler);
    adapter.handleWebhookEvents([messageActivity()]);
    await flush();
    expect(handler).toHaveBeenCalledOnce();
  });

  it("refreshes the reference on an inbound reaction (every inbound activity keeps it fresh)", async () => {
    const { store, capture } = makeFakeStore();
    const { deps } = makeAdapterDeps({ conversationStore: store });
    const adapter = createMsTeamsAdapter(deps);
    adapter.onReaction!(vi.fn());

    adapter.handleWebhookEvents([reactionActivity()]);
    await flush();

    expect(capture).toHaveBeenCalledOnce();
    const ref = capture.mock.calls[0]![0] as ConversationReference;
    // Same stripped channelId a message capture / proactive send targets.
    expect(ref.conversationId).toBe("19:channel-convo@thread.tacv2");
    expect(ref.serviceUrl).toBe("https://smba.example.com/teams/");
    expect(ref.tenantId).toBe(TENANT);
    // Thread root resolved identically to the message path (extractThreadRoot →
    // replyToId when the conversation id carries no ;messageid= suffix), so a
    // reaction refresh never clobbers a message capture's stored thread root.
    expect(ref.threadId).toBe("parent-msg-id");
    expect(typeof ref.updatedAt).toBe("number");
  });

  it("does not capture on a reaction from a non-allowlisted reactor", async () => {
    const { store, capture } = makeFakeStore();
    const { deps } = makeAdapterDeps({ conversationStore: store });
    const adapter = createMsTeamsAdapter(deps);
    adapter.onReaction!(vi.fn());
    adapter.handleWebhookEvents([
      reactionActivity({ from: { id: "29:stranger", aadObjectId: "stranger-aad" } }),
    ]);
    await flush();
    expect(capture).not.toHaveBeenCalled();
  });
});

describe("createMsTeamsAdapter — proactive store-fallback send", () => {
  const storedRef: ConversationReference = {
    conversationId: "19:dm-convo",
    serviceUrl: "https://smba.trafficmanager.net/emea/",
    tenantId: "tenant-1",
    threadId: undefined,
    updatedAt: FIXED_NOW,
  };

  it("recovers the stored serviceUrl for a proactive send when the caller supplies none", async () => {
    const { store, get } = makeFakeStore(storedRef);
    const { fetchImpl, spy } = makeConnectorFetch();
    const { deps } = makeAdapterDeps({ fetchImpl, conversationStore: store });
    const adapter = createMsTeamsAdapter(deps);

    const result = await adapter.sendMessage("19:dm-convo", "proactive hi", {});

    expect(result.ok).toBe(true);
    expect(get).toHaveBeenCalledWith("19:dm-convo");
    const [url] = findSendCall(spy)!;
    expect(url.startsWith("https://smba.trafficmanager.net/emea/")).toBe(true);
  });

  it("re-validates the STORED serviceUrl and refuses a poisoned host (no token minted, no send)", async () => {
    const { store } = makeFakeStore({ ...storedRef, serviceUrl: "https://attacker.example/" });
    const { fetchImpl, spy } = makeConnectorFetch();
    const { deps } = makeAdapterDeps({ fetchImpl, conversationStore: store });
    const adapter = createMsTeamsAdapter(deps);

    const result = await adapter.sendMessage("19:dm-convo", "hi", {});

    expect(result.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("errs clearly on a proactive send when the conversation was never captured (store miss)", async () => {
    const { store, get } = makeFakeStore(undefined);
    const { fetchImpl, spy } = makeConnectorFetch();
    const { deps } = makeAdapterDeps({ fetchImpl, conversationStore: store });
    const adapter = createMsTeamsAdapter(deps);

    const result = await adapter.sendMessage("19:never-seen", "hi", {});

    expect(result.ok).toBe(false);
    expect(get).toHaveBeenCalledWith("19:never-seen");
    expect(spy).not.toHaveBeenCalled();
  });

  it("leaves the reply path unchanged: an explicit serviceUrl never consults the store", async () => {
    const { store, get } = makeFakeStore(storedRef);
    const { fetchImpl, spy } = makeConnectorFetch();
    const { deps } = makeAdapterDeps({ fetchImpl, conversationStore: store });
    const adapter = createMsTeamsAdapter(deps);

    const result = await adapter.sendMessage("19:dm-convo", "reply", {
      extra: { serviceUrl: SERVICE_URL },
    });

    expect(result.ok).toBe(true);
    expect(get).not.toHaveBeenCalled();
    expect(findSendCall(spy)![0].startsWith(SERVICE_URL)).toBe(true);
  });

  it("threads a proactive channel send under the stored threadId when no explicit reply target", async () => {
    const { store } = makeFakeStore({
      ...storedRef,
      conversationId: "19:channel@thread.tacv2",
      threadId: "thread-root-9",
    });
    const { fetchImpl, spy } = makeConnectorFetch();
    const { deps } = makeAdapterDeps({ fetchImpl, conversationStore: store });
    const adapter = createMsTeamsAdapter(deps);

    await adapter.sendMessage("19:channel@thread.tacv2", "cron notice", {});

    const body = JSON.parse(String(findSendCall(spy)![1].body)) as { replyToId?: string };
    expect(body.replyToId).toBe("thread-root-9");
  });
});

describe("createMsTeamsAdapter — editMessage / deleteMessage via the Connector REST", () => {
  it("PUTs an updated activity to the conversation activity path with a Bearer token", async () => {
    const { fetchImpl, spy, token } = makeConnectorFetch();
    const { deps } = makeAdapterDeps({ fetchImpl });
    const adapter = createMsTeamsAdapter(deps);
    expect(adapter.editMessage).toBeInstanceOf(Function);

    const result = await adapter.editMessage!("19:convo", "activity-9", "updated text", {
      extra: { serviceUrl: SERVICE_URL },
    });

    expect(result.ok).toBe(true);
    const call = findActivityCall(spy);
    expect(call).toBeDefined();
    const [url, init] = call!;
    expect(url).toBe(
      `${SERVICE_URL}v3/conversations/${encodeURIComponent("19:convo")}/activities/${encodeURIComponent("activity-9")}`,
    );
    expect(init.method).toBe("PUT");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${token}`);
    const body = JSON.parse(String(init.body)) as { type: string; text: string };
    expect(body.type).toBe("message");
    expect(body.text).toBe("updated text");
  });

  it("DELETEs an activity, recovering the serviceUrl from the store (the renderer's no-serviceUrl call)", async () => {
    // deleteMessage(channelId, messageId) carries no options, so it recovers the
    // serviceUrl from the store the inbound captured — the edit-in-place renderer
    // calls it exactly this way.
    const { store } = makeFakeStore({
      conversationId: "19:convo",
      serviceUrl: SERVICE_URL,
      tenantId: "tenant-1",
      updatedAt: FIXED_NOW,
    });
    const { fetchImpl, spy, token } = makeConnectorFetch();
    const { deps } = makeAdapterDeps({ fetchImpl, conversationStore: store });
    const adapter = createMsTeamsAdapter(deps);
    expect(adapter.deleteMessage).toBeInstanceOf(Function);

    const result = await adapter.deleteMessage!("19:convo", "activity-9");
    expect(result.ok).toBe(true);
    const call = findActivityCall(spy);
    expect(call).toBeDefined();
    const [url, init] = call!;
    expect(url).toBe(
      `${SERVICE_URL}v3/conversations/${encodeURIComponent("19:convo")}/activities/${encodeURIComponent("activity-9")}`,
    );
    expect(init.method).toBe("DELETE");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${token}`);
  });

  it("rejects an unsafe messageId on edit with an err before any fetch (T-8)", async () => {
    const { fetchImpl, spy } = makeConnectorFetch();
    const { deps } = makeAdapterDeps({ fetchImpl });
    const adapter = createMsTeamsAdapter(deps);

    const result = await adapter.editMessage!("19:convo", "../../evil", "x", {
      extra: { serviceUrl: SERVICE_URL },
    });

    expect(result.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects an unsafe messageId on delete with an err before any fetch (T-8)", async () => {
    const { fetchImpl, spy } = makeConnectorFetch();
    const { deps } = makeAdapterDeps({ fetchImpl });
    const adapter = createMsTeamsAdapter(deps);

    const result = await adapter.deleteMessage!("19:convo", "../evil");

    expect(result.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("attaches the structural HTTP status + retryAfter to an edit failure so the renderer classifies it", async () => {
    const { fetchImpl } = makeConnectorFetch({ sendStatus: 429, retryAfter: "30" });
    const { deps } = makeAdapterDeps({ fetchImpl });
    const adapter = createMsTeamsAdapter(deps);

    const result = await adapter.editMessage!("19:convo", "activity-9", "x", {
      extra: { serviceUrl: SERVICE_URL },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // A bare Error(message) would classify as `internal` and the renderer's
      // 429 retry would silently no-op; the structural status is the contract.
      expect((result.error as { status?: number }).status).toBe(429);
      expect(classifyMSTeamsError(result.error)).toEqual({
        kind: "rate_limited",
        retryAfterMs: 30_000,
      });
    }
  });

  it("classifies a 404 edit failure as an activity-gone drop via the structural status", async () => {
    const { fetchImpl } = makeConnectorFetch({ sendStatus: 404 });
    const { deps } = makeAdapterDeps({ fetchImpl });
    const adapter = createMsTeamsAdapter(deps);

    const result = await adapter.editMessage!("19:convo", "activity-9", "x", {
      extra: { serviceUrl: SERVICE_URL },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(classifyMSTeamsError(result.error)).toEqual({
        kind: "not_supported",
        capability: "edit",
      });
    }
  });

  it("never logs the Connector bearer token on the edit path", async () => {
    const { fetchImpl, token } = makeConnectorFetch({ sendStatus: 403 });
    const { deps, loggerSpy } = makeAdapterDeps({ fetchImpl });
    const adapter = createMsTeamsAdapter(deps);
    await adapter.editMessage!("19:convo", "activity-9", "x", {
      extra: { serviceUrl: SERVICE_URL },
    });
    expect(loggerSpy.serialized()).not.toContain(token);
  });
});

describe("createMsTeamsAdapter — outbound mention wiring (id-shape gated)", () => {
  it("builds an <at> tag + mention entity for an id-shape-valid mention", async () => {
    const { fetchImpl, spy } = makeConnectorFetch();
    const { deps } = makeAdapterDeps({ fetchImpl });
    const adapter = createMsTeamsAdapter(deps);

    await adapter.sendMessage(
      "19:convo",
      `hey @[Ada](${MENTIONABLE_BOT_ID}) look`,
      { extra: { serviceUrl: SERVICE_URL } },
    );

    const body = JSON.parse(String(findSendCall(spy)![1].body)) as {
      text: string;
      entities?: Array<{ type: string; text: string; mentioned: { id: string; name: string } }>;
    };
    expect(body.text).toContain("<at>Ada</at>");
    expect(body.text).not.toContain("@[Ada]");
    expect(body.entities).toBeDefined();
    expect(body.entities![0]).toEqual({
      type: "mention",
      text: "<at>Ada</at>",
      mentioned: { id: MENTIONABLE_BOT_ID, name: "Ada" },
    });
  });

  it("leaves a non-GUID mention markup literal with NO entity (false-mention control)", async () => {
    const { fetchImpl, spy } = makeConnectorFetch();
    const { deps } = makeAdapterDeps({ fetchImpl });
    const adapter = createMsTeamsAdapter(deps);

    await adapter.sendMessage("19:convo", "see @[x](not-a-guid) here", {
      extra: { serviceUrl: SERVICE_URL },
    });

    const body = JSON.parse(String(findSendCall(spy)![1].body)) as {
      text: string;
      entities?: unknown;
    };
    expect(body.text).toContain("@[x](not-a-guid)");
    expect(body.entities).toBeUndefined();
  });

  it("wires the mention builder into editMessage too", async () => {
    const { fetchImpl, spy } = makeConnectorFetch();
    const { deps } = makeAdapterDeps({ fetchImpl });
    const adapter = createMsTeamsAdapter(deps);

    await adapter.editMessage!(
      "19:convo",
      "activity-9",
      `ping @[Ada](${MENTIONABLE_BOT_ID})`,
      { extra: { serviceUrl: SERVICE_URL } },
    );

    const body = JSON.parse(String(findActivityCall(spy)![1].body)) as {
      text: string;
      entities?: unknown[];
    };
    expect(body.text).toContain("<at>Ada</at>");
    expect(body.entities).toBeDefined();
    expect(body.entities!.length).toBe(1);
  });
});

describe("createMsTeamsPlugin — capability parity metadata", () => {
  it("declares reactions/editMessages/deleteMessages/typing/threads true, buttons adaptivecard", () => {
    const { deps } = makeAdapterDeps();
    const plugin = createMsTeamsPlugin(deps);
    expect(plugin.capabilities).toEqual({
      features: {
        reactions: true,
        editMessages: true,
        deleteMessages: true,
        fetchHistory: false,
        // Backed by sendAttachment (base64-inline image) + the msteams-file resolver.
        attachments: true,
        typing: true,
        threads: true,
        buttons: "adaptivecard",
      },
      limits: { maxMessageChars: 28000 },
      replyToMetaKey: "teamsActivityId",
    });
  });

  it("declares the adaptivecard buttons variant while editMessages routes to edit-in-place", () => {
    const { deps } = makeAdapterDeps();
    const plugin = createMsTeamsPlugin(deps);
    // editMessages:true auto-routes the channel to the edit-in-place strategy.
    expect(plugin.capabilities.features.editMessages).toBe(true);
    // buttons "adaptivecard" — the channel advertises an Adaptive Card button surface.
    expect(plugin.capabilities.features.buttons).toBe("adaptivecard");
  });

  it("exposes the plugin metadata and a msteams adapter", () => {
    const { deps } = makeAdapterDeps();
    const plugin = createMsTeamsPlugin(deps);
    expect(plugin.id).toBe("channel-msteams");
    expect(plugin.name).toBe("Microsoft Teams Channel Plugin");
    expect(plugin.version).toBe("1.0.0");
    expect(plugin.channelType).toBe("msteams");
    expect(plugin.adapter.channelType).toBe("msteams");
  });

  it("delegates register/activate/deactivate to the adapter lifecycle", async () => {
    const { deps } = makeAdapterDeps();
    const plugin = createMsTeamsPlugin(deps);
    expect(plugin.register({} as never).ok).toBe(true);
    expect((await plugin.activate()).ok).toBe(true);
    expect((await plugin.deactivate()).ok).toBe(true);
  });
});
