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

/** A fetch stub returning a 2xx Connector send response; captures its calls. */
function makeSendFetch(sentId = "sent-1", status = 200) {
  const spy = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ id: sentId }),
  }));
  return { fetchImpl: spy as unknown as typeof fetch, spy };
}

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
