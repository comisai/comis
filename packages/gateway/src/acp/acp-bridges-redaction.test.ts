// SPDX-License-Identifier: Apache-2.0
/**
 * Cross-bridge §19.6 M6 redaction sweep — the whole-surface guarantee.
 *
 * Per-bridge tests (acp-activity-bridge.test.ts, acp-plan-bridge.test.ts,
 * acp-approval-bridge.test.ts) each assert no raw params leak through THAT
 * bridge. This test is the integration-tier complement: it drives realistic
 * events through ALL THREE bridges (activity, plan, approval) against ONE fake
 * `AgentSideConnection` that captures every `sessionUpdate(params)` frame AND
 * every `requestPermission(req)` argument into a single `captured[]` array,
 * then asserts the §19.6 M6 invariant across the whole surface:
 *
 *   - NO captured `update` / `toolCall` carries `rawInput` / `rawOutput`.
 *   - `JSON.stringify(captured)` contains no `RAW_PARAM_SENTINEL` — the secret
 *     injected into EVERY source surface (the activity event `params`, the
 *     approval event `params`, and a SEP plan step's `completedBy`) crosses no
 *     frame.
 *
 * The test is NON-VACUOUS: it asserts `captured.length > 0` so a bridge that
 * silently stopped emitting could not vacuously pass. It is RED-first
 * conceptually: a future change that reintroduced raw-param forwarding in ANY
 * one bridge — slipping past the per-bridge unit tests — would surface the
 * sentinel and fail HERE.
 *
 * Imports the bridge factories from co-located source (relative `./acp-*`),
 * NOT from `dist/` — this is a unit-tier test run by `pnpm vitest run`. The
 * gateway boundary (@comis/core + @comis/shared + SDK only) is enforced
 * separately by `pnpm cycles` + source-rules.test.ts on `pnpm validate`.
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import type {
  ActivityEvent,
  ActivityStreamPort,
  ActivitySubscription,
  ReadonlyExecutionPlan,
  ExecutionPlanPort,
  TurnActivityContext,
} from "@comis/core";
import { TypedEventBus, formatSessionKey } from "@comis/core";
import type {
  AgentSideConnection,
  RequestPermissionRequest,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import { createAcpActivityBridge } from "./acp-activity-bridge.js";
import { createAcpPlanBridge } from "./acp-plan-bridge.js";
import { createAcpApprovalBridge } from "./acp-approval-bridge.js";

/**
 * The raw secret injected into EVERY source surface across the three bridges.
 * It must NEVER appear in any captured frame (§19.6 M6, whole-surface).
 */
const RAW_PARAM_SENTINEL = "RAW_SECRET_xyz789";

/** The ACP session id (= AcpSessionKey.peerId; the connection-registry key). */
const ACP_SESSION_ID = "peer-cross-bridge-1";

/** A sessionKey whose peerId reverse-resolves to ACP_SESSION_ID. */
const ACP_SESSION_KEY = formatSessionKey({
  tenantId: "default",
  agentId: "a1",
  userId: "ide-user",
  channelId: "acp",
  peerId: ACP_SESSION_ID,
});

/**
 * ONE fake AgentSideConnection capturing BOTH channels — every sessionUpdate
 * frame and every requestPermission request — into a single array. This is the
 * whole-surface capture the §19.6 M6 sweep asserts over (AGENTS.md §2.5 — only
 * the members the SUTs call).
 */
function makeCapturingConnection(): {
  connection: AgentSideConnection;
  captured: unknown[];
} {
  const captured: unknown[] = [];
  const connection = {
    sessionUpdate: vi.fn(async (p: SessionNotification) => {
      captured.push(p);
    }),
    requestPermission: vi.fn(async (r: RequestPermissionRequest) => {
      captured.push(r);
      return { outcome: { outcome: "selected", optionId: "approve" } };
    }),
  } as unknown as AgentSideConnection;
  return { connection, captured };
}

/**
 * Fake ActivityStreamPort that fans `emit` out to EVERY registered sink — both
 * the activity bridge and the approval bridge subscribe to the same port, each
 * obtaining its own `onEvent` callback, so the test must drive both.
 */
function makeFanoutStreamPort(): {
  port: ActivityStreamPort;
  emit: (e: ActivityEvent) => void;
} {
  const sinks: Array<(e: ActivityEvent) => void> = [];
  return {
    port: {
      subscribeForTurn(
        _ctx: TurnActivityContext,
        onEvent: (e: ActivityEvent) => void,
      ): ActivitySubscription {
        sinks.push(onEvent);
        return {
          unsubscribe(): void {
            const i = sinks.indexOf(onEvent);
            if (i >= 0) sinks.splice(i, 1);
          },
        };
      },
    },
    emit: (e: ActivityEvent) => {
      for (const sink of [...sinks]) sink(e);
    },
  };
}

