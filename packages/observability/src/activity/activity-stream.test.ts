// SPDX-License-Identifier: Apache-2.0
/**
 * RED test for the ActivityStream EventBus subscriber (STRAT-07, OBS-01/02/03).
 *
 * Fails on pre-patch code: `./activity-stream.js` does not exist.
 *
 * Behavior under test:
 *   - maps tool:started → tool:executed to ordered ActivityEvents (validated by
 *     parseActivityEvent), scoped to a turn via subscribeForTurn.
 *   - subagent events map to kind:"subagent" (APV-01) — the dedicated cases live
 *     in `__tests__/activity-stream.subagent.test.ts`.
 *   - approval:requested → approval:resolved (same requestId) close the matching
 *     activity via the correlation index keyed by requestId.
 *   - subscribeForTurn delivers only events scoped to {agentId,sessionKey,traceId};
 *     ActivitySubscription.unsubscribe() detaches (no leak).
 *   - OBS-03: a non-empty redactionsApplied logs exactly ONE WARN with
 *     hint+errorKind; a malformed event logs ERROR; NO `module:` field appears.
 *   - OBS-01: counters expose emitted + dropped + redaction-replacement counts.
 */
import { describe, it, expect, vi } from "vitest";
import { TypedEventBus, registerActivityLabelSpec, themeForName, type ComisLogger } from "@comis/core";
import type { TurnActivityContext, ActivityEvent } from "@comis/core";
import { createActivityStream } from "./activity-stream.js";
import { compressLabel } from "./label-compressor.js";

const TRACE = "trace-1";
const AGENT = "agent-1";
const SESSION = "session-1";

function makeCtx(overrides: Partial<TurnActivityContext> = {}): TurnActivityContext {
  return {
    agentId: AGENT,
    sessionKey: SESSION,
    traceId: TRACE,
    channelType: "telegram",
    channelKey: "chat-9",
    chatType: "direct",
    inboundMessageId: "m-1",
    rendererKey: "agent-1:telegram:chat-9:direct",
    ...overrides,
  };
}

function makeLogger(): ComisLogger & {
  warns: unknown[][];
  errors: unknown[][];
  debugs: unknown[][];
} {
  const warns: unknown[][] = [];
  const errors: unknown[][] = [];
  const debugs: unknown[][] = [];
  const logger = {
    info: vi.fn(),
    warn: vi.fn((...a: unknown[]) => warns.push(a)),
    error: vi.fn((...a: unknown[]) => errors.push(a)),
    debug: vi.fn((...a: unknown[]) => debugs.push(a)),
    child: vi.fn(() => logger),
  } as unknown as ComisLogger & {
    warns: unknown[][];
    errors: unknown[][];
    debugs: unknown[][];
  };
  logger.warns = warns;
  logger.errors = errors;
  logger.debugs = debugs;
  return logger;
}

