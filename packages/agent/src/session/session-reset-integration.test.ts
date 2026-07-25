// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  createConversationRef,
  type ComputeDailyResetNextRun,
  type ConversationScope,
  type SessionResetPolicyConfig,
  type TimerHandle,
  type TimerPort,
  type TypedEventBus,
} from "@comis/core";
import { createSessionStore, initSchema, type SessionStore } from "@comis/memory";
import { computeNextRunAtMs } from "@comis/scheduler";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { createSessionLifecycle, type SessionLifecycle } from "./session-lifecycle.js";
import { createSessionResetScheduler, type SessionResetScheduler } from "./session-reset-policy.js";

function wrapTimerHandle(timer: NodeJS.Timeout): TimerHandle {
  let cancelled = false;
  return {
    get cancelled() { return cancelled; },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      clearTimeout(timer);
    },
    unref() {
      if (!cancelled) timer.unref();
    },
  };
}

const testTimers: TimerPort = {
  setTimeout: (callback, delayMs) => wrapTimerHandle(setTimeout(callback, delayMs)),
  setInterval: (callback, delayMs) => wrapTimerHandle(setInterval(callback, delayMs)),
};

const computeDailyResetNextRun: ComputeDailyResetNextRun = (updatedAt, hour, timezone) =>
  computeNextRunAtMs(
    { kind: "cron", expr: `0 ${hour} * * *`, tz: timezone || undefined },
    updatedAt,
  );

function makeScope(
  principalId: string,
  conversationId: string,
  conversationKind: "direct" | "shared" = "direct",
): ConversationScope {
  return {
    tenantId: "t1",
    agentId: "agent_a",
    partition: {
      kind: "endpoint-conversation-principal",
      endpoint: {
        channelType: "test",
        channelInstanceId: "test-instance",
        conversationId,
        conversationKind,
      },
      principalId,
    },
  };
}

interface TestHarness {
  db: Database.Database;
  sessionStore: SessionStore;
  sessionManager: SessionLifecycle;
  scheduler: SessionResetScheduler;
  events: Array<{ name: string; payload: unknown }>;
  setNow(ms: number): void;
}

function createTestHarness(config: Partial<SessionResetPolicyConfig>): TestHarness {
  const db = new Database(":memory:");
  initSchema(db, 1536);
  const sessionStore = createSessionStore(db);
  const sessionManager = createSessionLifecycle(sessionStore);
  const events: Array<{ name: string; payload: unknown }> = [];
  const eventBus = {
    emit: (name: string, payload: unknown) => { events.push({ name, payload }); },
    on: () => {},
    off: () => {},
  } as unknown as TypedEventBus;
  const fullConfig: SessionResetPolicyConfig = {
    mode: "idle",
    dailyResetHour: 4,
    dailyResetTimezone: "",
    idleTimeoutMs: 14_400_000,
    sweepIntervalMs: 300_000,
    resetTriggers: [],
    perType: {},
    ...config,
  };
  let nowMs = Date.now();
  const scheduler = createSessionResetScheduler({
    sessionStore,
    sessionManager,
    eventBus,
    logger: createMockLogger(),
    getConfig: () => fullConfig,
    computeDailyResetNextRun,
    nowMs: () => nowMs,
    timers: testTimers,
    listQueryScopes: () => [{ tenantId: "t1", agentId: "agent_a" }],
  });
  return {
    db,
    sessionStore,
    sessionManager,
    scheduler,
    events,
    setNow(value) { nowMs = value; },
  };
}

function saveAt(
  harness: TestHarness,
  scope: ConversationScope,
  updatedAt: number,
  metadata: Record<string, unknown> = {},
): void {
  const saved = harness.sessionStore.save(scope, [{ role: "user", content: "test" }], metadata);
  expect(saved.ok).toBe(true);
  const conversationRef = createConversationRef(scope);
  if (!conversationRef.ok) throw conversationRef.error;
  harness.db.prepare(
    "UPDATE sessions SET updated_at = ? WHERE tenant_id = ? AND agent_id = ? AND conversation_ref = ?",
  ).run(updatedAt, scope.tenantId, scope.agentId, conversationRef.value);
}

function isStored(harness: TestHarness, scope: ConversationScope): boolean {
  const loaded = harness.sessionStore.load(scope);
  expect(loaded.ok).toBe(true);
  return loaded.ok && loaded.value !== undefined;
}

