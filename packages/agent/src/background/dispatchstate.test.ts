// SPDX-License-Identifier: Apache-2.0
//
// T0.11–T0.14 — dispatchState 3-state machine + persistence + recovery.
//
// Phase 2 (Plan 15-04) introduces:
//   - BackgroundSessionState: "pending" | "notified" | "dispatched" (D-S1)
//   - BackgroundTaskNotificationPolicy: typed enum (NOT a boolean) (D-S1)
//   - dispatchState persists alongside BackgroundTask JSON file (D-S2)
//   - Recovery-without-events: on daemon restart, recover dispatchState from
//     disk; do NOT replay events (D-S2 + D-S3)
//   - At-most-once fallback: state-machine transitions are the source of
//     truth (D-S3)
//
// All four tests are RED until 15-04 lands the new types + persistence
// extensions. We import from the real modules where possible and from
// the not-yet-existing dispatcher module via dynamic-import-with-undefined
// so the suite reaches assertions and fails meaningfully.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { safePath } from "@comis/core";
import {
  createBackgroundTaskManager,
  type BackgroundTaskManager,
} from "./background-task-manager.js";
import { persistTaskSync } from "./background-task-persistence.js";
import type {
  BackgroundTaskOrigin,
  PersistedTaskState,
} from "./background-task-types.js";

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

function buildOrigin(overrides: Partial<BackgroundTaskOrigin> = {}): BackgroundTaskOrigin {
  return {
    agentId: "default",
    sessionKey: "default:echo:test:user1",
    channelType: "echo",
    channelId: "test",
    traceId: null,
    backgroundHopCount: 0,
    ...overrides,
  };
}

// Dynamic loader for the not-yet-existing dispatcher module. The module
// surface is dictated by Phase 2 (15-04). The import-with-undefined pattern
// ensures the test suite reaches its assertions even when the module does
// not yet exist.
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

  it("T0.11: BackgroundSessionState is a 3-element typed enum (pending/notified/dispatched)", async () => {
    const mod = await loadDispatchTypes();
    expect(mod).toBeDefined();
    if (!mod) return;
    expect(mod.STATES).toEqual(["pending", "notified", "dispatched"]);
  });

  it("T0.12: BackgroundTaskNotificationPolicy is a typed enum (NOT a boolean) and round-trips through JSON", async () => {
    const mod = await loadDispatchTypes();
    expect(mod).toBeDefined();
    if (!mod) return;

    const policy = mod.BackgroundTaskNotificationPolicy;
    // Either object-style or array-style enum is acceptable; what matters is
    // that it round-trips through JSON.parse(JSON.stringify(...)) preserving
    // identity (i.e., it is NOT a boolean — booleans collapse to true/false
    // and lose intent across restart-recovery per D-S1).
    expect(policy).toBeDefined();
    if (Array.isArray(policy)) {
      expect(policy.length).toBeGreaterThanOrEqual(1);
    } else {
      expect(typeof policy).toBe("object");
    }
    const round = JSON.parse(JSON.stringify(policy));
    expect(round).toEqual(policy);
  });

  it("T0.13: dispatchState persists through BackgroundTask path (D-S2, with _promise)", () => {
    // Build a BackgroundTask shape (has _promise), the same code path the
    // manager's complete()/fail() funnel through. Pre-Phase-2 the
    // toPersistedState helper at background-task-persistence.ts:20-31 strips
    // anything outside the typed shape; dispatchState gets dropped. Post-
    // Phase-2 dispatchState is part of PersistedTaskState and survives.
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
    // Pre-Phase-2: toPersistedState strips dispatchState — assertion fails.
    // Post-Phase-2: PersistedTaskState carries dispatchState — assertion holds.
    expect(parsed.dispatchState).toBe("pending");

    // Advance through the BackgroundTask path to "notified".
    const advanced: Record<string, unknown> = { ...taskWithPromise, dispatchState: "notified" };
    persistTaskSync(dataDir, advanced as unknown as import("./background-task-types.js").BackgroundTask);
    const reread = JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
    expect(reread.dispatchState).toBe("notified");
  });

  it("T0.14: recovery-without-events preserves dispatchState (AC-5, D-S2 + D-S3)", () => {
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
      maxPerAgent: 5,
      maxTotal: 20,
      maxBackgroundDurationMs: 60_000,
    });
    manager.recoverOnStartup();

    // No notify event was emitted (T0.14).
    const notifyEvents = mockBus.emits.filter(
      (e) => e.event === "background_task:notify" || e.event === "notify",
    );
    expect(notifyEvents).toHaveLength(0);

    // The recovered task's dispatchState is "notified" (D-S2). Pre-Phase-2,
    // BackgroundTask does not carry dispatchState, so the access is unknown.
    const recovered = manager.getTask("task-recovered") as
      | (import("./background-task-types.js").BackgroundTask & { dispatchState?: string })
      | undefined;
    expect(recovered).toBeDefined();
    expect(recovered?.dispatchState).toBe("notified");
  });
});
