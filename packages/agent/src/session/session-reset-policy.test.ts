// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createConversationRef, TypedEventBus } from "@comis/core";
import type {
  ConversationScope,
  SessionKey,
  SessionStorePort,
  SessionResetPolicyConfig,
  ComputeDailyResetNextRun,
  TimerPort,
  TimerHandle,
} from "@comis/core";
import { ok } from "@comis/shared";

// ---------------------------------------------------------------------------
// Lightweight TimerPort wrapper that delegates to globals so
// vi.useFakeTimers() continues to intercept setInterval below.
// ---------------------------------------------------------------------------

function wrapTimerHandle(t: NodeJS.Timeout): TimerHandle {
  let cancelled = false;
  let unrefCalled = false;
  return {
    get cancelled() { return cancelled; },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      clearTimeout(t);
    },
    unref() {
      if (cancelled || unrefCalled) return;
      unrefCalled = true;
      t.unref();
    },
  };
}

const testTimers: TimerPort = {
  setTimeout: (cb, ms) => wrapTimerHandle(setTimeout(cb, ms)),
  setInterval: (cb, ms) => wrapTimerHandle(setInterval(cb, ms)),
};
import type { SessionDetailedEntry } from "@comis/core";
// Test-only import from @comis/scheduler: provides the canonical cron-shape
// helper that daemon composition (setup-schedulers.ts) wires into agent's
// SessionResetSchedulerDeps.computeDailyResetNextRun in production. The
// production source (session-reset-policy.ts) does NOT import this — agent's
// production source is scheduler-free.
import { computeNextRunAtMs } from "@comis/scheduler";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import {
  classifySession,
  resolvePolicy,
  isDailyResetDue,
  isIdleResetDue,
  checkReset,
  createSessionResetScheduler,
} from "./session-reset-policy.js";
import type {
  EffectiveResetPolicy,
  SessionResetSchedulerDeps,
} from "./session-reset-policy.js";
import type { SessionLifecycle } from "./session-lifecycle.js";

// ---------------------------------------------------------------------------
// computeDailyResetNextRun stub — wraps the real scheduler helper into the
// signature SessionResetSchedulerDeps expects. Behavior is identical to what
// daemon composition wires in production; the indirection only proves the
// callback is consumed (and lets future tests inject a deterministic stub).
// ---------------------------------------------------------------------------

const computeDailyResetNextRun: ComputeDailyResetNextRun = (
  updatedAt: number,
  hour: number,
  timezone: string,
): number | undefined => {
  return computeNextRunAtMs(
    { kind: "cron", expr: `0 ${hour} * * *`, tz: timezone || undefined },
    updatedAt,
  );
};

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeDetailedEntry(
  key: SessionKey,
  updatedAt: number,
  metadata: Record<string, unknown> = {},
): SessionDetailedEntry {
  const endpoint = {
    channelType: "test",
    channelInstanceId: "test-instance",
    conversationId: key.channelId,
    conversationKind: key.guildId === undefined ? "direct" as const : "shared" as const,
    ...(key.threadId === undefined ? {} : { threadId: key.threadId }),
  };
  const conversationScope: ConversationScope = {
    tenantId: key.tenantId,
    agentId: key.agentId ?? "agent_a",
    partition: {
      kind: "endpoint-conversation-principal",
      endpoint,
      principalId: key.userId,
    },
  };
  const conversationRef = createConversationRef(conversationScope);
  if (!conversationRef.ok) throw conversationRef.error;
  return {
    conversationRef: conversationRef.value,
    conversationScope,
    tenantId: key.tenantId,
    agentId: conversationScope.agentId,
    metadata,
    createdAt: updatedAt - 10_000,
    updatedAt,
    messageCount: 0,
  };
}

function mockSessionStore(
  entries: SessionDetailedEntry[] = [],
): Pick<SessionStorePort, "listDetailed"> {
  return {
    listDetailed: vi.fn((query) => ok(entries.filter((entry) =>
      entry.tenantId === query.tenantId && entry.agentId === query.agentId))),
  };
}

