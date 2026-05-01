// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for startup-dry-run: logOperationModelDryRun()
 * Validates that the dry-run function logs correct operation model
 * resolutions per agent at startup, emits WARN for cross-provider
 * API key misses, and never throws.
 * @module
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { logOperationModelDryRun } from "./startup-dry-run.js";

describe("logOperationModelDryRun", () => {
  let mockLogger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
  let mockSecretManager: { has: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockLogger = { info: vi.fn(), warn: vi.fn() };
    mockSecretManager = { has: vi.fn().mockReturnValue(true) };
  });

  // Test 1: Given 1 agent with anthropic provider, logs 1 INFO line containing all 7 operation types
  it("logs one INFO line per agent with all 7 operation types", () => {
    logOperationModelDryRun({
      agents: {
        myAgent: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
      },
      secretManager: mockSecretManager,
      logger: mockLogger,
    });

    expect(mockLogger.info).toHaveBeenCalledTimes(1);

    const infoCall = mockLogger.info.mock.calls[0];
    const logObj = infoCall[0] as Record<string, unknown>;
    expect(logObj.agentId).toBe("myAgent");

    const ops = logObj.operationModels as Array<{ op: string }>;
    expect(ops).toHaveLength(7);

    const opNames = ops.map((o) => o.op).sort();
    expect(opNames).toEqual(
      ["compaction", "condensation", "cron", "heartbeat", "interactive", "subagent", "taskExtraction"].sort(),
    );
  });

  // Test 2: Given 2 agents, logs 2 INFO lines
  it("logs one INFO line per agent for multiple agents", () => {
    logOperationModelDryRun({
      agents: {
        agentA: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
        agentB: { provider: "google", model: "gemini-2.5-pro" },
      },
      secretManager: mockSecretManager,
      logger: mockLogger,
    });

    expect(mockLogger.info).toHaveBeenCalledTimes(2);

    const agentIds = mockLogger.info.mock.calls.map(
      (c: unknown[]) => (c[0] as Record<string, unknown>).agentId,
    );
    expect(agentIds).toContain("agentA");
    expect(agentIds).toContain("agentB");
  });

  // Test 3: Same-provider family with key present => no WARN
  it("does not emit WARN when resolved model uses same provider family with key present", () => {
    mockSecretManager.has.mockReturnValue(true);

    logOperationModelDryRun({
      agents: {
        myAgent: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
      },
      secretManager: mockSecretManager,
      logger: mockLogger,
    });

    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  // Test 4: Cross-provider resolution with missing API key => WARN
  it("emits WARN when cross-provider resolution has missing API key", () => {
    // Agent is anthropic, but cron is overridden to openai
    // secretManager says OPENAI_API_KEY is missing
    mockSecretManager.has.mockImplementation((key: string) => {
      if (key === "OPENAI_API_KEY") return false;
      return true;
    });

    logOperationModelDryRun({
      agents: {
        myAgent: {
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
          operationModels: { cron: { model: "openai:gpt-4o" } },
        },
      },
      secretManager: mockSecretManager,
      logger: mockLogger,
    });

    expect(mockLogger.warn).toHaveBeenCalled();
    const warnCall = mockLogger.warn.mock.calls[0];
    const warnObj = warnCall[0] as Record<string, unknown>;
    expect(warnObj.expectedKey).toBe("OPENAI_API_KEY");
    expect(warnObj.agentId).toBe("myAgent");
    expect(warnObj.operationType).toBe("cron");
    expect(warnObj.resolvedProvider).toBe("openai");
  });

  // Test 5: Interactive has tieringActive=false, family_default sources have tieringActive=true
  it("marks interactive as tieringActive=false and family defaults as tieringActive=true", () => {
    logOperationModelDryRun({
      agents: {
        myAgent: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
      },
      secretManager: mockSecretManager,
      logger: mockLogger,
    });

    const infoCall = mockLogger.info.mock.calls[0];
    const ops = (infoCall[0] as Record<string, unknown>).operationModels as Array<{
      op: string;
      tieringActive: boolean;
      source: string;
    }>;

    const interactive = ops.find((o) => o.op === "interactive");
    expect(interactive?.tieringActive).toBe(false);
    // interactive source should be agent_primary (not family_default or explicit_config)
    expect(interactive?.source).toBe("agent_primary");

    // All family_default ops should have tieringActive=true
    const familyDefaults = ops.filter((o) => o.source === "family_default");
    expect(familyDefaults.length).toBeGreaterThan(0);
    for (const fd of familyDefaults) {
      expect(fd.tieringActive).toBe(true);
    }
  });

  // Test 6: Never throws -- if resolveOperationModel somehow throws, error is caught and logged as WARN
  it("catches internal errors and logs WARN instead of throwing", () => {
    // Pass agents with a property that would cause resolution to fail:
    // Use a getter that throws on access to simulate an internal error
    const badAgents = {
      get badAgent() {
        return {
          get provider(): string { throw new Error("Simulated internal error"); },
          model: "test",
        };
      },
    };

    expect(() => {
      logOperationModelDryRun({
        agents: badAgents as unknown as Record<string, { provider: string; model: string }>,
        secretManager: mockSecretManager,
        logger: mockLogger,
      });
    }).not.toThrow();

    // Should have logged a WARN for the error
    expect(mockLogger.warn).toHaveBeenCalled();
    const warnCall = mockLogger.warn.mock.calls[0];
    const warnObj = warnCall[0] as Record<string, unknown>;
    expect(warnObj.agentId).toBe("badAgent");
    expect(warnObj.errorKind).toBe("config");
  });

  // Test 7: Non-native provider family (custom YAML provider not in pi-ai
  // catalog) => all operations fall to agent_primary, all tieringActive=false.
  // Uses "ollama" (a custom YAML provider type) since native pi-ai providers
  // (xai, openai, anthropic, openrouter, google, etc.) all now resolve via
  // catalog cost-tiering and would incorrectly be classified as "unknown".
  it("falls back to agent_primary for non-native (custom) provider families", () => {
    logOperationModelDryRun({
      agents: {
        myAgent: { provider: "ollama", model: "llama3:8b" },
      },
      secretManager: mockSecretManager,
      logger: mockLogger,
    });

    expect(mockLogger.info).toHaveBeenCalledTimes(1);

    const infoCall = mockLogger.info.mock.calls[0];
    const ops = (infoCall[0] as Record<string, unknown>).operationModels as Array<{
      op: string;
      tieringActive: boolean;
      source: string;
    }>;

    // For non-native providers (no pi-ai catalog), all ops should fall back
    // to agent_primary (no catalog tier defaults available).
    for (const op of ops) {
      expect(op.source).toBe("agent_primary");
      expect(op.tieringActive).toBe(false);
    }
  });
});
