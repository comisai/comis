// SPDX-License-Identifier: Apache-2.0
/**
 * WIRE-06 (integration tier) — boots the REAL daemon via `startTestDaemon` and
 * proves the daemon-level activity-pipe wiring: setupObservability constructs
 * the ActivityStream, it subscribes to the EventBus at boot (WIRE-01), and the
 * shutdown chain (disposeActivityStream) detaches it without a long-running timer
 * leak (WIRE-05).
 *
 * This is the §17.7 "boots a fake daemon (existing test pattern)" smoke. It lives
 * in the integration tier because the daemon-harness dynamically imports
 * `@comis/daemon`, which only resolves under this config's `@comis/*`→dist
 * aliases (single-fork, dedicated gateway port). The deterministic in-memory pipe
 * proof (Echo apply/finalize/drain, one-coordinator-per-turn) is the unit-tier
 * companion at packages/daemon/src/__tests__/setup-activity.composition.test.ts.
 *
 * @module
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { describe, it, expect, afterAll } from "vitest";
import { startTestDaemon, type TestDaemonHandle } from "../support/daemon-harness.js";
import { EchoChannelAdapter, createTestSink } from "@comis/channels";
import { formatSessionKey, tryGetContext } from "@comis/core";
import type { NormalizedMessage } from "@comis/core";

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPOSITION_CONFIG_PATH = resolve(
  __dirname,
  "../config/config.test-activity-composition.yaml",
);

describe("WIRE-06 activity composition: daemon boot wires + drains the ActivityStream", () => {
  let handle: TestDaemonHandle | undefined;

  afterAll(async () => {
    if (handle) {
      try {
        await handle.cleanup();
      } catch (err) {
        // The harness's overridden exit() throws "Daemon exit with code N" by
        // design on graceful shutdown — swallow only that.
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("Daemon exit with code")) throw err;
      }
      handle = undefined;
    }
  });

  it("subscribes the ActivityStream to the EventBus at boot and detaches it plus every long-running timer on shutdown", async () => {
    handle = await startTestDaemon({
      configPath: COMPOSITION_CONFIG_PATH,
      useFakeTimers: true,
    });

    // Assertion 1: setupObservability constructed the ActivityStream, which
    // subscribed to the EventBus tool:* events at boot (WIRE-01).
    const bus = handle.daemon.container.eventBus;
    expect(bus.listenerCount("tool:executed")).toBeGreaterThanOrEqual(1);

    // Graceful shutdown runs the WIRE-05 drain chain (disposeActivityStream
    // detaches the stream's EventBus handlers before the other observability
    // disposes).
    await handle.daemon.shutdownHandle.trigger("test-activity-composition");

    // Assertion 4a: the ActivityStream's EventBus subscription was detached on
    // shutdown (no orphaned subscriber across a restart — T-70-10-03).
    expect(bus.listenerCount("tool:executed")).toBe(0);

    // Assertion 4b: every long-running interval registered during bootstrap was
    // cancelled or unref'd before shutdown completed (same long-running predicate
    // as daemon-shutdown.test.ts).
    const record = handle.getTimerRecord();
    expect(
      record,
      "test daemon must expose timer record — was useFakeTimers set?",
    ).toBeDefined();
    const longRunning = (record ?? []).filter(
      (r) => r.kind === "interval" || r.delay >= 30_000,
    );
    const leaked = longRunning.filter((r) => !r.cancelled && !r.unrefCalled);
    expect(
      leaked,
      `every long-running daemon interval must be cancelled or unref'd by shutdown; leaked:\n${JSON.stringify(leaked, null, 2)}`,
    ).toEqual([]);
  }, 120_000);
});

/**
 * WIRE-06 real-daemon-turn activation test (research §G).
 *
 * This is the RED gate for the whole phase. It boots the REAL daemon via
 * `startTestDaemon`, injects a TestSink spy renderer for the `echo` channelType
 * through the test-only `DaemonOverrides.activityRendererFactory` seam (threaded
 * via the typed `activityRendererFactory` harness option), drives a real inbound
 * Echo turn through the daemon's REAL inbound deps assembly, and asserts the spy
 * received `apply(frame)` at least once.
 *
 * RED proof (pre-Plan-03): the inbound `coordinatorFactory` is unassigned, so the
 * pipeline gate at execution-pipeline.ts:395 (`deps.activityStreamPort &&
 * deps.coordinatorFactory`) is FALSE — no per-turn coordinator is constructed,
 * `coordinator.start()` never subscribes, and `renderer.apply` is never called →
 * `spy.recorded.frames.length === 0` → this assertion FAILS. Plan 03 builds the
 * inbound coordinatorFactory over the renderers map (where the seam injected the
 * spy) and flips this GREEN.
 *
 * Stale-dist trap (Pitfall 3): imports `@comis/daemon` from dist/ — run
 * `pnpm build` before this test or the daemon-side seam edits are masked.
 */
