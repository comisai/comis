// SPDX-License-Identifier: Apache-2.0
/**
 * RED test for the ACP approval bridge (spec §6.4 / §16.8 / §19.6).
 *
 * Fails on pre-patch code: `./acp-approval-bridge.js` does not exist.
 *
 * Behavior under test:
 *   - A `kind:"approval"` ActivityEvent with a 3-choice `approval` block
 *     (`approve`/`deny`/`details`) triggers EXACTLY ONE
 *     `connection.requestPermission(...)` call on the retained per-session
 *     connection (the single emission the bridge mandates).
 *   - The `options` array carries one entry per choice with `optionId ===
 *     choice.id`, `name === choice.defaultLabel`, and `kind` mapped
 *     (`approve→"allow_once"`, `deny→"reject_once"`, `details→"allow_once"`).
 *   - `requestPermission` targets the explicitly subscribed `sessionId`, and
 *     `toolCall.toolCallId` equals the event's `toolCallId` (or `activityId`
 *     fallback).
 *   - §19.6 SECURITY: the `toolCall` carries NO `rawInput`/`rawOutput`, and
 *     `JSON.stringify(req)` contains no injected raw-param sentinel (the source
 *     ApprovalCorrelation deliberately has no full request id — only `shortId`).
 *   - The SDK outcome (`{ outcome:"selected", optionId:"approve" }`) is READ and
 *     LOGGED via the injected logger — the bridge does not throw and does NOT
 *     route into a (non-existent) approval gate (emit-and-log).
 *   - When `getConnection(sessionId)` returns undefined the bridge no-ops.
 *   - A non-approval event (`kind:"tool"`) is ignored (no `requestPermission`).
 */
import { describe, it, expect, vi } from "vitest";
import type {
  ActivityEvent,
  ActivityStreamPort,
  ActivitySubscription,
  ComisLogger,
  TurnActivityContext,
} from "@comis/core";
import { formatSessionKey } from "@comis/core";
import type {
  AgentSideConnection,
  RequestPermissionRequest,
} from "@agentclientprotocol/sdk";
import { createAcpApprovalBridge } from "./acp-approval-bridge.js";

/** The ACP session id (= AcpSessionKey.peerId; the connection-registry key). */
const ACP_SESSION_ID = "peer-9876";

/** A display label used for event correlation only. */
const ACP_SESSION_KEY = formatSessionKey({
  tenantId: "default",
  agentId: "a1",
  userId: "ide-user",
  channelId: "acp",
  peerId: ACP_SESSION_ID,
});

/**
 * A sentinel we sweep the serialized request for. ApprovalCorrelation has no
 * field that could carry it (only shortId/choices), so it must never appear —
 * the assertion proves the bridge invents no raw-param surface (§19.6).
 */
const RAW_PARAM_SENTINEL = "RAW_SECRET_xyz789";

/**
 * Hand-built fake AgentSideConnection (AGENTS.md §2.5 — only the members the
 * SUT touches). `requestPermission` resolves to the "selected" outcome and
 * captures every request for the options/security assertions.
 */
function makeFakeConnection(): {
  connection: AgentSideConnection;
  requests: RequestPermissionRequest[];
} {
  const requests: RequestPermissionRequest[] = [];
  const connection = {
    sessionUpdate: vi.fn(async () => {}),
    requestPermission: vi.fn(async (req: RequestPermissionRequest) => {
      requests.push(req);
      return { outcome: { outcome: "selected", optionId: "approve" } };
    }),
  } as unknown as AgentSideConnection;
  return { connection, requests };
}

/**
 * Fake ActivityStreamPort that captures the `onEvent` sink so a test can drive
 * ActivityEvents through the bridge synchronously, and records unsubscribe()
 * calls so cleanup symmetry can be asserted.
 */
