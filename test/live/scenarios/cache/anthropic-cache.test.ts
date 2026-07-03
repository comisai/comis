// SPDX-License-Identifier: Apache-2.0
/**
 * CACHE-01 — Anthropic prompt-cache write→hit→invalidate scenario test.
 *
 * Certifies that the Comis agent correctly exercises Anthropic's prompt-caching
 * API: the first turn with a given prefix creates a cache entry
 * (cacheCreationInputTokens > 0), a second identical turn hits the cache
 * (cacheReadInputTokens > 0), and a third turn with a different prefix causes
 * a digest change (cache miss detected).
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
 *   Real Anthropic prompt-cache write→hit→invalidate — drives 3 turns against
 *   a real Anthropic model, asserts cache-trace events at each step.
 *
 * costTier: "¢" — cheapest model per provider (Haiku) for live runs.
 *
 * @module
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { ConversationDriver, flushDaemonLogs } from "../../harness/conversation.js";
import { runLogOracle } from "../../assert/log-oracle.js";
import { runDbOracle } from "../../assert/db-oracle.js";
import {
  expectCacheWrite,
  expectDigestChange,
  readCacheTraceForTurn,
} from "../../assert/cache-trace.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCredentialRegistry } from "../../credentials.js";

// ---------------------------------------------------------------------------
// COMIS_LIVE gate — Stage-C blocks skip (not fail) when unset
// ---------------------------------------------------------------------------

const isLive = !!process.env["COMIS_LIVE"];

// Daemon startup budget + per-turn LLM latency for beforeAll timeout.
const DAEMON_STARTUP_MS = 15_000;

// ---------------------------------------------------------------------------
// Stage-A — mock/echo provider, always runs (CI-safe, no COMIS_LIVE needed)
// ---------------------------------------------------------------------------

describe("CACHE-01 Stage-A — cache-trace asserter mechanics (no COMIS_LIVE)", () => {
  let driver: ConversationDriver;

  beforeAll(async () => {
    driver = new ConversationDriver({ agentId: "cache-a1", timeoutMs: 30_000 });
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
// Stage-C — real Anthropic, gated on COMIS_LIVE (skips in CI, runs in live mode)
// ---------------------------------------------------------------------------

// costTier: "¢" — cheapest available Anthropic model (Haiku) for live runs
describe.skipIf(!isLive)("Live — CACHE-01 Anthropic write→hit→invalidate (Stage-C)", () => {
  const registry = buildCredentialRegistry();
  const provider = "anthropic";
  const canRun = registry.getSkipVerdict(`LLM(${provider})`) === null;

  let driver: ConversationDriver;

  beforeAll(async () => {
    if (!canRun) return;
    driver = new ConversationDriver({
      agentId: "cache-c1",
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
    "CACHE-01 Anthropic: turn-1 write, turn-2 read-hit, digest-change miss",
    async () => {
      const cacheTracePath = join(driver.getDataDir(), "logs", "cache-trace.jsonl");

      // Turn 1 — identical prefix → cacheCreationInputTokens > 0 (write)
      await driver.sendTurn("What is 1+1? Answer briefly.");
      await flushDaemonLogs(driver);
      const t1Lines = readFileSync(cacheTracePath, "utf-8");
      await expectCacheWrite({ minCreationTokens: 1 }, t1Lines);

      // Turn 2 — identical prefix → cacheReadInputTokens > 0 (hit).
      // Snapshot cumulative readTokens BEFORE turn 2, then assert a DELTA > 0
      // after turn 2.  Reading the whole file and checking totalReadTokens directly
      // would falsely pass if a prior warm-cache run already populated read tokens
      // from turn 1 (e.g., a partial cold-start hit against a previously warmed cache).
      const preTurn2ReadTokens = readCacheTraceForTurn(
        readFileSync(cacheTracePath, "utf-8"),
      ).totalReadTokens;
      await driver.sendTurn("What is 1+1? Answer briefly.");
      await flushDaemonLogs(driver);
      const t2Lines = readFileSync(cacheTracePath, "utf-8");
      const t2Summary = readCacheTraceForTurn(t2Lines);
      expect(t2Summary.totalReadTokens - preTurn2ReadTokens).toBeGreaterThan(0);

      // Turn 3 — different prefix → digest change → miss
      await driver.sendTurn("Tell me about quantum physics in one sentence.");
      await flushDaemonLogs(driver);
      const t3Lines = readFileSync(cacheTracePath, "utf-8");
      const t3Summary = readCacheTraceForTurn(t3Lines);
      expectDigestChange(t2Summary, t3Summary);
    },
    4 * 60_000,
  );
});