describe("WIRE-06 activity composition: a real inbound Echo turn drives renderer.apply through the daemon's real deps assembly", () => {
  let handle: TestDaemonHandle | undefined;

  afterAll(async () => {
    if (handle) {
      try {
        await handle.cleanup();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("Daemon exit with code")) throw err;
      }
      handle = undefined;
    }
  });

  it("drives renderer.apply on a real inbound Echo turn through the daemon's real deps assembly (WIRE-06)", async () => {
    // The spy the test retains — the per-turn renderer created inside the daemon
    // factory is otherwise unreachable. The seam injects this exact instance for
    // the `echo` channelType at the composition root.
    const spy = createTestSink();

    // Drive the turn inside a try/finally so the daemon is torn down on this
    // attempt even when the assertion below throws — the integration runner sets
    // `retry: 1`, and the double-start guard (daemon-harness.ts) would otherwise
    // reject the retry with "Test daemon already running". Cleanup before the
    // assertion keeps each attempt isolated; `afterAll` is a belt-and-suspenders net.
    let appliedFrames = 0;
    try {
      handle = await startTestDaemon({
        configPath: COMPOSITION_CONFIG_PATH,
        activityRendererFactory: (channelType) => (channelType === "echo" ? spy : undefined),
      });

      // Register the Echo adapter on the daemon's REAL adapter map (the same
      // Map<string, ChannelPort> exposed as adapterRegistry === adaptersByType, and
      // the delivery-side map) so the daemon's pipeline can find it for the turn.
      const echo = new EchoChannelAdapter({ channelId: "echo-activation", channelType: "echo" });
      handle.daemon.adapterRegistry.set("echo", echo);
      handle.daemon.deliveryAdapters.set("echo", echo);

      // Drive a deterministic activity event THROUGH the daemon's real ActivityStream
      // during the turn. The test daemon has no working LLM (the dummy ANTHROPIC_API_KEY
      // 401s), so the inbound turn emits no tool:*/model:* events on its own. We emit one
      // real `tool:executed` on the daemon's EventBus, correlated to THIS turn's
      // {agentId, sessionKey, traceId} so the inbound coordinator's turn-scoped
      // subscription receives it → chatProjection → renderer.apply(frame). The
      // `message:received` listener fires INSIDE the turn's runWithContext (the
      // injectMessage wrap), so tryGetContext().traceId is the turn's live traceId —
      // the SAME id the coordinator subscribed with. This proves the daemon's REAL deps
      // assembly wires the ActivityStream → coordinatorFactory → renderer end-to-end.
      const bus = handle.daemon.container.eventBus;
      const onReceived = (ev: { message: NormalizedMessage; sessionKey: import("@comis/core").SessionKey }): void => {
        if (ev.message.channelType !== "echo") return;
        // Capture the turn correlation SYNCHRONOUSLY (tryGetContext is only valid
        // inside the turn's runWithContext). `message:received` fires in Phase 1
        // (resolveAndPreprocess), BEFORE the coordinator subscribes at the pipeline
        // gate (execution-pipeline.ts:395), so schedule the emit on a short delay to
        // land AFTER the coordinator's subscribeForTurn — otherwise the turn-scoped
        // subscription misses the event (the stream is live-only, no replay).
        const traceId = tryGetContext()?.traceId;
        if (traceId === undefined) return;
        const sessionKey = formatSessionKey(ev.sessionKey);
        setTimeout(() => {
          bus.emit("tool:executed", {
            toolName: "read_file",
            durationMs: 4,
            success: true,
            timestamp: Date.now(),
            toolCallId: randomUUID(),
            agentId: "default",
            sessionKey,
            traceId,
            params: { path: "wire06-activation.txt" },
          });
        }, 300);
      };
      bus.on("message:received", onReceived);

      // Drive a real inbound turn through the daemon's REAL inbound pipeline deps.
      // channelManager.injectMessage(channelType, msg) → processInboundMessage(pipelineDeps, …)
      // is the same code path a live channel takes; pipelineDeps is the daemon's
      // real deps record (the one Plan 03 injects coordinatorFactory onto).
      const msg: NormalizedMessage = {
        id: randomUUID(),
        channelId: "echo-activation",
        channelType: "echo",
        senderId: "wire06-sender",
        text: "WIRE-06 activation turn",
        timestamp: Date.now(),
        attachments: [],
        metadata: {},
      };
      // channelManager is undefined when no channels are configured at boot
      // (setup-channels-runtime.ts only builds it when adaptersByType.size > 0).
      // Drive through it when present; otherwise the inbound path cannot run and
      // the assertion below stays RED (frames.length 0) on the pre-Plan-03 tree.
      const cm = handle.daemon.channelManager;
      if (cm) {
        await cm.injectMessage("echo", msg);
      }

      // Wait for the turn's activity to reach the coordinator → spy.apply. The apply
      // is debounced ~800ms (activity-turn-coordinator.ts:58); poll on real timers
      // with a bounded cap rather than asserting on a single tick. On the pre-Plan-03
      // tree no coordinator is ever constructed, so this poll exhausts its budget
      // and the assertion below fails (the captured RED).
      const deadline = Date.now() + 10_000;
      while (spy.recorded.frames.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      appliedFrames = spy.recorded.frames.length;
    } finally {
      if (handle) {
        try {
          await handle.cleanup();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes("Daemon exit with code")) throw err;
        }
        handle = undefined;
      }
    }

    // GREEN (after Plan 03): renderer.apply fired on the real inbound turn.
    // RED (current): frames.length === 0 — no inbound coordinatorFactory → gate
    // execution-pipeline.ts:395 false → coordinator never built → apply never called.
    expect(
      appliedFrames,
      "renderer.apply must fire >= 1 on a real inbound Echo turn through the daemon's real deps assembly " +
        "(RED until Plan 03 injects the inbound coordinatorFactory onto createChannelManager)",
    ).toBeGreaterThanOrEqual(1);
  }, 120_000);
});
