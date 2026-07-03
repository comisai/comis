// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import type { EventMap } from "./events.js";
import { TypedEventBus } from "./bus.js";

describe("InfraEvents payload structure", () => {
  it("approval:requested delivers requestId, toolName, params, timeoutMs, shortId", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["approval:requested"] = {
      requestId: "req-001",
      shortId: "abc123ABC456",
      toolName: "bash",
      action: "execute",
      params: { command: "rm -rf /tmp/test" },
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      trustLevel: "standard",
      createdAt: Date.now(),
      timeoutMs: 30000,
    };

    bus.on("approval:requested", handler);
    bus.emit("approval:requested", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["approval:requested"];
    expect(received.requestId).toBe("req-001");
    expect(received.shortId).toBe("abc123ABC456");
    expect(received.toolName).toBe("bash");
    expect(received.params).toEqual({ command: "rm -rf /tmp/test" });
    expect(received.timeoutMs).toBe(30000);
  });

  // -------------------------------------------------------------------------
  // Agent Transparency — approval:requested shortId/traceId
  //
  // The gate mints a short, renderer-safe id and emits it on
  // approval:requested. shortId is REQUIRED; traceId is
  // optional because restorePending() preserves shortId but may omit traceId.
  // The SOLE emit site (approval-gate.ts) supplies shortId — this schema only
  // declares the required field.
  // -------------------------------------------------------------------------

  it("approval:requested requires shortId and accepts an optional traceId", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["approval:requested"] = {
      requestId: "req-evt05",
      shortId: "abc123ABC456",
      traceId: "t1",
      toolName: "config_manage",
      action: "set",
      params: { key: "x" },
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      trustLevel: "standard",
      createdAt: Date.now(),
      timeoutMs: 30000,
    };

    bus.on("approval:requested", handler);
    bus.emit("approval:requested", payload);

    const received = handler.mock.calls[0]![0] as EventMap["approval:requested"];
    expect(received.shortId).toBe("abc123ABC456");
    expect(received.traceId).toBe("t1");
  });

  it("approval:requested restored shape carries shortId without traceId", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    // restorePending() preserves shortId but may omit traceId.
    const restored: EventMap["approval:requested"] = {
      requestId: "req-restored",
      shortId: "ZYX987zyx654",
      toolName: "bash",
      action: "execute",
      params: {},
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      trustLevel: "standard",
      createdAt: Date.now(),
      timeoutMs: 30000,
    };

    bus.on("approval:requested", handler);
    bus.emit("approval:requested", restored);

    const received = handler.mock.calls[0]![0] as EventMap["approval:requested"];
    expect(received.shortId).toBe("ZYX987zyx654");
    expect(received.traceId).toBeUndefined();
  });

  it("approval:requested rejects a payload missing shortId at the type level", () => {
    const bus = new TypedEventBus();
    // @ts-expect-error - shortId is now required on approval:requested
    bus.emit("approval:requested", {
      requestId: "req-no-short",
      toolName: "bash",
      action: "execute",
      params: {},
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      trustLevel: "standard",
      createdAt: Date.now(),
      timeoutMs: 30000,
    });
  });

  it("approval:resolved delivers approved boolean and optional reason", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();

    // Approved case
    const approvedPayload: EventMap["approval:resolved"] = {
      requestId: "req-001",
      approved: true,
      approvedBy: "admin",
      resolvedAt: Date.now(),
    };
    bus.on("approval:resolved", handler);
    bus.emit("approval:resolved", approvedPayload);

    expect(handler.mock.calls[0]![0].approved).toBe(true);
    expect(handler.mock.calls[0]![0].reason).toBeUndefined();

    // Denied case with reason
    const deniedPayload: EventMap["approval:resolved"] = {
      requestId: "req-002",
      approved: false,
      approvedBy: "system",
      reason: "Timed out after 30s",
      resolvedAt: Date.now(),
    };
    bus.emit("approval:resolved", deniedPayload);

    expect(handler.mock.calls[1]![0].approved).toBe(false);
    expect(handler.mock.calls[1]![0].reason).toBe("Timed out after 30s");
  });

  it("config:patched delivers section, optional key, patchedBy", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();

    // With key
    const payload: EventMap["config:patched"] = {
      section: "agent",
      key: "model",
      patchedBy: "admin",
      timestamp: Date.now(),
    };
    bus.on("config:patched", handler);
    bus.emit("config:patched", payload);
    expect(handler.mock.calls[0]![0].key).toBe("model");

    // Without key
    const noKeyPayload: EventMap["config:patched"] = {
      section: "channels",
      patchedBy: "rpc",
      timestamp: Date.now(),
    };
    bus.emit("config:patched", noKeyPayload);
    expect(handler.mock.calls[1]![0].key).toBeUndefined();
  });

  // The "plugin:registered" and "hook:executed" payload-shape tests were
  // deleted alongside the events. The events had zero non-test subscribers;
  // tests that needed plugin lifecycle now query PluginRegistry state directly.

  it("auth:token_rotated delivers provider and expiresAtMs", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const expiresAt = Date.now() + 3600000;
    const payload: EventMap["auth:token_rotated"] = {
      provider: "google",
      profileId: "google:gmail-oauth",
      expiresAtMs: expiresAt,
      timestamp: Date.now(),
    };

    bus.on("auth:token_rotated", handler);
    bus.emit("auth:token_rotated", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["auth:token_rotated"];
    expect(received.provider).toBe("google");
    expect(received.expiresAtMs).toBe(expiresAt);
  });

  it("diagnostic:message_processed delivers all timing fields, tokensUsed, cost, finishReason", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const now = Date.now();
    const payload: EventMap["diagnostic:message_processed"] = {
      messageId: "msg-001",
      channelId: "c1",
      channelType: "telegram",
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      receivedAt: now - 3000,
      executionDurationMs: 2500,
      deliveryDurationMs: 200,
      totalDurationMs: 2700,
      tokensUsed: 1500,
      cost: 0.018,
      success: true,
      finishReason: "end_turn",
      timestamp: now,
    };

    bus.on("diagnostic:message_processed", handler);
    bus.emit("diagnostic:message_processed", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["diagnostic:message_processed"];
    expect(received.receivedAt).toBe(now - 3000);
    expect(received.executionDurationMs).toBe(2500);
    expect(received.deliveryDurationMs).toBe(200);
    expect(received.totalDurationMs).toBe(2700);
    expect(received.tokensUsed).toBe(1500);
    expect(received.cost).toBe(0.018);
    expect(received.finishReason).toBe("end_turn");
  });

  it("diagnostic:channel_health delivers channels array with nested objects", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["diagnostic:channel_health"] = {
      channels: [
        {
          channelId: "tg-1",
          channelType: "telegram",
          lastActiveAt: Date.now() - 60000,
          messagesSent: 150,
          messagesReceived: 300,
        },
        {
          channelId: "dc-1",
          channelType: "discord",
          lastActiveAt: Date.now() - 120000,
          messagesSent: 50,
          messagesReceived: 100,
        },
      ],
      timestamp: Date.now(),
    };

    bus.on("diagnostic:channel_health", handler);
    bus.emit("diagnostic:channel_health", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["diagnostic:channel_health"];
    expect(received.channels).toHaveLength(2);
    expect(received.channels[0]!.channelType).toBe("telegram");
    expect(received.channels[0]!.messagesSent).toBe(150);
    expect(received.channels[1]!.channelType).toBe("discord");
  });

  it("media:file_extracted delivers fileName, mimeType, chars, truncated, durationMs", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["media:file_extracted"] = {
      fileName: "report.pdf",
      mimeType: "application/pdf",
      chars: 25000,
      truncated: true,
      durationMs: 850,
      timestamp: Date.now(),
    };

    bus.on("media:file_extracted", handler);
    bus.emit("media:file_extracted", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["media:file_extracted"];
    expect(received.fileName).toBe("report.pdf");
    expect(received.mimeType).toBe("application/pdf");
    expect(received.chars).toBe(25000);
    expect(received.truncated).toBe(true);
    expect(received.durationMs).toBe(850);
  });

  it("scheduler:job_result delivers nested deliveryTarget and optional payloadKind union", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();

    // With payloadKind
    const payload: EventMap["scheduler:job_result"] = {
      jobId: "job-001",
      jobName: "daily-summary",
      agentId: "agent-1",
      result: "Daily summary generated successfully",
      success: true,
      deliveryTarget: {
        channelId: "c1",
        userId: "u1",
        tenantId: "t1",
        channelType: "telegram",
      },
      timestamp: Date.now(),
      payloadKind: "agent_turn",
    };

    bus.on("scheduler:job_result", handler);
    bus.emit("scheduler:job_result", payload);

    const received = handler.mock.calls[0]![0] as EventMap["scheduler:job_result"];
    expect(received.deliveryTarget.channelId).toBe("c1");
    expect(received.deliveryTarget.userId).toBe("u1");
    expect(received.deliveryTarget.tenantId).toBe("t1");
    expect(received.deliveryTarget.channelType).toBe("telegram");
    expect(received.payloadKind).toBe("agent_turn");
    expect(received.onComplete).toBeUndefined(); // optional field

    // With onComplete callback
    const completeSpy = vi.fn();
    const withCallback: EventMap["scheduler:job_result"] = {
      ...payload,
      jobId: "job-001b",
      onComplete: completeSpy,
    };
    bus.emit("scheduler:job_result", withCallback);
    const receivedWithCb = handler.mock.calls[1]![0] as EventMap["scheduler:job_result"];
    receivedWithCb.onComplete?.({ status: "error", error: "overloaded" });
    expect(completeSpy).toHaveBeenCalledWith({ status: "error", error: "overloaded" });

    // Without payloadKind
    const noKindPayload: EventMap["scheduler:job_result"] = {
      jobId: "job-002",
      jobName: "heartbeat",
      agentId: "agent-1",
      result: "OK",
      success: true,
      deliveryTarget: { channelId: "c2", userId: "u2", tenantId: "t1" },
      timestamp: Date.now(),
    };
    bus.emit("scheduler:job_result", noKindPayload);
    expect(handler.mock.calls[2]![0].payloadKind).toBeUndefined();
  });

  it("scheduler:job_result accepts cronJobModel field", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();

    const payload: EventMap["scheduler:job_result"] = {
      jobId: "j1",
      jobName: "test-cron",
      agentId: "a1",
      result: "ok",
      success: true,
      deliveryTarget: { channelId: "c1", userId: "u1", tenantId: "t1" },
      timestamp: Date.now(),
      payloadKind: "agent_turn",
      cronJobModel: "anthropic:claude-haiku-4-5-20251001",
    };

    bus.on("scheduler:job_result", handler);
    bus.emit("scheduler:job_result", payload);

    const received = handler.mock.calls[0]![0] as EventMap["scheduler:job_result"];
    expect(received.cronJobModel).toBe("anthropic:claude-haiku-4-5-20251001");

    // Without cronJobModel (undefined)
    const noCronModel: EventMap["scheduler:job_result"] = {
      jobId: "j2",
      jobName: "sys-event",
      agentId: "a1",
      result: "text",
      success: true,
      deliveryTarget: { channelId: "c1", userId: "u1", tenantId: "t1" },
      timestamp: Date.now(),
      payloadKind: "system_event",
    };
    bus.emit("scheduler:job_result", noCronModel);
    expect(handler.mock.calls[1]![0].cronJobModel).toBeUndefined();
  });

  it("observability:metrics delivers nested eventLoopDelayMs with min/max/mean/p50/p99", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["observability:metrics"] = {
      rssBytes: 104857600,
      heapUsedBytes: 52428800,
      heapTotalBytes: 78643200,
      externalBytes: 1048576,
      eventLoopDelayMs: {
        min: 0.1,
        max: 15.5,
        mean: 1.2,
        p50: 0.8,
        p99: 12.3,
      },
      activeHandles: 42,
      uptimeSeconds: 3600,
      timestamp: Date.now(),
    };

    bus.on("observability:metrics", handler);
    bus.emit("observability:metrics", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["observability:metrics"];
    expect(received.eventLoopDelayMs.min).toBe(0.1);
    expect(received.eventLoopDelayMs.max).toBe(15.5);
    expect(received.eventLoopDelayMs.mean).toBe(1.2);
    expect(received.eventLoopDelayMs.p50).toBe(0.8);
    expect(received.eventLoopDelayMs.p99).toBe(12.3);
    expect(received.rssBytes).toBe(104857600);
    expect(received.activeHandles).toBe(42);
  });

  // There is deliberately NO "system:shutdown" event in InfraEvents — a bus
  // event here invites subscriber-without-emitter drift, where every teardown
  // silently no-ops until systemd KillMode reaps the process. Teardown
  // wiring flows directly through setupShutdown's ShutdownDeps (see
  // packages/daemon/src/wiring/setup-shutdown.ts), so no payload-shape test
  // exists for it.

  it("system:error delivers Error instance and source string", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const testError = new Error("Unhandled rejection");
    const payload: EventMap["system:error"] = {
      error: testError,
      source: "unhandledRejection",
    };

    bus.on("system:error", handler);
    bus.emit("system:error", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["system:error"];
    expect(received.error).toBeInstanceOf(Error);
    expect(received.error.message).toBe("Unhandled rejection");
    expect(received.source).toBe("unhandledRejection");
  });

  it("secret:accessed delivers outcome union", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();

    for (const outcome of ["success", "denied", "not_found"] as const) {
      const payload: EventMap["secret:accessed"] = {
        secretName: "OPENAI_API_KEY",
        agentId: "agent-1",
        outcome,
        timestamp: Date.now(),
      };
      bus.on("secret:accessed", handler);
      bus.emit("secret:accessed", payload);
      bus.removeAllListeners("secret:accessed");
    }

    expect(handler).toHaveBeenCalledTimes(3);
    expect(handler.mock.calls[0]![0].outcome).toBe("success");
    expect(handler.mock.calls[1]![0].outcome).toBe("denied");
    expect(handler.mock.calls[2]![0].outcome).toBe("not_found");
  });

  it('broker:denied delivers "body_too_large" reason', () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["broker:denied"] = {
      sessionId: "sess-1",
      host: "api.example.com",
      reason: "body_too_large",
      statusCode: 413,
      timestamp: Date.now(),
    };
    bus.on("broker:denied", handler);
    bus.emit("broker:denied", payload);
    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["broker:denied"];
    expect(received.reason).toBe("body_too_large");
    expect(received.statusCode).toBe(413);
  });

  it('broker:denied delivers "ws_upgrade_not_supported" reason with statusCode 501', () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    // Compile-time assertion: the literal "ws_upgrade_not_supported" must be
    // assignable to the reason union declared in events-infra.ts. If the union
    // is missing this member the TypeScript compiler rejects the payload type
    // annotation below — that is the failing RED proof.
    const payload: EventMap["broker:denied"] = {
      sessionId: "sess-ws",
      host: "api.example.com",
      reason: "ws_upgrade_not_supported",
      statusCode: 501,
      timestamp: Date.now(),
    };
    bus.on("broker:denied", handler);
    bus.emit("broker:denied", payload);
    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["broker:denied"];
    expect(received.reason).toBe("ws_upgrade_not_supported");
    expect(received.statusCode).toBe(501);
  });

  it("security:warn delivers category, agentId, message", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["security:warn"] = {
      category: "secret_access",
      agentId: "agent-1",
      message: "Agent accessing secrets without explicit allow config",
      timestamp: Date.now(),
    };

    bus.on("security:warn", handler);
    bus.emit("security:warn", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["security:warn"];
    expect(received.category).toBe("secret_access");
    expect(received.agentId).toBe("agent-1");
    expect(received.message).toBe("Agent accessing secrets without explicit allow config");
  });

  it("mcp:server:result_truncated delivers server, tool, sizes, traceId, timestamp", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["mcp:server:result_truncated"] = {
      server: "db-server",
      tool: "search",
      originalSize: 60_000,
      truncatedSize: 50_000,
      traceId: "11111111-1111-1111-1111-111111111111",
      timestamp: Date.now(),
    };

    bus.on("mcp:server:result_truncated", handler);
    bus.emit("mcp:server:result_truncated", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["mcp:server:result_truncated"];
    expect(received.server).toBe("db-server");
    expect(received.tool).toBe("search");
    expect(received.originalSize).toBe(60_000);
    expect(received.truncatedSize).toBe(50_000);
    expect(received.truncatedSize).toBeLessThan(received.originalSize);
    expect(received.traceId).toBe("11111111-1111-1111-1111-111111111111");
    expect(typeof received.timestamp).toBe("number");
  });

  it("type safety: @ts-expect-error for missing required fields", () => {
    const bus = new TypedEventBus();

    // @ts-expect-error - missing timeoutMs in approval:requested
    bus.emit("approval:requested", {
      requestId: "r", toolName: "t", action: "a",
      params: {}, agentId: "a", sessionKey: "s",
      trustLevel: "x", createdAt: 1,
    });

    // @ts-expect-error - missing eventLoopDelayMs in observability:metrics
    bus.emit("observability:metrics", {
      rssBytes: 0, heapUsedBytes: 0, heapTotalBytes: 0,
      externalBytes: 0, activeHandles: 0, uptimeSeconds: 0, timestamp: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// scheduler:wake_gate — the content-free pre-run wake-gate signal.
//
// The gate runs an untrusted, model-authored script off-turn; its gathered
// payload / script source / secrets must NEVER cross into the event's fields.
// The type is the enforcement point — a producer cannot emit a field the type
// does not declare. This block pins the shape to counts/enums/ids ONLY and
// goes RED if a payload-bearing field is ever added to the declaration.
// ---------------------------------------------------------------------------
describe("scheduler:wake_gate content-free event", () => {
  const source = readFileSync(new URL("./events-infra.ts", import.meta.url), "utf8");

  /** The counts/enums/ids allowlist — the ONLY keys the payload may carry
   *  (kept in sorted order to compare directly against Object.keys().sort()). */
  const ALLOWED_KEYS = [
    "agentId",
    "durationMs",
    "estTurnsSaved",
    "jobId",
    "timestamp",
    "toolCalls",
    "wake",
  ] as const;

  /** Field-name substrings that would leak gathered content or a secret. */
  const FORBIDDEN_SUBSTRINGS = [
    "context",
    "deliver",
    "script",
    "stdout",
    "payload",
    "result",
    "secret",
    "prompt",
  ] as const;

  /** The field declarations only (from the key line to its closing brace) —
   *  mirrors the acceptance grep window, excluding the leading JSDoc. */
  function fieldBlock(): string {
    const start = source.indexOf('"scheduler:wake_gate":');
    expect(start).toBeGreaterThan(-1);
    const rest = source.slice(start);
    const end = rest.indexOf("};");
    expect(end).toBeGreaterThan(-1);
    return rest.slice(0, end);
  }

  it("is declared in the scheduler family, beside scheduler:job_result", () => {
    expect(source).toContain('"scheduler:wake_gate":');
    const wakeIdx = source.indexOf('"scheduler:wake_gate":');
    const jobResultIdx = source.indexOf('"scheduler:job_result":');
    const heartbeatIdx = source.indexOf('"scheduler:heartbeat_check":');
    expect(jobResultIdx).toBeGreaterThan(-1);
    expect(heartbeatIdx).toBeGreaterThan(-1);
    // Sits inside the scheduler block: after job_result, before heartbeat.
    expect(wakeIdx).toBeGreaterThan(jobResultIdx);
    expect(wakeIdx).toBeLessThan(heartbeatIdx);
  });

  it("declares ONLY counts/enums/ids — no payload-bearing field in the type block", () => {
    const block = fieldBlock();
    // Forbidden check is case-insensitive; the allowlist check keeps field case.
    const lower = block.toLowerCase();
    for (const forbidden of FORBIDDEN_SUBSTRINGS) {
      expect(lower).not.toContain(forbidden);
    }
    for (const key of ALLOWED_KEYS) {
      expect(block).toContain(key);
    }
  });

  it("a constructed payload round-trips through the bus with EXACTLY the allowlist keys", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    // The type annotation is the compile-time contract: a payload-bearing field
    // would be rejected by the closed shape (the broker:denied precedent above).
    // At runtime the received keys are asserted against the allowlist.
    const skip: EventMap["scheduler:wake_gate"] = {
      jobId: "job-1",
      agentId: "agent-1",
      wake: false,
      durationMs: 12,
      toolCalls: 0,
      estTurnsSaved: 1,
      timestamp: Date.now(),
    };
    bus.on("scheduler:wake_gate", handler);
    bus.emit("scheduler:wake_gate", skip);

    expect(handler).toHaveBeenCalledWith(skip);
    const received = handler.mock.calls[0]![0] as EventMap["scheduler:wake_gate"];
    expect(Object.keys(received).sort()).toEqual([...ALLOWED_KEYS]);
    for (const forbidden of FORBIDDEN_SUBSTRINGS) {
      expect(received).not.toHaveProperty(forbidden);
    }

    // The woke case mirrors the same shape (no extra fields on wake).
    const wake: EventMap["scheduler:wake_gate"] = {
      jobId: "job-2",
      agentId: "agent-1",
      wake: true,
      durationMs: 40,
      toolCalls: 3,
      estTurnsSaved: 0,
      timestamp: Date.now(),
    };
    bus.emit("scheduler:wake_gate", wake);
    const receivedWake = handler.mock.calls[1]![0] as EventMap["scheduler:wake_gate"];
    expect(Object.keys(receivedWake).sort()).toEqual([...ALLOWED_KEYS]);
    expect(receivedWake.wake).toBe(true);
    expect(receivedWake.toolCalls).toBe(3);
    expect(receivedWake.estTurnsSaved).toBe(0);
  });
});
