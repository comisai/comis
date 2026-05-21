// SPDX-License-Identifier: Apache-2.0
/**
 * Daemon shutdown teardown integration test (CRIT-03 / EVENT-CLEAN-01).
 *
 * Asserts that each of the 9 ShutdownDeps teardown components introduced by
 * Phase 50 Plan 01 runs exactly once on simulated SIGTERM and SIGUSR2 (restart
 * path), and that double-shutdown is idempotent.
 *
 * Per RESEARCH Open Question #2 (RESOLVED): the 8 production
 * `eventBus.on("system:shutdown", ...)` subscribers map to 9 ShutdownDeps
 * fields because setup-tools.ts's single closure splits into two independent
 * concerns (background-processes + mcp-client-manager).
 *
 * @module
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { startTestDaemon } from "../support/daemon-harness.js";
import {
  createLogCapture,
  type LogEntry,
} from "../support/log-verifier.js";
import { ASYNC_SETTLE_MS } from "../support/timeouts.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEARDOWN_CONFIG_PATH = resolve(
  __dirname,
  "../config/config.test-daemon-shutdown-teardown.yaml",
);

/**
 * Expected teardown component names — these are the values that the
 * `daemonLogger.info({ component: "..." }, "Component stopped")` log lines
 * carry in the setup-shutdown.ts block bodies (CRIT-03 wiring).
 *
 * 9 components total, derived from the 8 production
 * `system:shutdown` subscribers + the setup-tools split (RESEARCH Open Q #2).
 *
 * 8 of the 9 wire INDEPENDENTLY of channel adapter presence — those are
 * asserted unconditionally. The 9th, `approval-notifier`, only wires when
 * `adaptersByType.size > 0` (setup-channels-runtime.ts:543). Because this
 * test runs without enabling a real channel (which would require live
 * credential validation against external APIs), `approval-notifier` is
 * treated as "wired-if-present, optional-if-absent". Its exactly-once
 * teardown contract is independently exercised by setup-shutdown.ts unit
 * tests and the daemon-shutdown.test.ts existing integration test.
 */
const ALWAYS_WIRED_COMPONENTS = [
  "background-processes",          // setup-tools.ts (split #1)
  "mcp-client-manager",            // setup-tools.ts (split #2)
  "background-completion-runner",  // setup-background-completion-runner
  "proxy-typing",                  // setup-cross-session-events.ts
  "delivery-queue",                // channels-helpers.ts (setupDeliveryQueue.shutdown)
  "delivery-mirror",               // channels-helpers.ts (setupDeliveryMirror.shutdown)
  "output-retention",              // channels-helpers.ts (setupOutputRetention.shutdown)
  "channel-health-monitor",        // channels-helpers.ts (setupChannelHealthMonitor.stop)
] as const;

const OPTIONAL_COMPONENTS = [
  "approval-notifier",             // requires adaptersByType.size > 0
] as const;

function countComponentStops(entries: LogEntry[], component: string): number {
  return entries.filter(
    (e) => e.msg === "Component stopped" && (e as Record<string, unknown>)["component"] === component,
  ).length;
}

