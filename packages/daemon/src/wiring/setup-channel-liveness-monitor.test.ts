// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { createFakeTimers } from "../../../../test/support/fake-timers.js";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { setupChannelLivenessMonitor } from "./setup-channel-liveness-monitor.js";
import type { ChannelPort, ChannelStatus } from "@comis/core";
import type { BootContext } from "../daemon-types.js";

const THRESHOLD = 21_600_000; // the 6h MsTeamsChannelEntrySchema default

/** A stub ChannelPort exposing only getStatus(). The status may be a static
 *  partial or a thunk so a test can advance lastInboundAt between checks. */
function makeAdapter(
  status: Partial<ChannelStatus> | (() => Partial<ChannelStatus>),
): ChannelPort {
  const resolve = typeof status === "function" ? status : () => status;
  return {
    getStatus: (): ChannelStatus => ({
      connected: true,
      channelId: "msteams-1",
      channelType: "msteams",
      ...resolve(),
    }),
  } as unknown as ChannelPort;
}

function makeHarness(opts: {
  adapters: Array<[string, ChannelPort]>;
  enabled?: boolean;
  thresholdMs?: number;
  initialMs?: number;
}): {
  deps: Parameters<typeof setupChannelLivenessMonitor>[0];
  emit: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  timer: ReturnType<typeof createFakeTimers>;
  clock: ReturnType<typeof createFakeClock>;
} {
  const initialMs = opts.initialMs ?? 0;
  const emit = vi.fn();
  const warn = vi.fn();
  const timer = createFakeTimers(initialMs);
  const clock = createFakeClock(initialMs);
  const container = {
    config: {
      channels: {
        msteams: {
          enabled: opts.enabled ?? true,
          missedInboundThresholdMs: opts.thresholdMs ?? THRESHOLD,
        },
      },
    },
    eventBus: { emit },
  } as unknown as BootContext["container"];
  const daemonLogger = {
    warn,
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  } as unknown as Parameters<typeof setupChannelLivenessMonitor>[0]["daemonLogger"];
  const deps: Parameters<typeof setupChannelLivenessMonitor>[0] = {
    adaptersByType: new Map(opts.adapters) as NonNullable<BootContext["adaptersByType"]>,
    daemonLogger,
    container,
    timer,
    now: () => clock.now(),
  };
  return { deps, emit, warn, timer, clock };
}