describe("createActivityStream (STRAT-07 / spec §5)", () => {
  it("maps tool:started then tool:executed to ordered ActivityEvents for the turn", () => {
    const bus = new TypedEventBus();
    const logger = makeLogger();
    const stream = createActivityStream({ eventBus: bus, logger });
    const received: ActivityEvent[] = [];
    const sub = stream.subscribeForTurn(makeCtx(), (e) => received.push(e));

    bus.emit("tool:started", {
      toolName: "edit",
      toolCallId: "call-1",
      timestamp: 1,
      agentId: AGENT,
      sessionKey: SESSION,
      traceId: TRACE,
    });
    bus.emit("tool:executed", {
      toolName: "edit",
      durationMs: 12,
      success: true,
      timestamp: 2,
      toolCallId: "call-1",
      agentId: AGENT,
      sessionKey: SESSION,
      traceId: TRACE,
    });

    expect(received).toHaveLength(2);
    expect(received[0].phase).toBe("start");
    expect(received[0].status).toBe("running");
    expect(received[1].phase).toBe("end");
    expect(received[1].status).toBe("completed");
    // Stable activityId across start↔end (correlated by toolCallId).
    expect(received[0].activityId).toBe(received[1].activityId);
    // Every emitted event validates against the canonical schema.
    expect(received[1].kind).toBe("tool");
    sub.unsubscribe();
  });

  it("maps a subagent spawn to a kind:'subagent' event for the matching turn (APV-01)", () => {
    const bus = new TypedEventBus();
    const logger = makeLogger();
    const stream = createActivityStream({ eventBus: bus, logger });
    const received: ActivityEvent[] = [];
    const sub = stream.subscribeForTurn(makeCtx(), (e) => received.push(e));
    bus.emit("session:sub_agent_spawned", {
      runId: "run-x",
      parentSessionKey: SESSION,
      agentId: AGENT,
      task: "do work",
      timestamp: 1,
    });
    expect(received).toHaveLength(1);
    expect(received[0].kind).toBe("subagent");
    sub.unsubscribe();
  });

  it("closes the matching activity on approval:resolved via the requestId index", () => {
    const bus = new TypedEventBus();
    const logger = makeLogger();
    const stream = createActivityStream({ eventBus: bus, logger });
    const received: ActivityEvent[] = [];
    const sub = stream.subscribeForTurn(makeCtx(), (e) => received.push(e));

    bus.emit("approval:requested", {
      requestId: "req-uuid-1",
      shortId: "abc123ABC456",
      toolName: "shell",
      action: "run",
      params: {},
      agentId: AGENT,
      sessionKey: SESSION,
      trustLevel: "external",
      createdAt: 1000,
      timeoutMs: 60000,
      traceId: TRACE,
    });
    bus.emit("approval:resolved", {
      requestId: "req-uuid-1",
      approved: true,
      approvedBy: "user",
      resolvedAt: 2000,
    });

    expect(received).toHaveLength(2);
    expect(received[0].kind).toBe("approval");
    expect(received[0].phase).toBe("start");
    expect(received[0].approval?.shortId).toBe("abc123ABC456");
    // The resolved event closes the SAME activity (matched via requestId index).
    expect(received[1].kind).toBe("approval");
    expect(received[1].phase).toBe("end");
    expect(received[1].activityId).toBe(received[0].activityId);
    expect(received[1].status).toBe("completed");
    sub.unsubscribe();
  });

  it("carries the SAME authoritative shortId on the resolved event as the start event (WR-04)", () => {
    const bus = new TypedEventBus();
    const logger = makeLogger();
    const stream = createActivityStream({ eventBus: bus, logger });
    const received: ActivityEvent[] = [];
    const sub = stream.subscribeForTurn(makeCtx(), (e) => received.push(e));

    const SHORT_ID = "Zx9Qw2Lp7Ka1"; // the CSPRNG shortId minted by the gate
    bus.emit("approval:requested", {
      requestId: "req-uuid-wr04",
      shortId: SHORT_ID,
      toolName: "shell",
      action: "run",
      params: {},
      agentId: AGENT,
      sessionKey: SESSION,
      trustLevel: "external",
      createdAt: 1000,
      timeoutMs: 60000,
      traceId: TRACE,
    });
    bus.emit("approval:resolved", {
      requestId: "req-uuid-wr04",
      approved: true,
      approvedBy: "user",
      resolvedAt: 2000,
    });

    expect(received).toHaveLength(2);
    // The resolved event must reuse the authoritative minted shortId — NOT a
    // weakly-derived placeholder. Pre-patch deriveShortId(requestId) produced a
    // value that neither matched the start event nor was unguessable.
    expect(received[1].approval?.shortId).toBe(SHORT_ID);
    expect(received[1].approval?.shortId).toBe(received[0].approval?.shortId);
    sub.unsubscribe();
  });

  it("ignores an approval:resolved with no matching index entry", () => {
    const bus = new TypedEventBus();
    const logger = makeLogger();
    const stream = createActivityStream({ eventBus: bus, logger });
    const received: ActivityEvent[] = [];
    const sub = stream.subscribeForTurn(makeCtx(), (e) => received.push(e));
    bus.emit("approval:resolved", {
      requestId: "never-seen",
      approved: false,
      approvedBy: "user",
      resolvedAt: 1,
    });
    expect(received).toHaveLength(0);
    sub.unsubscribe();
  });

  it("delivers only events scoped to the turn's {agentId,sessionKey,traceId}", () => {
    const bus = new TypedEventBus();
    const logger = makeLogger();
    const stream = createActivityStream({ eventBus: bus, logger });
    const received: ActivityEvent[] = [];
    const sub = stream.subscribeForTurn(makeCtx(), (e) => received.push(e));
    // A tool event for a DIFFERENT turn (other traceId) must NOT be delivered.
    bus.emit("tool:executed", {
      toolName: "edit",
      durationMs: 1,
      success: true,
      timestamp: 1,
      toolCallId: "x",
      agentId: AGENT,
      sessionKey: SESSION,
      traceId: "other-trace",
    });
    expect(received).toHaveLength(0);
    sub.unsubscribe();
  });

  it("unsubscribe() detaches the turn so later events are not delivered", () => {
    const bus = new TypedEventBus();
    const logger = makeLogger();
    const stream = createActivityStream({ eventBus: bus, logger });
    const received: ActivityEvent[] = [];
    const sub = stream.subscribeForTurn(makeCtx(), (e) => received.push(e));
    sub.unsubscribe();
    bus.emit("tool:executed", {
      toolName: "edit",
      durationMs: 1,
      success: true,
      timestamp: 1,
      toolCallId: "y",
      agentId: AGENT,
      sessionKey: SESSION,
      traceId: TRACE,
    });
    expect(received).toHaveLength(0);
  });

  it("logs exactly ONE WARN with hint+errorKind when redactionsApplied is non-empty (OBS-03)", () => {
    const bus = new TypedEventBus();
    const logger = makeLogger();
    // A label spec whose template substitutes a secret-keyed value triggers
    // redaction inside applyTemplate.
    registerActivityLabelSpec("deploy_tool", {
      actions: { run: { label: "deploying `{token}`", detailKeys: ["token"] } },
    });
    const stream = createActivityStream({ eventBus: bus, logger });
    const sub = stream.subscribeForTurn(makeCtx(), () => {});
    bus.emit("tool:started", {
      toolName: "deploy_tool",
      toolCallId: "call-9",
      timestamp: 1,
      action: "run",
      params: { token: "sk-ant-supersecretsupersecret" },
      agentId: AGENT,
      sessionKey: SESSION,
      traceId: TRACE,
    });
    // Exactly one WARN, carrying hint + errorKind.
    expect(logger.warns).toHaveLength(1);
    const [payload] = logger.warns[0] as [Record<string, unknown>, string];
    expect(payload.hint).toBeTypeOf("string");
    expect(payload.errorKind).toBe("validation");
    // OBS-02: NO module: field in the payload.
    expect(payload).not.toHaveProperty("module");
    sub.unsubscribe();
  });

  it("logs ERROR when a mapped event fails parseActivityEvent (OBS-03)", () => {
    const bus = new TypedEventBus();
    const logger = makeLogger();
    // Force a parse failure: a tool event missing the required toolName maps to
    // an ActivityEvent the schema rejects.
    const stream = createActivityStream({ eventBus: bus, logger });
    const received: ActivityEvent[] = [];
    const sub = stream.subscribeForTurn(makeCtx(), (e) => received.push(e));
    bus.emit("tool:executed", {
      // toolName intentionally empty → kind="tool" but the mapped event is
      // still required to validate; we corrupt the timestamp to a negative
      // durationMs which the schema's nonnegative() rejects.
      toolName: "edit",
      durationMs: -5,
      success: true,
      timestamp: 2,
      toolCallId: "call-bad",
      agentId: AGENT,
      sessionKey: SESSION,
      traceId: TRACE,
    });
    expect(logger.errors.length).toBeGreaterThan(0);
    const [payload] = logger.errors[0] as [Record<string, unknown>, string];
    expect(payload.errorKind).toBeTypeOf("string");
    expect(payload.hint).toBeTypeOf("string");
    expect(payload).not.toHaveProperty("module");
    // The malformed event is NOT delivered downstream.
    expect(received).toHaveLength(0);
    sub.unsubscribe();
  });

  it("exposes OBS-01 counters for emitted events", () => {
    const bus = new TypedEventBus();
    const logger = makeLogger();
    const stream = createActivityStream({ eventBus: bus, logger });
    const sub = stream.subscribeForTurn(makeCtx(), () => {});
    bus.emit("tool:started", {
      toolName: "edit",
      toolCallId: "c1",
      timestamp: 1,
      agentId: AGENT,
      sessionKey: SESSION,
      traceId: TRACE,
    });
    const counters = stream.counters();
    expect(counters.emitted).toBeGreaterThanOrEqual(1);
    sub.unsubscribe();
  });

  it("buffers turn events through the per-consumer bounded queue at the subscription boundary", () => {
    const bus = new TypedEventBus();
    const logger = makeLogger();
    const stream = createActivityStream({ eventBus: bus, logger });
    const received: ActivityEvent[] = [];
    const sub = stream.subscribeForTurn(makeCtx(), (e) => received.push(e));
    // Many distinct tool calls within one turn: each routes through the
    // subscriber's bounded queue (spec §5.1) and is delivered in order.
    for (let i = 0; i < 100; i++) {
      bus.emit("tool:started", {
        toolName: "edit",
        toolCallId: `c-${i}`,
        timestamp: i,
        agentId: AGENT,
        sessionKey: SESSION,
        traceId: TRACE,
      });
    }
    expect(received).toHaveLength(100);
    expect(stream.counters().emitted).toBe(100);
    // No drops under a draining consumer; the drop counter is the OBS-01 sink.
    expect(stream.counters().dropped).toBe(0);
    sub.unsubscribe();
  });
});

