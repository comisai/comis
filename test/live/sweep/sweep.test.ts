// SPDX-License-Identifier: Apache-2.0
/**
 * Stage-A unit tests for sweep orchestration.
 *
 * These tests use mock probes and a mock governor — NO real network calls.
 * All tests run with COMIS_LIVE unset (sandbox-safe).
 *
 * Tests live-gated blocks (describe.skipIf) require COMIS_LIVE=1.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runSweep, parseProbeFilter, type SweepResult, type ProbeVerdict } from "./sweep.js";
import type { Probe, ProbeResult } from "./probes.js";
import type { CredentialRegistry } from "../credentials.js";
import type { CostGovernor } from "../cost.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeProbe(id: string, result: ProbeResult): Probe {
  return {
    id,
    category: `cat-${id}`,
    costTier: "$0",
    run: async () => result,
  };
}

function makeMockRegistry(): CredentialRegistry {
  return {
    getUnlockedCategories: () => [],
    getSkipVerdict: () => null,
    hasKey: () => false,
  };
}

function makeMockGovernor(budgetExceededAfter?: number): CostGovernor {
  let callCount = 0;
  return {
    declare: () => {},
    check: () => {
      callCount++;
      return budgetExceededAfter !== undefined && callCount > budgetExceededAfter
        ? ("SKIPPED(budget-exceeded)" as const)
        : null;
    },
    tally: () => 0,
    dryRunPlan: () => [],
  } as unknown as CostGovernor;
}

// ---------------------------------------------------------------------------
// Stage-A unit tests — mock probes, no real network, COMIS_LIVE not required
// ---------------------------------------------------------------------------

describe("runSweep — orchestration (unit, mock probes)", () => {
  // Test 1: 3 mock probes all returning green
  it("returns SweepResult with verdicts.length === 3 and all status 'green'", async () => {
    const greenResult: ProbeResult = { status: "green", durationMs: 5 };
    const probes: Probe[] = [
      makeProbe("p1", greenResult),
      makeProbe("p2", greenResult),
      makeProbe("p3", greenResult),
    ];
    const registry = new Map(probes.map((p) => [p.id, p]));
    const result: SweepResult = await runSweep(
      makeMockRegistry(),
      makeMockGovernor(),
      { probeRegistry: registry },
    );
    expect(result.verdicts).toHaveLength(3);
    expect(result.verdicts.every((v) => v.status === "green")).toBe(true);
  });

  // Test 2: probe that returns skip
  it("records a skip entry when a probe returns skip", async () => {
    const probes: Probe[] = [
      makeProbe("p1", { status: "green", durationMs: 5 }),
      makeProbe("p2", { status: "skip", reason: "SKIPPED(no-creds)", durationMs: 0 }),
      makeProbe("p3", { status: "green", durationMs: 5 }),
    ];
    const registry = new Map(probes.map((p) => [p.id, p]));
    const result = await runSweep(
      makeMockRegistry(),
      makeMockGovernor(),
      { probeRegistry: registry },
    );
    const skipVerdict = result.verdicts.find((v) => v.id === "p2");
    expect(skipVerdict).toBeDefined();
    expect(skipVerdict?.status).toBe("skip");
  });

  // Test 3: budget exceeded after 1 probe — remaining probes are NOT run
  it("records remaining probes as skip('SKIPPED(budget-exceeded)') when budget exceeded", async () => {
    let p2RunCount = 0;
    let p3RunCount = 0;
    const customP2: Probe = {
      id: "p2",
      category: "cat-p2",
      costTier: "$0",
      run: async () => {
        p2RunCount++;
        return { status: "green", durationMs: 5 };
      },
    };
    const customP3: Probe = {
      id: "p3",
      category: "cat-p3",
      costTier: "$0",
      run: async () => {
        p3RunCount++;
        return { status: "green", durationMs: 5 };
      },
    };
    const probes: Probe[] = [
      makeProbe("p1", { status: "green", durationMs: 5 }),
      customP2,
      customP3,
    ];
    const registry = new Map(probes.map((p) => [p.id, p]));
    // budgetExceededAfter=1: check() returns non-null starting at call #2
    const result = await runSweep(
      makeMockRegistry(),
      makeMockGovernor(1),
      { probeRegistry: registry },
    );
    // p2 and p3 should be skipped (not run)
    expect(p2RunCount).toBe(0);
    expect(p3RunCount).toBe(0);
    const p2Verdict = result.verdicts.find((v) => v.id === "p2");
    const p3Verdict = result.verdicts.find((v) => v.id === "p3");
    expect(p2Verdict?.status).toBe("skip");
    expect(p2Verdict?.reason).toBe("SKIPPED(budget-exceeded)");
    expect(p3Verdict?.status).toBe("skip");
    expect(p3Verdict?.reason).toBe("SKIPPED(budget-exceeded)");
  });

  // Test 6: probeIds filter — only named probe is invoked
  it("only runs the named probe when opts.probeIds is set", async () => {
    let p1RunCount = 0;
    let p2RunCount = 0;
    const customP1: Probe = {
      id: "search-brave",
      category: "search(brave)",
      costTier: "cent",
      run: async () => {
        p1RunCount++;
        return { status: "green", durationMs: 5 };
      },
    };
    const customP2: Probe = {
      id: "llm-anthropic",
      category: "LLM(anthropic)",
      costTier: "cent",
      run: async () => {
        p2RunCount++;
        return { status: "green", durationMs: 5 };
      },
    };
    const registry = new Map([
      [customP1.id, customP1],
      [customP2.id, customP2],
    ]);
    const result = await runSweep(
      makeMockRegistry(),
      makeMockGovernor(),
      { probeRegistry: registry, probeIds: ["search-brave"] },
    );
    expect(p1RunCount).toBe(1);
    expect(p2RunCount).toBe(0);
    expect(result.verdicts).toHaveLength(1);
    expect(result.verdicts[0]?.id).toBe("search-brave");
  });

  // Test 7: SweepResult.costUsd is numeric; SweepResult.ranAt is ISO date string
  it("returns costUsd as a number and ranAt as an ISO date string", async () => {
    const registry = new Map([["p1", makeProbe("p1", { status: "green", durationMs: 1 })]]);
    const result = await runSweep(
      makeMockRegistry(),
      makeMockGovernor(),
      { probeRegistry: registry },
    );
    expect(typeof result.costUsd).toBe("number");
    expect(Number.isFinite(result.costUsd)).toBe(true);
    expect(typeof result.ranAt).toBe("string");
    // ISO 8601 — must parse
    expect(new Date(result.ranAt).toISOString()).toBe(result.ranAt);
  });

  // Test 8: ProbeVerdict includes id, category, status, durationMs (and optional reason)
  it("ProbeVerdict includes id, category, status, durationMs", async () => {
    const probe = makeProbe("test-probe", { status: "red", reason: "HTTP 401", durationMs: 42 });
    const registry = new Map([[probe.id, probe]]);
    const result = await runSweep(
      makeMockRegistry(),
      makeMockGovernor(),
      { probeRegistry: registry },
    );
    const verdict: ProbeVerdict = result.verdicts[0]!;
    expect(verdict.id).toBe("test-probe");
    expect(verdict.category).toBe("cat-test-probe");
    expect(verdict.status).toBe("red");
    expect(verdict.durationMs).toBe(42);
    expect(verdict.reason).toBe("HTTP 401");
  });
});

// ---------------------------------------------------------------------------
// Prefix matching — COMIS_LIVE_PROBES=search must select all search-* probes
// ---------------------------------------------------------------------------

describe("runSweep — probeIds prefix matching", () => {
  it("COMIS_LIVE_PROBES=search selects all search-* probes (prefix match)", async () => {
    const searchBrave: Probe = {
      id: "search-brave",
      category: "search(brave)",
      costTier: "$0",
      run: async () => ({ status: "green", durationMs: 1 }),
    };
    const searchTavily: Probe = {
      id: "search-tavily",
      category: "search(tavily)",
      costTier: "$0",
      run: async () => ({ status: "green", durationMs: 1 }),
    };
    const llmAnthropicProbe: Probe = {
      id: "llm-anthropic",
      category: "LLM(anthropic)",
      costTier: "$0",
      run: async () => ({ status: "green", durationMs: 1 }),
    };
    const registry = new Map([
      [searchBrave.id, searchBrave],
      [searchTavily.id, searchTavily],
      [llmAnthropicProbe.id, llmAnthropicProbe],
    ]);
    const result = await runSweep(
      makeMockRegistry(),
      makeMockGovernor(),
      { probeRegistry: registry, probeIds: ["search"] },
    );
    // Only search-* probes should run
    expect(result.verdicts).toHaveLength(2);
    const ids = result.verdicts.map((v) => v.id);
    expect(ids).toContain("search-brave");
    expect(ids).toContain("search-tavily");
    expect(ids).not.toContain("llm-anthropic");
  });

  it("exact probe ID 'search-brave' selects exactly one probe", async () => {
    const searchBrave: Probe = {
      id: "search-brave",
      category: "search(brave)",
      costTier: "$0",
      run: async () => ({ status: "green", durationMs: 1 }),
    };
    const searchTavily: Probe = {
      id: "search-tavily",
      category: "search(tavily)",
      costTier: "$0",
      run: async () => ({ status: "green", durationMs: 1 }),
    };
    const registry = new Map([
      [searchBrave.id, searchBrave],
      [searchTavily.id, searchTavily],
    ]);
    const result = await runSweep(
      makeMockRegistry(),
      makeMockGovernor(),
      { probeRegistry: registry, probeIds: ["search-brave"] },
    );
    expect(result.verdicts).toHaveLength(1);
    expect(result.verdicts[0]?.id).toBe("search-brave");
  });
});

describe("parseProbeFilter — COMIS_LIVE_PROBES env parsing (unit)", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env["COMIS_LIVE_PROBES"];
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env["COMIS_LIVE_PROBES"];
    } else {
      process.env["COMIS_LIVE_PROBES"] = originalEnv;
    }
  });

  // Test 4: empty COMIS_LIVE_PROBES returns []
  it("returns [] when COMIS_LIVE_PROBES is empty string", () => {
    process.env["COMIS_LIVE_PROBES"] = "";
    expect(parseProbeFilter()).toEqual([]);
  });

  // Also covers unset case
  it("returns [] when COMIS_LIVE_PROBES is unset", () => {
    delete process.env["COMIS_LIVE_PROBES"];
    expect(parseProbeFilter()).toEqual([]);
  });

  // Test 5: comma-separated list parses correctly
  it("returns ['llm-anthropic','search-brave'] when COMIS_LIVE_PROBES='llm-anthropic,search-brave'", () => {
    process.env["COMIS_LIVE_PROBES"] = "llm-anthropic,search-brave";
    expect(parseProbeFilter()).toEqual(["llm-anthropic", "search-brave"]);
  });

  it("trims whitespace around probe IDs", () => {
    process.env["COMIS_LIVE_PROBES"] = "llm-openai , stt-groq , vision-google";
    expect(parseProbeFilter()).toEqual(["llm-openai", "stt-groq", "vision-google"]);
  });

  it("filters out empty segments from extra commas", () => {
    process.env["COMIS_LIVE_PROBES"] = "llm-anthropic,,search-brave,";
    expect(parseProbeFilter()).toEqual(["llm-anthropic", "search-brave"]);
  });
});

// ---------------------------------------------------------------------------
// Live-gated block — real network, skip when COMIS_LIVE is unset
// ---------------------------------------------------------------------------

const isLive = !!process.env["COMIS_LIVE"];

describe.skipIf(!isLive)("runSweep — live network (real PROBE_REGISTRY)", () => {
  it("runs at least one probe and returns a SweepResult", async () => {
    const { PROBE_REGISTRY } = await import("./probes.js");
    const { CostGovernor } = await import("../cost.js");
    const { buildCredentialRegistry } = await import("../credentials.js");

    const governor = new CostGovernor();
    const registry = buildCredentialRegistry();
    const result = await runSweep(registry, governor, { probeRegistry: PROBE_REGISTRY });

    expect(result.verdicts.length).toBeGreaterThan(0);
    expect(typeof result.costUsd).toBe("number");
    expect(result.ranAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
