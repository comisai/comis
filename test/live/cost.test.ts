// SPDX-License-Identifier: Apache-2.0
/**
 * Stage-A unit tests for the CostGovernor, scanForSecrets, and assertNoSecrets.
 *
 * No real API calls; no real budget consumed.
 *
 * @module
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CostGovernor, scanForSecrets, assertNoSecrets } from "./cost.js";

describe("CostGovernor", () => {
  let savedBudgetEnv: string | undefined;

  beforeEach(() => {
    savedBudgetEnv = process.env["COMIS_LIVE_BUDGET_USD"];
    delete process.env["COMIS_LIVE_BUDGET_USD"];
  });

  afterEach(() => {
    if (savedBudgetEnv === undefined) {
      delete process.env["COMIS_LIVE_BUDGET_USD"];
    } else {
      process.env["COMIS_LIVE_BUDGET_USD"] = savedBudgetEnv;
    }
  });

  it("tally() returns 0 after declaring a $0 tier scenario", () => {
    const gov = new CostGovernor();
    gov.declare("$0", "smoke");
    expect(gov.tally()).toBe(0);
  });

  it("tally() returns positive value after declaring cent + dollar tiers", () => {
    const gov = new CostGovernor();
    gov.declare("cent", "t1");
    gov.declare("dollar", "t2");
    expect(gov.tally()).toBeGreaterThan(0);
  });

  it("check() returns SKIPPED(budget-exceeded) when tally exceeds COMIS_LIVE_BUDGET_USD", () => {
    process.env["COMIS_LIVE_BUDGET_USD"] = "0.01";
    const gov = new CostGovernor();
    gov.declare("cent", "t1");
    expect(gov.check()).toBe("SKIPPED(budget-exceeded)");
  });

  it("check() returns null when tally is under budget", () => {
    process.env["COMIS_LIVE_BUDGET_USD"] = "100.00";
    const gov = new CostGovernor();
    gov.declare("cent", "t1");
    expect(gov.check()).toBeNull();
  });

  it("dryRunPlan() returns string array of scenario IDs with tier labels", () => {
    const gov = new CostGovernor();
    gov.declare("cent", "t1");
    gov.declare("dollar", "t2");
    const plan = gov.dryRunPlan(["t1", "t2"]);
    expect(Array.isArray(plan)).toBe(true);
    expect(plan.length).toBe(2);
    expect(typeof plan[0]).toBe("string");
    expect(typeof plan[1]).toBe("string");
  });
});

describe("scanForSecrets", () => {
  it("matches a real-looking sk- key string", () => {
    const matches = scanForSecrets("sk-abc123456789012345678901234567890");
    expect(matches.length).toBeGreaterThan(0);
  });

  it("returns empty array for safe content", () => {
    const matches = scanForSecrets("hello world");
    expect(matches).toEqual([]);
  });

  // apiKey field-name false-positive regression tests
  it("does NOT match a JSON field name 'apiKey' with null value", () => {
    const matches = scanForSecrets(JSON.stringify({ apiKey: null }));
    expect(matches).toEqual([]);
  });

  it("does NOT match a JSON field name 'apiKey' with a short placeholder value", () => {
    // A parameter name shorter than 4 chars should not match
    const matches = scanForSecrets(JSON.stringify({ apiKey: "key" }));
    expect(matches).toEqual([]);
  });

  it("does NOT match a bare 'apiKey' word in prose", () => {
    const matches = scanForSecrets("The apiKey field is documented in the README.");
    expect(matches).toEqual([]);
  });

  it("matches apiKey key=value assignment with a real-looking value (double-quoted JSON)", () => {
    const matches = scanForSecrets('"apiKey": "sk-ant-api03-realtoken"');
    expect(matches.length).toBeGreaterThan(0);
  });

  it("matches apiKey key=value assignment with a real-looking value (unquoted JS form)", () => {
    const matches = scanForSecrets("apiKey: 'sk-ant-api03-realtoken'");
    expect(matches.length).toBeGreaterThan(0);
  });
});

describe("assertNoSecrets", () => {
  it("throws when content contains a Bearer token", () => {
    expect(() => {
      assertNoSecrets("Bearer xyz123456789012345678901234");
    }).toThrow();
  });

  it("does not throw for safe content", () => {
    expect(() => {
      assertNoSecrets("safe content with no credentials");
    }).not.toThrow();
  });
});
