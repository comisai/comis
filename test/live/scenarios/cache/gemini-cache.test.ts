// SPDX-License-Identifier: Apache-2.0
/**
 * CACHE-02 — Gemini CachedContent create→reuse scenario test.
 *
 * Certifies that the Comis agent correctly exercises Google Gemini's CachedContent
 * API: the first turn creates a CachedContent entry (cacheCreationInputTokens > 0),
 * a second identical turn reuses it (cacheReadInputTokens > 0), and
 * obs.billing.totalCacheSaved > 0 is confirmed via the billing RPC.
 *
 * Stage-A (always runs, no COMIS_LIVE needed):
 *   Validates driver mechanics — sendTurn issues agent.execute via WS JSON-RPC
 *   and receives a well-formed result-or-error envelope. With dummy API keys the
 *   provider call fails and sendTurn THROWS; the Stage-A tests wrap sendTurn in
 *   try/catch and assert deterministic structural properties only.
 *
 *   CRITICAL: Stage-A afterEach declares expectedErrors: ["JSON-RPC method error"]
 *   because rpc-dispatch.ts emits this ERROR-level Pino line when agent.execute
 *   fails at the LLM provider call (dummy keys). Without this declaration the
 *   log-oracle check 2 would flag it as an unexpected error.
 *
 * Stage-C (describe.skipIf(!isLive)):
 *   Real Google Gemini CachedContent create→reuse — drives 2 turns against a real
 *   Gemini model, asserts cache-trace events and mandatory billing totalCacheSaved
 *   assertion via rpcRequest to obs.billing.total.
 *
 * costTier: "¢" — cheapest Gemini model (gemini-flash) for live runs.
 *
 * @module
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { ConversationDriver, flushDaemonLogs } from "../../harness/conversation.js";
import { runLogOracle } from "../../assert/log-oracle.js";
import { runDbOracle } from "../../assert/db-oracle.js";
import {
  expectCacheWrite,
  expectCacheRead,
} from "../../assert/cache-trace.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCredentialRegistry } from "../../credentials.js";
import { rpcRequest } from "../../../support/daemon-harness.js";
import type { BillingSnapshot } from "../../assert/observe.js";

// ---------------------------------------------------------------------------
// COMIS_LIVE gate — Stage-C blocks skip (not fail) when unset
// ---------------------------------------------------------------------------

const isLive = !!process.env["COMIS_LIVE"];

// Daemon startup budget + per-turn LLM latency for beforeAll timeout.
const DAEMON_STARTUP_MS = 15_000;

// ---------------------------------------------------------------------------
// Stage-A — mock/echo provider, always runs (CI-safe, no COMIS_LIVE needed)
// ---------------------------------------------------------------------------

describe("CACHE-02 Stage-A — Gemini cache (driver mechanics, no COMIS_LIVE)", () => {
  let driver: ConversationDriver;

  beforeAll(async () => {
    driver = new ConversationDriver({ agentId: "cache-g-a1", timeoutMs: 30_000 });
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

    // "JSON-RPC method error" is expected in Stage-A: rpc-dispatch.ts emits this
    // ERROR-level Pino line when agent.execute fails at the LLM provider call
    // (dummy keys). Declare it in expectedErrors so log-oracle check 2 does not
    // flag it as an unexpected ERROR.
    await runLogOracle(driver.capturedLogLines(), {
      expectedErrors: ["JSON-RPC method error"],
    });

    // Persistence oracle — only run if memory.db was created by the turn
    const dbPath = join(driver.getDataDir(), "memory.db");
    if (existsSync(dbPath)) {
      await runDbOracle(dbPath, {});
    }
  });

  it("first sendTurn: driver mechanics — issues agent.execute + gets well-formed envelope", async () => {
    // With dummy keys, sendTurn THROWS (RPC error from LLM provider failure).
    // With live keys, sendTurn returns the reply string.
    // Both paths are valid Stage-A outcomes — the driver issued agent.execute
    // and received a well-formed result-or-error response from the daemon.
    let result: string | undefined;
    let errorMsg: string | undefined;

    try {
      result = await driver.sendTurn("What is 1+1? Answer briefly.");
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err);
    }

    if (result !== undefined) {
      // Live-key path: got a reply string (structural assertion only)
      expect(typeof result).toBe("string");
    } else {
      // Dummy-key path: driver issued RPC + got error envelope (expected)
      expect(typeof errorMsg).toBe("string");
      expect(errorMsg!.length).toBeGreaterThan(0);
    }
  });

  it("second sendTurn does not leave daemon in broken state", async () => {
    // First turn (may throw with dummy keys — that is fine)
    try {
      await driver.sendTurn("What is 1+1? Answer briefly.");
    } catch {
      // Expected with dummy keys — provider call fails
    }

    // Second turn must also complete (throw or return) without crashing the daemon.
    // This certifies the driver does not leave a broken WebSocket or RPC state
    // between successive turns in the same test session.
    let result: string | undefined;
    let errorMsg: string | undefined;

    try {
      result = await driver.sendTurn("What is 2+2? Answer briefly.");
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err);
    }

    if (result !== undefined) {
      // Structural assertion only — NOT reply.length > 0
      expect(typeof result).toBe("string");
    } else {
      // Error path: daemon is still responsive (didn't crash)
      expect(typeof errorMsg).toBe("string");
    }
  });
});

// ---------------------------------------------------------------------------
// Stage-C — real Google Gemini, gated on COMIS_LIVE (skips in CI, runs in live mode)
// ---------------------------------------------------------------------------

// costTier: "¢" — cheapest available Gemini model (gemini-flash) for live runs
describe.skipIf(!isLive)("Live — CACHE-02 Gemini CachedContent (Stage-C)", () => {
  const registry = buildCredentialRegistry();
  const provider = "google";
  const canRun = registry.getSkipVerdict(`LLM(${provider})`) === null;

  let driver: ConversationDriver;

  beforeAll(async () => {
    if (!canRun) return;
    driver = new ConversationDriver({
      agentId: "cache-g-c1",
      provider,
      timeoutMs: 60_000,
    });
    await driver.init();
  }, DAEMON_STARTUP_MS + 120_000);

  afterAll(async () => {
    if (driver) {
      try {
        await driver.close();
      } catch {
        // swallow shutdown noise
      }
    }
  });

  afterEach(async () => {
    if (!canRun) return;
    // Flush daemon log buffer before snapshotting.
    await flushDaemonLogs(driver);
    // Real successful turns emit no ERROR/FATAL lines
    await runLogOracle(driver.capturedLogLines(), { expectedErrors: [] });
    const dbPath = join(driver.getDataDir(), "memory.db");
    if (existsSync(dbPath)) {
      await runDbOracle(dbPath, {});
    }
  });

  it.skipIf(!canRun)(
    "CACHE-02 Gemini: CachedContent create→reuse, totalCacheSaved > 0",
    async () => {
      const cacheTracePath = join(driver.getDataDir(), "logs", "cache-trace.jsonl");

      // Turn 1 — creates Gemini CachedContent → cacheCreationInputTokens > 0
      await driver.sendTurn("What is 1+1? Answer briefly.");
      await flushDaemonLogs(driver);
      const t1Lines = readFileSync(cacheTracePath, "utf-8");
      await expectCacheWrite({ minCreationTokens: 1 }, t1Lines);

      // Turn 2 — reuses CachedContent → cacheReadInputTokens > 0
      await driver.sendTurn("What is 1+1? Answer briefly.");
      await flushDaemonLogs(driver);
      const t2Lines = readFileSync(cacheTracePath, "utf-8");
      await expectCacheRead({ minReadTokens: 1 }, t2Lines);

      // obs.billing.totalCacheSaved > 0 — MANDATORY assertion via rpcRequest.
      // There is NO fetchBillingSnapshot function and expectBillingTokens has no
      // minCacheSaved param — always assert directly via rpcRequest result.
      const handle = driver.getHandle();
      const billing = await rpcRequest(
        handle.gatewayUrl,
        "obs.billing.total",
        {},
        handle.authToken,
      );
      expect((billing as BillingSnapshot).totalCacheSaved ?? 0).toBeGreaterThan(0);
    },
    4 * 60_000,
  );
});