describe("ActivityStream themed status markers (UX-01)", () => {
  /** Emit one subagent spawn and return the single produced ActivityEvent. */
  function spawnSubagentLabel(theme?: ReturnType<typeof themeForName>): ActivityEvent {
    const bus = new TypedEventBus();
    const stream = createActivityStream({
      eventBus: bus,
      ...(theme !== undefined ? { theme } : {}),
    });
    const received: ActivityEvent[] = [];
    const sub = stream.subscribeForTurn(makeCtx(), (e) => received.push(e));
    bus.emit("session:sub_agent_spawned", {
      runId: "run-themed",
      parentSessionKey: SESSION,
      agentId: AGENT,
      task: "do work",
      timestamp: 1,
    });
    sub.unsubscribe();
    expect(received).toHaveLength(1);
    return received[0];
  }

  it("ascii theme strips the robot emoji from the subagent label", () => {
    const event = spawnSubagentLabel(themeForName("ascii"));
    // ascii subagent marker is the bracketed pure-ASCII tag [SUB] (75-01).
    expect(event.defaultLabel).toBe(`[SUB] ${AGENT} subagent`);
    expect(event.defaultLabel).not.toContain("🤖");
    expect(event.defaultLabel ?? "").not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("playful theme subagent marker differs from the ascii subagent marker", () => {
    const playful = spawnSubagentLabel(themeForName("playful"));
    const ascii = spawnSubagentLabel(themeForName("ascii"));
    // Same event, different theme → different rendered marker (themes are real).
    expect(playful.defaultLabel).not.toBe(ascii.defaultLabel);
    expect(playful.defaultLabel).toContain(themeForName("playful").markers?.subagent ?? "");
  });

  it("default theme preserves the robot emoji subagent label byte-identically", () => {
    const event = spawnSubagentLabel(themeForName("default"));
    expect(event.defaultLabel).toBe(`🤖 ${AGENT} subagent`);
  });

  it("no theme preserves the robot emoji subagent label byte-identically", () => {
    // Default-parity: a markerless construction is byte-identical to today's
    // hardcoded glyph, so existing channel golden fixtures (71-73) do not regress.
    const event = spawnSubagentLabel();
    expect(event.defaultLabel).toBe(`🤖 ${AGENT} subagent`);
  });

  it("ascii theme strips the robot emoji from the completed-subagent label too", () => {
    const bus = new TypedEventBus();
    const stream = createActivityStream({ eventBus: bus, theme: themeForName("ascii") });
    const received: ActivityEvent[] = [];
    const sub = stream.subscribeForTurn(makeCtx(), (e) => received.push(e));
    // Spawn THEN complete the same runId (completed requires a prior spawn).
    bus.emit("session:sub_agent_spawned", {
      runId: "run-complete",
      parentSessionKey: SESSION,
      agentId: AGENT,
      task: "do work",
      timestamp: 1,
    });
    bus.emit("session:sub_agent_completed", {
      runId: "run-complete",
      agentId: AGENT,
      success: true,
      runtimeMs: 42,
      timestamp: 2,
    });
    sub.unsubscribe();
    expect(received).toHaveLength(2);
    expect(received[1].phase).toBe("end");
    expect(received[1].defaultLabel).toBe(`[SUB] ${AGENT} subagent`);
    expect(received[1].defaultLabel).not.toContain("🤖");
  });
});

describe("SEC-05 -- failure paths leak nothing", () => {
  // Neutral placeholders (AGENTS.md §2.2): an obviously-fake secret token and a
  // non-routable example host. These ride on the model-fallback payload's `error`
  // field — the field the stream must NEVER read into a label.
  const FAKE_SECRET = "sk-ant-api03-EXAMPLESECRET";
  const FAKE_HOST = "internal.host.example.com";

  it("model fallback label omits the secret and host from the payload error", () => {
    const bus = new TypedEventBus();
    const logger = makeLogger();
    const stream = createActivityStream({ eventBus: bus, logger });
    const received: ActivityEvent[] = [];
    const sub = stream.subscribeForTurn(makeCtx(), (e) => received.push(e));
    // A provider error body carrying BOTH a secret-shaped token and a hostname.
    bus.emit("model:fallback_attempt", {
      fromProvider: "anthropic",
      fromModel: "claude-x",
      toProvider: "openai",
      toModel: "gpt-y",
      error: `401 from ${FAKE_HOST}: invalid key ${FAKE_SECRET}`,
      attemptNumber: 1,
      timestamp: 1,
      agentId: AGENT,
      sessionKey: SESSION,
      traceId: TRACE,
    });
    expect(received).toHaveLength(1);
    const modelEvent = received[0];
    // The label is STATIC — it never reflects p.error (onModelEvent). Phase 78
    // WS-B (SPEC-§3.1) bakes the running marker prefix at the emit site, so the
    // default-theme rendering is `🔧 switching model provider`. Still STATIC —
    // no leak of p.error.
    expect(modelEvent.defaultLabel).toBe("🔧 switching model provider");
    // Defense-in-depth: the WHOLE serialized event leaks neither secret nor host.
    // (Would FAIL if a future edit read p.error into the label or any field.)
    expect(JSON.stringify(modelEvent)).not.toContain(FAKE_SECRET);
    expect(JSON.stringify(modelEvent)).not.toContain(FAKE_HOST);
    sub.unsubscribe();
  });

  it("policy filtered event produces no activity so the denyEntry never renders", () => {
    const bus = new TypedEventBus();
    const logger = makeLogger();
    const stream = createActivityStream({ eventBus: bus, logger });
    const received: ActivityEvent[] = [];
    const sub = stream.subscribeForTurn(makeCtx(), (e) => received.push(e));
    const before = received.length;
    // The emit-site `reason` embeds a host-shaped denyEntry (tool-bridge.ts) — the
    // Pitfall-5 leak vector. tool:policy_filtered is deliberately NOT in
    // SUBSCRIBED_EVENTS, so it maps to ZERO ActivityEvents and the denyEntry never
    // reaches any rendered label. (Would FAIL if it were subscribed.)
    bus.emit("tool:policy_filtered", {
      profile: "default",
      agentId: AGENT,
      filtered: [
        { toolName: "web_fetch", reason: "explicit_deny:*.internal.example.com" },
      ],
      timestamp: 1,
    });
    const after = received.length;
    expect(after).toBe(before);
    expect(received).toHaveLength(0);
    sub.unsubscribe();
  });

  it("failed tool event carries no stack frame to the renderer", () => {
    const bus = new TypedEventBus();
    const logger = makeLogger();
    const stream = createActivityStream({ eventBus: bus, logger });
    const received: ActivityEvent[] = [];
    const sub = stream.subscribeForTurn(makeCtx(), (e) => received.push(e));
    // A failed tool: the bridge emits a sanitized errorKind + (capped)
    // errorMessage, NEVER a raw error object/stack. Pin that the produced event's
    // serialized surface carries no stack frame. (Would FAIL if a raw error/stack
    // were forwarded into the event.)
    bus.emit("tool:executed", {
      toolName: "shell",
      durationMs: 5,
      success: false,
      timestamp: 1,
      toolCallId: "call-fail",
      errorKind: "internal",
      agentId: AGENT,
      sessionKey: SESSION,
      traceId: TRACE,
    });
    expect(received).toHaveLength(1);
    const failedEvent = received[0];
    expect(failedEvent.status).toBe("failed");
    // No `at <fn> file.ts:NN` stack-frame substring anywhere in the event.
    expect(JSON.stringify(failedEvent)).not.toMatch(/\bat .*\.(ts|js):\d+/);
    sub.unsubscribe();
  });
});

describe("buildLabel compresses the post-redaction defaultLabel (UX-02 wiring)", () => {
  /** Register a tool spec and emit a tool:started for it; return the produced event. */
  function renderToolLabel(
    toolName: string,
    spec: Parameters<typeof registerActivityLabelSpec>[1],
    params: Record<string, unknown> = {},
    deps: { homeDir?: string } = {},
  ): ActivityEvent {
    registerActivityLabelSpec(toolName, spec);
    const bus = new TypedEventBus();
    const stream = createActivityStream({
      eventBus: bus,
      ...(deps.homeDir !== undefined ? { homeDir: deps.homeDir } : {}),
    });
    const received: ActivityEvent[] = [];
    const sub = stream.subscribeForTurn(makeCtx(), (e) => received.push(e));
    bus.emit("tool:started", {
      toolName,
      toolCallId: `tc-${toolName}`,
      timestamp: 1,
      action: "run",
      params,
      agentId: AGENT,
      sessionKey: SESSION,
      traceId: TRACE,
    });
    sub.unsubscribe();
    expect(received).toHaveLength(1);
    return received[0];
  }

  it("compresses an iso timestamp surfaced in a rendered tool label", () => {
    // A static label carrying an ISO-8601 timestamp flows through applyTemplate
    // (no params → no redaction change) then compressLabel → HH:MM:SS only.
    // Phase 78 WS-B (SPEC-§3.1) bakes `${markers.running} ` at the emit site,
    // so the default-theme rendered label is `🔧 snapshot at 18:42:00`.
    const event = renderToolLabel("ux02_ts_tool", {
      actions: { run: { label: "snapshot at 2025-05-22T18:42:00.123Z", detailKeys: [] } },
    });
    expect(event.defaultLabel).toBe("🔧 snapshot at 18:42:00");
    expect(event.defaultLabel).not.toContain("T18:42:00");
    expect(event.defaultLabel).not.toContain(".123Z");
  });

  it("leaves a redact-compacted path untouched in the rendered label", () => {
    // Pitfall 2 / redact-then-compress order: redactValue compacts the absolute
    // path ($HOME→~, last-2-segments) BEFORE compressLabel runs; the compressor
    // must treat that as a fixed point and NOT re-trim it. Phase 78 WS-B then
    // prepends `${markers.running} ` at the emit site (subagent precedent at
    // activity-stream.ts:602/621) — the compaction body is unchanged.
    const event = renderToolLabel(
      "ux02_path_tool",
      { actions: { run: { label: "reading {path}", detailKeys: ["path"] } } },
      { path: "/Users/me/comis/packages/observability/src/activity/activity-stream.ts" },
      { homeDir: "/Users/me" },
    );
    expect(event.defaultLabel).toBe("🔧 reading ~activity/activity-stream.ts");
    // The compressed sub-string (sans marker prefix) remains a fixed point.
    expect(compressLabel("reading ~activity/activity-stream.ts")).toBe(
      "reading ~activity/activity-stream.ts",
    );
  });

  it("rendered label compressed body is a fixed point of compressLabel (idempotent at the call site)", () => {
    // A second compressor pass over the rendered label's body (sans marker
    // prefix) is a no-op — proves the wiring did not break the one-pass
    // idempotency contract. Phase 78 WS-B prepends the running marker AFTER
    // compressLabel, so we strip the marker prefix before asserting the
    // compressor fixed-point property.
    const event = renderToolLabel("ux02_idem_tool", {
      actions: { run: { label: "fetched at 2025-05-22T18:42:00.123Z", detailKeys: [] } },
    });
    const body = (event.defaultLabel ?? "").replace(/^🔧 /, "");
    expect(compressLabel(body)).toBe(body);
  });

  it("leaves a plain semantic label byte-identical after wiring (no-op)", () => {
    // A plain label (no URL/timestamp/long-mcp-name) is unchanged by the
    // compressor — no regression for existing label tests/fixtures. Phase 78
    // WS-B prepends the running marker at the emit site.
    const event = renderToolLabel("ux02_plain_tool", {
      actions: { run: { label: "reading file", detailKeys: [] } },
    });
    expect(event.defaultLabel).toBe("🔧 reading file");
  });
});

describe("activity-stream — markers.running prefix on phase:start (Phase 78 WS-B / SPEC-§3.1)", () => {
  /**
   * Helper: build an ActivityStream (optional theme), emit a single bus event,
   * return the produced ActivityEvent(s) for the turn. Mirrors the existing
   * `spawnSubagentLabel` and `renderToolLabel` factories above — no new
   * boilerplate; reuses `makeCtx` / `makeLogger` / TRACE / AGENT / SESSION.
   */
  function streamWith(theme?: ReturnType<typeof themeForName>): {
    bus: TypedEventBus;
    received: ActivityEvent[];
    sub: { unsubscribe(): void };
  } {
    const bus = new TypedEventBus();
    const stream = createActivityStream({
      eventBus: bus,
      ...(theme !== undefined ? { theme } : {}),
    });
    const received: ActivityEvent[] = [];
    const sub = stream.subscribeForTurn(makeCtx(), (e) => received.push(e));
    return { bus, received, sub };
  }

  it("onToolStarted emits defaultLabel with markers.running prefix under default theme — SPEC-§3.1", () => {
    // Default theme (no explicit theme arg → DEFAULT_MARKERS). The `read` tool
    // has no LabelSpec registered here, so buildLabel falls back to the
    // humanized tool name ("read"). The stream MUST prefix `🔧 ` at the emit
    // site (subagent precedent mirror at activity-stream.ts:602/621).
    const { bus, received, sub } = streamWith();
    bus.emit("tool:started", {
      toolName: "read",
      toolCallId: "tc1",
      timestamp: 1,
      params: { path: "/tmp/x" },
      agentId: AGENT,
      sessionKey: SESSION,
      traceId: TRACE,
    });
    expect(received).toHaveLength(1);
    const event = received[0];
    expect(event.phase).toBe("start");
    expect(event.kind).toBe("tool");
    expect(event.defaultLabel?.startsWith("🔧 ")).toBe(true);
    expect(event.defaultLabel).toBe("🔧 read");
    sub.unsubscribe();
  });

  it("onToolStarted emits defaultLabel with [..] prefix under ascii theme — SPEC-§3.1 + §8.9", () => {
    // Ascii theme strips ALL Unicode > U+007F (themes/ascii.ts:8 LOCKED FACT).
    // The marker `[..]` is pure ASCII; combined with the fallback tool name
    // "read" the entire defaultLabel must be strictly ASCII.
    const { bus, received, sub } = streamWith(themeForName("ascii"));
    bus.emit("tool:started", {
      toolName: "read",
      toolCallId: "tc1",
      timestamp: 1,
      params: { path: "/tmp/x" },
      agentId: AGENT,
      sessionKey: SESSION,
      traceId: TRACE,
    });
    expect(received).toHaveLength(1);
    const event = received[0];
    expect(event.defaultLabel?.startsWith("[..] ")).toBe(true);
    expect(event.defaultLabel).toBe("[..] read");
    // Strict ASCII — no Unicode > U+007F anywhere in the label.
    expect(/[^\x00-\x7F]/.test(event.defaultLabel ?? "")).toBe(false);
    sub.unsubscribe();
  });

  it("onModelEvent prefixes the static 'switching model provider' label with markers.running", () => {
    // The model event's defaultLabel is a STATIC string in activity-stream.ts
    // (line ~520). Under default theme it must become `🔧 switching model
    // provider`. Pre-patch produces just `switching model provider`.
    const { bus, received, sub } = streamWith();
    bus.emit("model:fallback_attempt", {
      fromProvider: "anthropic",
      fromModel: "claude-x",
      toProvider: "openai",
      toModel: "gpt-y",
      error: "boom",
      attemptNumber: 1,
      timestamp: 1,
      agentId: AGENT,
      sessionKey: SESSION,
      traceId: TRACE,
    });
    expect(received).toHaveLength(1);
    const event = received[0];
    expect(event.kind).toBe("model");
    expect(event.defaultLabel).toBe("🔧 switching model provider");
    sub.unsubscribe();
  });

  it("onToolExecuted (phase:end) does NOT prefix markers.running — Pitfall 7 invariant", () => {
    // The running marker conveys "in flight" — applying it to a completed
    // (phase:"end") event mis-conveys status. Pitfall 7 from RESEARCH.md lines
    // 818-826: tool:executed dispatch MUST NEVER carry the running marker.
    // This is a regression-lock: passes against current code (no marker
    // anywhere) AND must continue passing after the GREEN patch lands the
    // marker only on the two phase:"start"/"progress" dispatch sites.
    const { bus, received, sub } = streamWith();
    bus.emit("tool:executed", {
      toolName: "read",
      toolCallId: "tc1",
      durationMs: 12,
      success: true,
      timestamp: 2,
      params: { path: "/tmp/x" },
      agentId: AGENT,
      sessionKey: SESSION,
      traceId: TRACE,
    });
    expect(received).toHaveLength(1);
    const event = received[0];
    expect(event.phase).toBe("end");
    expect(event.status).toBe("completed");
    expect(
      event.defaultLabel?.startsWith("🔧"),
      "phase:\"end\" events MUST NOT carry markers.running (Pitfall 7)",
    ).toBe(false);
    expect(
      event.defaultLabel,
      "phase:\"end\" events MUST NOT carry markers.running (Pitfall 7)",
    ).not.toMatch(/🔧/);
    sub.unsubscribe();
  });

  it("marker resolution captures the markers reference at stream construction — replacing deps.theme.markers post-construction is ignored", () => {
    // Pattern 2 contract (RESEARCH §Q2 + threat T-78-02-02): the implementation
    // at activity-stream.ts:198 does `const markers = deps.theme?.markers ??
    // DEFAULT_MARKERS;` — capturing the markers OBJECT REFERENCE once. Any
    // subsequent re-assignment of `deps.theme.markers` to a NEW object MUST be
    // invisible to the closure (it still holds the original reference).
    //
    // NOTE: mutating an inner field on the captured object (e.g. `markers
    // .running = "X"`) is observable today by design — the subagent precedent
    // at lines 602/621 reads `markers.subagent` lazily via the same closure.
    // The test below pins the reference-capture invariant (the strongest one
    // the current code guarantees).
    const bus = new TypedEventBus();
    const themeRef = {
      markers: {
        success: "[OK]",
        failure: "[ERR]",
        subagent: "[SUB]",
        running: "[..]",
      },
    } as { markers: { success: string; failure: string; subagent: string; running: string } };
    const stream = createActivityStream({
      eventBus: bus,
      theme: themeRef as unknown as ReturnType<typeof themeForName>,
    });
    const received: ActivityEvent[] = [];
    const sub = stream.subscribeForTurn(makeCtx(), (e) => received.push(e));

    // First emit before any mutation — assert baseline ascii prefix.
    bus.emit("tool:started", {
      toolName: "read",
      toolCallId: "tc-before",
      timestamp: 1,
      params: {},
      agentId: AGENT,
      sessionKey: SESSION,
      traceId: TRACE,
    });
    expect(received).toHaveLength(1);
    expect(received[0].defaultLabel?.startsWith("[..] ")).toBe(true);

    // Replace the markers OBJECT REFERENCE on the deps-supplied theme. The
    // closure captured the original reference at line 198 and ignores this.
    themeRef.markers = {
      success: "NEW-OK",
      failure: "NEW-ERR",
      subagent: "NEW-SUB",
      running: "NEW-RUN",
    };

    bus.emit("tool:started", {
      toolName: "read",
      toolCallId: "tc-after",
      timestamp: 2,
      params: {},
      agentId: AGENT,
      sessionKey: SESSION,
      traceId: TRACE,
    });
    expect(received).toHaveLength(2);
    // The post-mutation event MUST still carry the original-captured ascii prefix.
    expect(received[1].defaultLabel?.startsWith("[..] ")).toBe(true);
    expect(received[1].defaultLabel).not.toContain("NEW-RUN");
    sub.unsubscribe();
  });
});
