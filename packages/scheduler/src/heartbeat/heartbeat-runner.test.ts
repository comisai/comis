// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";
import { TypedEventBus } from "@comis/core";
import { ok } from "@comis/shared";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { HeartbeatRunnerDeps, HeartbeatNotification } from "./heartbeat-runner.js";
import type { HeartbeatSourcePort, HeartbeatCheckResult } from "./heartbeat-source.js";
import type { QuietHoursConfig } from "./quiet-hours.js";
import { createHeartbeatRunner } from "./heartbeat-runner.js";
import { HEARTBEAT_OK_TOKEN } from "./relevance-filter.js";

function makeSource(
  id: string,
  text: string,
  overrides?: Partial<HeartbeatCheckResult>,
): HeartbeatSourcePort {
  return {
    id,
    name: `Source ${id}`,
    check: vi.fn(async () => ({
      sourceId: id,
      text,
      timestamp: Date.now(),
      ...overrides,
    })),
  };
}

function makeLogger() {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return logger;
}

function makeDeps(overrides?: Partial<HeartbeatRunnerDeps>): HeartbeatRunnerDeps {
  return {
    sources: [],
    eventBus: new TypedEventBus(),
    logger: makeLogger(),
    config: { intervalMs: 1000, showOk: false, showAlerts: true },
    quietHoursConfig: { enabled: false, start: "22:00", end: "07:00", timezone: "UTC" },
    criticalBypass: true,
    onNotification: vi.fn(),
    nowMs: () => Date.UTC(2024, 0, 15, 12, 0, 0),
    ...overrides,
  };
}

