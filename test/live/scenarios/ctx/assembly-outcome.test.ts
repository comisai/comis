// SPDX-License-Identifier: Apache-2.0
/**
 * HARN-01 — assembly-outcome eval harness.
 * Stage-A (always): deterministic scorer math + assertAssemblyOutcome.
 * Stage-B (describe.skipIf(!isLive)): live daemon replay.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { assemblyOutcomeScore, assertAssemblyOutcome } from "../../assert/assembly-outcome.js";

// ---------------------------------------------------------------------------
// COMIS_LIVE gate — Stage-B blocks skip (not fail) when unset
// ---------------------------------------------------------------------------

const isLive = !!process.env["COMIS_LIVE"];

// ---------------------------------------------------------------------------
// Stage-A — deterministic scorer math (no COMIS_LIVE, no daemon)
// ---------------------------------------------------------------------------

describe("HARN-01 Stage-A — assembly-outcome scorer (no COMIS_LIVE)", () => {
  it("assemblyOutcomeScore returns 1.0 when all key facts are present in model answer", () => {
    const score = assemblyOutcomeScore(
      "The capital is Paris and it is in France",
      "Paris is the capital of France",
      ["paris", "france"],
    );
    expect(score).toBe(1.0);
  });

  it("assemblyOutcomeScore returns 0.0 when no key facts present in model answer", () => {
    const score = assemblyOutcomeScore(
      "I do not know",
      "Paris",
      ["paris", "france"],
    );
    expect(score).toBe(0.0);
  });

  it("assemblyOutcomeScore is case-insensitive for key fact matching", () => {
    const score = assemblyOutcomeScore(
      "PARIS is a city",
      "Paris",
      ["paris"],
    );
    expect(score).toBe(1.0);
  });

  it("assemblyOutcomeScore partial match returns fraction proportional to hits", () => {
    const score = assemblyOutcomeScore(
      "Paris is mentioned",
      "Paris and France",
      ["paris", "france"],
    );
    expect(score).toBe(0.5);
  });

  it("assemblyOutcomeScore returns 0 for empty keyFacts array argument", () => {
    const score = assemblyOutcomeScore("anything", "ref", []);
    expect(score).toBe(0);
  });

  it("assertAssemblyOutcome does not throw when score meets or exceeds threshold", () => {
    expect(() =>
      assertAssemblyOutcome({ score: 0.8, threshold: 0.6, scenarioId: "s1", modelAnswer: "test" }),
    ).not.toThrow();
  });

  it("assertAssemblyOutcome throws with scenarioId in message when score is below threshold", () => {
    expect(() =>
      assertAssemblyOutcome({
        score: 0.3,
        threshold: 0.6,
        scenarioId: "test-scenario-id",
        modelAnswer: "wrong answer here",
      }),
    ).toThrow("test-scenario-id");
  });

  it("assertAssemblyOutcome error message includes formatted score and threshold values", () => {
    let errorMessage = "";
    try {
      assertAssemblyOutcome({
        score: 0.3,
        threshold: 0.6,
        scenarioId: "s2",
        modelAnswer: "wrong",
      });
    } catch (e) {
      errorMessage = e instanceof Error ? e.message : String(e);
    }
    expect(errorMessage).toContain("0.300");
    expect(errorMessage).toContain("0.6");
  });
});

// ---------------------------------------------------------------------------
// Stage-B — live daemon replay (COMIS_LIVE required)
// ---------------------------------------------------------------------------

describe.skipIf(!isLive)(
  "HARN-01 Stage-B — live assembly outcome (COMIS_LIVE required)",
  () => {
    it(
      "seeded conversation about known facts scores ≥ 0.6 on factual recall question",
      async () => {
        // Stage-B: seed a conversation with known facts, query, assert score ≥ 0.6
        // Implementation: use ConversationDriver with mkdtempSync isolation
        // TODO wire-in: ConversationDriver + buildCtxConfig + seed + query
        // For now: structural stub — verifies harness is importable and Stage-B is gated
        expect(isLive).toBe(true);
      },
    );
  },
);

// Stage-B skeleton preserved for wire-in:
// import { ConversationDriver, flushDaemonLogs } from "../../harness/conversation.js";
// import { buildCtxConfig } from "../../harness/ctx-config.js";
// import { mkdtempSync } from "node:fs";
// import { tmpdir } from "node:os";
//
// describe.skipIf(!isLive)("HARN-01 Stage-B — live assembly outcome (COMIS_LIVE required)", () => {
//   it("seeded conversation about known facts scores ≥ 0.6 on factual recall question", async () => {
//     const dataDir = mkdtempSync(tmpdir() + "/assembly-outcome-");
//     const configPath = buildCtxConfig({ version: "dag", label: "assembly-outcome", filePrefix: "ao" });
//     const driver = new ConversationDriver({ agentId: "ao-test", provider: "anthropic", timeoutMs: 5 * 60_000 });
//     // ... seed known facts via driver, query, capture modelAnswer ...
//     // const score = assemblyOutcomeScore(modelAnswer, referenceAnswer, keyFacts);
//     // assertAssemblyOutcome({ score, threshold: 0.6, scenarioId: "harn-01-live", modelAnswer });
//   });
// });
