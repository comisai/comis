// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import type { ComisLogger, MessageHandler, NormalizedMessage } from "@comis/core";
import { createMsTeamsAdapter, type MsTeamsAdapterDeps } from "../msteams-adapter.js";
import type { TeamsActivity } from "../message-mapper.js";

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
  opts: { sendStatus?: number; sentId?: string; token?: string } = {},
) {
  const sendStatus = opts.sendStatus ?? 200;
  const sentId = opts.sentId ?? "sent-1";
  const token = opts.token ?? "connector-access-token";
  const spy = vi.fn(async (url: string) => {
    if (String(url).includes("/oauth2/v2.0/token")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: token, expires_in: 3600 }),
      };
    }
    return {
      ok: sendStatus >= 200 && sendStatus < 300,
      status: sendStatus,
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

const SERVICE_URL = "https://smba.example.com/teams/";

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

  it("exposes channelId and channelType as adapter properties", () => {
    const { deps } = makeAdapterDeps();
    const adapter = createMsTeamsAdapter(deps);
    expect(adapter.channelType).toBe("msteams");
    expect(typeof adapter.channelId).toBe("string");
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

    // LIVE-01: lastMessageAt advances from undefined to the injected clock.
    expect(before).toBeUndefined();
    const after = adapter.getStatus?.().lastMessageAt;
    expect(typeof after).toBe("number");
    expect(after).toBe(FIXED_NOW);

    // OBS-01: an INFO inbound line carries the pipeline step, messageId and traceId.
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
    expect(url).toBe(`${SERVICE_URL}v3/conversations/19:dm-convo/activities`);
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

  it("resolves the default Connector service URL when none is supplied", async () => {
    const { fetchImpl, spy } = makeConnectorFetch();
    const { deps } = makeAdapterDeps({ fetchImpl });
    const adapter = createMsTeamsAdapter(deps);
    const result = await adapter.sendMessage("19:dm-convo", "hi");
    expect(result.ok).toBe(true);
    const sendCall = findSendCall(spy);
    expect(sendCall).toBeDefined();
    const [url] = sendCall!;
    expect(url.startsWith("https://")).toBe(true);
    expect(url).toContain("/v3/conversations/19:dm-convo/activities");
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

  it("never logs the Connector bearer token on the outbound path", async () => {
    const { fetchImpl, token } = makeConnectorFetch();
    const { deps, loggerSpy } = makeAdapterDeps({ fetchImpl });
    const adapter = createMsTeamsAdapter(deps);
    await adapter.sendMessage("19:dm-convo", "hi", {
      extra: { serviceUrl: SERVICE_URL },
    });
    expect(loggerSpy.serialized()).not.toContain(token);
  });
});
