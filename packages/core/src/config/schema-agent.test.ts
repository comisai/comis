// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  AgentConfigSchema,
  PerAgentConfigSchema,
  RoutingConfigSchema,
  RoutingBindingSchema,
  RagConfigSchema,
  BootstrapConfigSchema,
  ConcurrencyConfigSchema,
  BroadcastGroupSchema,
  ElevatedReplyConfigSchema,
  TracingConfigSchema,
  SdkRetryConfigSchema,
  ContextGuardConfigSchema,
  AgentsMapSchema,
  DeferredToolsConfigSchema,
} from "./schema-agent.js";

// ---------------------------------------------------------------------------
// AgentConfigSchema
// ---------------------------------------------------------------------------

describe("AgentConfigSchema", () => {
  it("produces valid defaults from empty object", () => {
    const result = AgentConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("Comis");
      expect(result.data.model).toBe("default");
      expect(result.data.provider).toBe("default");
      expect(result.data.maxSteps).toBe(150);
      expect(result.data.maxContextChars).toBe(100_000);
      expect(result.data.maxToolResultChars).toBe(50_000);
      expect(result.data.preserveRecent).toBe(4);
    }
  });

  it("leaves optional fields undefined when omitted (except cacheRetention which defaults)", () => {
    const result = AgentConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.thinkingLevel).toBeUndefined();
      expect(result.data.maxTokens).toBeUndefined();
      expect(result.data.temperature).toBeUndefined();
      expect(result.data.cacheRetention).toBe("long");
      expect(result.data.workspacePath).toBeUndefined();
      expect(result.data.reactionLevel).toBeUndefined();
    }
  });

  it("rejects empty string for name", () => {
    const result = AgentConfigSchema.safeParse({ name: "" });
    expect(result.success).toBe(false);
  });

  it("rejects non-positive maxSteps", () => {
    const result = AgentConfigSchema.safeParse({ maxSteps: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects negative maxSteps", () => {
    const result = AgentConfigSchema.safeParse({ maxSteps: -5 });
    expect(result.success).toBe(false);
  });

  it("rejects temperature below 0", () => {
    const result = AgentConfigSchema.safeParse({ temperature: -0.1 });
    expect(result.success).toBe(false);
  });

  it("rejects temperature above 2", () => {
    const result = AgentConfigSchema.safeParse({ temperature: 2.1 });
    expect(result.success).toBe(false);
  });

  it("accepts temperature at boundary values", () => {
    const r0 = AgentConfigSchema.safeParse({ temperature: 0 });
    expect(r0.success).toBe(true);
    const r2 = AgentConfigSchema.safeParse({ temperature: 2 });
    expect(r2.success).toBe(true);
  });

  it("accepts valid thinkingLevel enum values", () => {
    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh"] as const) {
      const result = AgentConfigSchema.safeParse({ thinkingLevel: level });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.thinkingLevel).toBe(level);
      }
    }
  });

  it("rejects invalid thinkingLevel", () => {
    const result = AgentConfigSchema.safeParse({ thinkingLevel: "ultra" });
    expect(result.success).toBe(false);
  });

  it("accepts valid cacheRetention values", () => {
    for (const val of ["none", "short", "long"] as const) {
      const result = AgentConfigSchema.safeParse({ cacheRetention: val });
      expect(result.success).toBe(true);
    }
  });

  it("includes nested defaults for budgets, circuitBreaker, rag, bootstrap", () => {
    const result = AgentConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.budgets).toBeDefined();
      expect(result.data.circuitBreaker).toBeDefined();
      expect(result.data.rag).toBeDefined();
      expect(result.data.rag.enabled).toBe(true);
      expect(result.data.bootstrap).toBeDefined();
      expect(result.data.bootstrap.maxChars).toBe(20_000);
      expect(result.data.modelFailover).toBeDefined();
      expect(result.data.sdkRetry).toBeDefined();
    }
  });

  it("includes promptTimeout defaults", () => {
    const config = AgentConfigSchema.parse({});
    expect(config.promptTimeout.promptTimeoutMs).toBe(180_000);
    expect(config.promptTimeout.retryPromptTimeoutMs).toBe(60_000);
  });

  it("enforceFinalTag defaults to false", () => {
    const result = AgentConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enforceFinalTag).toBe(false);
    }
  });

  it("fastMode defaults to false", () => {
    const result = AgentConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.fastMode).toBe(false);
    }
  });

  it("storeCompletions defaults to false", () => {
    const result = AgentConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.storeCompletions).toBe(false);
    }
  });

  it("enforceFinalTag, fastMode, storeCompletions accept true when explicitly set", () => {
    const result = AgentConfigSchema.safeParse({
      enforceFinalTag: true,
      fastMode: true,
      storeCompletions: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enforceFinalTag).toBe(true);
      expect(result.data.fastMode).toBe(true);
      expect(result.data.storeCompletions).toBe(true);
    }
  });

  it("cacheRetention defaults to 'long'", () => {
    const result = AgentConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cacheRetention).toBe("long");
    }
  });

  it("cacheBreakpointStrategy defaults to 'single'", () => {
    const result = AgentConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cacheBreakpointStrategy).toBe("single");
    }
  });

  it("cacheBreakpointStrategy accepts 'auto'", () => {
    const result = AgentConfigSchema.safeParse({ cacheBreakpointStrategy: "auto" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cacheBreakpointStrategy).toBe("auto");
    }
  });

  it("cacheBreakpointStrategy accepts valid values", () => {
    const result = AgentConfigSchema.safeParse({ cacheBreakpointStrategy: "single" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cacheBreakpointStrategy).toBe("single");
    }
  });

  it("cacheBreakpointStrategy rejects invalid values", () => {
    const result = AgentConfigSchema.safeParse({ cacheBreakpointStrategy: "double" });
    expect(result.success).toBe(false);
  });

  // cacheRetentionOverrides schema tests
  it("cacheRetentionOverrides accepts valid record of string->CacheRetention", () => {
    const result = AgentConfigSchema.safeParse({
      cacheRetentionOverrides: {
        "claude-sonnet": "none",
        "claude-opus-4-6": "short",
        "gpt-4o": "long",
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cacheRetentionOverrides).toEqual({
        "claude-sonnet": "none",
        "claude-opus-4-6": "short",
        "gpt-4o": "long",
      });
    }
  });

  it("cacheRetentionOverrides is optional (omitting is valid)", () => {
    const result = AgentConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cacheRetentionOverrides).toBeUndefined();
    }
  });

  it("cacheRetentionOverrides rejects invalid retention values", () => {
    const result = AgentConfigSchema.safeParse({
      cacheRetentionOverrides: { "claude-sonnet": "forever" },
    });
    expect(result.success).toBe(false);
  });

  it("adaptiveCacheRetention defaults to true", () => {
    const result = AgentConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.adaptiveCacheRetention).toBe(true);
    }
  });

  it("adaptiveCacheRetention can be set to false", () => {
    const result = AgentConfigSchema.safeParse({ adaptiveCacheRetention: false });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.adaptiveCacheRetention).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// PerAgentConfigSchema
// ---------------------------------------------------------------------------

describe("PerAgentConfigSchema", () => {
  it("produces valid defaults from empty object including nested defaults", () => {
    const result = PerAgentConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      // Inherits AgentConfigSchema defaults
      expect(result.data.name).toBe("Comis");
      expect(result.data.model).toBe("default");
      expect(result.data.provider).toBe("default");

      // PerAgent-specific nested defaults
      expect(result.data.concurrency).toBeDefined();
      expect(result.data.concurrency.maxConcurrentRuns).toBe(4);
      expect(result.data.concurrency.maxQueuedPerSession).toBe(50);
      expect(result.data.broadcastGroups).toEqual([]);
      expect(result.data.elevatedReply).toBeDefined();
      expect(result.data.elevatedReply.enabled).toBe(false);
      expect(result.data.tracing).toBeDefined();
      expect(result.data.tracing.enabled).toBe(false);
      expect(result.data.contextGuard).toBeDefined();
      expect(result.data.contextGuard.enabled).toBe(true);
    }
  });

  it("has optional skills, scheduler, session, secrets, contextPruning, sourceGate", () => {
    const result = PerAgentConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.skills).toBeUndefined();
      expect(result.data.scheduler).toBeUndefined();
      expect(result.data.session).toBeUndefined();
      expect(result.data.secrets).toBeUndefined();
      expect(result.data.contextPruning).toBeUndefined();
      expect(result.data.sourceGate).toBeUndefined();
    }
  });

  it("extends AgentConfigSchema (has all AgentConfig fields)", () => {
    const result = PerAgentConfigSchema.safeParse({
      name: "CustomAgent",
      model: "gpt-4o",
      maxSteps: 10,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("CustomAgent");
      expect(result.data.model).toBe("gpt-4o");
      expect(result.data.maxSteps).toBe(10);
    }
  });

  it("accepts full config with all nested objects populated", () => {
    const result = PerAgentConfigSchema.safeParse({
      name: "FullAgent",
      skills: {
        discoveryPaths: ["./my-skills"],
        watchEnabled: true,
        watchDebounceMs: 500,
      },
      concurrency: { maxConcurrentRuns: 3, maxQueuedPerSession: 100 },
      broadcastGroups: [
        { id: "team", name: "Team", targets: [{ channelType: "telegram", channelId: "tg1", chatId: "123" }] },
      ],
      elevatedReply: { enabled: true, defaultTrustLevel: "admin" },
      tracing: { enabled: true, outputDir: "/var/traces" },
      contextGuard: { enabled: false, warnPercent: 70, blockPercent: 90 },
      contextPruning: { softTrimRatio: 0.2, hardClearRatio: 0.6 },
      sourceGate: { maxResponseBytes: 1_000_000 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.skills?.discoveryPaths).toEqual(["./my-skills"]);
      expect(result.data.concurrency.maxConcurrentRuns).toBe(3);
      expect(result.data.broadcastGroups).toHaveLength(1);
      expect(result.data.elevatedReply.enabled).toBe(true);
      expect(result.data.tracing.outputDir).toBe("/var/traces");
      expect(result.data.contextGuard.warnPercent).toBe(70);
      expect(result.data.contextPruning?.softTrimRatio).toBe(0.2);
      expect(result.data.contextPruning?.hardClearRatio).toBe(0.6);
      expect(result.data.sourceGate?.maxResponseBytes).toBe(1_000_000);
    }
  });

  it("contextPruning as empty object parses to valid defaults", () => {
    const result = PerAgentConfigSchema.safeParse({ contextPruning: {} });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contextPruning).toBeDefined();
      expect(result.data.contextPruning!.enabled).toBe(true);
      expect(result.data.contextPruning!.softTrimRatio).toBe(0.3);
      expect(result.data.contextPruning!.hardClearRatio).toBe(0.5);
      expect(result.data.contextPruning!.keepLastAssistants).toBe(3);
      expect(result.data.contextPruning!.minPrunableToolChars).toBe(4000);
      expect(result.data.contextPruning!.protectedTools).toHaveLength(4);
    }
  });

  it("contextPruning accepts custom values", () => {
    const result = PerAgentConfigSchema.safeParse({
      contextPruning: { softTrimRatio: 0.1, hardClearRatio: 0.4 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contextPruning!.softTrimRatio).toBe(0.1);
      expect(result.data.contextPruning!.hardClearRatio).toBe(0.4);
    }
  });

  it("rejects contextPruning with softTrimRatio >= hardClearRatio", () => {
    const result = PerAgentConfigSchema.safeParse({
      contextPruning: { softTrimRatio: 0.5, hardClearRatio: 0.3 },
    });
    expect(result.success).toBe(false);
  });

  it("sourceGate defaults to undefined when omitted", () => {
    const result = PerAgentConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sourceGate).toBeUndefined();
    }
  });

  it("sourceGate as empty object parses to valid defaults", () => {
    const result = PerAgentConfigSchema.safeParse({ sourceGate: {} });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sourceGate).toBeDefined();
      expect(result.data.sourceGate!.maxResponseBytes).toBe(2_000_000);
      expect(result.data.sourceGate!.stripHiddenHtml).toBe(true);
    }
  });

  it("deferredTools is undefined when omitted (not defaulted)", () => {
    const result = PerAgentConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.deferredTools).toBeUndefined();
    }
  });

  it("deferredTools with explicit config passes validation", () => {
    const result = PerAgentConfigSchema.safeParse({
      deferredTools: { mode: "never", neverDefer: ["tool_a"], alwaysDefer: ["tool_b"] },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.deferredTools).toBeDefined();
      expect(result.data.deferredTools!.mode).toBe("never");
      expect(result.data.deferredTools!.neverDefer).toEqual(["tool_a"]);
      expect(result.data.deferredTools!.alwaysDefer).toEqual(["tool_b"]);
    }
  });
});