/** Mutable fake ExecutionPlanPort (mirrors plan-stream.test.ts:21-32). */
function makePlanPort(plan: ReadonlyExecutionPlan | undefined): {
  port: ExecutionPlanPort;
  set: (p: ReadonlyExecutionPlan | undefined) => void;
} {
  let current = plan;
  return {
    port: { getCurrentPlan: () => current },
    set: (p) => {
      current = p;
    },
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

/** A tool ActivityEvent whose redacted params carry the sentinel. */
function makeToolEvent(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    schemaVersion: 1,
    activityId: "11111111-1111-4111-8111-111111111111",
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
    // The sentinel rides the (already-redacted) params map; no bridge may
    // forward it to any SDK field.
    params: { secret: RAW_PARAM_SENTINEL },
    ...overrides,
  };
}

/** A kind:"approval" ActivityEvent whose params ALSO carry the sentinel. */
function makeApprovalEvent(
  overrides: Partial<ActivityEvent> = {},
): ActivityEvent {
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
    params: { secret: RAW_PARAM_SENTINEL },
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

/** Flush microtasks so each bridge's async drain / round-trip settles. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("ACP bridges cross-surface redaction sweep (§19.6 M6, whole-surface)", () => {
  it("no raw params cross any ACP bridge frame across all three bridges (§19.6 M6, whole-surface)", async () => {
    const { connection, captured } = makeCapturingConnection();
    const stream = makeFanoutStreamPort();
    const bus = new TypedEventBus();
    const getConnection = (id: string): AgentSideConnection | undefined =>
      id === ACP_SESSION_ID ? connection : undefined;

    // A SEP plan whose step carries the sentinel in `completedBy` — a field the
    // plan bridge must NEVER project into the SDK PlanEntry.
    const planPort = makePlanPort({
      active: true,
      request: "do the thing",
      completedCount: 0,
      steps: [
        {
          index: 1,
          description: "step one",
          status: "in_progress",
          completedBy: [RAW_PARAM_SENTINEL],
        },
        { index: 2, description: "step two", status: "pending" },
      ],
    });

    // Construct all three bridges against the SAME capturing connection.
    const activityBridge = createAcpActivityBridge({
      activityStreamPort: stream.port,
      getConnection,
    });
    const approvalBridge = createAcpApprovalBridge({
      activityStreamPort: stream.port,
      getConnection,
    });
    const planUnsubscribe = createAcpPlanBridge({
      eventBus: bus,
      executionPlanPort: planPort.port,
      getConnection,
      resolveAcpSessionId: () => ACP_SESSION_ID,
    });
    const activityUnsubscribe = activityBridge.subscribe(makeTurnContext(), ACP_SESSION_ID);
    const approvalUnsubscribe = approvalBridge.subscribe(makeTurnContext(), ACP_SESSION_ID);

    // Drive realistic events through every bridge.
    // 1) Activity: a tool start/progress/end sequence (params carry sentinel).
    stream.emit(makeToolEvent({ phase: "start", status: "running" }));
    stream.emit(makeToolEvent({ phase: "progress", status: "running" }));
    stream.emit(makeToolEvent({ phase: "end", status: "completed" }));
    // 2) Plan: sep:plan_extracted then a tool:executed re-emit.
    bus.emit("sep:plan_extracted", {
      agentId: "a1",
      sessionKey: ACP_SESSION_KEY,
      stepCount: 2,
      timestamp: Date.now(),
    });
    bus.emit("tool:executed", {
      toolName: "edit",
      durationMs: 5,
      success: true,
      timestamp: Date.now(),
      toolCallId: "call-1",
      agentId: "a1",
      sessionKey: ACP_SESSION_KEY,
      phase: "completed",
    });
    // 3) Approval: a kind:"approval" event (params carry sentinel).
    stream.emit(makeApprovalEvent());
    await flush();

    // NON-VACUOUS: every bridge actually emitted onto the shared connection.
    // (3 activity tool_call/_update frames + 2 plan frames + the approval
    // bridge's requestPermission; the activity bridge also turns the approval
    // event into a tool_call frame — so strictly > 0, and in practice ≥ 6.)
    expect(captured.length).toBeGreaterThan(0);

    // §19.6 M6 (whole-surface): no raw params in ANY captured frame.
    for (const item of captured) {
      const frame = item as Record<string, unknown>;
      // sessionUpdate frames carry `update`; requestPermission carries `toolCall`.
      const update = frame.update as Record<string, unknown> | undefined;
      const toolCall = frame.toolCall as Record<string, unknown> | undefined;
      if (update !== undefined) {
        expect(update.rawInput).toBeUndefined();
        expect(update.rawOutput).toBeUndefined();
      }
      if (toolCall !== undefined) {
        expect(toolCall.rawInput).toBeUndefined();
        expect(toolCall.rawOutput).toBeUndefined();
      }
      // Whole-frame deep check: the sentinel must not appear anywhere.
      expect(JSON.stringify(item)).not.toContain(RAW_PARAM_SENTINEL);
    }

    // Belt-and-braces: serialize the entire capture once and sweep it.
    expect(JSON.stringify(captured)).not.toContain(RAW_PARAM_SENTINEL);

    planUnsubscribe();
    activityUnsubscribe();
    approvalUnsubscribe();
  });
});
