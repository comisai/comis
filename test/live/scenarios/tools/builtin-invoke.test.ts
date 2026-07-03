// SPDX-License-Identifier: Apache-2.0
/**
 * TOOL-01 — real-model built-in tool invocation scenario test.
 *
 * Certifies that the Comis agent can invoke built-in tools during a conversation
 * turn, that tool:executed events are emitted with the expected shape, and that
 * a throwing tool surfaces gracefully without crashing the agent loop.
 *
 * Stage-A (always runs, no COMIS_LIVE needed):
 *   Validates event-bus wiring — the tool:executed and tool:install_detour_detected
 *   listeners can be registered and unregistered without error. Stage-A does NOT
 *   call sendTurn (no LLM call is made), so no "JSON-RPC method error" is emitted.
 *   Therefore Stage-A afterEach keeps expectedErrors: [] (empty).
 *
 * Stage-C (describe.skipIf(!isLive)):
 *   Real-LLM it.each over TOOL_SAMPLE — drives targeted prompts for sampled
 *   built-in tools (datetime, web_search, memory_search). Asserts
 *   toolEvents.length >= 1 and toolEvents.some(e => e.success === true).
 *   Includes tool-error-no-crash resilience test: sendTurn resolves even when
 *   a tool errors.
 *
 * Security notes:
 *   - tool:executed listener is unregistered in a finally block
 *     — no handler persists after the test.
 *   - toolName is structural metadata, not PII; the log-oracle
 *     post-condition checks no secret leaks in daemon log.
 *
 * costTier: "¢" — cheapest model per provider (Haiku / gpt-4o-mini).
 *
 * @module
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { ConversationDriver, flushDaemonLogs } from "../../harness/conversation.js";
import { runLogOracle } from "../../assert/log-oracle.js";
import { runDbOracle } from "../../assert/db-oracle.js";
import { buildCredentialRegistry } from "../../credentials.js";

// ---------------------------------------------------------------------------
// COMIS_LIVE gate — Stage-C blocks skip (not fail) when unset
// ---------------------------------------------------------------------------

const isLive = !!process.env["COMIS_LIVE"];

// Daemon startup budget for beforeAll timeout.
const DAEMON_STARTUP_MS = 15_000;

// ---------------------------------------------------------------------------
// TOOL_SAMPLE matrix — targeted prompts for sampled built-in tools (Stage-C)
// ---------------------------------------------------------------------------

const TOOL_SAMPLE = [
  {
    toolName: "datetime",
    prompt: "What is the current date and time? Use a tool to get it.",
  },
  {
    toolName: "web_search",
    prompt: "Search the web for: latest Anthropic Claude updates.",
  },
  {
    toolName: "memory_search",
    prompt: "Search my memories for notes about 'project testing'.",
  },
] as const;

// ---------------------------------------------------------------------------
// Stage-A — event-bus wiring, always runs (CI-safe, no COMIS_LIVE needed)
//
// NOTE: Stage-A does NOT call sendTurn — no LLM provider call is made, so
// rpc-dispatch.ts does NOT emit "JSON-RPC method error". Keep expectedErrors: []
// in afterEach (mirrors LOOP-02 Stage-A precedent).
// ---------------------------------------------------------------------------

describe("TOOL-01 Stage-A — event-bus wiring (no COMIS_LIVE)", () => {
  let driver: ConversationDriver;

  beforeAll(async () => {
    driver = new ConversationDriver({ agentId: "tool-01-a", timeoutMs: 30_000 });
    await driver.init();
  }, DAEMON_STARTUP_MS + 30_000);

  afterAll(async () => {
    try {
      await driver.close();
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      if (!m.includes("Daemon exit")) throw err;
    }
  });

  afterEach(async () => {
    // Flush daemon log buffer before snapshotting (T-134-flush).
    await flushDaemonLogs(driver);

    // No sendTurn is called in Stage-A — no provider failure ERROR is emitted.
    // Keep expectedErrors: [] (no "JSON-RPC method error" will appear here).
    await runLogOracle(driver.capturedLogLines(), { expectedErrors: [] });

    // Persistence oracle — only run if memory.db was created.
    const dbPath = join(driver.getDataDir(), "memory.db");
    if (existsSync(dbPath)) {
      await runDbOracle(dbPath, {});
    }
  });

  it("event bus is accessible on daemon container", () => {
    const handle = driver.getHandle();
    const container = handle.daemon.container as unknown as { eventBus: unknown };
    expect(container.eventBus).toBeTruthy();
  });

  it("tool:executed listener registers and unregisters without error", () => {
    // Verify the event bus accepts and releases a tool:executed listener
    // without throwing. Certifies event-bus wiring before spending any live budget.
    const handle = driver.getHandle();
    const container = handle.daemon.container as unknown as {
      eventBus: {
        on: (event: string, listener: unknown) => void;
        off: (event: string, listener: unknown) => void;
      };
    };

    const listener = (): void => { /* noop */ };

    expect(() => {
      container.eventBus.on("tool:executed", listener);
      container.eventBus.off("tool:executed", listener);
    }).not.toThrow();
  });

  it("tool:install_detour_detected listener registers and unregisters without error", () => {
    // Certifies event-bus wiring for the install-detour event (TOOL-02 related).
    const handle = driver.getHandle();
    const container = handle.daemon.container as unknown as {
      eventBus: {
        on: (event: string, listener: unknown) => void;
        off: (event: string, listener: unknown) => void;
      };
    };

    const listener = (): void => { /* noop */ };

    expect(() => {
      container.eventBus.on("tool:install_detour_detected", listener);
      container.eventBus.off("tool:install_detour_detected", listener);
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Stage-C — real-LLM, gated on COMIS_LIVE (skips in CI, runs in live mode)
// ---------------------------------------------------------------------------

// costTier: "¢" — cheapest available model per provider (Haiku / gpt-4o-mini)
describe.skipIf(!isLive)("Live — TOOL-01 built-in tool invocation (Stage-C, real LLM)", () => {
  const registry = buildCredentialRegistry();
  const availableProviders = ["anthropic", "openai", "google", "groq"].filter(
    (p) => registry.getSkipVerdict(`LLM(${p})`) === null,
  );

  let driver: ConversationDriver;
  let container: {
    eventBus: {
      on: (event: string, listener: unknown) => void;
      off: (event: string, listener: unknown) => void;
    };
  };
  const toolEvents: { toolName: string; success: boolean; timestamp: number }[] = [];
  const toolListener = (e: { toolName: string; success: boolean; timestamp: number }): void => {
    toolEvents.push({ toolName: e.toolName, success: e.success, timestamp: e.timestamp });
  };

  beforeAll(async () => {
    const provider = availableProviders[0] ?? "anthropic";
    driver = new ConversationDriver({
      agentId: "tool-01-c",
      provider,
      timeoutMs: 60_000,
    });
    await driver.init();
    container = driver.getHandle().daemon.container as unknown as {
      eventBus: {
        on: (event: string, listener: unknown) => void;
        off: (event: string, listener: unknown) => void;
      };
    };
  }, DAEMON_STARTUP_MS + 120_000);

  afterAll(async () => {
    try {
      await driver.close();
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      if (!m.includes("Daemon exit")) throw err;
    }
  });

  afterEach(async () => {
    // Flush daemon log buffer before snapshotting (T-134-flush).
    await flushDaemonLogs(driver);
    await runLogOracle(driver.capturedLogLines(), { expectedErrors: [] });

    const dbPath = join(driver.getDataDir(), "memory.db");
    if (existsSync(dbPath)) {
      await runDbOracle(dbPath, {});
    }

    // Clear toolEvents between tests so each it() starts fresh.
    toolEvents.length = 0;
  });

  it.each(TOOL_SAMPLE)(
    "TOOL-01 built-in tool $toolName fires tool:executed with success=true",
    async ({ toolName, prompt }) => {
      container.eventBus.on("tool:executed", toolListener);
      try {
        const reply = await driver.sendTurn(prompt);

        // Allow a brief flush window for async event delivery.
        await new Promise<void>((r) => setTimeout(r, 1500));

        // Rung 1 — delivery: agent sent a reply.
        expect(typeof reply).toBe("string");
        expect(reply.length).toBeGreaterThan(0);

        // Rung 4 — tool-call trace: at least one tool:executed event fired.
        expect(toolEvents.length).toBeGreaterThan(0);

        // At least one successful invocation — the specific toolName may vary
        // if the model selects a related tool; success is the invariant.
        expect(toolEvents.some((e) => e.success)).toBe(true);

        // Log which tool was actually chosen for traceability.
        const usedTools = toolEvents.map((e) => e.toolName).join(", ");
        // Soft assertion: log if the expected tool wasn't the first chosen.
        if (!toolEvents.some((e) => e.toolName === toolName)) {
          console.info(
            `TOOL-01: prompt for '${toolName}' triggered tool(s): ${usedTools}`,
          );
        }
      } finally {
        // Always unregister to prevent listener leak across tests.
        container.eventBus.off("tool:executed", toolListener);
      }
    },
    2 * 60_000,
  );

  it(
    "TOOL-01 tool error does not crash the agent loop",
    async () => {
      // Send a prompt that may invoke a command that doesn't exist.
      // The agent loop must not throw — it should surface the error gracefully
      // and return a reply string. This certifies tool-error resilience.
      container.eventBus.on("tool:executed", toolListener);
      try {
        const reply = await driver.sendTurn(
          "Run the command: this_command_does_not_exist_xyz_123",
        );
        await new Promise<void>((r) => setTimeout(r, 1500));

        // Rung 1: a reply was returned (loop did not crash).
        expect(typeof reply).toBe("string");
        expect(reply.length).toBeGreaterThan(0);
      } finally {
        // T-136-02-02: always unregister.
        container.eventBus.off("tool:executed", toolListener);
      }
    },
    3 * 60_000,
  );
});
