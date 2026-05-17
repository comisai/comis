// SPDX-License-Identifier: Apache-2.0
/**
 * Install-detour soft-stop refuses pre-spawn
 *
 * Deterministic CI-gating behavioral surface for the soft-stop contract.
 * Boots the daemon with config.test-tooling-soft-stop.yaml (port 8507,
 * mode="soft-stop", no approvalGate), constructs createExecTool inline
 * against the live daemon container's eventBus + secretManager, and verifies
 * that `pip install market-data-lib` is refused PRE-SPAWN with the
 * permission_denied template.
 *
 * Refusal pre-spawn means:
 * 1. ONE `tool:install_detour_detected` event with action="soft_stopped"
 * 2. tool.execute() throws "[permission_denied] ..." (caught by exec-tool's
 *    outer try/catch which re-throws when message starts with "["; see
 *    exec-tool.ts:1016-1018, exec-tool.test.ts:2502-2504)
 * 3. NO successful `tool:executed` event (verified via negative awaiter — a
 *    listener captures all exec events during a 1-second window after the
 *    refusal; assertion verifies none have success=true)
 * 4. Privacy invariant — payload JSON does not contain raw command/cwd
 *
 * exec is NOT an RPC method (packages/daemon/src/wiring/setup-gateway-api.ts
 * has no exec.* allowlist entry). Driving the install-detour code path
 * requires inline createExecTool + tool.execute().
 *
 * @module
 */

// -----------------------------------------------------------------------------
// CI POLICY: This test is the deterministic CI-gating behavioral surface for
// install-detour soft-stop. It MUST run on every PR — do NOT wrap the
// describe block in a conditional skip. Provider-gated metric tests are
// conditionally skipped; this one is not.
// -----------------------------------------------------------------------------

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  startTestDaemon,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import { DAEMON_STARTUP_MS } from "../support/timeouts.js";
import { createEventAwaiter } from "../support/event-awaiter.js";
import type { TypedEventBus, EventMap } from "@comis/core";
// exec / process registry live at the `./tools` subpath.
import { createExecTool, createProcessRegistry } from "@comis/skills/tools";
// Test-only stub. Allowed import from test/integration/ — the architecture-grep
// (packages/skills/src/__tests__/architecture.test.ts) scopes only
// packages/<pkg>/src/**/*.ts, NOT test/integration/.
import { createCapabilityPortStub } from "../../packages/core/src/ports/__test-helpers/tool-capability-stub.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = resolve(
  __dirname,
  "../config/config.test-tooling-soft-stop.yaml",
);

