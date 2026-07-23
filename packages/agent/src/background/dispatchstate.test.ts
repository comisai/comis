// SPDX-License-Identifier: Apache-2.0
//
// dispatchState 3-state machine + persistence + recovery.
//
//   - BackgroundSessionState: "pending" | "notified" | "dispatched"
//   - BackgroundTaskNotificationPolicy: typed enum (NOT a boolean)
//   - dispatchState persists alongside BackgroundTask JSON file
//   - Recovery-without-events: on daemon restart, recover dispatchState from
//     disk; do NOT replay events
//   - At-most-once fallback: state-machine transitions are the source of
//     truth
//
// We import from the real modules where possible and from the dispatcher
// module via dynamic-import-with-undefined so the suite reaches assertions
// and fails meaningfully.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createConversationRef, safePath } from "@comis/core";
import {
  createBackgroundTaskManager,
  type BackgroundTaskManager,
} from "./background-task-manager.js";
import { persistTaskSync } from "./background-task-persistence.js";
import type {
  BackgroundTaskOrigin,
  PersistedTaskState,
} from "./background-task-types.js";
import type { ClockPort, TimerPort, TimerHandle } from "@comis/core";

// ---------------------------------------------------------------------------
// Lightweight port wrappers that delegate to globals so vi.useFakeTimers()
// continues to intercept Date.now / setTimeout below.
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

const testClock: ClockPort = {
  now: () => Date.now(),
  nowDate: () => new Date(),
};

const testTimers: TimerPort = {
  setTimeout: (cb, ms) => wrapTimerHandle(setTimeout(cb, ms)),
  setInterval: (cb, ms) => wrapTimerHandle(setInterval(cb, ms)),
};

function createMockEventBus() {
  const emits: Array<{ event: string; data: unknown }> = [];
  return {
    bus: {
      emit: vi.fn((event: string, data: unknown) => {
        emits.push({ event, data });
      }),
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as import("@comis/core").TypedEventBus,
    emits,
  };
}

function createMockLogger() {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
}

function buildOrigin(overrides: Partial<BackgroundTaskOrigin> & { agentId?: string } = {}): BackgroundTaskOrigin {
  const agentId = overrides.agentId ?? "default";
  const endpoint = { channelType: "echo", channelInstanceId: "test-instance", conversationId: "test", conversationKind: "direct" as const };
  const turnScope = { conversation: { tenantId: "default", agentId, partition: { kind: "endpoint-conversation-principal" as const, endpoint, principalId: "user1" } }, principal: { principalId: "user1" }, endpoint };
  const conversationRef = createConversationRef(turnScope.conversation);
  if (!conversationRef.ok) throw conversationRef.error;
  return {
    turnScope,
    conversationRef: conversationRef.value,
    deliveryOrigin: { channelType: "echo", channelId: "test", userId: "user1", tenantId: "default" },
    traceId: null,
    responseLocalePolicy: { source: "unset", enforceLocale: false },
    backgroundHopCount: 0,
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "agentId")),
  };
}

// Dynamic loader for the dispatcher module. The import-with-undefined
// pattern ensures the test suite reaches its assertions and fails
// meaningfully even if the module fails to resolve.
async function loadDispatchTypes(): Promise<
  | {
      // 3-state typed enum.
      STATES?: readonly string[];
      // Notification policy typed enum (not boolean).
      BackgroundTaskNotificationPolicy?: Record<string, string> | readonly string[];
    }
  | undefined
> {
  try {
    const mod = (await import("./completion-dispatcher.js")) as Record<string, unknown>;
    return mod as unknown as {
      STATES?: readonly string[];
      BackgroundTaskNotificationPolicy?: Record<string, string> | readonly string[];
    };
  } catch {
    return undefined;
  }
}

