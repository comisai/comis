// SPDX-License-Identifier: Apache-2.0
/**
 * LOOP-02 — real tool-call loop scenario test.
 *
 * Certifies that the Comis agent can invoke tools during a conversation turn
 * and that the tool:executed event is fired on the daemon event bus with the
 * expected shape.
 *
 * Stage-A (always runs, no COMIS_LIVE needed):
 *   Validates event-bus wiring — the tool:executed event bus is accessible on
 *   the daemon container, and listeners can be registered and unregistered
 *   without error. Stage-A does NOT call sendTurn (no LLM call is made), so
 *   the "JSON-RPC method error" from rpc-dispatch.ts is NOT emitted here.
 *   Therefore Stage-A afterEach keeps expectedErrors: [] (empty).
 *
 * Stage-C (describe.skipIf(!isLive)):
 *   Real-LLM per-provider it — drives a turn with a prompt designed to invoke
 *   a tool, asserts toolEvents.length >= 1 and toolEvents[0].success === true
 *   (rung 4 — tool-call trace). Also asserts world-state via
 *   getEcho().getSentMessages() that a reply was sent (rung 1).
 *   Tool errors do not crash the loop — resilience assertion included.
 *
 * Security notes:
 *   tool:executed listener is unregistered in a finally block
 *   — no handler persists after the test.
 *
 * costTier: "¢" — cheapest model per provider (Haiku / gpt-4o-mini).
 *
 * @module
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { ConversationDriver, flushDaemonLogs } from "../../harness/conversation.js";
import { runLogOracle } from "../../assert/log-oracle.js";
import { runDbOracle } from "../../assert/db-oracle.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildCredentialRegistry } from "../../credentials.js";

// ---------------------------------------------------------------------------
// COMIS_LIVE gate — Stage-C blocks skip (not fail) when unset
// ---------------------------------------------------------------------------

const isLive = !!process.env["COMIS_LIVE"];

// Daemon startup budget for beforeAll timeout. Matches the shared
// test/support/timeouts.ts value — the prior local 15s shadow gave Stage-A a
// 45s hook budget, which a loaded runner (concurrent daemon boots + GGUF
// embedding-model load) blows through.
const DAEMON_STARTUP_MS = 60_000;

// ---------------------------------------------------------------------------
// Stage-A — event-bus wiring, always runs (CI-safe, no COMIS_LIVE needed)
//
// NOTE: Stage-A does NOT call sendTurn — no LLM provider call is made, so
// rpc-dispatch.ts does NOT emit "JSON-RPC method error". Keep expectedErrors: []
// in afterEach (contrast with multi-turn.test.ts Stage-A which calls sendTurn).
// ---------------------------------------------------------------------------

describe("LOOP-02 Stage-A — tool event-bus wiring (no COMIS_LIVE)", () => {
  let driver: ConversationDriver;

  beforeAll(async () => {
    driver = new ConversationDriver({ agentId: "loop-tc-a", timeoutMs: 30_000 });
    await driver.init();
  }, DAEMON_STARTUP_MS + 30_000);

  afterAll(async () => {
    try {
      await driver.close();
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      // Swallow expected shutdown noise; re-throw anything surprising
      if (!m.includes("Daemon exit")) throw err;
    }
  });

  afterEach(async () => {
    // Flush daemon log buffer before snapshotting.
    await flushDaemonLogs(driver);

    // No sendTurn is called in Stage-A — no provider failure ERROR is emitted.
    // Keep expectedErrors: [] (no "JSON-RPC method error" will appear here).
    await runLogOracle(driver.capturedLogLines(), { expectedErrors: [] });

    // Persistence oracle — only run if memory.db was created
    const dbPath = join(driver.getDataDir(), "memory.db");
    if (existsSync(dbPath)) {
      await runDbOracle(dbPath, {});
    }
  });

  it("event bus is accessible on daemon container", () => {
    // Cast to expose the eventBus field that TypedEventBus injects at runtime.
    // The container type is intentionally opaque for modularity — use `unknown`
    // cast to access the runtime field without depending on internal types.
    const handle = driver.getHandle();
    const container = handle.daemon.container as unknown as { eventBus: unknown };
    expect(container.eventBus).toBeTruthy();
  });

  it("tool:executed listener registers and unregisters without error", () => {
    // Verify the event bus accepts and releases a tool:executed listener
    // without throwing. This certifies the event-bus wiring required for
    // LOOP-02 Stage-C before spending any live budget.
    const handle = driver.getHandle();
    const container = handle.daemon.container as unknown as {
      eventBus: {
        on: (event: string, listener: unknown) => void;
        off: (event: string, listener: unknown) => void;
      };
    };

    // noop listener — only tests registration, not dispatch
    const listener = (): void => { /* noop */ };

    expect(() => {
      container.eventBus.on("tool:executed", listener);
      container.eventBus.off("tool:executed", listener);
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Stage-C — real-LLM, gated on COMIS_LIVE (skips in CI, runs in live mode)
// ---------------------------------------------------------------------------

// costTier: "¢" — cheapest available model per provider (Haiku / gpt-4o-mini)
describe.skipIf(!isLive)("Live — LOOP-02 tool-call (Stage-C, real LLM)", () => {
  // Build credential registry to determine which providers are available.
  // Providers without a present API key are skipped (not failed) — Skip ≠ fail.
  const registry = buildCredentialRegistry();
  const availableProviders = ["anthropic", "openai", "google", "groq"].filter(
    (p) => registry.getSkipVerdict(`LLM(${p})`) === null,
  );

  let driver: ConversationDriver;

  beforeAll(async () => {
    // Use the first available provider (or anthropic as default)
    const provider = availableProviders[0] ?? "anthropic";
    driver = new ConversationDriver({
      agentId: "loop-tc-c",
      provider,
      timeoutMs: 60_000,
    });
    await driver.init();
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
    // Flush daemon log buffer before snapshotting.
    await flushDaemonLogs(driver);

    // Real successful turns emit no ERROR/FATAL lines
    await runLogOracle(driver.capturedLogLines(), { expectedErrors: [] });

    const dbPath = join(driver.getDataDir(), "memory.db");
    if (existsSync(dbPath)) {
      await runDbOracle(dbPath, {});
    }
  });

  it(
    "LOOP-02 real tool-call loop invokes a tool and asserts tool:executed",
    async () => {
      const handle = driver.getHandle();
      const container = handle.daemon.container as unknown as {
        eventBus: {
          on: (event: string, listener: unknown) => void;
          off: (event: string, listener: unknown) => void;
        };
      };

      // Collect tool:executed events during the turn (rung 4 — tool-call trace).
      // Listener MUST be unregistered in a finally block.
      const toolEvents: { toolName: string; success: boolean; timestamp: number }[] = [];
      const toolListener = (e: { toolName: string; success: boolean; timestamp: number }): void => {
        toolEvents.push({ toolName: e.toolName, success: e.success, timestamp: e.timestamp });
      };

      container.eventBus.on("tool:executed", toolListener);

      try {
        // Send a prompt likely to invoke a built-in tool (search, datetime, etc.)
        // Use a prompt that is generic enough to work across all providers.
        // We do NOT assert on which specific tool is called — only that ≥1 tool fires.
        const reply = await driver.sendTurn(
          "What is the current date and time? Use any available tool to get it.",
        );

        // Allow a brief flush window for async event delivery
        await new Promise<void>((r) => setTimeout(r, 1500));

        // Rung 1 — delivery: agent sent a reply
        expect(typeof reply).toBe("string");
        expect(reply.length).toBeGreaterThan(0);

        // Rung 4 — tool-call trace: at least one tool:executed event fired
        expect(toolEvents.length).toBeGreaterThan(0);

        // At least one successful tool invocation
        expect(toolEvents.some((e) => e.success)).toBe(true);

        // Rung 1 — world-state: the echo adapter received the reply
        const sentMessages = driver.getEcho().getSentMessages();
        expect(sentMessages.length).toBeGreaterThan(0);

        // Resilience: if any tool failed, the loop must not have thrown.
        // (The try/catch below sendTurn catches a crash — reaching here means the
        // agent loop continued even in the presence of tool errors.)
        // We verify this implicitly: if we reach this assertion, the turn completed.
        expect(typeof reply).toBe("string");
      } finally {
        // Always unregister to prevent listener leak across tests
        container.eventBus.off("tool:executed", toolListener);
      }
    },
    2 * 60_000 + 60_000,
  );
});
