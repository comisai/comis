// SPDX-License-Identifier: Apache-2.0
/**
 * RED test for the ACP activity bridge (spec §16.8 / §19.6).
 *
 * Fails on pre-patch code: `./acp-activity-bridge.js` does not exist.
 *
 * Behavior under test:
 *   - §19.6 SECURITY (FIRST test — redaction-first): a `RAW_PARAM_SENTINEL`
 *     injected into the SOURCE ActivityEvent's `params` NEVER appears in any
 *     captured ACP SessionUpdate frame, and `update.rawInput` / `update.rawOutput`
 *     are always `undefined`. This is the bridge's primary security control.
 *   - phase:"start" → `sessionUpdate:"tool_call"` with the event's toolCallId, a
 *     non-empty title, and `status:"pending"`.
 *   - phase:"progress" | phase:"end" → `sessionUpdate:"tool_call_update"`; status
 *     maps completed→"completed", failed→"failed", otherwise "in_progress".
 *   - sessionUpdate is the SINGLE-ARG call `{ sessionId, update }` whose sessionId
 *     is supplied explicitly when the turn subscription is registered.
 *   - events drain through the local 256 queue in enqueue order (e1→e2→e3).
 *   - when `getConnection(sessionId)` returns undefined the bridge no-ops.
 */
