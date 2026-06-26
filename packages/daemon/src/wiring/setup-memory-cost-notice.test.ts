// SPDX-License-Identifier: Apache-2.0
/**
 * First-run cost-disclosure notice (v1 opt-out posture — increment 1).
 *
 * On daemon startup, when the master kill switch `memory.costFeatures.enabled`
 * is ON (the default) AND at least one LLM cost-bearing memory feature is
 * actually active for some agent, the daemon emits ONE prominent WARN that:
 *   - names the active cost features,
 *   - states they spend the operator's own LLM/API budget,
 *   - gives the exact one-line config to turn them ALL off
 *     (`memory.costFeatures.enabled: false`).
 *
 * When the kill switch is OFF, or when NO cost feature is active (today's
 * default bare config), the notice emits NOTHING. The notice never logs a
 * secret/key.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { makeMockLogger } from "../../../../test/support/mock-logger.js";
import { emitMemoryCostFeatureNotice } from "./setup-memory-cost-notice.js";

/** An agent with all per-agent memory features OFF (today's default). */
function bareAgent(): Record<string, unknown> {
  return { name: "Agent", skills: { builtinTools: { browser: false } } };
}

describe("emitMemoryCostFeatureNotice (first-run cost disclosure)", () => {
  it("emits NOTHING when no cost feature is active (today's default bare config)", () => {
    const logger = makeMockLogger();
    emitMemoryCostFeatureNotice({
      agents: { "agent-1": bareAgent() },
      costFeaturesEnabled: true,
      logger: logger as never,
    });
    expect(logger._calls("warn")).toHaveLength(0);
  });

  it("emits NOTHING when the kill switch is OFF, even if a feature is per-agent-enabled", () => {
    const logger = makeMockLogger();
    emitMemoryCostFeatureNotice({
      agents: { "agent-1": { ...bareAgent(), memoryReview: { enabled: true } } },
      costFeaturesEnabled: false,
      logger: logger as never,
    });
    // Switch off ⇒ the feature is force-disabled elsewhere ⇒ nothing to disclose.
    expect(logger._calls("warn")).toHaveLength(0);
  });

  it("emits EXACTLY ONE WARN naming the active feature and the one-line disable config", () => {
    const logger = makeMockLogger();
    emitMemoryCostFeatureNotice({
      agents: { "agent-1": { ...bareAgent(), memoryReview: { enabled: true } } },
      costFeaturesEnabled: true,
      logger: logger as never,
    });

    const warns = logger._calls("warn");
    expect(warns, "exactly one cost-disclosure WARN").toHaveLength(1);

    const warn = warns[0]!;
    // Names the active feature.
    expect(JSON.stringify(warn.payload)).toContain("memoryReview");
    // Gives the exact one-line disable config.
    expect(JSON.stringify({ p: warn.payload, m: warn.msg })).toContain(
      "memory.costFeatures.enabled: false",
    );
    // States it spends the operator's own budget.
    expect((warn.msg + JSON.stringify(warn.payload)).toLowerCase()).toMatch(
      /budget|spend|cost|api/,
    );
    // WARN carries the §2.7-required operator-actionable hint + errorKind.
    expect(warn.payload).toHaveProperty("hint");
    expect(warn.payload).toHaveProperty("errorKind");
  });

  it("names the dialectic (memory_ask) tool when it is the active cost feature", () => {
    const logger = makeMockLogger();
    emitMemoryCostFeatureNotice({
      agents: { "agent-1": { ...bareAgent(), dialectic: { enabled: true } } },
      costFeaturesEnabled: true,
      logger: logger as never,
    });
    const warns = logger._calls("warn");
    expect(warns).toHaveLength(1);
    expect(JSON.stringify(warns[0]!.payload)).toMatch(/dialectic|memory_ask/);
  });

  it("aggregates every active cost feature across agents into the single notice", () => {
    // The deleted memoryConsolidation/memoryReasoning/memoryUserRepresentation crons (Phase 225-05)
    // are no longer cost features; the surviving disclosed crons are memoryReview + memoryUsefulnessJudge
    // (+ the query-time dialectic tool).
    const logger = makeMockLogger();
    emitMemoryCostFeatureNotice({
      agents: {
        "agent-1": { ...bareAgent(), memoryReview: { enabled: true } },
        "agent-2": { ...bareAgent(), memoryUsefulnessJudge: { enabled: true }, dialectic: { enabled: true } },
      },
      costFeaturesEnabled: true,
      logger: logger as never,
    });
    const warns = logger._calls("warn");
    expect(warns, "still exactly one notice regardless of feature count").toHaveLength(1);
    const blob = JSON.stringify(warns[0]!.payload);
    expect(blob).toContain("memoryReview");
    expect(blob).toContain("memoryUsefulnessJudge");
    expect(blob).toMatch(/dialectic|memory_ask/);
  });

  it("does NOT treat the keyless lifecycle sweep or the privacy-gated social cron as cost features", () => {
    const logger = makeMockLogger();
    emitMemoryCostFeatureNotice({
      agents: {
        "agent-1": {
          ...bareAgent(),
          memoryLifecycle: { enabled: true },
          socialModeling: { enabled: true, privacyReviewSignedOffBy: "op@example.com" },
        },
      },
      costFeaturesEnabled: true,
      logger: logger as never,
    });
    // Neither is a $-spending LLM cost feature gated by this switch ⇒ no disclosure.
    expect(logger._calls("warn")).toHaveLength(0);
  });

  it("never logs a secret/key-shaped value", () => {
    const logger = makeMockLogger();
    emitMemoryCostFeatureNotice({
      agents: { "agent-1": { ...bareAgent(), memoryReview: { enabled: true } } },
      costFeaturesEnabled: true,
      logger: logger as never,
    });
    const logged = JSON.stringify(logger._calls());
    expect(logged).not.toMatch(/sk-[A-Za-z0-9]{16,}|Bearer |apiKey"\s*:\s*"[^"]+"/);
  });
});