describe("Session reset integration", () => {
  let harness: TestHarness;

  afterEach(() => {
    harness.scheduler.stop();
    harness.db.close();
  });

  it("expires a conversation beyond the idle timeout", () => {
    harness = createTestHarness({ mode: "idle", idleTimeoutMs: 14_400_000 });
    const now = Date.now();
    const scope = makeScope("user_a", "chat_a");
    saveAt(harness, scope, now - 5 * 60 * 60 * 1000);
    harness.setNow(now);

    harness.scheduler.sweep();

    expect(isStored(harness, scope)).toBe(false);
    expect(harness.events).toContainEqual({
      name: "session:expired",
      payload: { conversationScope: scope, reason: "auto-reset:idle" },
    });
  });

  it("retains a conversation inside the idle timeout", () => {
    harness = createTestHarness({ mode: "idle", idleTimeoutMs: 14_400_000 });
    const now = Date.now();
    const scope = makeScope("user_a", "chat_a");
    saveAt(harness, scope, now - 60 * 60 * 1000);
    harness.setNow(now);

    harness.scheduler.sweep();

    expect(isStored(harness, scope)).toBe(true);
    expect(harness.events).toHaveLength(0);
  });

  it("expires a conversation across the configured daily boundary", () => {
    harness = createTestHarness({ mode: "daily", dailyResetHour: 4, dailyResetTimezone: "UTC" });
    const scope = makeScope("user_a", "chat_a");
    saveAt(harness, scope, new Date("2026-02-10T03:00:00Z").getTime());
    harness.setNow(new Date("2026-02-11T05:00:00Z").getTime());

    harness.scheduler.sweep();

    expect(isStored(harness, scope)).toBe(false);
  });

  it("retains a conversation updated after the current daily boundary", () => {
    harness = createTestHarness({ mode: "daily", dailyResetHour: 4, dailyResetTimezone: "UTC" });
    const scope = makeScope("user_a", "chat_a");
    saveAt(harness, scope, new Date("2026-02-11T05:00:00Z").getTime());
    harness.setNow(new Date("2026-02-11T06:00:00Z").getTime());

    harness.scheduler.sweep();

    expect(isStored(harness, scope)).toBe(true);
  });

  it("hybrid mode expires conversations matching either condition", () => {
    harness = createTestHarness({
      mode: "hybrid",
      dailyResetHour: 4,
      dailyResetTimezone: "UTC",
      idleTimeoutMs: 14_400_000,
    });
    const now = new Date("2026-02-11T05:00:00Z").getTime();
    const idle = makeScope("idle_user", "chat_idle");
    const daily = makeScope("daily_user", "chat_daily");
    saveAt(harness, idle, now - 5 * 60 * 60 * 1000);
    saveAt(harness, daily, new Date("2026-02-11T01:30:00Z").getTime());
    harness.setNow(now);

    harness.scheduler.sweep();

    expect(isStored(harness, idle)).toBe(false);
    expect(isStored(harness, daily)).toBe(false);
  });

  it("hybrid mode retains a conversation matching neither condition", () => {
    harness = createTestHarness({
      mode: "hybrid",
      dailyResetHour: 4,
      dailyResetTimezone: "UTC",
      idleTimeoutMs: 14_400_000,
    });
    const scope = makeScope("fresh_user", "chat_fresh");
    saveAt(harness, scope, new Date("2026-02-11T04:30:00Z").getTime());
    harness.setNow(new Date("2026-02-11T05:00:00Z").getTime());

    harness.scheduler.sweep();

    expect(isStored(harness, scope)).toBe(true);
  });

  it("applies conversation-kind overrides without parsing display keys", () => {
    harness = createTestHarness({
      mode: "idle",
      idleTimeoutMs: 14_400_000,
      perType: { group: { mode: "none" } },
    });
    const now = Date.now();
    const direct = makeScope("user_a", "direct_chat");
    const shared = makeScope("user_b", "shared_chat", "shared");
    saveAt(harness, direct, now - 5 * 60 * 60 * 1000);
    saveAt(harness, shared, now - 5 * 60 * 60 * 1000);
    harness.setNow(now);

    harness.scheduler.sweep();

    expect(isStored(harness, direct)).toBe(false);
    expect(isStored(harness, shared)).toBe(true);
  });

  it("retains sub-agent conversations managed by their own lifecycle", () => {
    harness = createTestHarness({ mode: "idle", idleTimeoutMs: 14_400_000 });
    const now = Date.now();
    const child = makeScope("child_principal", "child_chat");
    const regular = makeScope("user_a", "chat_a");
    saveAt(harness, child, now - 5 * 60 * 60 * 1000, { parentSessionKey: "parent" });
    saveAt(harness, regular, now - 5 * 60 * 60 * 1000);
    harness.setNow(now);

    harness.scheduler.sweep();

    expect(isStored(harness, child)).toBe(true);
    expect(isStored(harness, regular)).toBe(false);
  });
});

function matchesResetTrigger(text: string, triggers: string[]): boolean {
  const lowerText = text.toLowerCase().trim();
  for (const trigger of triggers) {
    try {
      if (trigger.startsWith("/") && trigger.endsWith("/") && trigger.length > 2) {
        if (new RegExp(trigger.slice(1, -1), "i").test(lowerText)) return true;
      } else if (lowerText === trigger.toLowerCase()) return true;
    } catch {
      continue;
    }
  }
  return false;
}

describe("Trigger Phrase Matching", () => {
  it("matches literal trigger phrases case-insensitively", () => {
    expect(matchesResetTrigger("Reset Session", ["reset session"])).toBe(true);
  });

  it("matches regular-expression trigger patterns", () => {
    expect(matchesResetTrigger("I want to start over now", ["/start over/"])).toBe(true);
  });

  it("does not match different text", () => {
    expect(matchesResetTrigger("hello", ["reset session"])).toBe(false);
  });

  it("skips invalid regular expressions", () => {
    expect(matchesResetTrigger("test", ["/[invalid/"])).toBe(false);
  });

  it("handles an empty trigger list", () => {
    expect(matchesResetTrigger("anything", [])).toBe(false);
  });

  it("matches any configured trigger", () => {
    expect(matchesResetTrigger("new chat", ["reset session", "new chat", "/forget/"])).toBe(true);
  });

  it("trims input whitespace", () => {
    expect(matchesResetTrigger("  reset session  ", ["reset session"])).toBe(true);
  });
});
