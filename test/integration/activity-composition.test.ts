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
import { describe, it, expect, afterAll } from "vitest";
import { startTestDaemon, type TestDaemonHandle } from "../support/daemon-harness.js";

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
