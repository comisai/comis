// SPDX-License-Identifier: Apache-2.0
/**
 * Co-located unit tests for metric-aggregator.ts.
 *
 * Asserts:
 *   - The three classifier predicates (isDiscoveryTool, isMcpTool,
 *     isInstallExec) return correct positive + negative answers.
 *   - computeRoundSignals() correctly converts synthetic event streams into
 *     the four binary RoundSignals (the canonical OBS-CAP-03 metric-
 *     definition verification surface -- see 24-04 PLAN <success_criteria>).
 *   - MetricAggregator records rounds and aggregates rates correctly,
 *     including the null-aware nullable-rate denominator for
 *     installDetourHintCoverage.
 */

import { describe, it, expect } from "vitest";
import {
  MetricAggregator,
  computeRoundSignals,
  isDiscoveryTool,
  isMcpTool,
  isInstallExec,
  type ToolEvent,
  type InstallDetourEvent,
} from "./metric-aggregator.js";

describe("Phase 24 metric aggregator (OBS-CAP-03)", () => {
  // -------------------------------------------------------------------------
  // Block 1 -- Classifier correctness
  // -------------------------------------------------------------------------

  describe("Classifiers", () => {
    it("isDiscoveryTool: returns true for discover_tools", () => {
      expect(isDiscoveryTool("discover_tools")).toBe(true);
    });

    it("isDiscoveryTool: returns true for tool_search_tool_regex", () => {
      expect(isDiscoveryTool("tool_search_tool_regex")).toBe(true);
    });

    it("isDiscoveryTool: returns true for any /^(list|search|discover|find).*tool/i match", () => {
      expect(isDiscoveryTool("list_tools")).toBe(true);
      expect(isDiscoveryTool("search_for_tool")).toBe(true);
      expect(isDiscoveryTool("find_my_tool")).toBe(true);
      expect(isDiscoveryTool("discover_my_tool")).toBe(true);
    });

    it("isDiscoveryTool: returns false for non-discovery tools", () => {
      expect(isDiscoveryTool("exec")).toBe(false);
      expect(isDiscoveryTool("read")).toBe(false);
      expect(isDiscoveryTool("mcp__finance-data--get_price")).toBe(false);
    });

    it("isMcpTool: returns true for canonical mcp__server--tool form", () => {
      expect(isMcpTool("mcp__finance-data--get_price")).toBe(true);
      expect(isMcpTool("mcp__foo-bar--baz")).toBe(true);
    });

    it("isMcpTool: returns false for non-MCP tools", () => {
      expect(isMcpTool("exec")).toBe(false);
      expect(isMcpTool("discover_tools")).toBe(false);
      expect(isMcpTool("mcp")).toBe(false);
    });

    it("isInstallExec: returns true for pip install", () => {
      expect(isInstallExec("exec", { command: "pip install foo" })).toBe(true);
      expect(isInstallExec("exec", { command: "pip3 install bar" })).toBe(true);
    });

    it("isInstallExec: returns true for npm install", () => {
      expect(isInstallExec("exec", { command: "npm install foo" })).toBe(true);
      expect(isInstallExec("exec", { command: "npm i foo" })).toBe(true);
      expect(isInstallExec("exec", { command: "npm add foo" })).toBe(true);
      expect(isInstallExec("exec", { command: "pnpm install foo" })).toBe(true);
      expect(isInstallExec("exec", { command: "pnpm add foo" })).toBe(true);
      expect(isInstallExec("exec", { command: "yarn add foo" })).toBe(true);
    });

    it("isInstallExec: returns true for python -m pip install ...", () => {
      expect(
        isInstallExec("exec", {
          command: "python -m pip install market-data-lib",
        }),
      ).toBe(true);
      expect(
        isInstallExec("exec", { command: "python3 -m pip install foo" }),
      ).toBe(true);
    });

    it("isInstallExec: returns false for non-install exec commands", () => {
      expect(isInstallExec("exec", { command: "echo hi" })).toBe(false);
      expect(isInstallExec("exec", { command: "ls" })).toBe(false);
      // python -m foo is the parser's leading-token rule edge: only
      // "python -m pip install ..." matches.
      expect(isInstallExec("exec", { command: "python -m foo" })).toBe(false);
      expect(isInstallExec("exec", { command: "" })).toBe(false);
      expect(isInstallExec("exec", undefined)).toBe(false);
    });

    it("isInstallExec: returns false for non-exec tools", () => {
      expect(
        isInstallExec("read", { command: "pip install foo" }),
      ).toBe(false);
      expect(
        isInstallExec("mcp__finance-data--get_price", {
          command: "pip install foo",
        }),
      ).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Block 2 -- computeRoundSignals (the canonical OBS-CAP-03 surface)
  // -------------------------------------------------------------------------

  describe("computeRoundSignals", () => {
    it("empty events -> all false, hintCoverage=null", () => {
      const r = computeRoundSignals([], [], []);
      expect(r.firstNonDiscoveryActionIsMcp).toBe(false);
      expect(r.firstNonDiscoveryActionIsInstall).toBe(false);
      expect(r.installBeforeFirstMcpDataFetch).toBe(false);
      expect(r.installDetourHintCoverage).toBe(null);
    });

    it("first event is MCP -> firstNonDiscoveryActionIsMcp=true", () => {
      const events: ToolEvent[] = [
        { toolName: "discover_tools", timestamp: 100 }, // discovery -- skipped
        { toolName: "mcp__finance-data--get_price", timestamp: 200 },
      ];
      const r = computeRoundSignals(events, [], []);
      expect(r.firstNonDiscoveryActionIsMcp).toBe(true);
      expect(r.firstNonDiscoveryActionIsInstall).toBe(false);
    });

    it("first event is install -> firstNonDiscoveryActionIsInstall=true", () => {
      const events: ToolEvent[] = [
        {
          toolName: "exec",
          timestamp: 100,
          params: { command: "pip install market-data-lib" },
        },
      ];
      const r = computeRoundSignals(events, [], []);
      expect(r.firstNonDiscoveryActionIsInstall).toBe(true);
      expect(r.firstNonDiscoveryActionIsMcp).toBe(false);
    });

    it("install BEFORE finance-data MCP fetch -> installBeforeFirstMcpDataFetch=true", () => {
      const events: ToolEvent[] = [
        {
          toolName: "exec",
          timestamp: 100,
          params: { command: "pip install market-data-lib" },
        },
        { toolName: "mcp__finance-data--get_price", timestamp: 200 },
      ];
      const r = computeRoundSignals(events, [], []);
      expect(r.installBeforeFirstMcpDataFetch).toBe(true);
    });

    it("finance-data fetch BEFORE install -> installBeforeFirstMcpDataFetch=false", () => {
      const events: ToolEvent[] = [
        { toolName: "mcp__finance-data--get_price", timestamp: 100 },
        {
          toolName: "exec",
          timestamp: 200,
          params: { command: "pip install market-data-lib" },
        },
      ];
      const r = computeRoundSignals(events, [], []);
      expect(r.installBeforeFirstMcpDataFetch).toBe(false);
    });

    it("hint augmentation tracking", () => {
      const detour: InstallDetourEvent[] = [
        { action: "hinted", mode: "advise", timestamp: 100 },
      ];
      const r1 = computeRoundSignals([], detour, [true]);
      expect(r1.installDetourHintCoverage).toBe(true);

      const r2 = computeRoundSignals([], detour, [false]);
      expect(r2.installDetourHintCoverage).toBe(false);

      // No "hinted" detour event -> null (excluded from rate denominator).
      const r3 = computeRoundSignals([], [], []);
      expect(r3.installDetourHintCoverage).toBe(null);

      // "observed" detour event (not "hinted") -> still null.
      const r4 = computeRoundSignals(
        [],
        [{ action: "observed", mode: "observe", timestamp: 100 }],
        [],
      );
      expect(r4.installDetourHintCoverage).toBe(null);
    });

    it("events arriving out-of-order are sorted by timestamp internally", () => {
      const events: ToolEvent[] = [
        { toolName: "mcp__finance-data--get_price", timestamp: 200 },
        {
          toolName: "exec",
          timestamp: 100,
          params: { command: "pip install market-data-lib" },
        },
      ];
      // Despite array order putting the MCP fetch first, the install at
      // timestamp 100 wins as "first non-discovery" + "first install" once
      // sorted by timestamp.
      const r = computeRoundSignals(events, [], []);
      expect(r.firstNonDiscoveryActionIsInstall).toBe(true);
      expect(r.firstNonDiscoveryActionIsMcp).toBe(false);
      expect(r.installBeforeFirstMcpDataFetch).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Block 3 -- MetricAggregator
  // -------------------------------------------------------------------------

  describe("MetricAggregator", () => {
    it("empty -> empty report with totalRounds=0", () => {
      const a = new MetricAggregator();
      const r = a.finalize([]);
      expect(r.totalRounds).toBe(0);
      expect(Object.keys(r.providers)).toEqual([]);
      expect(r.fixturesRun).toEqual([]);
      expect(typeof r.timestamp).toBe("string");
    });

    it("2 rounds, 1 provider -> rates correctly averaged", () => {
      const a = new MetricAggregator();
      a.recordRound("anthropic", {
        firstNonDiscoveryActionIsMcp: true,
        firstNonDiscoveryActionIsInstall: false,
        installBeforeFirstMcpDataFetch: false,
        installDetourHintCoverage: null,
      });
      a.recordRound("anthropic", {
        firstNonDiscoveryActionIsMcp: false,
        firstNonDiscoveryActionIsInstall: true,
        installBeforeFirstMcpDataFetch: true,
        installDetourHintCoverage: null,
      });
      const r = a.finalize(["fixtureA"]);
      expect(r.providers["anthropic"]?.rounds).toBe(2);
      expect(r.providers["anthropic"]?.firstNonDiscoveryActionIsMcp.rate).toBe(0.5);
      expect(r.providers["anthropic"]?.firstNonDiscoveryActionIsMcp.count).toBe(1);
      expect(
        r.providers["anthropic"]?.firstNonDiscoveryActionIsInstall.rate,
      ).toBe(0.5);
      expect(
        r.providers["anthropic"]?.installBeforeFirstMcpDataFetch.rate,
      ).toBe(0.5);
      // Hint coverage: both rounds had null -> applicable=0 -> rate=0, count=0
      expect(
        r.providers["anthropic"]?.installDetourHintCoverage.rate,
      ).toBe(0);
      expect(
        r.providers["anthropic"]?.installDetourHintCoverage.count,
      ).toBe(0);
      expect(r.totalRounds).toBe(2);
      expect(r.fixturesRun).toEqual(["fixtureA"]);
      expect(typeof r.timestamp).toBe("string");
    });

    it("hint coverage rate excludes null rounds", () => {
      const a = new MetricAggregator();
      a.recordRound("anthropic", {
        firstNonDiscoveryActionIsMcp: false,
        firstNonDiscoveryActionIsInstall: false,
        installBeforeFirstMcpDataFetch: false,
        installDetourHintCoverage: null,
      });
      a.recordRound("anthropic", {
        firstNonDiscoveryActionIsMcp: false,
        firstNonDiscoveryActionIsInstall: false,
        installBeforeFirstMcpDataFetch: false,
        installDetourHintCoverage: true,
      });
      a.recordRound("anthropic", {
        firstNonDiscoveryActionIsMcp: false,
        firstNonDiscoveryActionIsInstall: false,
        installBeforeFirstMcpDataFetch: false,
        installDetourHintCoverage: false,
      });
      const r = a.finalize([]);
      // Two applicable rounds (true + false), one true -> rate 0.5, count 1
      expect(
        r.providers["anthropic"]?.installDetourHintCoverage.rate,
      ).toBe(0.5);
      expect(
        r.providers["anthropic"]?.installDetourHintCoverage.count,
      ).toBe(1);
    });

    it("roundCount returns the right count", () => {
      const a = new MetricAggregator();
      const signals = {
        firstNonDiscoveryActionIsMcp: false,
        firstNonDiscoveryActionIsInstall: false,
        installBeforeFirstMcpDataFetch: false,
        installDetourHintCoverage: null,
      } as const;
      a.recordRound("anthropic", { ...signals });
      a.recordRound("anthropic", { ...signals });
      a.recordRound("anthropic", { ...signals });
      expect(a.roundCount("anthropic")).toBe(3);
      expect(a.roundCount("openai-codex")).toBe(0);
    });

    it("multi-provider isolation", () => {
      const a = new MetricAggregator();
      a.recordRound("anthropic", {
        firstNonDiscoveryActionIsMcp: true,
        firstNonDiscoveryActionIsInstall: false,
        installBeforeFirstMcpDataFetch: false,
        installDetourHintCoverage: null,
      });
      a.recordRound("openai-codex", {
        firstNonDiscoveryActionIsMcp: false,
        firstNonDiscoveryActionIsInstall: true,
        installBeforeFirstMcpDataFetch: false,
        installDetourHintCoverage: null,
      });
      const r = a.finalize(["fA", "fB"]);
      expect(r.totalRounds).toBe(2);
      expect(r.providers["anthropic"]?.firstNonDiscoveryActionIsMcp.rate).toBe(1);
      expect(
        r.providers["anthropic"]?.firstNonDiscoveryActionIsInstall.rate,
      ).toBe(0);
      expect(
        r.providers["openai-codex"]?.firstNonDiscoveryActionIsMcp.rate,
      ).toBe(0);
      expect(
        r.providers["openai-codex"]?.firstNonDiscoveryActionIsInstall.rate,
      ).toBe(1);
      expect(r.fixturesRun).toEqual(["fA", "fB"]);
    });
  });
});