describe("setupChannelLivenessMonitor", () => {
  it("emits exactly one channel:inbound_silent + a platform WARN once a webhook ingress is silent past the threshold", () => {
    const { deps, emit, warn, clock, timer } = makeHarness({
      adapters: [["msteams", makeAdapter({ connectionMode: "webhook", lastInboundAt: 0 })]],
    });
    const { stop } = setupChannelLivenessMonitor(deps);
    // Advance well past the threshold and across many check intervals.
    clock.advance(THRESHOLD + 2_000_000);
    timer.advance(THRESHOLD + 2_000_000);

    expect(emit).toHaveBeenCalledTimes(1);
    const [event, payload] = emit.mock.calls[0]! as [string, {
      channelType: string;
      lastInboundAt: number | null;
      silentForMs: number;
      thresholdMs: number;
      timestamp: number;
    }];
    expect(event).toBe("channel:inbound_silent");
    expect(payload.channelType).toBe("msteams");
    expect(payload.thresholdMs).toBe(THRESHOLD);
    expect(payload.lastInboundAt).toBe(0);
    expect(payload.silentForMs).toBeGreaterThan(THRESHOLD);

    expect(warn).toHaveBeenCalledTimes(1);
    const warnFields = warn.mock.calls[0]![0] as { errorKind: string; hint: string; channelType: string };
    expect(warnFields.errorKind).toBe("platform");
    expect(warnFields.hint).toBeTruthy();
    expect(warnFields.channelType).toBe("msteams");

    stop?.();
  });

  it("emits nothing while a webhook ingress has received inbound within the threshold", () => {
    const { deps, emit, warn, clock, timer } = makeHarness({
      adapters: [["msteams", makeAdapter({ connectionMode: "webhook", lastInboundAt: 0 })]],
    });
    setupChannelLivenessMonitor(deps);
    // Advance only halfway to the threshold — the silence never exceeds it.
    clock.advance(THRESHOLD / 2);
    timer.advance(THRESHOLD / 2);
    expect(emit).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("emits for a webhook adapter that has NEVER received inbound (null lastInboundAt) once daemon uptime exceeds the threshold", () => {
    const { deps, emit, clock, timer } = makeHarness({
      // No lastInboundAt at all → null; baseline is the daemon-start (setup) time.
      adapters: [["msteams", makeAdapter({ connectionMode: "webhook" })]],
    });
    setupChannelLivenessMonitor(deps);
    clock.advance(THRESHOLD + 1_000_000);
    timer.advance(THRESHOLD + 1_000_000);
    expect(emit).toHaveBeenCalledTimes(1);
    const payload = emit.mock.calls[0]![1] as { lastInboundAt: number | null };
    expect(payload.lastInboundAt).toBeNull();
  });

  it("re-alerts after inbound resumes and then goes silent again (debounced once per silent window)", () => {
    let lastInbound = 0;
    const { deps, emit, clock, timer } = makeHarness({
      adapters: [["msteams", makeAdapter(() => ({ connectionMode: "webhook", lastInboundAt: lastInbound }))]],
    });
    setupChannelLivenessMonitor(deps);

    // 1) Silent past threshold → one alert (debounced across the many ticks).
    clock.advance(THRESHOLD + 1_000_000);
    timer.advance(THRESHOLD + 1_000_000);
    expect(emit).toHaveBeenCalledTimes(1);

    // 2) Inbound resumes: the last-received timestamp jumps to now; one check
    //    interval later the silence is back under the threshold → debounce clears.
    lastInbound = clock.now();
    clock.advance(1_000_000);
    timer.advance(1_000_000);
    expect(emit).toHaveBeenCalledTimes(1); // still just the first alert

    // 3) Silent again past threshold → a second, fresh alert.
    clock.advance(THRESHOLD + 1_000_000);
    timer.advance(THRESHOLD + 1_000_000);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it("stop() cancels the interval (unref'd + cancelled, no leaked timer) and no further alerts fire", () => {
    const { deps, emit, timer, clock } = makeHarness({
      adapters: [["msteams", makeAdapter({ connectionMode: "webhook", lastInboundAt: 0 })]],
    });
    const { stop } = setupChannelLivenessMonitor(deps);
    expect(stop).toBeDefined();
    stop!();

    const interval = timer.unrefRecord().find((e) => e.kind === "interval");
    expect(interval).toBeDefined();
    expect(interval!.cancelled).toBe(true);
    expect(interval!.unrefCalled).toBe(true);

    // A cancelled interval never fires again, so no alert is emitted.
    clock.advance(THRESHOLD * 3);
    timer.advance(THRESHOLD * 3);
    expect(emit).not.toHaveBeenCalled();
  });

  it("is a no-op (undefined monitor + stop) when the msteams channel is disabled", () => {
    const { deps } = makeHarness({
      adapters: [["msteams", makeAdapter({ connectionMode: "webhook", lastInboundAt: 0 })]],
      enabled: false,
    });
    const result = setupChannelLivenessMonitor(deps);
    expect(result.monitor).toBeUndefined();
    expect(result.stop).toBeUndefined();
  });

  it("is a no-op when there are no webhook adapters to watch (socket-only system)", () => {
    const { deps, timer } = makeHarness({
      adapters: [["telegram", makeAdapter({ connectionMode: "socket", lastInboundAt: 0 })]],
      enabled: true,
    });
    const result = setupChannelLivenessMonitor(deps);
    expect(result.monitor).toBeUndefined();
    expect(result.stop).toBeUndefined();
    // No interval was ever scheduled.
    expect(timer.unrefRecord().some((e) => e.kind === "interval")).toBe(false);
  });
});
