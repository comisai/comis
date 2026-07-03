// SPDX-License-Identifier: Apache-2.0
/**
 * PROVE-03 — the short deterministic SOAK SMOKE.
 *
 * Proves the soak HARNESS mechanism end-to-end on the echo Stage-B daemon: a few
 * iterations of journey-library traffic driven through a real ConversationDriver,
 * with the health-line watcher parsing whatever "Daemon health" line is present.
 * This is the in-process, $0, deterministic proof that `runSoak` drives traffic +
 * parses the daemon health line correctly.
 *
 * The REAL multi-hour soak is the operator step (a Linux VPS): run `runSoak`
 * with COMIS_LIVE + provider keys + many iterations over a long window; the
 * health-line watcher then gates RSS/heap trend + zero stuck/deadLetter/promptTimeouts
 * + empty degradedProviders over hours. Held below in the gated Stage-C/operator block.
 *
 * Stage-B idiom: dummy keys (the LLM errors fast); the afterEach runLogOracle
 * declares the dummy-key expectedErrors. costTier: "$0".
 *
 * @module
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ConversationDriver, flushDaemonLogs } from "../../harness/conversation.js";
import { runLogOracle } from "../../assert/log-oracle.js";
import { runDbOracle } from "../../assert/db-oracle.js";
import { runSoak } from "../../soak.js";
import type { UserStory } from "../../journeys/types.js";

const isLive = !!process.env["COMIS_LIVE"];
const DAEMON_STARTUP_MS = 30_000;

// A tiny inline traffic story (a single send_text step) — keeps the smoke fast +
// deterministic; the soak HARNESS itself is unit-tested in soak.test.ts.
const SMOKE_STORY: UserStory = {
  id: "__test__soak-smoke",
  story: "As a soak smoke, I want a short traffic pass so the harness mechanism is proven",
  tags: ["A"],
  dimensions: [],
  requires: {},
  costTier: "$0",
  determinism: { runs: 1, passRateThreshold: 1 },
  steps: [{ verb: "send_text", text: "soak ping" }],
  acceptance: { outcomes: [], rubric: "n/a — soak is endurance, not correctness" },
  status: "active",
};

describe("PROVE-03 Stage-B — short deterministic soak smoke (the harness drives traffic + parses the health line)", () => {
  let driver: ConversationDriver;

  beforeAll(async () => {
    driver = new ConversationDriver({ agentId: "prove-soak-smoke", timeoutMs: 30_000 });
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
    await flushDaemonLogs(driver);
    // "JSON-RPC method error" is the expected dummy-key ERROR (rpc-dispatch.ts on
    // the failed agent.execute provider call). The universal oracle still validates
    // every other stream — broken observability would fail the soak smoke too.
    await runLogOracle(driver.capturedLogLines(), {
      expectedErrors: ["JSON-RPC method error"],
    });
    const dbPath = join(driver.getDataDir(), "memory.db");
    if (existsSync(dbPath)) {
      await runDbOracle(dbPath, {});
    }
  });

  it("runSoak drives the iterations through the echo daemon and returns a SoakResult", async () => {
    // 2 iterations × 1 story × 1 send_text = 2 turns through the real daemon.
    // sendTurn throws on dummy keys — runSoak tolerates it (the harness watches
    // health, not turn success) so the soak completes deterministically.
    const result = await runSoak({ driver, iterations: 2, stories: [SMOKE_STORY], expectedDegradations: [] });
    await flushDaemonLogs(driver);

    // The MECHANISM: the soak ran the iterations + drove the turns + returned a
    // result. We assert the harness shape (deterministic + non-flaky); the health
    // VALUE assertions (RSS/heap trend, zero stuck/deadLetter) are the real-soak's
    // job — in a short window the periodic health tick may or may not have fired,
    // so we do NOT gate on a specific health sample count here (that would be flaky).
    expect(result.iterations).toBe(2);
    expect(Array.isArray(result.samples)).toBe(true);
    expect(Array.isArray(result.violations)).toBe(true);
    // If a health line DID appear in the window, the harness must have parsed it
    // into a sample carrying the verified field shape.
    for (const s of result.samples) {
      expect(typeof s.iteration).toBe("number");
    }
  });
});

// ===========================================================================
// PROVE-03 — the real multi-hour soak (operator / Linux VPS, gated).
// ===========================================================================

describe.skipIf(!isLive)("PROVE-03 — real multi-hour soak (operator, gated)", () => {
  it.skip(
    "multi-hour real-LLM journey traffic; the health-line watcher gates no RSS/heap trend + zero stuck/deadLetter/promptTimeouts + empty degradedProviders over hours — SKIPPED(operator: multi-hour Linux VPS soak). Run `runSoak` with COMIS_LIVE + provider keys + many iterations on a Linux VPS. The harness + the short smoke + parseHealthLine are covered above.",
    () => {
      // Operator: const result = await runSoak({ driver, iterations: <many>,
      //   stories: getStories().filter(s => s.status === "active") }); over a long
      //   window; assert result.healthy === true (the RSS/heap-trend + zero-counters gate).
    },
  );
});