describe("Install-detour soft-stop refuses pre-spawn", () => {
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
    "pip install of overlapping package is refused pre-spawn in soft-stop mode",
    async () => {
      const awaiter = createEventAwaiter(eventBus);
      // Negative awaiter: capture every tool:executed for "exec" within a
      // 1-second window after the refusal. Soft-stop refusal happens
      // PRE-SPAWN (see exec-tool.ts:767-789 — throwToolError(
      // "permission_denied", ...) fires BEFORE any spawn site). Therefore
      // tool:executed for "exec" with success=true MUST NOT fire. The
      // exec-tool may emit tool:executed with success=false OR not emit
      // at all; both pass the assertion below.
      type ExecutedPayload = EventMap["tool:executed"];
      const collectedExecEvents: ExecutedPayload[] = [];
      const execListener = (e: ExecutedPayload): void => {
        if (e.toolName === "exec") collectedExecEvents.push(e);
      };
      eventBus.on("tool:executed", execListener);

      try {
        // 1. Register listener BEFORE triggering — filter on action "soft_stopped".
        const eventPromise = awaiter.waitFor("tool:install_detour_detected", {
          timeoutMs: 30_000,
          filter: (payload) => payload.action === "soft_stopped",
        });

        // 2. Build the configured ToolCapabilityPort. Mode = "soft-stop" +
        //    the finance-data MCP overlap source. The capabilityPort
        //    .replacesPackages array MUST include "market-data-lib" so
        //    parseInstallDetour finds the overlap.
        const capabilityPort = createCapabilityPortStub({
          getInstallDetourMode: () => "soft-stop" as const,
          getConnectedMcpServers: () => ["finance-data"],
          getMcpServerHint: (server) =>
            server === "finance-data"
              ? {
                  cluster: "data-fetching-financial",
                  description: "Market prices, history, fundamentals.",
                  replacesPackages: ["market-data-lib"],
                }
              : undefined,
          getClusterConfig: (id) =>
            id === "data-fetching-financial"
              ? {
                  label: "Data fetching - financial / market",
                  priority: 10,
                  preferOverInstalls: true,
                }
              : undefined,
        });

        // 3. Construct exec-tool inline. Same as the advise test, with
        //    capabilityPort wired to "soft-stop" mode + approvalGate
        //    undefined so the exec-tool's fail-closed branch fires
        //    (exec-tool.ts:792-804).
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
          approvalGate: undefined, // soft-stop fail-closed (no override path)
        });

        // 4. Invoke directly. tool.execute() THROWS for soft-stop (verified
        //    at exec-tool.ts:1016-1018: outer try/catch re-throws when
        //    message starts with "[", and exec-tool.test.ts:2502-2504 uses
        //    rejects.toThrow). Capture the thrown error message for assertion.
        let thrownMessage = "";
        await expect(
          tool.execute("test-soft-stop-1", {
            command: "pip install market-data-lib",
            cwd: "/tmp",
            timeoutMs: 5_000,
          }),
        )
          .rejects.toThrow(/Refused: install overlaps/)
          .catch((err: unknown) => {
            // expect().rejects.toThrow() returns void on match; the catch
            // here only fires if the assertion ITSELF rejects, which we
            // do not expect. Kept defensively to surface non-matching errors.
            throw err;
          });

        // Re-run inside try/catch to capture the exact message for additional
        // assertions on the template content. (expect.rejects.toThrow does
        // not expose the error object directly.)
        try {
          await tool.execute("test-soft-stop-2", {
            command: "pip install market-data-lib",
            cwd: "/tmp",
            timeoutMs: 5_000,
          });
        } catch (err) {
          thrownMessage = err instanceof Error ? err.message : String(err);
        }
        expect(thrownMessage).toMatch(
          /\[permission_denied\] Refused: install overlaps/,
        );
        expect(thrownMessage).toContain('connected MCP server "finance-data"');
        expect(thrownMessage).toContain("market-data-lib");

        // 5. Assert: at least one event with action "soft_stopped" was
        //    emitted. (Two tool.execute() calls above produce two events —
        //    the awaiter's filter resolves on the first matching one.)
        const event = await eventPromise;
        expect(event.mode).toBe("soft-stop");
        expect(event.action).toBe("soft_stopped");
        expect(event.packageManager).toBe("pip");
        expect(event.overlaps.length).toBeGreaterThan(0);
        expect(event.overlaps[0]?.sourceType).toBe("mcp");
        expect(event.overlaps[0]?.sourceName).toBe("finance-data");
        expect(event.commandDigest).toMatch(/^[0-9a-f]{16}$/);

        // 6. Privacy invariant — payload does NOT contain raw command shape
        //    or the `cwd` we passed in. The closed payload excludes both
        //    raw command and cwd.
        const payloadJson = JSON.stringify(event);
        expect(payloadJson).not.toMatch(/pip install/);
        expect(payloadJson).not.toContain("/tmp");

        // 7. Allow a brief settle window for tool:executed to fire if it
        //    were going to.
        await new Promise((r) => setTimeout(r, 1000));

        // 8. Assert: NO successful exec subprocess. Refusal is pre-spawn,
        //    so any captured exec event MUST have success !== true;
        //    preferably none were captured at all.
        for (const exe of collectedExecEvents) {
          expect(exe.success).not.toBe(true);
        }
      } finally {
        eventBus.off("tool:executed", execListener);
        awaiter.dispose();
      }
    },
    90_000,
  );
});