import { describe, it, expect, vi } from "vitest";
import type {
  ActivityEvent,
  ActivityStreamPort,
  ActivitySubscription,
  TurnActivityContext,
} from "@comis/core";
import { formatSessionKey } from "@comis/core";
import type {
  AgentSideConnection,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import { createAcpActivityBridge } from "./acp-activity-bridge.js";

/** The raw secret we inject into the source event params; it must NEVER cross the wire. */
const RAW_PARAM_SENTINEL = "RAW_SECRET_abc123";

/** The ACP session id (= AcpSessionKey.peerId; the connection-registry key). */
const ACP_SESSION_ID = "peer-1234";

/** A display label used for event correlation only. */
const ACP_SESSION_KEY = formatSessionKey({
  tenantId: "default",
  agentId: "a1",
  userId: "ide-user",
  channelId: "acp",
  peerId: ACP_SESSION_ID,
});

/**
 * Hand-built fake AgentSideConnection (AGENTS.md §2.5 — only the members the
 * SUT touches). Captures every SessionNotification frame for the §19.6
 * assertion.
 */
function makeFakeConnection(): {
  connection: AgentSideConnection;
  frames: SessionNotification[];
} {
  const frames: SessionNotification[] = [];
  const connection = {
    sessionUpdate: vi.fn(async (p: SessionNotification) => {
      frames.push(p);
    }),
    requestPermission: vi.fn(async () => ({
      outcome: { outcome: "selected", optionId: "approve" },
    })),
  } as unknown as AgentSideConnection;
  return { connection, frames };
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

/** Build a minimal valid-shaped ActivityEvent. */
function makeActivityEvent(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    schemaVersion: 1,
    activityId: "11111111-1111-4111-8111-111111111111",
    sessionKey: ACP_SESSION_KEY,
    agentId: "a1",
    traceId: "t1",
    toolCallId: "tc-1",
    ts: "2026-05-26T00:00:00.000Z",
    phase: "start",
    status: "running",
    kind: "tool",
    semanticPhase: "tool",
    toolName: "read_file",
    defaultLabel: "Reading file",
    // params is already redacted at emit; we inject a sentinel to prove the
    // bridge never forwards it to any SDK field (§19.6).
    params: { secret: RAW_PARAM_SENTINEL },
    ...overrides,
  };
}

/** Flush microtasks so the bridge's async drain completes before assertions. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("createAcpActivityBridge (redacted ActivityEvent → SDK session/update)", () => {
  it("never lets raw params (rawInput/rawOutput/sentinel) cross the wire in any frame (§19.6)", async () => {
    const { connection, frames } = makeFakeConnection();
    const stream = makeFakeStreamPort();
    const bridge = createAcpActivityBridge({
      activityStreamPort: stream.port,
      getConnection: (id) => (id === ACP_SESSION_ID ? connection : undefined),
    });
    const unsubscribe = bridge.subscribe(makeTurnContext(), ACP_SESSION_ID);

    stream.emit(makeActivityEvent({ phase: "start", status: "running" }));
    stream.emit(makeActivityEvent({ phase: "progress", status: "running" }));
    stream.emit(makeActivityEvent({ phase: "end", status: "completed" }));
    await flush();

    expect(frames.length).toBe(3);
    for (const f of frames) {
      const u = f.update as Record<string, unknown>;
      expect(u.rawInput).toBeUndefined();
      expect(u.rawOutput).toBeUndefined();
      // Deep check: the redacted params map must not be forwarded anywhere.
      expect(JSON.stringify(f)).not.toContain(RAW_PARAM_SENTINEL);
    }
    unsubscribe();
  });

  it("maps phase:start to a tool_call frame with toolCallId, a title, and pending status", async () => {
    const { connection, frames } = makeFakeConnection();
    const stream = makeFakeStreamPort();
    const bridge = createAcpActivityBridge({
      activityStreamPort: stream.port,
      getConnection: () => connection,
    });
    bridge.subscribe(makeTurnContext(), ACP_SESSION_ID);

    stream.emit(
      makeActivityEvent({ phase: "start", status: "running", toolCallId: "tc-start" }),
    );
    await flush();

    expect(frames.length).toBe(1);
    const u = frames[0]!.update as Record<string, unknown>;
    expect(u.sessionUpdate).toBe("tool_call");
    expect(u.toolCallId).toBe("tc-start");
    expect(typeof u.title).toBe("string");
    expect((u.title as string).length).toBeGreaterThan(0);
    expect(u.status).toBe("pending");
  });

  it("maps phase:progress and phase:end to tool_call_update frames with mapped status", async () => {
    const { connection, frames } = makeFakeConnection();
    const stream = makeFakeStreamPort();
    const bridge = createAcpActivityBridge({
      activityStreamPort: stream.port,
      getConnection: () => connection,
    });
    bridge.subscribe(makeTurnContext(), ACP_SESSION_ID);

    stream.emit(makeActivityEvent({ phase: "progress", status: "running" }));
    stream.emit(makeActivityEvent({ phase: "end", status: "completed" }));
    stream.emit(makeActivityEvent({ phase: "end", status: "failed" }));
    await flush();

    expect(frames.length).toBe(3);
    const updates = frames.map((f) => f.update as Record<string, unknown>);
    expect(updates[0]!.sessionUpdate).toBe("tool_call_update");
    expect(updates[0]!.status).toBe("in_progress");
    expect(updates[1]!.sessionUpdate).toBe("tool_call_update");
    expect(updates[1]!.status).toBe("completed");
    expect(updates[2]!.sessionUpdate).toBe("tool_call_update");
    expect(updates[2]!.status).toBe("failed");
  });

  it("calls sessionUpdate with a single object arg whose sessionId is the resolved acpSessionId", async () => {
    const { connection, frames } = makeFakeConnection();
    const stream = makeFakeStreamPort();
    const bridge = createAcpActivityBridge({
      activityStreamPort: stream.port,
      getConnection: (id) => (id === ACP_SESSION_ID ? connection : undefined),
    });
    bridge.subscribe(makeTurnContext(), ACP_SESSION_ID);

    stream.emit(makeActivityEvent({ phase: "start" }));
    await flush();

    const sessionUpdate = connection.sessionUpdate as unknown as ReturnType<
      typeof vi.fn
    >;
    expect(sessionUpdate).toHaveBeenCalledTimes(1);
    // SINGLE-ARG call shape: one argument, an object carrying sessionId + update.
    expect(sessionUpdate.mock.calls[0]!.length).toBe(1);
    expect(frames[0]!.sessionId).toBe(ACP_SESSION_ID);
  });

  it("delivers enqueued events to the connection in their original enqueue order", async () => {
    const { connection, frames } = makeFakeConnection();
    const stream = makeFakeStreamPort();
    const bridge = createAcpActivityBridge({
      activityStreamPort: stream.port,
      getConnection: () => connection,
    });
    bridge.subscribe(makeTurnContext(), ACP_SESSION_ID);

    stream.emit(makeActivityEvent({ phase: "start", toolCallId: "e1" }));
    stream.emit(makeActivityEvent({ phase: "progress", toolCallId: "e2" }));
    stream.emit(makeActivityEvent({ phase: "end", toolCallId: "e3", status: "completed" }));
    await flush();

    const ids = frames.map((f) => (f.update as Record<string, unknown>).toolCallId);
    expect(ids).toEqual(["e1", "e2", "e3"]);
  });

  it("no-ops without throwing or emitting a frame when no connection is retained", async () => {
    const stream = makeFakeStreamPort();
    const bridge = createAcpActivityBridge({
      activityStreamPort: stream.port,
      getConnection: () => undefined,
    });
    bridge.subscribe(makeTurnContext(), ACP_SESSION_ID);

    expect(() => stream.emit(makeActivityEvent({ phase: "start" }))).not.toThrow();
    await flush();
    // No connection means nothing was pushed — the assertion is the absence of a throw.
  });

  it("detaches the activity-stream subscription when the returned unsubscribe is called", async () => {
    const { connection } = makeFakeConnection();
    const stream = makeFakeStreamPort();
    const bridge = createAcpActivityBridge({
      activityStreamPort: stream.port,
      getConnection: () => connection,
    });
    const unsubscribe = bridge.subscribe(makeTurnContext(), ACP_SESSION_ID);

    expect(stream.unsubscribeCalls()).toBe(0);
    unsubscribe();
    expect(stream.unsubscribeCalls()).toBe(1);
  });

  it("logs a rejected sessionUpdate and still delivers a later frame (no chain poisoning)", async () => {
    // A connection whose FIRST sessionUpdate rejects (IDE disconnects mid-turn)
    // then succeeds. Pre-fix: the rejected promise poisons the `draining` chain
    // so every later pump's `.then` callback never runs — the second frame is
    // silently dropped — and the rejection surfaces unhandled.
    const frames: SessionNotification[] = [];
    const sessionUpdate = vi
      .fn()
      .mockRejectedValueOnce(new Error("ide writer closed"))
      .mockImplementation(async (p: SessionNotification) => {
        frames.push(p);
      });
    const connection = {
      sessionUpdate,
      requestPermission: vi.fn(async () => ({
        outcome: { outcome: "selected", optionId: "approve" },
      })),
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
    } as unknown as import("@comis/core").ComisLogger;

    const stream = makeFakeStreamPort();
    const bridge = createAcpActivityBridge({
      activityStreamPort: stream.port,
      getConnection: () => connection,
      logger,
    });
    bridge.subscribe(makeTurnContext(), ACP_SESSION_ID);

    // First frame triggers the rejecting sessionUpdate.
    stream.emit(makeActivityEvent({ phase: "start", toolCallId: "fail" }));
    await flush();
    // Second frame must still reach the connection — the chain is not poisoned.
    stream.emit(makeActivityEvent({ phase: "end", toolCallId: "ok", status: "completed" }));
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
    // (c) the SECOND frame was delivered (proves the chain survived the failure).
    expect(sessionUpdate).toHaveBeenCalledTimes(2);
    expect(frames).toHaveLength(1);
    expect((frames[0]!.update as Record<string, unknown>).toolCallId).toBe("ok");
  });
});