describe("dispatchState 3-state machine + persistence + recovery", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = safePath(tmpdir(), `comis-dispatch-state-${randomUUID()}`);
    mkdirSync(dataDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("BackgroundSessionState is a 3-element typed enum (pending/notified/dispatched)", async () => {
    const mod = await loadDispatchTypes();
    expect(mod).toBeDefined();
    if (!mod) return;
    expect(mod.STATES).toEqual(["pending", "notified", "dispatched"]);
  });

  it("BackgroundTaskNotificationPolicy is a typed enum (NOT a boolean) and round-trips through JSON", async () => {
    const mod = await loadDispatchTypes();
    expect(mod).toBeDefined();
    if (!mod) return;

    const policy = mod.BackgroundTaskNotificationPolicy;
    // Either object-style or array-style enum is acceptable; what matters is
    // that it round-trips through JSON.parse(JSON.stringify(...)) preserving
    // identity (i.e., it is NOT a boolean — booleans collapse to true/false
    // and lose intent across restart-recovery).
    expect(policy).toBeDefined();
    if (Array.isArray(policy)) {
      expect(policy.length).toBeGreaterThanOrEqual(1);
    } else {
      expect(typeof policy).toBe("object");
    }
    const round = JSON.parse(JSON.stringify(policy));
    expect(round).toEqual(policy);
  });

  it("dispatchState persists through BackgroundTask path (with _promise)", () => {
    // Build a BackgroundTask shape (has _promise), the same code path the
    // manager's complete()/fail() funnel through. The toPersistedState
    // helper at background-task-persistence.ts:20-31 carries dispatchState
    // through PersistedTaskState so it survives.
    const taskWithPromise: Record<string, unknown> = {
      id: "task-pending",
      toolName: "exec",
      status: "completed",
      startedAt: 1,
      completedAt: 2,
      origin: buildOrigin({ agentId: "agent-a" }),
      dispatchState: "pending",
      _promise: Promise.resolve(),
    };
    persistTaskSync(dataDir, taskWithPromise as unknown as import("./background-task-types.js").BackgroundTask);

    const filePath = safePath(safePath(dataDir, "agent-a"), "task-pending.json");
    expect(existsSync(filePath)).toBe(true);
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
    // PersistedTaskState carries dispatchState — assertion holds.
    expect(parsed.dispatchState).toBe("pending");

    // Advance through the BackgroundTask path to "notified".
    const advanced: Record<string, unknown> = { ...taskWithPromise, dispatchState: "notified" };
    persistTaskSync(dataDir, advanced as unknown as import("./background-task-types.js").BackgroundTask);
    const reread = JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
    expect(reread.dispatchState).toBe("notified");
  });

  it("recovery-without-events preserves dispatchState", () => {
    // Seed a task JSON file with dispatchState: "notified" already on disk.
    const agentDir = safePath(dataDir, "agent-recover");
    mkdirSync(agentDir, { recursive: true });
    const filePath = safePath(agentDir, "task-recovered.json");
    const seeded: Record<string, unknown> = {
      id: "task-recovered",
      toolName: "exec",
      status: "completed",
      startedAt: 1,
      completedAt: 2,
      origin: buildOrigin({ agentId: "agent-recover" }),
      dispatchState: "notified",
    };
    writeFileSync(filePath, JSON.stringify(seeded, null, 2), "utf-8");

    // Build a manager and call recoverOnStartup. Assert NO notify event was
    // emitted by the eventBus (recovery-without-events).
    const mockBus = createMockEventBus();
    const logger = createMockLogger();
    const manager: BackgroundTaskManager = createBackgroundTaskManager({
      dataDir,
      eventBus: mockBus.bus,
      logger,
      clock: testClock,
      timers: testTimers,
      maxPerAgent: 5,
      maxTotal: 20,
      maxBackgroundDurationMs: 60_000,
    });
    manager.recoverOnStartup();

    // No notify event was emitted.
    const notifyEvents = mockBus.emits.filter(
      (e) => e.event === "background_task:notify" || e.event === "notify",
    );
    expect(notifyEvents).toHaveLength(0);

    // The recovered task's dispatchState is "notified".
    const recovered = manager.getTask("task-recovered") as
      | (import("./background-task-types.js").BackgroundTask & { dispatchState?: string })
      | undefined;
    expect(recovered).toBeDefined();
    expect(recovered?.dispatchState).toBe("notified");
  });
});