function makeFakeStreamPort(): {
  port: ActivityStreamPort;
  emit: (e: ActivityEvent) => void;
  unsubscribeCalls: () => number;
} {
  let sink: ((e: ActivityEvent) => void) | undefined;
  let unsubscribes = 0;
  return {
    port: {
      subscribeForTurn(
        _ctx: TurnActivityContext,
        onEvent: (e: ActivityEvent) => void,
      ): ActivitySubscription {
        sink = onEvent;
        return {
          unsubscribe(): void {
            unsubscribes += 1;
            sink = undefined;
          },
        };
      },
    },
    emit: (e: ActivityEvent) => {
      if (sink === undefined) throw new Error("no subscriber attached");
      sink(e);
    },
    unsubscribeCalls: () => unsubscribes,
  };
}

/** Minimal recording logger satisfying the ComisLogger contract. */
function makeFakeLogger(): {
  logger: ComisLogger;
  infoCalls: () => Array<{ fields: unknown; msg: string }>;
} {
  const infoCalls: Array<{ fields: unknown; msg: string }> = [];
  const logger = {
    level: "info",
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn((fields: unknown, msg: string) => {
      infoCalls.push({ fields, msg });
    }),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    audit: vi.fn(),
    child: vi.fn(),
  } as unknown as ComisLogger;
  return { logger, infoCalls: () => infoCalls };
}

function makeTurnContext(): TurnActivityContext {
  return {
    agentId: "a1",
    sessionKey: ACP_SESSION_KEY,
    traceId: "t1",
    channelType: "acp",
    channelKey: "acp",
    chatType: "direct",
    inboundMessageId: "m1",
    rendererKey: "a1:acp:acp:direct",
  };
}

/**
 * Build a `kind:"approval"` ActivityEvent with a 3-choice approval block. The
 * refine on ActivityEventSchema requires the `approval` block iff
 * kind === "approval", so this is the canonical approval shape.
 */
function makeApprovalEvent(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    schemaVersion: 1,
    activityId: "22222222-2222-4222-8222-222222222222",
    sessionKey: ACP_SESSION_KEY,
    agentId: "a1",
    traceId: "t1",
    toolCallId: "tc-approval",
    ts: "2026-05-26T00:00:00.000Z",
    phase: "start",
    status: "running",
    kind: "approval",
    semanticPhase: "tool",
    defaultLabel: "Approve shell command?",
    approval: {
      shortId: "abcDEF123456",
      expiresAt: 1_900_000_000_000,
      choices: [
        { id: "approve", defaultLabel: "Approve", style: "primary" },
        { id: "deny", defaultLabel: "Deny", style: "danger" },
        { id: "details", defaultLabel: "Details", style: "secondary" },
      ],
    },
    ...overrides,
  };
}

/** A non-approval (tool) event the bridge must ignore. */
function makeToolEvent(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    schemaVersion: 1,
    activityId: "33333333-3333-4333-8333-333333333333",
    sessionKey: ACP_SESSION_KEY,
    agentId: "a1",
    traceId: "t1",
    toolCallId: "tc-tool",
    ts: "2026-05-26T00:00:00.000Z",
    phase: "start",
    status: "running",
    kind: "tool",
    semanticPhase: "tool",
    toolName: "read_file",
    defaultLabel: "Reading file",
    ...overrides,
  };
}