// ---------------------------------------------------------------------------
// DeferredToolsConfigSchema
// ---------------------------------------------------------------------------

describe("DeferredToolsConfigSchema", () => {
  it("empty object produces correct defaults", () => {
    const result = DeferredToolsConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mode).toBe("auto");
      expect(result.data.neverDefer).toEqual([]);
      expect(result.data.alwaysDefer).toEqual([]);
    }
  });

  it("explicit values are preserved", () => {
    const result = DeferredToolsConfigSchema.safeParse({
      mode: "never",
      neverDefer: ["tool_a"],
      alwaysDefer: ["tool_b"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mode).toBe("never");
      expect(result.data.neverDefer).toEqual(["tool_a"]);
      expect(result.data.alwaysDefer).toEqual(["tool_b"]);
    }
  });

  it("invalid mode value is rejected", () => {
    const result = DeferredToolsConfigSchema.safeParse({ mode: "invalid" });
    expect(result.success).toBe(false);
  });

  it("extra properties on strictObject are rejected", () => {
    const result = DeferredToolsConfigSchema.safeParse({ extraProp: true });
    expect(result.success).toBe(false);
  });

  it("accepts all valid mode values", () => {
    for (const mode of ["always", "auto", "never"] as const) {
      const result = DeferredToolsConfigSchema.safeParse({ mode });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.mode).toBe(mode);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// RoutingConfigSchema
// ---------------------------------------------------------------------------

describe("RoutingConfigSchema", () => {
  it("produces valid defaults", () => {
    const result = RoutingConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.defaultAgentId).toBe("default");
      expect(result.data.bindings).toEqual([]);
    }
  });

  it("accepts binding with all fields", () => {
    const result = RoutingConfigSchema.safeParse({
      bindings: [{
        channelType: "telegram",
        channelId: "ch1",
        peerId: "user1",
        guildId: "guild1",
        agentId: "agent1",
      }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.bindings).toHaveLength(1);
      expect(result.data.bindings[0].agentId).toBe("agent1");
    }
  });

  it("rejects binding with empty agentId", () => {
    const result = RoutingBindingSchema.safeParse({ agentId: "" });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RagConfigSchema
// ---------------------------------------------------------------------------

describe("RagConfigSchema", () => {
  it("produces valid defaults", () => {
    const result = RagConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
      expect(result.data.maxResults).toBe(5);
      expect(result.data.maxContextChars).toBe(4000);
      expect(result.data.minScore).toBe(0.1);
      expect(result.data.includeTrustLevels).toEqual(["system", "learned"]);
    }
  });

  it("rejects minScore above 1", () => {
    const result = RagConfigSchema.safeParse({ minScore: 1.1 });
    expect(result.success).toBe(false);
  });

  it("rejects minScore below 0", () => {
    const result = RagConfigSchema.safeParse({ minScore: -0.1 });
    expect(result.success).toBe(false);
  });

  it("accepts minScore at boundary values", () => {
    const r0 = RagConfigSchema.safeParse({ minScore: 0 });
    expect(r0.success).toBe(true);
    const r1 = RagConfigSchema.safeParse({ minScore: 1 });
    expect(r1.success).toBe(true);
  });

  it("rejects non-positive maxResults", () => {
    const result = RagConfigSchema.safeParse({ maxResults: 0 });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// BootstrapConfigSchema
// ---------------------------------------------------------------------------

describe("BootstrapConfigSchema", () => {
  it("produces valid defaults", () => {
    const result = BootstrapConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxChars).toBe(20_000);
      expect(result.data.promptMode).toBe("full");
    }
  });

  it("accepts all 3 promptMode values", () => {
    for (const mode of ["full", "minimal", "none"] as const) {
      const result = BootstrapConfigSchema.safeParse({ promptMode: mode });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.promptMode).toBe(mode);
      }
    }
  });

  it("rejects invalid promptMode", () => {
    const result = BootstrapConfigSchema.safeParse({ promptMode: "verbose" });
    expect(result.success).toBe(false);
  });

  it("defaults groupChatFiltering to true", () => {
    const result = BootstrapConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.groupChatFiltering).toBe(true);
    }
  });

  it("accepts explicit groupChatFiltering: false", () => {
    const result = BootstrapConfigSchema.safeParse({ groupChatFiltering: false });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.groupChatFiltering).toBe(false);
    }
  });

  it("accepts explicit groupChatFiltering: true", () => {
    const result = BootstrapConfigSchema.safeParse({ groupChatFiltering: true });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.groupChatFiltering).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// ConcurrencyConfigSchema
// ---------------------------------------------------------------------------

describe("ConcurrencyConfigSchema", () => {
  it("produces valid defaults", () => {
    const result = ConcurrencyConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxConcurrentRuns).toBe(4);
      expect(result.data.maxQueuedPerSession).toBe(50);
    }
  });

  it("rejects non-positive maxConcurrentRuns", () => {
    const result = ConcurrencyConfigSchema.safeParse({ maxConcurrentRuns: 0 });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// BroadcastGroupSchema
// ---------------------------------------------------------------------------

describe("BroadcastGroupSchema", () => {
  it("produces valid defaults for optional fields", () => {
    const result = BroadcastGroupSchema.safeParse({ id: "test" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("");
      expect(result.data.targets).toEqual([]);
      expect(result.data.enabled).toBe(true);
    }
  });

  it("rejects empty id", () => {
    const result = BroadcastGroupSchema.safeParse({ id: "" });
    expect(result.success).toBe(false);
  });

  it("accepts targets with all fields", () => {
    const result = BroadcastGroupSchema.safeParse({
      id: "alerts",
      targets: [{ channelType: "discord", channelId: "ch1", chatId: "123" }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.targets).toHaveLength(1);
    }
  });
});

// ---------------------------------------------------------------------------
// ElevatedReplyConfigSchema
// ---------------------------------------------------------------------------

describe("ElevatedReplyConfigSchema", () => {
  it("produces valid defaults", () => {
    const result = ElevatedReplyConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(false);
      expect(result.data.trustModelRoutes).toEqual({});
      expect(result.data.trustPromptOverrides).toEqual({});
      expect(result.data.defaultTrustLevel).toBe("external");
      expect(result.data.senderTrustMap).toEqual({});
    }
  });
});

// ---------------------------------------------------------------------------
// TracingConfigSchema
// ---------------------------------------------------------------------------

describe("TracingConfigSchema", () => {
  it("produces valid defaults", () => {
    const result = TracingConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(false);
      expect(result.data.outputDir).toBe("~/.comis/traces");
    }
  });
});

// ---------------------------------------------------------------------------
// SdkRetryConfigSchema
// ---------------------------------------------------------------------------

describe("SdkRetryConfigSchema", () => {
  it("produces valid defaults", () => {
    const result = SdkRetryConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
      expect(result.data.maxRetries).toBe(5);
      expect(result.data.baseDelayMs).toBe(4000);
      expect(result.data.maxDelayMs).toBe(60000);
    }
  });

  it("accepts maxRetries=0 (disabled retries)", () => {
    const result = SdkRetryConfigSchema.safeParse({ maxRetries: 0 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxRetries).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// ContextGuardConfigSchema
// ---------------------------------------------------------------------------

describe("ContextGuardConfigSchema", () => {
  it("produces valid defaults", () => {
    const result = ContextGuardConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
      expect(result.data.warnPercent).toBe(80);
      expect(result.data.blockPercent).toBe(95);
    }
  });

  it("rejects warnPercent above 100", () => {
    const result = ContextGuardConfigSchema.safeParse({ warnPercent: 101 });
    expect(result.success).toBe(false);
  });

  it("rejects warnPercent below 0", () => {
    const result = ContextGuardConfigSchema.safeParse({ warnPercent: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects blockPercent above 100", () => {
    const result = ContextGuardConfigSchema.safeParse({ blockPercent: 101 });
    expect(result.success).toBe(false);
  });

  it("accepts boundary values", () => {
    const r0 = ContextGuardConfigSchema.safeParse({ warnPercent: 0, blockPercent: 0 });
    expect(r0.success).toBe(true);
    const r100 = ContextGuardConfigSchema.safeParse({ warnPercent: 100, blockPercent: 100 });
    expect(r100.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AgentsMapSchema
// ---------------------------------------------------------------------------

describe("AgentsMapSchema", () => {
  it("parses a record with string keys to PerAgentConfig values", () => {
    const result = AgentsMapSchema.safeParse({
      default: {},
      assistant: { name: "Assistant", model: "gpt-4o" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.default.name).toBe("Comis");
      expect(result.data.assistant.name).toBe("Assistant");
    }
  });

  it("rejects empty string keys", () => {
    const result = AgentsMapSchema.safeParse({ "": {} });
    expect(result.success).toBe(false);
  });
});
