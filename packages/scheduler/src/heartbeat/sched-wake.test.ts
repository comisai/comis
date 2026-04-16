/**
 * Wake tool triggers immediate heartbeat execution.
 *
 * The wake tool calls rpcCall("scheduler.wake"). The daemon handles this
 * RPC by calling heartbeatRunner.runOnce(). These tests verify the
 * heartbeat side: runOnce() directly (simulating the RPC handler)
 * executes all registered sources.
 */

import { TypedEventBus } from "@comis/core";
import { describe, it, expect, vi } from "vitest";
import type { HeartbeatRunnerDeps, HeartbeatNotification } from "./heartbeat-runner.js";
import type { HeartbeatSourcePort } from "./heartbeat-source.js";
import type { QuietHoursConfig } from "./quiet-hours.js";
import { createHeartbeatRunner } from "./heartbeat-runner.js";
import { HEARTBEAT_OK_TOKEN } from "./relevance-filter.js";

// ---------------------------------------------------------------------------
// Helpers (reused from heartbeat-runner.test.ts patterns)
// ---------------------------------------------------------------------------

function makeSource(id: string, text: string): HeartbeatSourcePort {
  return {
    id,
    name: `Source ${id}`,
    check: vi.fn(async () => ({
      sourceId: id,
      text,
      timestamp: Date.now(),
    })),
  };
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

const quietHoursOff: QuietHoursConfig = {
  enabled: false,
  start: "00:00",
  end: "00:00",
  timezone: "UTC",
};

function makeDeps(overrides?: Partial<HeartbeatRunnerDeps>): HeartbeatRunnerDeps {
  return {
    sources: [],
    eventBus: new TypedEventBus(),
    logger: makeLogger(),
    config: { intervalMs: 60_000, showOk: false, showAlerts: true },
    quietHoursConfig: quietHoursOff,
    criticalBypass: true,
    onNotification: vi.fn(),
    nowMs: () => Date.UTC(2024, 0, 15, 12, 0, 0),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe("Wake tool triggers immediate heartbeat execution", () => {
  it("runOnce() checks all registered sources and emits heartbeat_check event", async () => {
    const s1 = makeSource("s1", `${HEARTBEAT_OK_TOKEN}`);
    const s2 = makeSource("s2", `${HEARTBEAT_OK_TOKEN}`);

    const eventBus = new TypedEventBus();
    const events: Array<{ checksRun: number; alertsRaised: number }> = [];
    eventBus.on("scheduler:heartbeat_check", (payload) => {
      events.push(payload);
    });

    const deps = makeDeps({ sources: [s1, s2], eventBus });
    const runner = createHeartbeatRunner(deps);

    await runner.runOnce();

    // Both sources checked
    expect(s1.check).toHaveBeenCalledOnce();
    expect(s2.check).toHaveBeenCalledOnce();

    // Event emitted with correct counts
    expect(events).toHaveLength(1);
    expect(events[0].checksRun).toBe(2);
    expect(events[0].alertsRaised).toBe(0);
  });

  it("runOnce() can be called on-demand without start() (simulating wake RPC)", async () => {
    const s1 = makeSource("s1", `${HEARTBEAT_OK_TOKEN}`);
    const s2 = makeSource("s2", `${HEARTBEAT_OK_TOKEN}`);

    const deps = makeDeps({ sources: [s1, s2] });
    const runner = createHeartbeatRunner(deps);

    // Do NOT call start() -- no periodic interval running.
    // Call runOnce() directly, simulating the daemon's wake RPC handler.
    await runner.runOnce();

    // Sources are checked despite no interval being active
    expect(s1.check).toHaveBeenCalledOnce();
    expect(s2.check).toHaveBeenCalledOnce();
  });

  it("runOnce() delivers notifications for alert-level results", async () => {
    // Text without HEARTBEAT_OK_TOKEN and without "CRITICAL"/"EMERGENCY"
    // classifies as "alert" level
    const alertSource = makeSource("disk", "Warning: disk usage 95%");

    const notifications: HeartbeatNotification[] = [];
    const onNotification = vi.fn((n: HeartbeatNotification) => {
      notifications.push(n);
    });

    const deps = makeDeps({
      sources: [alertSource],
      config: { intervalMs: 60_000, showOk: false, showAlerts: true },
      onNotification,
    });
    const runner = createHeartbeatRunner(deps);

    // Call runOnce() directly (simulating wake-triggered execution)
    await runner.runOnce();

    // onNotification called with alert-level notification
    expect(onNotification).toHaveBeenCalledOnce();
    expect(notifications).toHaveLength(1);
    expect(notifications[0].level).toBe("alert");
    expect(notifications[0].sourceId).toBe("disk");
    expect(notifications[0].text).toBe("Warning: disk usage 95%");
  });
});