/** Flush microtasks so the bridge's async requestPermission settles. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("createAcpApprovalBridge (kind:'approval' ActivityEvent → SDK requestPermission)", () => {
  it("invokes requestPermission exactly once for a single kind:approval event", async () => {
    const { connection } = makeFakeConnection();
    const stream = makeFakeStreamPort();
    const bridge = createAcpApprovalBridge({
      activityStreamPort: stream.port,
      getConnection: (id) => (id === ACP_SESSION_ID ? connection : undefined),
    });
    bridge.subscribe(makeTurnContext(), ACP_SESSION_ID);

    stream.emit(makeApprovalEvent());
    await flush();

    const requestPermission =
      connection.requestPermission as unknown as ReturnType<typeof vi.fn>;
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it("maps ApprovalCorrelation.choices to PermissionOption[] with id/label/kind", async () => {
    const { connection, requests } = makeFakeConnection();
    const stream = makeFakeStreamPort();
    const bridge = createAcpApprovalBridge({
      activityStreamPort: stream.port,
      getConnection: () => connection,
    });
    bridge.subscribe(makeTurnContext(), ACP_SESSION_ID);

    stream.emit(makeApprovalEvent());
    await flush();

    expect(requests.length).toBe(1);
    expect(requests[0]!.options).toEqual([
      { optionId: "approve", name: "Approve", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
      { optionId: "details", name: "Details", kind: "allow_once" },
    ]);
  });

  it("targets the resolved acpSessionId and the event toolCallId on the request", async () => {
    const { connection, requests } = makeFakeConnection();
    const stream = makeFakeStreamPort();
    const bridge = createAcpApprovalBridge({
      activityStreamPort: stream.port,
      getConnection: (id) => (id === ACP_SESSION_ID ? connection : undefined),
    });
    bridge.subscribe(makeTurnContext(), ACP_SESSION_ID);

    stream.emit(makeApprovalEvent({ toolCallId: "tc-explicit" }));
    await flush();

    expect(requests[0]!.sessionId).toBe(ACP_SESSION_ID);
    expect(requests[0]!.toolCall.toolCallId).toBe("tc-explicit");
  });

  it("falls back to activityId for toolCallId when the event has none", async () => {
    const { connection, requests } = makeFakeConnection();
    const stream = makeFakeStreamPort();
    const bridge = createAcpApprovalBridge({
      activityStreamPort: stream.port,
      getConnection: () => connection,
    });
    bridge.subscribe(makeTurnContext(), ACP_SESSION_ID);

    stream.emit(makeApprovalEvent({ toolCallId: undefined }));
    await flush();

    expect(requests[0]!.toolCall.toolCallId).toBe(
      "22222222-2222-4222-8222-222222222222",
    );
  });

  it("never sets rawInput/rawOutput or leaks a raw-param sentinel in the request (§19.6)", async () => {
    const { connection, requests } = makeFakeConnection();
    const stream = makeFakeStreamPort();
    const bridge = createAcpApprovalBridge({
      activityStreamPort: stream.port,
      getConnection: () => connection,
    });
    bridge.subscribe(makeTurnContext(), ACP_SESSION_ID);

    // Inject the sentinel into a field the bridge could (wrongly) forward.
    stream.emit(
      makeApprovalEvent({ defaultLabel: undefined, toolCallId: "tc-1" }),
    );
    // Also drive an event whose params carry the sentinel — params must never
    // be forwarded to the permission request.
    stream.emit(makeApprovalEvent({ params: { secret: RAW_PARAM_SENTINEL } }));
    await flush();

    expect(requests.length).toBe(2);
    for (const req of requests) {
      const tc = req.toolCall as Record<string, unknown>;
      expect(tc.rawInput).toBeUndefined();
      expect(tc.rawOutput).toBeUndefined();
      expect(JSON.stringify(req)).not.toContain(RAW_PARAM_SENTINEL);
    }
  });

  it("logs the SDK outcome and does not throw or route into an approval gate", async () => {
    const { connection } = makeFakeConnection();
    const stream = makeFakeStreamPort();
    const { logger, infoCalls } = makeFakeLogger();
    const bridge = createAcpApprovalBridge({
      activityStreamPort: stream.port,
      getConnection: () => connection,
      logger,
    });
    bridge.subscribe(makeTurnContext(), ACP_SESSION_ID);

    expect(() => stream.emit(makeApprovalEvent())).not.toThrow();
    await flush();

    // The "selected" outcome from the fake connection was read and logged.
    const outcomeLog = infoCalls().find(
      (c) => (c.fields as { step?: string }).step === "permission-outcome",
    );
    expect(outcomeLog).toBeDefined();
    expect((outcomeLog!.fields as { outcome?: string }).outcome).toBe(
      "selected",
    );
  });

  it("no-ops without throwing or calling requestPermission when no connection is retained", async () => {
    const stream = makeFakeStreamPort();
    const bridge = createAcpApprovalBridge({
      activityStreamPort: stream.port,
      getConnection: () => undefined,
    });
    bridge.subscribe(makeTurnContext(), ACP_SESSION_ID);

    expect(() => stream.emit(makeApprovalEvent())).not.toThrow();
    await flush();
    // The assertion is the absence of a throw — there is no connection to call.
  });

  it("ignores a non-approval (kind:tool) event without calling requestPermission", async () => {
    const { connection } = makeFakeConnection();
    const stream = makeFakeStreamPort();
    const bridge = createAcpApprovalBridge({
      activityStreamPort: stream.port,
      getConnection: () => connection,
    });
    bridge.subscribe(makeTurnContext(), ACP_SESSION_ID);

    stream.emit(makeToolEvent());
    await flush();

    const requestPermission =
      connection.requestPermission as unknown as ReturnType<typeof vi.fn>;
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("detaches the activity-stream subscription when the returned unsubscribe is called", () => {
    const { connection } = makeFakeConnection();
    const stream = makeFakeStreamPort();
    const bridge = createAcpApprovalBridge({
      activityStreamPort: stream.port,
      getConnection: () => connection,
    });
    const unsubscribe = bridge.subscribe(makeTurnContext(), ACP_SESSION_ID);

    expect(stream.unsubscribeCalls()).toBe(0);
    unsubscribe();
    expect(stream.unsubscribeCalls()).toBe(1);
  });

  it("logs a rejected requestPermission and still serves a later approval (no chain poisoning)", async () => {
    // A connection whose FIRST requestPermission rejects (IDE disconnects
    // mid-turn) then succeeds. Pre-fix: the rejected promise poisons the
    // `chain` so every later approval's `.then` callback never runs — the
    // second approval is silently dropped — and the rejection is unhandled.
    const served: RequestPermissionRequest[] = [];
    const requestPermission = vi
      .fn()
      .mockRejectedValueOnce(new Error("ide permission channel closed"))
      .mockImplementation(async (req: RequestPermissionRequest) => {
        served.push(req);
        return { outcome: { outcome: "selected", optionId: "approve" } };
      });
    const connection = {
      sessionUpdate: vi.fn(async () => {}),
      requestPermission,
    } as unknown as AgentSideConnection;

    const debugCalls: Array<{ fields: unknown; msg: string }> = [];
    const logger = {
      level: "debug",
      trace: vi.fn(),
      debug: vi.fn((fields: unknown, msg: string) => {
        debugCalls.push({ fields, msg });
      }),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      audit: vi.fn(),
      child: vi.fn(),
    } as unknown as ComisLogger;

    const stream = makeFakeStreamPort();
    const bridge = createAcpApprovalBridge({
      activityStreamPort: stream.port,
      getConnection: () => connection,
      logger,
    });
    bridge.subscribe(makeTurnContext(), ACP_SESSION_ID);

    // First approval triggers the rejecting requestPermission.
    stream.emit(makeApprovalEvent({ toolCallId: "fail" }));
    await flush();
    // Second approval must still reach the connection — chain not poisoned.
    stream.emit(makeApprovalEvent({ toolCallId: "ok" }));
    await flush();

    // (a) no unhandled rejection (the await of `flush()` would surface it),
    // (b) the rejection was logged with the canonical `err` field + context,
    const errLog = debugCalls.find(
      (c) => (c.fields as { err?: unknown }).err !== undefined,
    );
    expect(errLog).toBeDefined();
    expect((errLog!.fields as { err?: Error }).err).toBeInstanceOf(Error);
    expect((errLog!.fields as { acpSessionId?: string }).acpSessionId).toBe(
      ACP_SESSION_ID,
    );
    // (c) the SECOND approval was served (proves the chain survived).
    expect(requestPermission).toHaveBeenCalledTimes(2);
    expect(served).toHaveLength(1);
    expect(served[0]!.toolCall.toolCallId).toBe("ok");
  });
});
