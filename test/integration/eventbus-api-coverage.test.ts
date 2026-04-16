/**
 * TypedEventBus Integration Tests: EventMap Payload Coverage + Behavioral Guarantees
 *
 * Validates that every event type in the EventMap can be emitted and received
 * with correctly-typed payloads through the built TypedEventBus, plus behavioral
 * guarantees (fan-out, ordering, maxListeners, removeAllListeners) and
 * EventAwaiter integration (waitFor, waitForAll, waitForSequence, collectDuring).
 *
 * All imports come from built dist/ packages via vitest aliases --
 * this is integration testing, not unit testing.
 *
 *   Domain 1:  Message/Session (6 events)
 *   Domain 2:  Cross-Session/Sub-Agent (5 events)
 *   Domain 3:  Skills/Tools (6 events)
 *   Domain 4:  Observability/Metrics (3 events)
 *   Domain 5:  Scheduler/Tasks (5 events)
 *   Domain 6:  Queue/Priority (8 events)
 *   Domain 7:  Plugin/Hooks (3 events)
 *   Domain 8:  Delivery/Streaming/Retry (7 events)
 *   Domain 9:  Model/Failover (5 events)
 *   Domain 10: AutoReply/SendPolicy (5 events)
 *   Domain 11: Config/System (3 events)
 *   Domain 12: Diagnostic (4 events)
 *   Domain 13: Compaction/Audit/Command (4 events)
 *   Domain 14: Browser/Device/Auth (5 events)
 *   Domain 15: Channel/GroupHistory/Followup/Elevated/Ack (7 events)
 *
 *   Behavioral Guarantees (6 tests)
 *   EventAwaiter Integration (5 tests)
 *
 * Total: 77 payload tests + 11 behavioral/EventAwaiter tests = ~88 tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TypedEventBus } from "@comis/core";
import type { EventMap } from "@comis/core";
import { createEventAwaiter } from "../support/event-awaiter.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const NOW = Date.now();

const SESSION_KEY = {
  tenantId: "test-tenant",
  userId: "user-001",
  channelId: "channel-001",
};

const NORMALIZED_MESSAGE = {
  id: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
  channelId: "channel-001",
  channelType: "echo" as const,
  senderId: "sender-001",
  text: "Hello from test",
  timestamp: NOW,
  attachments: [],
  metadata: {},
};

// ---------------------------------------------------------------------------
// EventMap Payload Coverage
// ---------------------------------------------------------------------------

describe("EventMap Payload Coverage", () => {
  let bus: TypedEventBus;

  beforeEach(() => {
    bus = new TypedEventBus();
  });

  afterEach(() => {
    bus.removeAllListeners();
  });

  // -------------------------------------------------------------------------
  // Domain 1: Message/Session (6 events)
  // -------------------------------------------------------------------------

  describe("Domain 1: Message/Session", () => {
    const EVENTS = {
      "message:received": {
        message: NORMALIZED_MESSAGE,
        sessionKey: SESSION_KEY,
      },
      "message:sent": {
        channelId: "ch-001",
        messageId: "msg-001",
        content: "Hello world",
      },
      "message:streaming": {
        channelId: "ch-001",
        messageId: "msg-002",
        delta: "Hel",
        accumulated: "Hel",
      },
      // NOTE: session:created is NOT yet emitted in production (research open question 1)
      "session:created": {
        sessionKey: SESSION_KEY,
        timestamp: NOW,
      },
      "session:expired": {
        sessionKey: SESSION_KEY,
        reason: "timeout",
      },
      // NOTE: session:label_changed is NOT yet emitted in production (research open question 1)
      "session:label_changed": {
        sessionKey: SESSION_KEY,
        label: "New Label",
        previousLabel: "Old Label",
        timestamp: NOW,
      },
    } satisfies Partial<EventMap>;

    for (const [eventName, payload] of Object.entries(EVENTS)) {
      it(`emits and receives ${eventName} with correct payload`, () => {
        const handler = vi.fn();
        bus.on(eventName as keyof EventMap, handler);
        bus.emit(eventName as keyof EventMap, payload as EventMap[keyof EventMap]);
        expect(handler).toHaveBeenCalledOnce();
        expect(handler).toHaveBeenCalledWith(payload);
      });
    }
  });

  // -------------------------------------------------------------------------
  // Domain 2: Cross-Session/Sub-Agent (5 events)
  // -------------------------------------------------------------------------

  describe("Domain 2: Cross-Session/Sub-Agent", () => {
    const EVENTS = {
      "session:cross_send": {
        fromSessionKey: "tenant:user1:ch1",
        toSessionKey: "tenant:user2:ch2",
        mode: "fire-and-forget" as const,
        timestamp: NOW,
      },
      "session:ping_pong_turn": {
        fromSessionKey: "tenant:user1:ch1",
        toSessionKey: "tenant:user2:ch2",
        turnNumber: 3,
        totalTurns: 5,
        tokensUsed: 512,
        timestamp: NOW,
      },
      "session:sub_agent_spawned": {
        runId: "run-001",
        parentSessionKey: "tenant:user1:ch1",
        agentId: "summarizer",
        task: "Summarize conversation",
        timestamp: NOW,
      },
      "session:sub_agent_completed": {
        runId: "run-001",
        agentId: "summarizer",
        success: true,
        runtimeMs: 3200,
        tokensUsed: 1024,
        cost: 0.015,
        timestamp: NOW,
      },
      "session:sub_agent_archived": {
        runId: "run-001",
        sessionKey: "tenant:sub-agent:ch1",
        ageMs: 86400000,
        timestamp: NOW,
      },
    } satisfies Partial<EventMap>;

    for (const [eventName, payload] of Object.entries(EVENTS)) {
      it(`emits and receives ${eventName} with correct payload`, () => {
        const handler = vi.fn();
        bus.on(eventName as keyof EventMap, handler);
        bus.emit(eventName as keyof EventMap, payload as EventMap[keyof EventMap]);
        expect(handler).toHaveBeenCalledOnce();
        expect(handler).toHaveBeenCalledWith(payload);
      });
    }
  });

  // -------------------------------------------------------------------------
  // Domain 3: Skills/Tools (6 events)
  // -------------------------------------------------------------------------

  describe("Domain 3: Skills/Tools", () => {
    const EVENTS = {
      "skill:loaded": {
        skillName: "web-search",
        source: "/skills/web-search/SKILL.md",
        timestamp: NOW,
      },
      "skill:executed": {
        skillName: "web-search",
        durationMs: 450,
        success: true,
        timestamp: NOW,
      },
      "skill:rejected": {
        skillName: "malicious-skill",
        reason: "AST scanner found violations",
        violations: ["eval() usage", "process.env access"],
        timestamp: NOW,
      },
      "skill:prompt_loaded": {
        skillName: "system-prompt",
        source: "/skills/system-prompt/SKILL.md",
        bodyLength: 2048,
        timestamp: NOW,
      },
      "skill:prompt_invoked": {
        skillName: "system-prompt",
        invokedBy: "user" as const,
        args: "--format markdown",
        timestamp: NOW,
      },
      "tool:executed": {
        toolName: "brave_search",
        durationMs: 320,
        success: true,
        timestamp: NOW,
        userId: "user-001",
        traceId: "trace-abc-123",
      },
    } satisfies Partial<EventMap>;

    for (const [eventName, payload] of Object.entries(EVENTS)) {
      it(`emits and receives ${eventName} with correct payload`, () => {
        const handler = vi.fn();
        bus.on(eventName as keyof EventMap, handler);
        bus.emit(eventName as keyof EventMap, payload as EventMap[keyof EventMap]);
        expect(handler).toHaveBeenCalledOnce();
        expect(handler).toHaveBeenCalledWith(payload);
      });
    }
  });

  // -------------------------------------------------------------------------
  // Domain 4: Observability/Metrics (3 events)
  // -------------------------------------------------------------------------

  describe("Domain 4: Observability/Metrics", () => {
    const EVENTS = {
      "observability:metrics": {
        rssBytes: 104857600,
        heapUsedBytes: 52428800,
        heapTotalBytes: 73400320,
        externalBytes: 8388608,
        eventLoopDelayMs: {
          min: 0.1,
          max: 15.3,
          mean: 2.4,
          p50: 1.8,
          p99: 12.1,
        },
        activeHandles: 42,
        uptimeSeconds: 3600,
        timestamp: NOW,
      },
      "observability:token_usage": {
        timestamp: NOW,
        traceId: "trace-001",
        agentId: "default",
        channelId: "ch-001",
        executionId: "exec-001",
        provider: "anthropic",
        model: "claude-3.5-sonnet",
        tokens: { prompt: 1200, completion: 350, total: 1550 },
        cost: { input: 0.0036, output: 0.00525, total: 0.00885 },
        latencyMs: 2100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      "observability:latency": {
        operation: "llm_call" as const,
        durationMs: 2100,
        timestamp: NOW,
        metadata: { provider: "anthropic", model: "claude-3.5-sonnet" },
      },
    } satisfies Partial<EventMap>;

    for (const [eventName, payload] of Object.entries(EVENTS)) {
      it(`emits and receives ${eventName} with correct payload`, () => {
        const handler = vi.fn();
        bus.on(eventName as keyof EventMap, handler);
        bus.emit(eventName as keyof EventMap, payload as EventMap[keyof EventMap]);
        expect(handler).toHaveBeenCalledOnce();
        expect(handler).toHaveBeenCalledWith(payload);
      });
    }
  });

  // -------------------------------------------------------------------------
  // Domain 5: Scheduler/Tasks (5 events)
  // -------------------------------------------------------------------------

  describe("Domain 5: Scheduler/Tasks", () => {
    const EVENTS = {
      "scheduler:job_started": {
        jobId: "job-001",
        jobName: "daily-digest",
        agentId: "default",
        timestamp: NOW,
      },
      "scheduler:job_completed": {
        jobId: "job-001",
        jobName: "daily-digest",
        agentId: "default",
        durationMs: 5200,
        success: true,
        error: "minor warning",
        timestamp: NOW,
      },
      "scheduler:job_result": {
        jobId: "job-001",
        jobName: "daily-digest",
        agentId: "default",
        result: "Daily digest sent successfully",
        success: true,
        deliveryTarget: {
          channelId: "ch-001",
          userId: "user-001",
          tenantId: "tenant-001",
          channelType: "telegram",
        },
        timestamp: NOW,
      },
      "scheduler:heartbeat_check": {
        checksRun: 4,
        alertsRaised: 1,
        timestamp: NOW,
      },
      "scheduler:task_extracted": {
        taskId: "task-001",
        title: "Send weekly report",
        priority: "high",
        confidence: 0.92,
        sessionKey: "tenant:user:ch",
        timestamp: NOW,
      },
    } satisfies Partial<EventMap>;

    for (const [eventName, payload] of Object.entries(EVENTS)) {
      it(`emits and receives ${eventName} with correct payload`, () => {
        const handler = vi.fn();
        bus.on(eventName as keyof EventMap, handler);
        bus.emit(eventName as keyof EventMap, payload as EventMap[keyof EventMap]);
        expect(handler).toHaveBeenCalledOnce();
        expect(handler).toHaveBeenCalledWith(payload);
      });
    }
  });

  // -------------------------------------------------------------------------
  // Domain 6: Queue/Priority (8 events)
  // -------------------------------------------------------------------------

  describe("Domain 6: Queue/Priority", () => {
    const EVENTS = {
      "queue:enqueued": {
        sessionKey: SESSION_KEY,
        channelType: "telegram",
        queueDepth: 3,
        mode: "fifo",
        timestamp: NOW,
      },
      "queue:dequeued": {
        sessionKey: SESSION_KEY,
        channelType: "telegram",
        waitTimeMs: 150,
        timestamp: NOW,
      },
      "queue:overflow": {
        sessionKey: SESSION_KEY,
        channelType: "telegram",
        policy: "drop-oldest",
        droppedCount: 2,
        timestamp: NOW,
      },
      "queue:coalesced": {
        sessionKey: SESSION_KEY,
        channelType: "telegram",
        messageCount: 4,
        timestamp: NOW,
      },
      "debounce:buffered": {
        sessionKey: SESSION_KEY,
        channelType: "telegram",
        bufferedCount: 2,
        windowMs: 500,
        timestamp: NOW,
      },
      "debounce:flushed": {
        sessionKey: SESSION_KEY,
        channelType: "telegram",
        messageCount: 3,
        trigger: "timer" as const,
        timestamp: NOW,
      },
      "priority:lane_assigned": {
        sessionKey: SESSION_KEY,
        channelType: "telegram",
        lane: "high",
        reason: "trusted sender",
        timestamp: NOW,
      },
      "priority:aged_promotion": {
        sessionKey: "tenant:user:ch",
        fromLane: "low",
        toLane: "normal",
        waitTimeMs: 30000,
        timestamp: NOW,
      },
    } satisfies Partial<EventMap>;

    for (const [eventName, payload] of Object.entries(EVENTS)) {
      it(`emits and receives ${eventName} with correct payload`, () => {
        const handler = vi.fn();
        bus.on(eventName as keyof EventMap, handler);
        bus.emit(eventName as keyof EventMap, payload as EventMap[keyof EventMap]);
        expect(handler).toHaveBeenCalledOnce();
        expect(handler).toHaveBeenCalledWith(payload);
      });
    }
  });

  // -------------------------------------------------------------------------
  // Domain 7: Plugin/Hooks (3 events)
  // -------------------------------------------------------------------------

  describe("Domain 7: Plugin/Hooks", () => {
    const EVENTS = {
      "plugin:registered": {
        pluginId: "plugin-001",
        pluginName: "custom-auth",
        hookCount: 3,
        timestamp: NOW,
      },
      "plugin:deactivated": {
        pluginId: "plugin-001",
        reason: "error threshold exceeded",
        timestamp: NOW,
      },
      "hook:executed": {
        hookName: "beforeAgentStart",
        pluginId: "plugin-001",
        durationMs: 12,
        success: true,
        error: "non-fatal warning",
        timestamp: NOW,
      },
    } satisfies Partial<EventMap>;

    for (const [eventName, payload] of Object.entries(EVENTS)) {
      it(`emits and receives ${eventName} with correct payload`, () => {
        const handler = vi.fn();
        bus.on(eventName as keyof EventMap, handler);
        bus.emit(eventName as keyof EventMap, payload as EventMap[keyof EventMap]);
        expect(handler).toHaveBeenCalledOnce();
        expect(handler).toHaveBeenCalledWith(payload);
      });
    }
  });

  // -------------------------------------------------------------------------
  // Domain 8: Delivery/Streaming/Retry (7 events)
  // -------------------------------------------------------------------------

  describe("Domain 8: Delivery/Streaming/Retry", () => {
    const EVENTS = {
      "streaming:block_sent": {
        channelId: "ch-001",
        chatId: "chat-001",
        blockIndex: 2,
        totalBlocks: 5,
        charCount: 480,
        timestamp: NOW,
      },
      "typing:started": {
        channelId: "ch-001",
        chatId: "chat-001",
        mode: "continuous",
        timestamp: NOW,
      },
      "typing:stopped": {
        channelId: "ch-001",
        chatId: "chat-001",
        durationMs: 3500,
        timestamp: NOW,
      },
      "response:filtered": {
        channelId: "ch-001",
        suppressedBy: "NO_REPLY" as const,
        timestamp: NOW,
      },
      "retry:attempted": {
        channelId: "ch-001",
        chatId: "chat-001",
        attempt: 2,
        maxAttempts: 3,
        delayMs: 1000,
        error: "503 Service Unavailable",
        timestamp: NOW,
      },
      "retry:exhausted": {
        channelId: "ch-001",
        chatId: "chat-001",
        totalAttempts: 3,
        finalError: "503 Service Unavailable",
        timestamp: NOW,
      },
      "retry:markdown_fallback": {
        channelId: "ch-001",
        chatId: "chat-001",
        originalParseMode: "MarkdownV2",
        timestamp: NOW,
      },
    } satisfies Partial<EventMap>;

    for (const [eventName, payload] of Object.entries(EVENTS)) {
      it(`emits and receives ${eventName} with correct payload`, () => {
        const handler = vi.fn();
        bus.on(eventName as keyof EventMap, handler);
        bus.emit(eventName as keyof EventMap, payload as EventMap[keyof EventMap]);
        expect(handler).toHaveBeenCalledOnce();
        expect(handler).toHaveBeenCalledWith(payload);
      });
    }
  });

  // -------------------------------------------------------------------------
  // Domain 9: Model/Failover (5 events)
  // -------------------------------------------------------------------------

  describe("Domain 9: Model/Failover", () => {
    const EVENTS = {
      "model:fallback_attempt": {
        fromProvider: "anthropic",
        fromModel: "claude-3.5-sonnet",
        toProvider: "openai",
        toModel: "gpt-4o",
        error: "429 Rate limited",
        attemptNumber: 1,
        timestamp: NOW,
      },
      "model:fallback_exhausted": {
        provider: "anthropic",
        model: "claude-3.5-sonnet",
        totalAttempts: 3,
        timestamp: NOW,
      },
      "model:auth_cooldown": {
        keyName: "anthropic-prod",
        provider: "anthropic",
        cooldownMs: 60000,
        failureCount: 5,
        timestamp: NOW,
      },
      "model:catalog_loaded": {
        providerCount: 4,
        modelCount: 42,
        timestamp: NOW,
      },
      "model:scan_completed": {
        results: [
          {
            provider: "anthropic",
            keyValid: true,
            modelsDiscovered: 5,
            durationMs: 320,
          },
          {
            provider: "openai",
            keyValid: false,
            modelsDiscovered: 0,
            error: "Invalid API key",
            durationMs: 150,
          },
        ],
        timestamp: NOW,
      },
    } satisfies Partial<EventMap>;

    for (const [eventName, payload] of Object.entries(EVENTS)) {
      it(`emits and receives ${eventName} with correct payload`, () => {
        const handler = vi.fn();
        bus.on(eventName as keyof EventMap, handler);
        bus.emit(eventName as keyof EventMap, payload as EventMap[keyof EventMap]);
        expect(handler).toHaveBeenCalledOnce();
        expect(handler).toHaveBeenCalledWith(payload);
      });
    }
  });

  // -------------------------------------------------------------------------
  // Domain 10: AutoReply/SendPolicy (5 events)
  // -------------------------------------------------------------------------

  describe("Domain 10: AutoReply/SendPolicy", () => {
    const EVENTS = {
      "autoreply:activated": {
        channelId: "ch-001",
        senderId: "user-001",
        activationMode: "mention",
        reason: "Bot was @mentioned",
        timestamp: NOW,
      },
      "autoreply:suppressed": {
        channelId: "ch-001",
        senderId: "user-002",
        reason: "Not mentioned in group",
        injectedAsHistory: true,
        timestamp: NOW,
      },
      "sendpolicy:allowed": {
        channelId: "ch-001",
        channelType: "telegram",
        chatType: "group",
        reason: "Explicit DM scope allows",
        timestamp: NOW,
      },
      "sendpolicy:denied": {
        channelId: "ch-002",
        channelType: "discord",
        chatType: "channel",
        reason: "Send policy denies channel messages",
        timestamp: NOW,
      },
      "sendpolicy:override_changed": {
        sessionKey: SESSION_KEY,
        override: "always-send",
        changedBy: "admin",
        timestamp: NOW,
      },
    } satisfies Partial<EventMap>;

    for (const [eventName, payload] of Object.entries(EVENTS)) {
      it(`emits and receives ${eventName} with correct payload`, () => {
        const handler = vi.fn();
        bus.on(eventName as keyof EventMap, handler);
        bus.emit(eventName as keyof EventMap, payload as EventMap[keyof EventMap]);
        expect(handler).toHaveBeenCalledOnce();
        expect(handler).toHaveBeenCalledWith(payload);
      });
    }
  });

  // -------------------------------------------------------------------------
  // Domain 11: Config/System (3 events)
  // -------------------------------------------------------------------------

  describe("Domain 11: Config/System", () => {
    const EVENTS = {
      "config:patched": {
        section: "agents",
        key: "default.model",
        patchedBy: "rpc:admin",
        timestamp: NOW,
      },
      "system:shutdown": {
        reason: "SIGTERM received",
        graceful: true,
      },
      "system:error": {
        error: new Error("test unhandled error"),
        source: "agent-executor",
      },
    } satisfies Partial<EventMap>;

    for (const [eventName, payload] of Object.entries(EVENTS)) {
      it(`emits and receives ${eventName} with correct payload`, () => {
        const handler = vi.fn();
        bus.on(eventName as keyof EventMap, handler);
        bus.emit(eventName as keyof EventMap, payload as EventMap[keyof EventMap]);
        expect(handler).toHaveBeenCalledOnce();
        expect(handler).toHaveBeenCalledWith(payload);
      });
    }
  });

  // -------------------------------------------------------------------------
  // Domain 12: Diagnostic (4 events)
  // -------------------------------------------------------------------------

  describe("Domain 12: Diagnostic", () => {
    const EVENTS = {
      "diagnostic:message_processed": {
        messageId: "msg-001",
        channelId: "ch-001",
        channelType: "telegram",
        agentId: "default",
        sessionKey: "tenant:user:ch",
        receivedAt: NOW - 5000,
        executionDurationMs: 3200,
        deliveryDurationMs: 150,
        totalDurationMs: 3350,
        tokensUsed: 1550,
        cost: 0.00885,
        success: true,
        finishReason: "stop",
        timestamp: NOW,
      },
      "diagnostic:webhook_delivered": {
        webhookId: "wh-001",
        source: "scheduler",
        event: "job_completed",
        statusCode: 200,
        success: true,
        durationMs: 85,
        error: undefined,
        timestamp: NOW,
      },
      "diagnostic:channel_health": {
        channels: [
          {
            channelId: "ch-telegram",
            channelType: "telegram",
            lastActiveAt: NOW - 60000,
            messagesSent: 150,
            messagesReceived: 200,
          },
          {
            channelId: "ch-discord",
            channelType: "discord",
            lastActiveAt: NOW - 30000,
            messagesSent: 80,
            messagesReceived: 120,
          },
        ],
        timestamp: NOW,
      },
      "diagnostic:billing_snapshot": {
        providers: [
          {
            provider: "anthropic",
            totalCost: 12.50,
            totalTokens: 500000,
            callCount: 320,
          },
          {
            provider: "openai",
            totalCost: 8.30,
            totalTokens: 350000,
            callCount: 180,
          },
        ],
        totalCost: 20.80,
        timestamp: NOW,
      },
    } satisfies Partial<EventMap>;

    for (const [eventName, payload] of Object.entries(EVENTS)) {
      it(`emits and receives ${eventName} with correct payload`, () => {
        const handler = vi.fn();
        bus.on(eventName as keyof EventMap, handler);
        bus.emit(eventName as keyof EventMap, payload as EventMap[keyof EventMap]);
        expect(handler).toHaveBeenCalledOnce();
        expect(handler).toHaveBeenCalledWith(payload);
      });
    }
  });

  // -------------------------------------------------------------------------
  // Domain 13: Compaction/Audit/Command (4 events)
  // -------------------------------------------------------------------------

  describe("Domain 13: Compaction/Audit/Command", () => {
    const EVENTS = {
      "compaction:started": {
        agentId: "coverage-agent",
        sessionKey: SESSION_KEY,
        timestamp: NOW,
      },
      "compaction:flush": {
        sessionKey: SESSION_KEY,
        memoriesWritten: 12,
        trigger: "soft" as const,
        success: true,
        timestamp: NOW,
      },
      "audit:event": {
        timestamp: NOW,
        agentId: "default",
        tenantId: "tenant-001",
        actionType: "file:write",
        classification: "destructive",
        outcome: "success" as const,
        metadata: { path: "/tmp/output.txt", sizeBytes: 1024 },
      },
      "command:executed": {
        command: "/reset",
        args: ["--hard"],
        sessionKey: SESSION_KEY,
        handled: true,
        timestamp: NOW,
      },
    } satisfies Partial<EventMap>;

    for (const [eventName, payload] of Object.entries(EVENTS)) {
      it(`emits and receives ${eventName} with correct payload`, () => {
        const handler = vi.fn();
        bus.on(eventName as keyof EventMap, handler);
        bus.emit(eventName as keyof EventMap, payload as EventMap[keyof EventMap]);
        expect(handler).toHaveBeenCalledOnce();
        expect(handler).toHaveBeenCalledWith(payload);
      });
    }
  });

  // -------------------------------------------------------------------------
  // Domain 14: Browser/Device/Auth (5 events)
  // -------------------------------------------------------------------------

  describe("Domain 14: Browser/Device/Auth", () => {
    const EVENTS = {
      "browser:session_started": {
        profileName: "default-chrome",
        cdpPort: 9222,
        timestamp: NOW,
      },
      "browser:session_ended": {
        profileName: "default-chrome",
        reason: "CDP disconnected",
        timestamp: NOW,
      },
      "auth:token_rotated": {
        provider: "google",
        profileName: "user-profile-01",
        expiresAtMs: NOW + 3600000,
        timestamp: NOW,
      },
      "device:pairing_requested": {
        deviceId: "device-001",
        displayName: "iPhone 15",
        platform: "ios",
        timestamp: NOW,
      },
      "device:pairing_approved": {
        deviceId: "device-001",
        role: "trusted",
        timestamp: NOW,
      },
    } satisfies Partial<EventMap>;

    for (const [eventName, payload] of Object.entries(EVENTS)) {
      it(`emits and receives ${eventName} with correct payload`, () => {
        const handler = vi.fn();
        bus.on(eventName as keyof EventMap, handler);
        bus.emit(eventName as keyof EventMap, payload as EventMap[keyof EventMap]);
        expect(handler).toHaveBeenCalledOnce();
        expect(handler).toHaveBeenCalledWith(payload);
      });
    }
  });

  // -------------------------------------------------------------------------
  // Domain 15: Channel/GroupHistory/Followup/Elevated/Ack (7 events)
  // -------------------------------------------------------------------------

  describe("Domain 15: Channel/GroupHistory/Followup/Elevated/Ack", () => {
    const EVENTS = {
      "channel:registered": {
        channelType: "telegram",
        pluginId: "telegram-adapter",
        capabilities: {
          chatTypes: ["dm", "group"] as ("dm" | "group" | "thread" | "channel" | "forum")[],
          features: {},
          limits: { maxMessageChars: 4096 },
          streaming: {},
          threading: {},
        },
        timestamp: NOW,
      },
      "channel:deregistered": {
        channelType: "telegram",
        pluginId: "telegram-adapter",
        timestamp: NOW,
      },
      "grouphistory:injected": {
        sessionKey: "tenant:user:ch",
        channelType: "telegram",
        messageCount: 10,
        charCount: 2048,
        timestamp: NOW,
      },
      "followup:enqueued": {
        sessionKey: "tenant:user:ch",
        channelType: "telegram",
        reason: "tool_result" as const,
        chainId: "chain-001",
        chainDepth: 2,
        timestamp: NOW,
      },
      "followup:depth_exceeded": {
        sessionKey: "tenant:user:ch",
        chainId: "chain-001",
        maxDepth: 5,
        timestamp: NOW,
      },
      "elevated:model_routed": {
        sessionKey: "tenant:user:ch",
        senderTrustLevel: "owner",
        modelRoute: "claude-3.5-sonnet",
        agentId: "default",
        timestamp: NOW,
      },
      "ack:reaction_sent": {
        channelId: "ch-001",
        channelType: "telegram",
        messageId: "msg-001",
        emoji: "eyes",
        timestamp: NOW,
      },
    } satisfies Partial<EventMap>;

    for (const [eventName, payload] of Object.entries(EVENTS)) {
      it(`emits and receives ${eventName} with correct payload`, () => {
        const handler = vi.fn();
        bus.on(eventName as keyof EventMap, handler);
        bus.emit(eventName as keyof EventMap, payload as EventMap[keyof EventMap]);
        expect(handler).toHaveBeenCalledOnce();
        expect(handler).toHaveBeenCalledWith(payload);
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Behavioral Guarantees
// ---------------------------------------------------------------------------

describe("Behavioral Guarantees", () => {
  let bus: TypedEventBus;

  beforeEach(() => {
    bus = new TypedEventBus();
  });

  afterEach(() => {
    bus.removeAllListeners();
  });

  it("multi-listener fan-out delivers same payload reference to 5 handlers", () => {
    const payload = { reason: "test fan-out", graceful: true };
    const handlers = Array.from({ length: 5 }, () => vi.fn());

    for (const h of handlers) {
      bus.on("system:shutdown", h);
    }

    bus.emit("system:shutdown", payload);

    for (const h of handlers) {
      expect(h).toHaveBeenCalledOnce();
      // Reference equality: same object instance delivered to all handlers
      expect(h.mock.calls[0][0]).toBe(payload);
    }
  });

  it("event handlers are invoked in registration order", () => {
    const order: number[] = [];

    bus.on("system:shutdown", () => order.push(0));
    bus.on("system:shutdown", () => order.push(1));
    bus.on("system:shutdown", () => order.push(2));
    bus.on("system:shutdown", () => order.push(3));

    bus.emit("system:shutdown", { reason: "ordering test", graceful: true });

    expect(order).toEqual([0, 1, 2, 3]);
  });

  it("maxListeners exceeded warning fires when threshold is crossed", async () => {
    bus.setMaxListeners(2);

    let warningReceived = false;
    const warningHandler = (warning: Error): void => {
      if (warning.name === "MaxListenersExceededWarning" || warning.message.includes("MaxListeners")) {
        warningReceived = true;
      }
    };

    process.on("warning", warningHandler);
    try {
      // Register 3 handlers to exceed limit of 2
      bus.on("system:shutdown", () => {});
      bus.on("system:shutdown", () => {});
      bus.on("system:shutdown", () => {});

      // Warning is emitted asynchronously via process.emitWarning
      // Wait a tick for it to be delivered
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(warningReceived).toBe(true);
    } finally {
      process.removeListener("warning", warningHandler);
      bus.removeAllListeners();
    }
  });

  it("setMaxListeners overrides the warning threshold", () => {
    bus.setMaxListeners(20);

    for (let i = 0; i < 15; i++) {
      bus.on("system:shutdown", () => {});
    }

    // No warning should fire -- just verify the listener count is correct
    expect(bus.listenerCount("system:shutdown")).toBe(15);
  });

  it("removeAllListeners for specific event preserves other event listeners", () => {
    bus.on("system:shutdown", () => {});
    bus.on("system:error", () => {});

    bus.removeAllListeners("system:shutdown");

    expect(bus.listenerCount("system:shutdown")).toBe(0);
    expect(bus.listenerCount("system:error")).toBe(1);
  });

  it("removeAllListeners with no argument clears everything", () => {
    bus.on("system:shutdown", () => {});
    bus.on("system:error", () => {});
    bus.on("config:patched", () => {});

    bus.removeAllListeners();

    expect(bus.listenerCount("system:shutdown")).toBe(0);
    expect(bus.listenerCount("system:error")).toBe(0);
    expect(bus.listenerCount("config:patched")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// EventAwaiter Integration
// ---------------------------------------------------------------------------

describe("EventAwaiter Integration", () => {
  let bus: TypedEventBus;
  let awaiter: ReturnType<typeof createEventAwaiter>;

  beforeEach(() => {
    bus = new TypedEventBus();
    awaiter = createEventAwaiter(bus);
  });

  afterEach(() => {
    awaiter.dispose();
    bus.removeAllListeners();
  });

  it("waitFor resolves with payload", async () => {
    const expected = {
      pluginId: "plugin-test",
      pluginName: "test-plugin",
      hookCount: 2,
      timestamp: Date.now(),
    };

    const promise = awaiter.waitFor("plugin:registered");
    queueMicrotask(() => bus.emit("plugin:registered", expected));
    const result = await promise;

    expect(result).toEqual(expected);
  });

  it("waitFor with filter resolves only matching payload", async () => {
    const lowDepth = {
      sessionKey: SESSION_KEY,
      channelType: "telegram",
      queueDepth: 2,
      mode: "fifo",
      timestamp: Date.now(),
    };

    const highDepth = {
      sessionKey: SESSION_KEY,
      channelType: "telegram",
      queueDepth: 10,
      mode: "fifo",
      timestamp: Date.now(),
    };

    const promise = awaiter.waitFor("queue:enqueued", {
      filter: (p) => p.queueDepth > 5,
    });

    queueMicrotask(() => {
      bus.emit("queue:enqueued", lowDepth);
      bus.emit("queue:enqueued", highDepth);
    });

    const result = await promise;
    expect(result.queueDepth).toBe(10);
  });

  it("waitForAll collects N events", async () => {
    const payloads = [
      { toolName: "brave_search", durationMs: 100, success: true, timestamp: Date.now() },
      { toolName: "memory_write", durationMs: 50, success: true, timestamp: Date.now() },
      { toolName: "cron_list", durationMs: 30, success: false, timestamp: Date.now() },
    ];

    const promise = awaiter.waitForAll("tool:executed", 3);

    queueMicrotask(() => {
      for (const p of payloads) {
        bus.emit("tool:executed", p);
      }
    });

    const results = await promise;
    expect(results).toHaveLength(3);
    expect(results[0].toolName).toBe("brave_search");
    expect(results[1].toolName).toBe("memory_write");
    expect(results[2].toolName).toBe("cron_list");
  });

  it("waitForSequence verifies ordered emission", async () => {
    const promise = awaiter.waitForSequence([
      "plugin:registered",
      "hook:executed",
      "plugin:deactivated",
    ]);

    queueMicrotask(() => {
      bus.emit("plugin:registered", {
        pluginId: "p1",
        pluginName: "test",
        hookCount: 1,
        timestamp: Date.now(),
      });
      bus.emit("hook:executed", {
        hookName: "beforeAgentStart",
        pluginId: "p1",
        durationMs: 5,
        success: true,
        timestamp: Date.now(),
      });
      bus.emit("plugin:deactivated", {
        pluginId: "p1",
        reason: "test complete",
        timestamp: Date.now(),
      });
    });

    const results = await promise;
    expect(results).toHaveLength(3);
    // Verify correct types by checking discriminant fields
    expect((results[0] as EventMap["plugin:registered"]).pluginName).toBe("test");
    expect((results[1] as EventMap["hook:executed"]).hookName).toBe("beforeAgentStart");
    expect((results[2] as EventMap["plugin:deactivated"]).reason).toBe("test complete");
  });

  it("collectDuring captures events during async operation", async () => {
    const payload1 = {
      skillName: "web-search",
      durationMs: 100,
      success: true,
      timestamp: Date.now(),
    };
    const payload2 = {
      skillName: "memory-write",
      durationMs: 50,
      success: true,
      timestamp: Date.now(),
    };

    const collected = await awaiter.collectDuring(
      "skill:executed",
      async () => {
        bus.emit("skill:executed", payload1);
        bus.emit("skill:executed", payload2);
      },
    );

    expect(collected).toHaveLength(2);
    expect(collected[0].skillName).toBe("web-search");
    expect(collected[1].skillName).toBe("memory-write");
  });
});