describe("Daemon shutdown teardowns (CRIT-03)", () => {
  it("SIGTERM invokes the 8 always-wired teardown components exactly once", async () => {
    const logCapture = createLogCapture();
    const handle = await startTestDaemon({
      configPath: TEARDOWN_CONFIG_PATH,
      logStream: logCapture.stream,
      useFakeTimers: true,
    });

    try {
      try {
        await handle.daemon.shutdownHandle.trigger("SIGTERM");
      } catch (err) {
        // Expected: exit override throws "Daemon exit with code 0"
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("Daemon exit with code")) throw err;
      }

      // Wait for async cleanup + log flush
      await new Promise((r) => setTimeout(r, ASYNC_SETTLE_MS * 5));

      const entries = logCapture.getEntries();
      const missing: string[] = [];
      const duplicated: Array<{ component: string; count: number }> = [];

      for (const component of ALWAYS_WIRED_COMPONENTS) {
        const count = countComponentStops(entries, component);
        if (count === 0) {
          missing.push(component);
        } else if (count > 1) {
          duplicated.push({ component, count });
        }
      }

      // Optional components: assert <= 1 if present
      for (const component of OPTIONAL_COMPONENTS) {
        const count = countComponentStops(entries, component);
        if (count > 1) {
          duplicated.push({ component, count });
        }
      }

      expect(
        missing,
        `Components missing teardown invocation on SIGTERM:\n${missing.join("\n")}\n` +
          `These teardowns are silently no-op'd today because the system:shutdown event has zero production emitters (CRIT-03).`,
      ).toEqual([]);

      expect(
        duplicated,
        `Components invoked more than once on SIGTERM:\n${JSON.stringify(duplicated, null, 2)}`,
      ).toEqual([]);
    } finally {
      // Run the harness cleanup so the activeHandle guard releases before
      // the next describe block starts another daemon. cleanup() also runs
      // shutdown again (no-op when already triggered) and disposes signal
      // handlers.
      try {
        await handle.cleanup();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("Daemon exit with code")) throw err;
      }
    }
  }, 60_000);

  it("SIGUSR2 (restart) invokes the 8 always-wired teardown components exactly once", async () => {
    const logCapture = createLogCapture();
    const handle = await startTestDaemon({
      configPath: TEARDOWN_CONFIG_PATH,
      logStream: logCapture.stream,
      useFakeTimers: true,
    });

    try {
      try {
        await handle.daemon.shutdownHandle.trigger("SIGUSR2");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("Daemon exit with code")) throw err;
      }

      await new Promise((r) => setTimeout(r, ASYNC_SETTLE_MS * 5));

      const entries = logCapture.getEntries();
      const missing: string[] = [];
      const duplicated: Array<{ component: string; count: number }> = [];

      for (const component of ALWAYS_WIRED_COMPONENTS) {
        const count = countComponentStops(entries, component);
        if (count === 0) {
          missing.push(component);
        } else if (count > 1) {
          duplicated.push({ component, count });
        }
      }

      for (const component of OPTIONAL_COMPONENTS) {
        const count = countComponentStops(entries, component);
        if (count > 1) {
          duplicated.push({ component, count });
        }
      }

      expect(
        missing,
        `Components missing teardown invocation on SIGUSR2:\n${missing.join("\n")}`,
      ).toEqual([]);

      expect(
        duplicated,
        `Components invoked more than once on SIGUSR2:\n${JSON.stringify(duplicated, null, 2)}`,
      ).toEqual([]);
    } finally {
      try {
        await handle.cleanup();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("Daemon exit with code")) throw err;
      }
    }
  }, 60_000);

  it("Double-shutdown is idempotent (second trigger is a no-op)", async () => {
    const logCapture = createLogCapture();
    const handle = await startTestDaemon({
      configPath: TEARDOWN_CONFIG_PATH,
      logStream: logCapture.stream,
      useFakeTimers: true,
    });

    try {
      // First trigger
      try {
        await handle.daemon.shutdownHandle.trigger("SIGTERM");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("Daemon exit with code")) throw err;
      }

      await new Promise((r) => setTimeout(r, ASYNC_SETTLE_MS * 5));

      // Second trigger (must be a no-op — shutdown handle should guard)
      try {
        await handle.daemon.shutdownHandle.trigger("SIGTERM");
      } catch {
        // Either re-entrant no-op or "already shutting down" error are
        // acceptable; the assertion below is about teardown component
        // log-line counts, not the second trigger's return value.
      }

      await new Promise((r) => setTimeout(r, ASYNC_SETTLE_MS * 5));

      const entries = logCapture.getEntries();
      const duplicated: Array<{ component: string; count: number }> = [];

      for (const component of [...ALWAYS_WIRED_COMPONENTS, ...OPTIONAL_COMPONENTS]) {
        const count = countComponentStops(entries, component);
        if (count > 1) {
          duplicated.push({ component, count });
        }
      }

      expect(
        duplicated,
        `Double-shutdown caused components to be torn down more than once:\n${JSON.stringify(duplicated, null, 2)}`,
      ).toEqual([]);
    } finally {
      try {
        await handle.cleanup();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("Daemon exit with code")) throw err;
      }
    }
  }, 60_000);
});
