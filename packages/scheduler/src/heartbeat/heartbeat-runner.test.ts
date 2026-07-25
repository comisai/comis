// SPDX-License-Identifier: Apache-2.0
import { TypedEventBus } from "@comis/core";
import { err, ok } from "@comis/shared";
import { describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { createFakeTimers } from "../../../../test/support/fake-timers.js";
import { createHeartbeatRunner } from "./heartbeat-runner.js";
import type { HeartbeatSourcePort } from "./heartbeat-source.js";

const NOW_MS = 1_800_000_000_000;

function source(
  id: string,
  result = ok({
    level: "ok" as const,
    observedAtMs: NOW_MS,
    code: "healthy",
    counters: [],
  }),
): HeartbeatSourcePort {
  return { id, check: vi.fn(async () => result) };
}

function fixture(overrides: Record<string, unknown> = {}) {
  const clock = createFakeClock(NOW_MS);
  const timers = createFakeTimers(NOW_MS);
  const eventBus = new TypedEventBus();
  const logger = {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  };
  const runner = createHeartbeatRunner({
    sources: [],
    clock,
    timers,
    eventBus,
    logger,
    staleMs: 120_000,
    ...overrides,
  } as never);
  return { clock, timers, eventBus, logger, runner };
}

describe("monitoring heartbeat runner", () => {
  it("fails closed when configured source identities are invalid or duplicated", async () => {
    for (const sources of [[source("")], [source("monitor_disk"), source("monitor_disk")]]) {
      const built = fixture({ sources });
      await expect(built.runner.runOnce("manual", new AbortController().signal)).resolves.toEqual(err({
        code: "precondition_failed",
        errorKind: "precondition",
      }));
    }
  });

  it("returns exact settled counters from closed source diagnostics", async () => {
    const healthy = source("monitor_disk");
    const critical = source("monitor_cpu", ok({
      level: "critical",
      observedAtMs: NOW_MS,
      code: "threshold_exceeded",
      counters: [{ name: "used_percent", value: 95 }],
    }));
    const built = fixture({ sources: [healthy, critical] });

    await expect(built.runner.runOnce("interval", new AbortController().signal)).resolves.toEqual(ok({
      status: "settled",
      trigger: "interval",
      checksRun: 2,
      checksFailed: 0,
      alertsRaised: 1,
      durationMs: 0,
    }));
    expect(healthy.check).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(critical.check).toHaveBeenCalledWith(expect.any(AbortSignal));
  });

  it("classifies returned and thrown source failures without exposing prose", async () => {
    const returned = source("monitor_disk", err({ code: "stat_failed", errorKind: "resource" }));
    const thrown: HeartbeatSourcePort = {
      id: "monitor_service",
      check: vi.fn(async () => { throw new Error("secret-bearing adapter prose"); }),
    };
    const built = fixture({ sources: [returned, thrown] });

    await expect(built.runner.runOnce("manual", new AbortController().signal)).resolves.toMatchObject({
      ok: true,
      value: { status: "settled", checksRun: 2, checksFailed: 2, alertsRaised: 2 },
    });
    expect(built.logger.error).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(built.logger.error.mock.calls)).not.toContain("secret-bearing adapter prose");
  });

  it("classifies malformed source diagnostics as validation failures", async () => {
    const malformed = source("monitor_disk", ok({
      level: "unknown",
      observedAtMs: NOW_MS,
      code: "invalid",
      counters: [],
    } as never));
    const built = fixture({ sources: [malformed] });

    await expect(built.runner.runOnce("hook", new AbortController().signal)).resolves.toMatchObject({
      ok: true,
      value: { checksRun: 1, checksFailed: 1, alertsRaised: 1 },
    });
    expect(built.logger.error).toHaveBeenCalledWith(expect.objectContaining({
      sourceErrorCode: "invalid_diagnostic",
      errorKind: "validation",
    }), "Monitoring source check failed");
  });

  it("fails before a source starts when the requested trigger is invalid or already aborted", async () => {
    const checked = source("monitor_disk");
    const built = fixture({ sources: [checked] });
    const controller = new AbortController();
    controller.abort("shutdown");

    await expect(built.runner.runOnce("task" as never, new AbortController().signal)).resolves.toEqual(err({
      code: "invalid_input",
      errorKind: "validation",
    }));
    await expect(built.runner.runOnce("manual", controller.signal)).resolves.toEqual(err({
      code: "precondition_failed",
      errorKind: "precondition",
    }));
    expect(checked.check).not.toHaveBeenCalled();
  });

  it("returns a cooperative deadline abort after cancelling the active source", async () => {
    const checked: HeartbeatSourcePort = {
      id: "monitor_disk",
      check: vi.fn((signal) => new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve(err({
          code: "cancelled",
          errorKind: "timeout",
        })), { once: true });
      })),
    };
    const built = fixture({ sources: [checked], staleMs: 1_000 });
    const running = built.runner.runOnce("interval", new AbortController().signal);

    built.clock.advance(1_000);
    built.timers.advance(1_000);
    await expect(running).resolves.toEqual(ok({
      status: "aborted",
      trigger: "interval",
      reason: "deadline",
      errorKind: "timeout",
      checksRun: 1,
      checksFailed: 1,
      alertsRaised: 1,
      durationMs: 1_000,
    }));
  });

  it("propagates parent shutdown abort and stops before the next source", async () => {
    const parent = new AbortController();
    const first: HeartbeatSourcePort = {
      id: "monitor_disk",
      check: vi.fn((signal) => new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve(ok({
          level: "ok",
          observedAtMs: NOW_MS,
          code: "cancelled_cleanly",
          counters: [],
        })), { once: true });
      })),
    };
    const second = source("monitor_cpu");
    const built = fixture({ sources: [first, second] });
    const running = built.runner.runOnce("wake", parent.signal);
    await vi.waitFor(() => expect(first.check).toHaveBeenCalledOnce());
    parent.abort("shutdown");

    await expect(running).resolves.toMatchObject({
      ok: true,
      value: { status: "aborted", reason: "shutdown", checksRun: 1 },
    });
    expect(second.check).not.toHaveBeenCalled();
  });

  it("returns unsettled after grace while retaining the busy guard until late settlement", async () => {
    let settle!: () => void;
    const checked: HeartbeatSourcePort = {
      id: "monitor_disk",
      check: vi.fn(() => new Promise((resolve) => {
        settle = () => resolve(ok({
          level: "ok", observedAtMs: NOW_MS, code: "late_ok", counters: [],
        }));
      })),
    };
    const built = fixture({ sources: [checked], staleMs: 1_000 });
    const running = built.runner.runOnce("interval", new AbortController().signal);

    built.clock.advance(1_000);
    built.timers.advance(1_000);
    await Promise.resolve();
    await Promise.resolve();
    built.clock.advance(5_000);
    built.timers.advance(5_000);
    await expect(running).resolves.toEqual(ok({
      status: "unsettled",
      trigger: "interval",
      reason: "deadline_termination_unestablished",
      errorKind: "timeout",
      checksRun: 1,
      checksCompleted: 0,
      checksFailed: 0,
      alertsRaised: 0,
      durationMs: 6_000,
    }));
    expect(built.runner.isBusy()).toBe(true);
    settle();
    await vi.waitFor(() => expect(built.runner.isBusy()).toBe(false));
  });

  it("registers unique source identities and closes admission on shutdown", async () => {
    const checked = source("monitor_disk");
    const built = fixture();

    expect(built.runner.registerSource(checked)).toEqual(ok(undefined));
    expect(built.runner.registerSource(checked)).toEqual(err({
      code: "invalid_input",
      errorKind: "validation",
    }));
    expect(built.runner.unregisterSource("monitor_disk")).toBe(true);
    built.runner.shutdown();
    expect(built.runner.registerSource(checked)).toEqual(err({
      code: "not_bound",
      errorKind: "precondition",
    }));
  });
});
