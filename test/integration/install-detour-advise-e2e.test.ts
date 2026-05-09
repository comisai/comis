// SPDX-License-Identifier: Apache-2.0
/**
 * Phase 24 INTEG-05: Install-detour advise-mode end-to-end
 *
 * Promotes the Phase 22 unit-level install-detour surface to integration
 * level via the real daemon-harness path. Boots the daemon with the Phase 24
 * advise-mode test config (config.test-tooling-fixtures.yaml, port 8506)
 * and exercises the install-detour code path by directly invoking
 * `createExecTool` against the live daemon container's eventBus and
 * secretManager.
 *
 * exec is NOT an RPC method (verified at planning time:
 * packages/daemon/src/wiring/setup-gateway-rpc.ts has no exec.* in the
 * allowlist). It is an AgentTool registered at exec-tool.ts:600. Driving
 * the install-detour code path requires constructing the tool inline and
 * calling tool.execute() directly.
 *
 * In advise mode the tool emits a `tool:install_detour_detected` event with
 * action="hinted" for each overlap, then falls through to spawn the
 * subprocess. The result envelope carries `details.installDetourHint`
 * augmentation (Phase 22 contract).
 *
 * NOT skipif-wrapped — deterministic CI gate (INTEG-05).
 *
 * @module
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  startTestDaemon,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import { DAEMON_STARTUP_MS } from "../support/timeouts.js";
import { createEventAwaiter } from "../support/event-awaiter.js";
import type { TypedEventBus } from "@comis/core";
import { createExecTool, createProcessRegistry } from "@comis/skills";
// Test-only stub. Allowed import from test/integration/ — the architecture-grep
// (packages/skills/src/__tests__/architecture.test.ts) scopes only
// packages/<pkg>/src/**/*.ts, NOT test/integration/.
import { createCapabilityPortStub } from "../../packages/core/src/ports/__test-helpers/tool-capability-stub.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = resolve(
  __dirname,
  "../config/config.test-tooling-fixtures.yaml",
);

describe("Phase 24 INTEG-05: Install-detour advise-mode end-to-end", () => {
  let handle: TestDaemonHandle;
  let eventBus: TypedEventBus;

  beforeAll(async () => {
    handle = await startTestDaemon({ configPath: CONFIG_PATH });
    eventBus = (handle.daemon.container as unknown as { eventBus: TypedEventBus })
      .eventBus;
  }, DAEMON_STARTUP_MS + 30_000);

  afterAll(async () => {
    if (handle) {
      try {
        await handle.cleanup();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("Daemon exit with code")) {
          throw err;
        }
      }
    }
  }, 30_000);

  it(
    "advise mode emits 'hinted' event with overlap; command runs unchanged with installDetourHint augmentation",
    async () => {
      const awaiter = createEventAwaiter(eventBus);
      try {
        // 1. Register listener BEFORE triggering the tool call.
        const eventPromise = awaiter.waitFor("tool:install_detour_detected", {
          timeoutMs: 30_000,
          filter: (payload) => payload.action === "hinted",
        });

        // 2. Build the configured ToolCapabilityPort. Mode = "advise" + the
        //    finance-data MCP overlap source matching the test config's
        //    tooling.mcp.capabilityHints.finance-data.replacesPackages.
        const capabilityPort = createCapabilityPortStub({
          getInstallDetourMode: () => "advise" as const,
          getConnectedMcpServers: () => ["finance-data"],
          getMcpServerHint: (server) =>
            server === "finance-data"
              ? {
                  cluster: "data-fetching-financial",
                  description: "Market prices, history, fundamentals.",
                  replacesPackages: ["market-data-lib"],
                }
              : undefined,
        });

        // 3. Construct exec-tool inline. eventBus + secretManager from the
        //    live daemon container so the install-detour event flows through
        //    the SAME bus the test's awaiter is subscribed to.
        const container = handle.daemon.container as unknown as {
          eventBus: TypedEventBus;
          secretManager: {
            get(k: string): string | undefined;
            keys(): string[];
          };
        };
        const registry = createProcessRegistry();
        const tool = createExecTool({
          workspacePath: "/tmp",
          registry,
          secretManager: container.secretManager,
          platformSecretNames: new Set<string>(),
          logger: handle.daemon.logger as unknown as Parameters<
            typeof createExecTool
          >[0]["logger"],
          subprocessEnv: {
            PATH: process.env["PATH"] ?? "",
            HOME: process.env["HOME"] ?? "",
          },
          sandboxConfig: undefined,
          eventBus: container.eventBus,
          getToolResultsDir: () => undefined,
          toolCapabilityPort: capabilityPort,
          approvalGate: undefined,
        });

        // 4. Invoke directly. Returns AgentToolResult — does NOT throw on
        //    install-detour hint (advise mode falls through to spawn). The
        //    actual `pip install market-data-lib` will fail at the OS level
        //    (fictional package) but the hint is augmented onto the result.
        const result = await tool.execute("test-advise-1", {
          command: "pip install market-data-lib",
          cwd: "/tmp",
          timeoutMs: 5_000,
        });

        // 5. Await the hinted event.
        const event = await eventPromise;
        expect(event.mode).toBe("advise");
        expect(event.action).toBe("hinted");
        expect(event.packageManager).toBe("pip");
        expect(event.overlaps.length).toBeGreaterThan(0);
        expect(event.overlaps[0]?.sourceType).toBe("mcp");
        expect(event.overlaps[0]?.sourceName).toBe("finance-data");
        expect(event.commandDigest).toMatch(/^[0-9a-f]{16}$/);
        expect(event.packages.length).toBeGreaterThan(0);
        expect(event.packages[0]?.normalizedName).toBe("market-data-lib");
        expect(event.packages[0]?.ecosystem).toBe("python");

        // 6. Privacy invariant — payload MUST NOT contain raw command text.
        //    The normalized package name "market-data-lib" IS a legitimate
        //    field of the closed payload (event.packages[0].normalizedName,
        //    design §8.2). Only the verbatim raw command form must be
        //    absent.
        const payloadJson = JSON.stringify(event);
        expect(payloadJson).not.toMatch(/pip install/);

        // 7. Advise mode is non-blocking — the tool.execute() returned a
        //    result envelope. The actual subprocess (pip install of a
        //    fictional package) errors at the OS level; the result envelope
        //    captures that as exitCode != 0 with stderr. The Phase 22
        //    advise-mode contract injects details.installDetourHint into
        //    BOTH success and exit-with-error envelopes (exec-tool.ts:1132
        //    + :1470). NO permission_denied is raised in advise mode.
        const resultJson = JSON.stringify(result);
        // Forbidden tokens that would indicate the refusal path fired by
        // mistake (this test is advise-mode only). The regex dot `soft.stop`
        // matches the canonical refusal-mode tokens emitted by the policy
        // gate when refusal fires.
        expect(resultJson).not.toMatch(/permission_denied|soft.stop|refused/i);

        // installDetourHint augmentation IS expected — Phase 22 advise-mode
        // contract guarantees it on every overlap-triggering exec call.
        const details = (result as { details?: Record<string, unknown> })
          .details;
        expect(details).toBeDefined();
        const hintField = (
          details as { installDetourHint?: unknown }
        ).installDetourHint;
        expect(typeof hintField).toBe("string");
        expect((hintField as string).length).toBeGreaterThan(0);
        expect(hintField as string).toContain("market-data-lib");
      } finally {
        awaiter.dispose();
      }
    },
    90_000,
  );
});