describe("HeartbeatRunner", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runOnce calls check() on all sources", async () => {
    const s1 = makeSource("s1", `${HEARTBEAT_OK_TOKEN}`);
    const s2 = makeSource("s2", `${HEARTBEAT_OK_TOKEN}`);
    const deps = makeDeps({ sources: [s1, s2] });
    const runner = createHeartbeatRunner(deps);

    await runner.runOnce();

    expect(s1.check).toHaveBeenCalledOnce();
    expect(s2.check).toHaveBeenCalledOnce();
  });

  it("alert triggers onNotification", async () => {
    const source = makeSource("disk", "Warning: disk usage 95%");
    const deps = makeDeps({
      sources: [source],
      config: { intervalMs: 1000, showOk: false, showAlerts: true },
    });
    const runner = createHeartbeatRunner(deps);

    await runner.runOnce();

    expect(deps.onNotification).toHaveBeenCalledOnce();
    const notification = (deps.onNotification as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as HeartbeatNotification;
    expect(notification.level).toBe("alert");
    expect(notification.sourceId).toBe("disk");
  });

  it("OK with showOk=false does NOT trigger notification", async () => {
    const source = makeSource("ping", `All clear ${HEARTBEAT_OK_TOKEN}`);
    const deps = makeDeps({
      sources: [source],
      config: { intervalMs: 1000, showOk: false, showAlerts: true },
    });
    const runner = createHeartbeatRunner(deps);

    await runner.runOnce();

    expect(deps.onNotification).not.toHaveBeenCalled();
  });

  it("OK with showOk=true triggers notification", async () => {
    const source = makeSource("ping", `All clear ${HEARTBEAT_OK_TOKEN}`);
    const deps = makeDeps({
      sources: [source],
      config: { intervalMs: 1000, showOk: true, showAlerts: true },
    });
    const runner = createHeartbeatRunner(deps);

    await runner.runOnce();

    expect(deps.onNotification).toHaveBeenCalledOnce();
    const notification = (deps.onNotification as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as HeartbeatNotification;
    expect(notification.level).toBe("ok");
  });

  it("quiet hours suppress non-critical", async () => {
    const source = makeSource("cpu", "Warning: high CPU");
    // nowMs at 23:00 UTC, quiet hours 22:00-07:00
    const deps = makeDeps({
      sources: [source],
      config: { intervalMs: 1000, showOk: true, showAlerts: true },
      quietHoursConfig: { enabled: true, start: "22:00", end: "07:00", timezone: "UTC" },
      nowMs: () => Date.UTC(2024, 0, 15, 23, 0, 0),
    });
    const runner = createHeartbeatRunner(deps);

    await runner.runOnce();

    expect(deps.onNotification).not.toHaveBeenCalled();
  });

  it("critical bypasses quiet hours when criticalBypass=true", async () => {
    const source = makeSource("disk", "CRITICAL: disk full");
    // nowMs at 23:00 UTC, quiet hours 22:00-07:00
    const deps = makeDeps({
      sources: [source],
      config: { intervalMs: 1000, showOk: false, showAlerts: true },
      quietHoursConfig: { enabled: true, start: "22:00", end: "07:00", timezone: "UTC" },
      criticalBypass: true,
      nowMs: () => Date.UTC(2024, 0, 15, 23, 0, 0),
    });
    const runner = createHeartbeatRunner(deps);

    await runner.runOnce();

    expect(deps.onNotification).toHaveBeenCalledOnce();
    const notification = (deps.onNotification as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as HeartbeatNotification;
    expect(notification.level).toBe("critical");
  });

  it("emits scheduler:heartbeat_check event with correct counts", async () => {
    const okSource = makeSource("ping", `${HEARTBEAT_OK_TOKEN}`);
    const alertSource = makeSource("cpu", "Warning: high CPU");
    const criticalSource = makeSource("disk", "CRITICAL: disk full");

    const eventBus = new TypedEventBus();
    const events: Array<{ checksRun: number; alertsRaised: number }> = [];
    eventBus.on("scheduler:heartbeat_check", (payload) => {
      events.push(payload);
    });

    const deps = makeDeps({
      sources: [okSource, alertSource, criticalSource],
      eventBus,
      config: { intervalMs: 1000, showOk: true, showAlerts: true },
    });
    const runner = createHeartbeatRunner(deps);

    await runner.runOnce();

    expect(events).toHaveLength(1);
    expect(events[0].checksRun).toBe(3);
    expect(events[0].alertsRaised).toBe(2); // alert + critical
  });

  it("catches and logs source check errors", async () => {
    const errorSource: HeartbeatSourcePort = {
      id: "bad",
      name: "Bad Source",
      check: vi.fn(async () => {
        throw new Error("connection refused");
      }),
    };
    const logger = makeLogger();
    const deps = makeDeps({
      sources: [errorSource],
      logger,
      config: { intervalMs: 1000, showOk: false, showAlerts: true },
    });
    const runner = createHeartbeatRunner(deps);

    await runner.runOnce();

    expect(logger.error).toHaveBeenCalled();
    // Error produces an alert-level notification
    expect(deps.onNotification).toHaveBeenCalledOnce();
  });

  it("sanitizes credentials in notification text via sanitizeLogString", async () => {
    const errorSource: HeartbeatSourcePort = {
      id: "leaky",
      name: "Leaky Source",
      check: vi.fn(async () => {
        throw new Error("Connection failed with token sk-abc123def456ghi789jkl012mno345pqr678");
      }),
    };
    const deps = makeDeps({
      sources: [errorSource],
      config: { intervalMs: 1000, showOk: false, showAlerts: true },
    });
    const runner = createHeartbeatRunner(deps);

    await runner.runOnce();

    expect(deps.onNotification).toHaveBeenCalledOnce();
    const notification = (deps.onNotification as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as HeartbeatNotification;
    // Credentials must be redacted by sanitizeLogString
    expect(notification.text).not.toContain("sk-abc123def456ghi789jkl012mno345pqr678");
    expect(notification.text).toContain("sk-[REDACTED]");
    expect(notification.text).toContain("Error checking source:");
  });

  it("registerSource adds a new source", async () => {
    const deps = makeDeps({ sources: [] });
    const runner = createHeartbeatRunner(deps);

    const newSource = makeSource("new", "Warning: something");
    runner.registerSource(newSource);
    await runner.runOnce();

    expect(newSource.check).toHaveBeenCalledOnce();
  });

  it("unregisterSource removes a source and returns true", async () => {
    const source = makeSource("s1", `${HEARTBEAT_OK_TOKEN}`);
    const deps = makeDeps({ sources: [source] });
    const runner = createHeartbeatRunner(deps);

    const removed = runner.unregisterSource("s1");
    expect(removed).toBe(true);

    await runner.runOnce();
    expect(source.check).not.toHaveBeenCalled();
  });

  it("unregisterSource returns false for unknown source", () => {
    const deps = makeDeps({ sources: [] });
    const runner = createHeartbeatRunner(deps);

    expect(runner.unregisterSource("nonexistent")).toBe(false);
  });

  it("start/stop controls the interval timer", async () => {
    vi.useFakeTimers();
    const source = makeSource("s1", `${HEARTBEAT_OK_TOKEN}`);
    const deps = makeDeps({
      sources: [source],
      config: { intervalMs: 500, showOk: true, showAlerts: true },
    });
    const runner = createHeartbeatRunner(deps);

    runner.start();

    // Advance timer past one interval
    await vi.advanceTimersByTimeAsync(600);
    expect(source.check).toHaveBeenCalled();

    const callCountAfterStart = (source.check as ReturnType<typeof vi.fn>).mock.calls.length;

    runner.stop();

    // Advance further -- no more calls
    (source.check as ReturnType<typeof vi.fn>).mockClear();
    await vi.advanceTimersByTimeAsync(2000);
    expect(source.check).not.toHaveBeenCalled();
  });

  it("start is idempotent (calling twice does not create two timers)", () => {
    const logger = makeLogger();
    const deps = makeDeps({ logger });
    const runner = createHeartbeatRunner(deps);

    runner.start();
    runner.start(); // should not log a second "started" message

    // Only one start message (object-first: logger.info({ ... }, "HeartbeatRunner started"))
    const startCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) =>
        (typeof call[0] === "string" && (call[0] as string).includes("started")) ||
        (typeof call[1] === "string" && (call[1] as string).includes("started")),
    );
    expect(startCalls).toHaveLength(1);

    runner.stop();
  });

  it("lock prevents concurrent checks", async () => {
    const source = makeSource("s1", "Warning: alert");
    const lockFn = vi.fn(
      async <T>(lockPath: string, fn: () => Promise<T>): Promise<Result<T, "locked" | "error">> => {
        const result = await fn();
        return ok(result);
      },
    );
    const deps = makeDeps({
      sources: [source],
      lockFn,
      lockDir: "/tmp/test-locks",
    });
    const runner = createHeartbeatRunner(deps);

    await runner.runOnce();

    expect(lockFn).toHaveBeenCalledOnce();
    expect(lockFn).toHaveBeenCalledWith("/tmp/test-locks/heartbeat.lock", expect.any(Function));
    expect(source.check).toHaveBeenCalledOnce();
  });

  it("lock held -> skips checks and logs warning", async () => {
    const source = makeSource("s1", "Warning: alert");
    const lockFn = vi.fn(
      async <T>(
        _lockPath: string,
        _fn: () => Promise<T>,
      ): Promise<Result<T, "locked" | "error">> => {
        return { ok: false, error: "locked" as const };
      },
    );
    const logger = makeLogger();
    const deps = makeDeps({
      sources: [source],
      lockFn,
      lockDir: "/tmp/test-locks",
      logger,
    });
    const runner = createHeartbeatRunner(deps);

    await runner.runOnce();

    expect(source.check).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ hint: expect.stringContaining("Previous heartbeat check"), errorKind: "resource" }),
      "Heartbeat check skipped",
    );
  });

  it("logs heartbeat tick at DEBUG with checksRun and alertsRaised", async () => {
    const okSource = makeSource("ping", "HEARTBEAT_OK");
    const alertSource = makeSource("cpu", "Warning: high CPU");
    const logger = makeLogger();
    const deps = makeDeps({
      sources: [okSource, alertSource],
      logger,
      config: { intervalMs: 1000, showOk: true, showAlerts: true },
    });
    const runner = createHeartbeatRunner(deps);

    await runner.runOnce();

    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ checksRun: 2, alertsRaised: 1 }),
      "Heartbeat tick complete",
    );
  });

  it("handles lock error (non-locked failure) and logs error", async () => {
    const source = makeSource("s1", "Warning: alert");
    const lockFn = vi.fn(
      async <T>(
        _lockPath: string,
        _fn: () => Promise<T>,
      ): Promise<Result<T, "locked" | "error">> => {
        return { ok: false, error: "error" as const };
      },
    );
    const logger = makeLogger();
    const deps = makeDeps({
      sources: [source],
      lockFn,
      lockDir: "/tmp/test-locks",
      logger,
    });
    const runner = createHeartbeatRunner(deps);

    await runner.runOnce();

    // Checks should NOT have been called (lock failed)
    expect(source.check).not.toHaveBeenCalled();
    // Error logged (not warn -- "error" is different from "locked")
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: expect.stringContaining("Lock acquisition failed"),
        errorKind: "internal",
      }),
      "Heartbeat check lock error",
    );
  });
});
