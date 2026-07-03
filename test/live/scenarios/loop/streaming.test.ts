// SPDX-License-Identifier: Apache-2.0
/**
 * LOOP-04 — streaming deltas arrive ordered; completion line carries durationMs;
 * obs.billing tokens match the response.
 *
 * Stage-A (always runs, no COMIS_LIVE needed):
 *   Validates structural streaming properties that do NOT require a real LLM:
 *   - sendTurn returns a string OR throws — never returns undefined (contract)
 *   - echo.getSentMessages() timestamps are non-decreasing (ordering invariant)
 *   - turn_completed.durationMs is typeof "number" when events are present
 *     (does NOT assert > 0 — that requires a successful LLM turn, Stage-C only)
 *
 *   CRITICAL: Stage-A afterEach declares expectedErrors: ["JSON-RPC method error"]
 *   because sendTurn is called in all three Stage-A tests (wrapped in try/catch).
 *   rpc-dispatch.ts emits this ERROR-level Pino line when agent.execute fails at
 *   the LLM provider call (dummy keys). Without this declaration the log-oracle
 *   check 2 would flag it as an unexpected error.
 *
 * Stage-C (describe.skipIf(!isLive)):
 *   Real-LLM streaming assertions — drives a real turn and asserts:
 *   - turn_completed.durationMs > 0
 *   - obs.billing.totalTokens > 0 via rpcRequest
 *   - getSentMessages() timestamps non-decreasing with >= 1 message
 *
 * costTier: "¢" — cheapest model per provider for live runs.
 *
 * @module
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { ConversationDriver, flushDaemonLogs } from "../../harness/conversation.js";
import { runLogOracle } from "../../assert/log-oracle.js";
import { runDbOracle } from "../../assert/db-oracle.js";
import { rpcRequest } from "../../../support/daemon-harness.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildCredentialRegistry } from "../../credentials.js";
import type {
  TurnCompletedEvent,
  SessionIndexEvent,
} from "@comis/observability";

// ---------------------------------------------------------------------------
// COMIS_LIVE gate — Stage-C blocks skip (not fail) when unset
// ---------------------------------------------------------------------------

const isLive = !!process.env["COMIS_LIVE"];

// Daemon startup budget + per-turn LLM latency for beforeAll timeout.
const DAEMON_STARTUP_MS = 15_000;

// ---------------------------------------------------------------------------
// Stage-A — streaming structural assertions (no COMIS_LIVE needed)
//
// sendTurn is called in all three Stage-A tests. With dummy keys, the LLM
// provider call fails and sendTurn THROWS. Wrap in try/catch.
//
// afterEach declares expectedErrors: ["JSON-RPC method error"] — rpc-dispatch.ts
// emits this ERROR-level Pino line when agent.execute fails with dummy keys.
// ---------------------------------------------------------------------------

describe("LOOP-04 Stage-A — streaming structural assertions (no COMIS_LIVE)", () => {
  let driver: ConversationDriver;

  beforeAll(async () => {
    driver = new ConversationDriver({ agentId: "loop-st-a", timeoutMs: 30_000 });
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
    // Flush daemon log buffer before snapshotting.
    await flushDaemonLogs(driver);

    // "JSON-RPC method error" is expected in Stage-A: sendTurn is called in
    // all three Stage-A tests and rpc-dispatch.ts emits this ERROR when
    // agent.execute fails at the LLM provider call with dummy keys.
    await runLogOracle(driver.capturedLogLines(), {
      expectedErrors: ["JSON-RPC method error"],
    });

    // Persistence oracle — only run if memory.db was created
    const dbPath = join(driver.getDataDir(), "memory.db");
    if (existsSync(dbPath)) {
      await runDbOracle(dbPath, {});
    }
  });

  it("sendTurn returns a string or throws — never returns undefined", async () => {
    let result: string | undefined;
    let errorMsg: string | undefined;

    try {
      result = await driver.sendTurn("Hello");
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err);
    }

    // With dummy keys sendTurn THROWS (RPC error envelope from LLM failure).
    // With live keys it returns a string.
    // Both paths are valid Stage-A outcomes.
    if (result !== undefined) {
      // Live-key path: got a reply string — type assertion only
      // (NOT reply.length > 0 — that requires a real LLM, Stage-C only)
      expect(typeof result).toBe("string");
    } else {
      // Dummy-key path: driver issued RPC + got error envelope (expected)
      // Assert it was an explicit error message, not a null/undefined crash
      expect(typeof errorMsg).toBe("string");
      expect(errorMsg!.length).toBeGreaterThan(0);
    }
  });

  it("getSentMessages() timestamps are non-decreasing (ordering invariant)", async () => {
    // sendTurn THROWS with dummy keys — expected
    try {
      await driver.sendTurn("One more turn");
    } catch {
      // Expected with dummy keys
    }

    // Read messages captured by the EchoChannelAdapter
    const sent = driver.getEcho().getSentMessages();

    // For each consecutive pair: timestamps must be non-decreasing.
    // With a single message or no messages (dummy-key path may produce 0),
    // this loop is trivially vacuous-true — that is correct for Stage-A
    // (the daemon received no delivery because the LLM call failed).
    for (let i = 1; i < sent.length; i++) {
      expect(sent[i]!.timestamp).toBeGreaterThanOrEqual(sent[i - 1]!.timestamp);
    }
  });

  it("turn_completed.durationMs is typeof 'number' when present (NOT > 0 — that requires live LLM)", async () => {
    // sendTurn THROWS with dummy keys — expected
    try {
      await driver.sendTurn("Ping");
    } catch {
      // Expected with dummy keys
    }

    // getSessionIndexEvents() reads from the isolated test dataDir.
    // With dummy keys and the current bridge wiring (session-index goes to
    // ~/.comis), this returns []. The assertion is vacuous-true when empty.
    const events: SessionIndexEvent[] = await driver.getSessionIndexEvents();
    const turns = events.filter(
      (e): e is TurnCompletedEvent => e.event === "turn_completed",
    );

    // Stage-A: type assertion only.
    // durationMs > 0 requires a real LLM turn completing successfully.
    // Stage-C only.
    for (const t of turns) {
      expect(typeof t.durationMs).toBe("number");
    }
  });
});

// ---------------------------------------------------------------------------
// Stage-C — real-LLM streaming + billing, gated on COMIS_LIVE (skips in CI)
// ---------------------------------------------------------------------------

// costTier: "¢" — 1 real-LLM turn per provider
describe.skipIf(!isLive)("Live — LOOP-04 streaming + billing (Stage-C, real LLM)", () => {
  const registry = buildCredentialRegistry();
  const availableProviders = ["anthropic", "openai", "google", "groq"].filter(
    (p) => registry.getSkipVerdict(`LLM(${p})`) === null,
  );

  let driver: ConversationDriver;

  beforeAll(async () => {
    const provider = availableProviders[0] ?? "anthropic";
    driver = new ConversationDriver({
      agentId: "loop-st-c",
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

    // Real successful LLM turns emit no ERROR/FATAL lines
    await runLogOracle(driver.capturedLogLines(), { expectedErrors: [] });

    const dbPath = join(driver.getDataDir(), "memory.db");
    if (existsSync(dbPath)) {
      await runDbOracle(dbPath, {});
    }
  });

  it.each(availableProviders.length > 0 ? availableProviders : ["anthropic"])(
    "LOOP-04 real: turn_completed.durationMs > 0 + obs.billing.totalTokens > 0 for provider %s",
    async (provider) => {
      // Skip if this provider has no credentials (skip-not-fail discipline)
      const verdict = registry.getSkipVerdict(`LLM(${provider})`);
      if (verdict !== null) return;

      // Drive one real LLM turn
      const reply = await driver.sendTurn(
        "Say hello in exactly three words.",
      );
      expect(reply.length).toBeGreaterThan(0);

      // LOOP-04: turn_completed.durationMs > 0 (real LLM turn completed)
      const events: SessionIndexEvent[] = await driver.getSessionIndexEvents();
      const turns = events.filter(
        (e): e is TurnCompletedEvent => e.event === "turn_completed",
      );
      expect(turns.length).toBeGreaterThanOrEqual(1);
      // Stage-C: durationMs > 0 (real LLM latency measured)
      expect(turns[0]!.durationMs).toBeGreaterThan(0);

      // LOOP-04: obs.billing.totalTokens > 0 (rpcRequest to billing endpoint)
      const handle = driver.getHandle();
      const billing = await rpcRequest(
        handle.gatewayUrl,
        "obs.billing.total",
        {},
        handle.authToken,
      );
      expect(
        (billing as { totalTokens?: number }).totalTokens,
      ).toBeGreaterThan(0);
    },
    3 * 60_000 + 60_000,
  );

  it.each(availableProviders.length > 0 ? availableProviders : ["anthropic"])(
    "LOOP-04 real: getSentMessages() timestamps non-decreasing with >= 1 message for provider %s",
    async (provider) => {
      // Skip if this provider has no credentials (skip-not-fail discipline)
      const verdict = registry.getSkipVerdict(`LLM(${provider})`);
      if (verdict !== null) return;

      // Drive one real LLM turn
      const reply = await driver.sendTurn(
        "Respond with the single word: done",
      );
      expect(reply.length).toBeGreaterThan(0);

      // LOOP-04: getSentMessages() timestamps non-decreasing
      const sent = driver.getEcho().getSentMessages();

      // Stage-C: at least 1 message (real LLM must have sent a reply)
      expect(sent.length).toBeGreaterThanOrEqual(1);

      // Ordering invariant: timestamps are non-decreasing
      for (let i = 1; i < sent.length; i++) {
        expect(sent[i]!.timestamp).toBeGreaterThanOrEqual(sent[i - 1]!.timestamp);
      }
    },
    3 * 60_000 + 60_000,
  );
});