function mockSessionLifecycle(): Pick<SessionLifecycle, "expire"> {
  return {
    expire: vi.fn(() => ok(true)),
  };
}

function mockLogger() {
  return createMockLogger();
}

function defaultConfig(
  overrides: Partial<SessionResetPolicyConfig> = {},
): SessionResetPolicyConfig {
  return {
    mode: "idle",
    dailyResetHour: 4,
    dailyResetTimezone: "",
    idleTimeoutMs: 14_400_000,
    sweepIntervalMs: 300_000,
    resetTriggers: [],
    perType: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Group 1: classifySession
// ---------------------------------------------------------------------------

describe("classifySession", () => {
  it("returns 'group' when session key has guildId", () => {
    const key: SessionKey = {
      tenantId: "t1",
      userId: "u1",
      channelId: "c1",
      guildId: "g1",
    };
    const entry = makeDetailedEntry(key, Date.now());
    expect(classifySession(entry)).toBe("group");
  });

  it("returns 'dm' when session key has no guildId", () => {
    const key: SessionKey = {
      tenantId: "t1",
      userId: "u1",
      channelId: "c1",
    };
    const entry = makeDetailedEntry(key, Date.now());
    expect(classifySession(entry)).toBe("dm");
  });

  it("returns 'thread' when the conversation endpoint has a thread", () => {
    const entry = makeDetailedEntry({
      tenantId: "t1",
      agentId: "agent_a",
      userId: "u1",
      channelId: "c1",
      threadId: "thread_a",
    }, Date.now());
    expect(classifySession(entry)).toBe("thread");
  });
});

// ---------------------------------------------------------------------------
// Group 2: resolvePolicy
// ---------------------------------------------------------------------------

describe("resolvePolicy", () => {
  it("returns default config values when no per-type override exists", () => {
    const config = defaultConfig({ mode: "daily", dailyResetHour: 6 });
    const result = resolvePolicy(config, "dm");
    expect(result.mode).toBe("daily");
    expect(result.dailyResetHour).toBe(6);
    expect(result.idleTimeoutMs).toBe(14_400_000);
  });

  it("merges per-type override for dm with default (overridden fields replace)", () => {
    const config = defaultConfig({
      mode: "daily",
      dailyResetHour: 4,
      idleTimeoutMs: 14_400_000,
      perType: {
        dm: { mode: "idle", idleTimeoutMs: 7_200_000 },
      },
    });
    const result = resolvePolicy(config, "dm");
    expect(result.mode).toBe("idle");
    expect(result.idleTimeoutMs).toBe(7_200_000);
    // Non-overridden fields inherit
    expect(result.dailyResetHour).toBe(4);
    expect(result.dailyResetTimezone).toBe("");
  });

  it("per-type override with mode 'none' disables reset for groups", () => {
    const config = defaultConfig({
      mode: "hybrid",
      perType: {
        group: { mode: "none" },
      },
    });
    const result = resolvePolicy(config, "group");
    expect(result.mode).toBe("none");
  });

  it("per-type override with partial fields inherits remaining from default", () => {
    const config = defaultConfig({
      mode: "hybrid",
      dailyResetHour: 3,
      dailyResetTimezone: "America/New_York",
      idleTimeoutMs: 10_000_000,
      perType: {
        group: { dailyResetHour: 8 },
      },
    });
    const result = resolvePolicy(config, "group");
    expect(result.mode).toBe("hybrid");
    expect(result.dailyResetHour).toBe(8);
    expect(result.dailyResetTimezone).toBe("America/New_York");
    expect(result.idleTimeoutMs).toBe(10_000_000);
  });
});

// ---------------------------------------------------------------------------
// Group 3: isDailyResetDue
// ---------------------------------------------------------------------------

describe("isDailyResetDue", () => {
  it("returns true when session was updated before the daily reset hour today", () => {
    // Simulate: daily reset at 4 AM UTC.
    // Session was updated at 3 AM UTC today.
    // Now it's 5 AM UTC today.
    const today4AM = new Date();
    today4AM.setUTCHours(4, 0, 0, 0);
    const before4AM = today4AM.getTime() - 3_600_000; // 3 AM
    const after4AM = today4AM.getTime() + 3_600_000; // 5 AM

    // Use UTC timezone for deterministic tests
    const result = isDailyResetDue(before4AM, 4, "UTC", after4AM, computeDailyResetNextRun);
    expect(result).toBe(true);
  });

  it("returns false when session was updated after the daily reset hour today", () => {
    // Session updated at 5 AM UTC. Now it's 6 AM UTC. Next reset is tomorrow 4 AM.
    const today4AM = new Date();
    today4AM.setUTCHours(4, 0, 0, 0);
    const after4AM = today4AM.getTime() + 3_600_000; // 5 AM
    const later = today4AM.getTime() + 7_200_000; // 6 AM

    const result = isDailyResetDue(after4AM, 4, "UTC", later, computeDailyResetNextRun);
    expect(result).toBe(false);
  });

  it("uses timezone parameter for correct local time evaluation", () => {
    // Use a specific fixed time for deterministic test.
    // 2025-06-15 03:00 UTC = 2025-06-14 23:00 US/Eastern (EDT, UTC-4).
    // Daily reset at hour 0 in US/Eastern = midnight ET.
    // Session updated at 2025-06-15 03:00 UTC (= 23:00 ET on June 14).
    // Now is 2025-06-15 05:00 UTC (= 01:00 ET on June 15).
    // So midnight ET (= 04:00 UTC on June 15) has passed since updatedAt.
    const updatedAt = Date.UTC(2025, 5, 15, 3, 0, 0); // 03:00 UTC
    const nowMs = Date.UTC(2025, 5, 15, 5, 0, 0); // 05:00 UTC

    const result = isDailyResetDue(
      updatedAt,
      0,
      "America/New_York",
      nowMs,
      computeDailyResetNextRun,
    );
    expect(result).toBe(true);
  });

  it("returns false when computeDailyResetNextRun returns undefined (invalid schedule)", () => {
    // Stub that simulates an invalid cron expression / unparseable hour.
    // The production wrapper treats undefined as "not due" — never spuriously
    // resets a session because of a malformed policy config.
    const undefinedStub: ComputeDailyResetNextRun = () => undefined;
    const nowMs = Date.now();
    const result = isDailyResetDue(nowMs - 86_400_000, 99, "UTC", nowMs, undefinedStub);
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Group 4: isIdleResetDue
// ---------------------------------------------------------------------------

describe("isIdleResetDue", () => {
  it("returns true when session updated more than idleTimeoutMs ago", () => {
    const now = Date.now();
    const updatedAt = now - 20_000; // 20 seconds ago
    expect(isIdleResetDue(updatedAt, 10_000, now)).toBe(true);
  });

  it("returns false when session updated less than idleTimeoutMs ago", () => {
    const now = Date.now();
    const updatedAt = now - 5_000; // 5 seconds ago
    expect(isIdleResetDue(updatedAt, 10_000, now)).toBe(false);
  });

  it("returns true at exact boundary (<=)", () => {
    const now = Date.now();
    const updatedAt = now - 10_000; // exactly 10 seconds ago
    expect(isIdleResetDue(updatedAt, 10_000, now)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group 5: checkReset
// ---------------------------------------------------------------------------

describe("checkReset", () => {
  const now = Date.now();
  const staleSession = makeDetailedEntry(
    { tenantId: "t1", userId: "u1", channelId: "c1" },
    now - 20_000_000, // very old
  );
  const freshSession = makeDetailedEntry(
    { tenantId: "t1", userId: "u1", channelId: "c1" },
    now - 1_000, // just updated
  );

  it("mode 'none' always returns { reset: false }", () => {
    const policy: EffectiveResetPolicy = {
      mode: "none",
      dailyResetHour: 4,
      dailyResetTimezone: "",
      idleTimeoutMs: 14_400_000,
    };
    const result = checkReset(policy, staleSession, now, computeDailyResetNextRun);
    expect(result.reset).toBe(false);
    expect(result.reason).toBe("disabled");
  });

  it("mode 'idle' returns true when session is idle", () => {
    const policy: EffectiveResetPolicy = {
      mode: "idle",
      dailyResetHour: 4,
      dailyResetTimezone: "",
      idleTimeoutMs: 10_000, // 10s timeout
    };
    const result = checkReset(policy, staleSession, now, computeDailyResetNextRun);
    expect(result.reset).toBe(true);
    expect(result.reason).toBe("idle");
  });

  it("mode 'idle' returns false when session is fresh", () => {
    const policy: EffectiveResetPolicy = {
      mode: "idle",
      dailyResetHour: 4,
      dailyResetTimezone: "",
      idleTimeoutMs: 14_400_000,
    };
    const result = checkReset(policy, freshSession, now, computeDailyResetNextRun);
    expect(result.reset).toBe(false);
    expect(result.reason).toBe("not-due");
  });

  it("mode 'daily' delegates to isDailyResetDue", () => {
    // Use a fixed time: 2025-06-15 05:00 UTC, session updated 2025-06-15 03:00 UTC
    // Daily reset at 4 UTC: 4 AM has passed since updatedAt
    const fixedNow = Date.UTC(2025, 5, 15, 5, 0, 0);
    const dailySession = makeDetailedEntry(
      { tenantId: "t1", userId: "u1", channelId: "c1" },
      Date.UTC(2025, 5, 15, 3, 0, 0),
    );
    const policy: EffectiveResetPolicy = {
      mode: "daily",
      dailyResetHour: 4,
      dailyResetTimezone: "UTC",
      idleTimeoutMs: 14_400_000,
    };
    const result = checkReset(policy, dailySession, fixedNow, computeDailyResetNextRun);
    expect(result.reset).toBe(true);
    expect(result.reason).toBe("daily");
  });

  it("mode 'hybrid' returns true if EITHER daily OR idle is due", () => {
    // Idle is due (20M ms old, 10s timeout), daily check may or may not trigger
    const policy: EffectiveResetPolicy = {
      mode: "hybrid",
      dailyResetHour: 4,
      dailyResetTimezone: "UTC",
      idleTimeoutMs: 10_000, // 10s -- staleSession is way past this
    };
    const result = checkReset(policy, staleSession, now, computeDailyResetNextRun);
    expect(result.reset).toBe(true);
    expect(result.reason).toMatch(/idle|daily/);
  });

  it("mode 'hybrid' returns false when neither condition is met", () => {
    const policy: EffectiveResetPolicy = {
      mode: "hybrid",
      dailyResetHour: 4,
      dailyResetTimezone: "UTC",
      idleTimeoutMs: 100_000_000, // very large
    };
    const result = checkReset(policy, freshSession, now, computeDailyResetNextRun);
    expect(result.reset).toBe(false);
    expect(result.reason).toBe("not-due");
  });
});

// ---------------------------------------------------------------------------
// Group 6: createSessionResetScheduler integration-style tests
// ---------------------------------------------------------------------------

describe("createSessionResetScheduler", () => {
  let eventBus: TypedEventBus;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    vi.useFakeTimers();
    eventBus = new TypedEventBus();
    logger = mockLogger();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeDeps(
    overrides: Partial<SessionResetSchedulerDeps> = {},
  ): SessionResetSchedulerDeps {
    return {
      sessionStore: mockSessionStore() as unknown as SessionStorePort,
      sessionManager: mockSessionLifecycle() as unknown as SessionLifecycle,
      eventBus,
      logger,
      getConfig: () => defaultConfig({ mode: "idle", idleTimeoutMs: 10_000 }),
      computeDailyResetNextRun,
      nowMs: () => Date.now(),
      timers: testTimers,
      listQueryScopes: () => [{ tenantId: "t1", agentId: "agent_a" }],
      ...overrides,
    };
  }

  it("sweep() with no sessions does nothing", () => {
    const store = mockSessionStore([]);
    const mgr = mockSessionLifecycle();
    const deps = makeDeps({
      sessionStore: store as unknown as SessionStorePort,
      sessionManager: mgr as unknown as SessionLifecycle,
    });
    const scheduler = createSessionResetScheduler(deps);
    scheduler.sweep();
    expect(mgr.expire).not.toHaveBeenCalled();
  });

  it("sweep() expires idle session and emits session:expired with auto-reset:idle reason", () => {
    const now = Date.now();
    const staleKey: SessionKey = { tenantId: "t1", userId: "u1", channelId: "c1" };
    const entry = makeDetailedEntry(staleKey, now - 20_000);
    const store = mockSessionStore([entry]);
    const mgr = mockSessionLifecycle();
    const emitted: unknown[] = [];
    eventBus.on("session:expired", (payload) => emitted.push(payload));

    const deps = makeDeps({
      sessionStore: store as unknown as SessionStorePort,
      sessionManager: mgr as unknown as SessionLifecycle,
      getConfig: () => defaultConfig({ mode: "idle", idleTimeoutMs: 10_000 }),
      nowMs: () => now,
    });

    const scheduler = createSessionResetScheduler(deps);
    scheduler.sweep();

    expect(mgr.expire).toHaveBeenCalledTimes(1);
    expect(emitted).toHaveLength(1);
    expect((emitted[0] as { reason: string }).reason).toBe("auto-reset:idle");
  });

  it("sweep() skips sub-agent sessions (metadata.parentSessionKey present)", () => {
    const now = Date.now();
    const subAgentKey: SessionKey = { tenantId: "t1", userId: "u1", channelId: "c1" };
    const entry = makeDetailedEntry(subAgentKey, now - 20_000, {
      parentSessionKey: "t1:parent:c1",
    });
    const store = mockSessionStore([entry]);
    const mgr = mockSessionLifecycle();

    const deps = makeDeps({
      sessionStore: store as unknown as SessionStorePort,
      sessionManager: mgr as unknown as SessionLifecycle,
      getConfig: () => defaultConfig({ mode: "idle", idleTimeoutMs: 10_000 }),
      nowMs: () => now,
    });

    const scheduler = createSessionResetScheduler(deps);
    scheduler.sweep();

    expect(mgr.expire).not.toHaveBeenCalled();
  });

  it("sweep() applies per-type override (group sessions use group override policy)", () => {
    const now = Date.now();
    const groupKey: SessionKey = {
      tenantId: "t1",
      userId: "u1",
      channelId: "c1",
      guildId: "g1",
    };
    const entry = makeDetailedEntry(groupKey, now - 20_000);
    const store = mockSessionStore([entry]);
    const mgr = mockSessionLifecycle();

    const deps = makeDeps({
      sessionStore: store as unknown as SessionStorePort,
      sessionManager: mgr as unknown as SessionLifecycle,
      getConfig: () =>
        defaultConfig({
          mode: "idle",
          idleTimeoutMs: 10_000,
          perType: {
            group: { mode: "none" }, // Disable for groups
          },
        }),
      nowMs: () => now,
    });

    const scheduler = createSessionResetScheduler(deps);
    scheduler.sweep();

    // Group session should NOT be expired because per-type override is "none"
    expect(mgr.expire).not.toHaveBeenCalled();
  });

  it("sweep() with mode 'none' config skips all sessions", () => {
    const now = Date.now();
    const key: SessionKey = { tenantId: "t1", userId: "u1", channelId: "c1" };
    const entry = makeDetailedEntry(key, now - 20_000);
    const store = mockSessionStore([entry]);
    const mgr = mockSessionLifecycle();

    const deps = makeDeps({
      sessionStore: store as unknown as SessionStorePort,
      sessionManager: mgr as unknown as SessionLifecycle,
      getConfig: () => defaultConfig({ mode: "none" }),
      nowMs: () => now,
    });

    const scheduler = createSessionResetScheduler(deps);
    scheduler.sweep();

    expect(mgr.expire).not.toHaveBeenCalled();
  });

  it("start() runs sweep immediately, then at interval", () => {
    const now = Date.now();
    const store = mockSessionStore([]);
    const deps = makeDeps({
      sessionStore: store as unknown as SessionStorePort,
      getConfig: () => defaultConfig({ mode: "idle", sweepIntervalMs: 60_000 }),
      nowMs: () => now,
    });

    const scheduler = createSessionResetScheduler(deps);
    scheduler.start();

    // Immediate sweep on start
    expect(store.listDetailed).toHaveBeenCalledTimes(1);

    // Advance past one interval
    vi.advanceTimersByTime(60_000);
    expect(store.listDetailed).toHaveBeenCalledTimes(2);

    // Advance past another interval
    vi.advanceTimersByTime(60_000);
    expect(store.listDetailed).toHaveBeenCalledTimes(3);

    scheduler.stop();
  });

  it("stop() clears the interval", () => {
    const store = mockSessionStore([]);
    const deps = makeDeps({
      sessionStore: store as unknown as SessionStorePort,
      getConfig: () => defaultConfig({ mode: "idle", sweepIntervalMs: 60_000 }),
    });

    const scheduler = createSessionResetScheduler(deps);
    scheduler.start();

    // Immediate sweep
    expect(store.listDetailed).toHaveBeenCalledTimes(1);

    scheduler.stop();

    // No more sweeps after stop
    vi.advanceTimersByTime(120_000);
    expect(store.listDetailed).toHaveBeenCalledTimes(1);
  });

  it("config change: new getConfig values are used between sweeps", () => {
    const now = Date.now();
    const key: SessionKey = { tenantId: "t1", userId: "u1", channelId: "c1" };
    const entry = makeDetailedEntry(key, now - 20_000);
    const store = mockSessionStore([entry]);
    const mgr = mockSessionLifecycle();

    // Start with very large idle timeout (no reset)
    let currentConfig = defaultConfig({
      mode: "idle",
      idleTimeoutMs: 100_000_000,
      sweepIntervalMs: 60_000,
    });

    const deps = makeDeps({
      sessionStore: store as unknown as SessionStorePort,
      sessionManager: mgr as unknown as SessionLifecycle,
      getConfig: () => currentConfig,
      nowMs: () => now,
    });

    const scheduler = createSessionResetScheduler(deps);
    scheduler.start();

    // First sweep: large timeout, no reset
    expect(mgr.expire).not.toHaveBeenCalled();

    // Hot-reload: change to small timeout
    currentConfig = defaultConfig({
      mode: "idle",
      idleTimeoutMs: 10_000,
      sweepIntervalMs: 60_000,
    });

    // Advance to next sweep
    vi.advanceTimersByTime(60_000);

    // Second sweep should use new config and expire the session
    expect(mgr.expire).toHaveBeenCalledTimes(1);

    scheduler.stop();
  });

  it("sweep() with undefined getConfig skips all sessions", () => {
    const store = mockSessionStore([]);
    const deps = makeDeps({
      sessionStore: store as unknown as SessionStorePort,
      getConfig: () => undefined,
    });

    const scheduler = createSessionResetScheduler(deps);
    scheduler.sweep();

    // listDetailed should not be called when config is undefined
    expect(store.listDetailed).not.toHaveBeenCalled();
  });
});
