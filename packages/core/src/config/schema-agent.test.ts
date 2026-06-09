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
} from "./schema-agent/index.js";

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

  // -------------------------------------------------------------------------
  // thinking.downshiftOnTightWindow (Fix 3 / Phase 166 CWF-02)
  // -------------------------------------------------------------------------

  describe("thinking.downshiftOnTightWindow", () => {
    it("defaults thinking.downshiftOnTightWindow to true when thinking is omitted", () => {
      const result = AgentConfigSchema.parse({});
      // CWF-02: thinking-effort governor defaults to enabled.
      expect(result.thinking.downshiftOnTightWindow).toBe(true);
    });

    it("thinking defaults to { downshiftOnTightWindow: true } when omitted entirely", () => {
      const result = AgentConfigSchema.parse({});
      expect(result.thinking).toEqual({ downshiftOnTightWindow: true });
    });

    it("accepts explicit downshiftOnTightWindow: false (operator opt-out)", () => {
      const result = AgentConfigSchema.parse({ thinking: { downshiftOnTightWindow: false } });
      expect(result.thinking.downshiftOnTightWindow).toBe(false);
    });

    it("accepts explicit downshiftOnTightWindow: true", () => {
      const result = AgentConfigSchema.parse({ thinking: { downshiftOnTightWindow: true } });
      expect(result.thinking.downshiftOnTightWindow).toBe(true);
    });

    it("rejects unknown keys inside thinking (strictObject enforcement)", () => {
      const result = AgentConfigSchema.safeParse({
        thinking: { downshiftOnTightWindow: true, unknownField: "bad" },
      });
      expect(result.success).toBe(false);
    });

    it("rejects non-boolean downshiftOnTightWindow", () => {
      const result = AgentConfigSchema.safeParse({ thinking: { downshiftOnTightWindow: "yes" } });
      expect(result.success).toBe(false);
    });
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
// PerAgentConfigSchema oauthProfiles
// ---------------------------------------------------------------------------

describe("PerAgentConfigSchema oauthProfiles", () => {
  it("accepts a valid single-entry record", () => {
    const result = PerAgentConfigSchema.safeParse({
      oauthProfiles: { "openai-codex": "openai-codex:user_a@example.com" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.oauthProfiles).toEqual({
        "openai-codex": "openai-codex:user_a@example.com",
      });
    }
  });

  it("accepts a multi-provider record", () => {
    const result = PerAgentConfigSchema.safeParse({
      oauthProfiles: {
        "openai-codex": "openai-codex:user_a@example.com",
        "anthropic": "anthropic:user_b@example.com",
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.keys(result.data.oauthProfiles!)).toHaveLength(2);
      expect(result.data.oauthProfiles!["openai-codex"]).toBe(
        "openai-codex:user_a@example.com",
      );
      expect(result.data.oauthProfiles!["anthropic"]).toBe(
        "anthropic:user_b@example.com",
      );
    }
  });

  it("rejects a malformed profile-ID (no colon)", () => {
    const result = PerAgentConfigSchema.safeParse({
      oauthProfiles: { "openai-codex": "no-colon" },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = JSON.stringify(result.error.issues);
      expect(message).toMatch(/Invalid profile ID/);
      expect(message).toMatch(/validateProfileId/);
      // Path includes oauthProfiles + the failing key
      expect(result.error.issues.some((i) => i.path.includes("oauthProfiles"))).toBe(true);
      expect(result.error.issues.some((i) => i.path.includes("openai-codex"))).toBe(true);
    }
  });

  it("rejects a profile-ID with forbidden characters (slash)", () => {
    const result = PerAgentConfigSchema.safeParse({
      oauthProfiles: { "openai-codex": "openai-codex:bad/path" },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toMatch(/Invalid profile ID/);
    }
  });

  it("rejects an empty profile-ID value", () => {
    const result = PerAgentConfigSchema.safeParse({
      oauthProfiles: { "openai-codex": "" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty provider key", () => {
    const result = PerAgentConfigSchema.safeParse({
      oauthProfiles: { "": "openai-codex:user_a@example.com" },
    });
    expect(result.success).toBe(false);
  });

  it("treats oauthProfiles as optional (undefined accepted)", () => {
    const result = PerAgentConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.oauthProfiles).toBeUndefined();
    }
  });

  it("accepts an empty record (no entries set)", () => {
    const result = PerAgentConfigSchema.safeParse({
      oauthProfiles: {},
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.oauthProfiles).toEqual({});
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
// RagConfigSchema.rerank (cross-encoder reranking, default-OFF)
// ---------------------------------------------------------------------------

describe("RagConfigSchema.rerank", () => {
  it("defaults reranking ON (opt-out posture) with the candidate cap, timeout, and minResults", () => {
    // Opt-out posture supersedes the earlier default-OFF decision:
    // rerank is a $0-at-recall capability, default-ON at the schema level. The daemon's
    // EFFECTIVE-rerank precedence (raw pre-Zod signal + model-present) still governs the
    // auto-on/download path, so a bare config does NOT force a 606MB download.
    const result = RagConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rerank.enabled).toBe(true);
      expect(result.data.rerank.maxCandidates).toBe(40);
      expect(result.data.rerank.minResults).toBe(1);
      expect(result.data.rerank.timeoutMs).toBe(800);
    }
  });

  it("leaves the existing RagConfig defaults untouched when rerank/scoring are added", () => {
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

  it("rejects a negative maxCandidates (positive-int bound)", () => {
    const result = RagConfigSchema.safeParse({ rerank: { maxCandidates: -1 } });
    expect(result.success).toBe(false);
  });

  it("rejects a non-integer maxCandidates", () => {
    const result = RagConfigSchema.safeParse({ rerank: { maxCandidates: 1.5 } });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown key inside rerank (strictObject)", () => {
    const result = RagConfigSchema.safeParse({ rerank: { unknownKey: 1 } });
    expect(result.success).toBe(false);
  });

  it("accepts a partial rerank override and fills the rest from defaults", () => {
    const result = RagConfigSchema.safeParse({ rerank: { enabled: true } });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rerank.enabled).toBe(true);
      expect(result.data.rerank.maxCandidates).toBe(40);
      expect(result.data.rerank.timeoutMs).toBe(800);
      expect(result.data.rerank.minResults).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// RagConfigSchema.scoring (recency/temporal/proof/trust boosts, 0..1 alphas)
// ---------------------------------------------------------------------------

describe("RagConfigSchema.scoring", () => {
  it("defaults the four scoring alphas to small in-range weights", () => {
    const result = RagConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scoring.recencyAlpha).toBe(0.2);
      expect(result.data.scoring.temporalAlpha).toBe(0.2);
      expect(result.data.scoring.proofAlpha).toBe(0.1);
      expect(result.data.scoring.trustAlpha).toBe(0.1);
    }
  });

  it("defaults the SINGLE canonical usefulnessAlpha to 0.1 next to the other alphas", () => {
    // The recall-utility feedback loop reads `rag.scoring.usefulnessAlpha` — the ONE
    // magnitude knob, alongside recency/temporal/proof/trust. `rag.feedback` carries only
    // the on/off toggle (no duplicate alpha — the single-knob invariant).
    const result = RagConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scoring.usefulnessAlpha).toBe(0.1);
    }
  });

  it("defaults the FadeMem decay weight forgetAlpha to 0.1 next to the other alphas", () => {
    // The FadeMem decay magnitude knob — the SINGLE canonical `rag.scoring.forgetAlpha`,
    // alongside the other alphas (NOT a knob on `rag.forget`, which carries only the on/off
    // toggle — the single-knob invariant). Bounded small (same magnitude as trust/proof) so a
    // stale memory's decay RANKS but cannot overturn trust-first (Pitfall 2). Neutral (factor
    // 1.0) whenever forget is OFF or at event-age 0.
    const result = RagConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scoring.forgetAlpha).toBe(0.1);
    }
  });

  it("rejects a forgetAlpha above 1 (out of [0,1])", () => {
    const result = RagConfigSchema.safeParse({ scoring: { forgetAlpha: 1.5 } });
    expect(result.success).toBe(false);
  });

  it("rejects a negative forgetAlpha (out of [0,1])", () => {
    const result = RagConfigSchema.safeParse({ scoring: { forgetAlpha: -0.1 } });
    expect(result.success).toBe(false);
  });

  it("rejects a usefulnessAlpha above 1 (out of [0,1])", () => {
    const result = RagConfigSchema.safeParse({ scoring: { usefulnessAlpha: 1.5 } });
    expect(result.success).toBe(false);
  });

  it("rejects a negative usefulnessAlpha (out of [0,1])", () => {
    const result = RagConfigSchema.safeParse({ scoring: { usefulnessAlpha: -0.1 } });
    expect(result.success).toBe(false);
  });

  it("rejects an alpha above 1 (recencyAlpha out of [0,1])", () => {
    const result = RagConfigSchema.safeParse({ scoring: { recencyAlpha: 1.5 } });
    expect(result.success).toBe(false);
  });

  it("rejects a negative alpha (trustAlpha out of [0,1])", () => {
    const result = RagConfigSchema.safeParse({ scoring: { trustAlpha: -0.1 } });
    expect(result.success).toBe(false);
  });

  it("accepts alphas at the 0 and 1 boundaries", () => {
    const lo = RagConfigSchema.safeParse({
      scoring: { recencyAlpha: 0, temporalAlpha: 0, proofAlpha: 0, trustAlpha: 0 },
    });
    expect(lo.success).toBe(true);
    const hi = RagConfigSchema.safeParse({
      scoring: { recencyAlpha: 1, temporalAlpha: 1, proofAlpha: 1, trustAlpha: 1 },
    });
    expect(hi.success).toBe(true);
  });

  it("rejects an unknown key inside scoring (strictObject)", () => {
    const result = RagConfigSchema.safeParse({ scoring: { bogusAlpha: 0.5 } });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RagConfigSchema.lanes (per-lane RRF weights, the PARITY
// guard — fts 1.0 / vector 1.5 reproduce today's hardcoded hybrid-search weights)
// ---------------------------------------------------------------------------

describe("RagConfigSchema.lanes", () => {
  it("defaults the per-lane weights to the PARITY guard {fts:1.0, vector:1.5}", () => {
    // These are the EXACT weights hybrid-search.ts hardcoded (computeRRF 1.0/1.5),
    // so default-weight fusion reproduces today's ranking byte-for-byte.
    const result = RagConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.lanes.fts.weight).toBe(1.0);
      expect(result.data.lanes.vector.weight).toBe(1.5);
    }
  });

  it("accepts operator-tuned weights (the lanes are tunable)", () => {
    const result = RagConfigSchema.safeParse({ lanes: { fts: { weight: 0.5 }, vector: { weight: 3.0 } } });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.lanes.fts.weight).toBe(0.5);
      expect(result.data.lanes.vector.weight).toBe(3.0);
    }
  });

  it("rejects a negative fts weight (z.number().min(0) — a negative term could invert RRF)", () => {
    const result = RagConfigSchema.safeParse({ lanes: { fts: { weight: -0.1 } } });
    expect(result.success).toBe(false);
  });

  it("rejects a negative vector weight (z.number().min(0))", () => {
    const result = RagConfigSchema.safeParse({ lanes: { vector: { weight: -1 } } });
    expect(result.success).toBe(false);
  });

  it("accepts a zero weight at the boundary (min(0) inclusive)", () => {
    const result = RagConfigSchema.safeParse({ lanes: { fts: { weight: 0 }, vector: { weight: 0 } } });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown key inside lanes (strictObject)", () => {
    // `temporal` is now a VALID sub-lane — use a genuinely-unknown key.
    const result = RagConfigSchema.safeParse({ lanes: { bogusLane: { weight: 1 } } });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown key inside a single lane (strictObject)", () => {
    const result = RagConfigSchema.safeParse({ lanes: { fts: { weight: 1, bogus: 2 } } });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RagConfigSchema.lanes.temporal (the temporal-spread lane,
// opt-in / default-OFF — mirrors rag.entityLane; default windowDays:7)
// ---------------------------------------------------------------------------

describe("RagConfigSchema.lanes.temporal", () => {
  it("defaults the temporal lane ON (opt-out posture) with weight 1.0 / windowDays 7", () => {
    // Opt-out posture: the temporal-spread lane is $0 at recall, default-ON.
    // It is neutral (the fused lanes are unchanged) whenever no top hit carries an occurred_at
    // seed (the no-seed gate), so the byte-identity-when-no-event-data property still holds.
    const result = RagConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.lanes.temporal.enabled).toBe(true);
      expect(result.data.lanes.temporal.weight).toBe(1.0);
      expect(result.data.lanes.temporal.windowDays).toBe(7);
    }
  });

  it("accepts an explicit temporal opt-in (enabled:true + tuned weight + windowDays)", () => {
    const result = RagConfigSchema.safeParse({
      lanes: { temporal: { enabled: true, weight: 2.0, windowDays: 30 } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.lanes.temporal.enabled).toBe(true);
      expect(result.data.lanes.temporal.weight).toBe(2.0);
      expect(result.data.lanes.temporal.windowDays).toBe(30);
    }
  });

  it("rejects a negative temporal weight (z.number().min(0) — no negative RRF term)", () => {
    const result = RagConfigSchema.safeParse({ lanes: { temporal: { weight: -0.1 } } });
    expect(result.success).toBe(false);
  });

  it("rejects a zero / negative windowDays (z.number().int().positive() — no empty window)", () => {
    expect(RagConfigSchema.safeParse({ lanes: { temporal: { windowDays: 0 } } }).success).toBe(false);
    expect(RagConfigSchema.safeParse({ lanes: { temporal: { windowDays: -7 } } }).success).toBe(false);
  });

  it("rejects a non-integer windowDays (z.number().int())", () => {
    const result = RagConfigSchema.safeParse({ lanes: { temporal: { windowDays: 7.5 } } });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown key inside temporal (strictObject)", () => {
    const result = RagConfigSchema.safeParse({ lanes: { temporal: { bogus: 1 } } });
    expect(result.success).toBe(false);
  });

  it("accepts a zero temporal weight at the boundary (min(0) inclusive — the lane contributes nothing)", () => {
    const result = RagConfigSchema.safeParse({ lanes: { temporal: { weight: 0 } } });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// RagConfigSchema.lanes.causal (the causal one-hop recall
// lane, opt-in / default-OFF — the exact temporal-lane sibling; no windowDays)
// ---------------------------------------------------------------------------

describe("RagConfigSchema.lanes.causal", () => {
  it("defaults the causal lane ON (opt-out posture) with weight 1.0", () => {
    // Opt-out posture: the causal one-hop lane is $0 at recall, default-ON.
    // It is neutral (the fused lanes are unchanged) whenever no causal edges exist (the empty-lane
    // no-op), so the byte-identity-when-no-causal-data property still holds.
    const result = RagConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.lanes.causal.enabled).toBe(true);
      expect(result.data.lanes.causal.weight).toBe(1.0);
    }
  });

  it("accepts an explicit causal opt-in (enabled:true + tuned weight)", () => {
    const result = RagConfigSchema.safeParse({
      lanes: { causal: { enabled: true, weight: 2.0 } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.lanes.causal.enabled).toBe(true);
      expect(result.data.lanes.causal.weight).toBe(2.0);
    }
  });

  it("rejects a negative causal weight (z.number().min(0) — no negative RRF term)", () => {
    const result = RagConfigSchema.safeParse({ lanes: { causal: { weight: -1 } } });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown key inside causal (strictObject)", () => {
    const result = RagConfigSchema.safeParse({ lanes: { causal: { bogus: 1 } } });
    expect(result.success).toBe(false);
  });

  it("accepts a zero causal weight at the boundary (min(0) inclusive — the lane contributes nothing)", () => {
    const result = RagConfigSchema.safeParse({ lanes: { causal: { weight: 0 } } });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// RagConfigSchema.lanes.graphSpread (the recursive-CTE graph-
// spread recall lane, opt-in / default-OFF — the temporal/causal-lane sibling,
// plus maxDepth + fanOut caps for the bounded walk)
// ---------------------------------------------------------------------------

describe("RagConfigSchema.lanes.graphSpread", () => {
  it("defaults the graph-spread lane ON (opt-out posture) with weight 1.0 / maxDepth 2 / fanOut 8", () => {
    // Opt-out posture: the bounded recursive-CTE graph-spread lane is $0 at
    // recall, default-ON. It is neutral (the fused lanes are unchanged) whenever the triple store
    // has no connected edges (the empty-lane no-op), so the byte-identity-when-no-graph property
    // still holds. The walk caps (maxDepth 2 / fanOut 8) keep it O(bounded) on-device.
    const result = RagConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.lanes.graphSpread.enabled).toBe(true);
      expect(result.data.lanes.graphSpread.weight).toBe(1.0);
      expect(result.data.lanes.graphSpread.maxDepth).toBe(2);
      expect(result.data.lanes.graphSpread.fanOut).toBe(8);
    }
  });

  it("accepts an explicit graph-spread opt-in (enabled:true + tuned weight/maxDepth/fanOut)", () => {
    const result = RagConfigSchema.safeParse({
      lanes: { graphSpread: { enabled: true, weight: 2.0, maxDepth: 3, fanOut: 12 } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.lanes.graphSpread.enabled).toBe(true);
      expect(result.data.lanes.graphSpread.weight).toBe(2.0);
      expect(result.data.lanes.graphSpread.maxDepth).toBe(3);
      expect(result.data.lanes.graphSpread.fanOut).toBe(12);
    }
  });

  it("rejects a negative graph-spread weight (z.number().min(0) — no negative RRF term)", () => {
    const result = RagConfigSchema.safeParse({ lanes: { graphSpread: { weight: -1 } } });
    expect(result.success).toBe(false);
  });

  it("rejects a zero / negative maxDepth (z.number().int().positive() — no empty walk)", () => {
    expect(RagConfigSchema.safeParse({ lanes: { graphSpread: { maxDepth: 0 } } }).success).toBe(false);
    expect(RagConfigSchema.safeParse({ lanes: { graphSpread: { maxDepth: -2 } } }).success).toBe(false);
  });

  it("rejects a zero / negative fanOut (z.number().int().positive() — the fan-out cap must bound expansion)", () => {
    expect(RagConfigSchema.safeParse({ lanes: { graphSpread: { fanOut: 0 } } }).success).toBe(false);
    expect(RagConfigSchema.safeParse({ lanes: { graphSpread: { fanOut: -8 } } }).success).toBe(false);
  });

  it("rejects a non-integer maxDepth / fanOut (z.number().int())", () => {
    expect(RagConfigSchema.safeParse({ lanes: { graphSpread: { maxDepth: 2.5 } } }).success).toBe(false);
    expect(RagConfigSchema.safeParse({ lanes: { graphSpread: { fanOut: 8.5 } } }).success).toBe(false);
  });

  it("rejects an unknown key inside graphSpread (strictObject)", () => {
    const result = RagConfigSchema.safeParse({ lanes: { graphSpread: { bogus: 1 } } });
    expect(result.success).toBe(false);
  });

  it("accepts a zero graph-spread weight at the boundary (min(0) inclusive — the lane contributes nothing)", () => {
    const result = RagConfigSchema.safeParse({ lanes: { graphSpread: { weight: 0 } } });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// RagConfigSchema.feedback (recall-utility feedback loop,
// opt-in / default-OFF — mirrors rag.entityLane)
// ---------------------------------------------------------------------------

describe("RagConfigSchema.feedback", () => {
  it("defaults the feedback loop ON (opt-out posture)", () => {
    // Opt-out posture: the recall-utility feedback loop is $0 at recall
    // (the usefulness read + write-back are on-device, no API budget), default-ON. The folded
    // usefulnessFactor is neutral (1.0) whenever no usefulness signal has been recorded yet.
    const result = RagConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.feedback.enabled).toBe(true);
    }
  });

  it("exposes ONLY the enabled toggle — no usefulnessAlpha on feedback (single-knob invariant)", () => {
    // The magnitude knob lives at rag.scoring.usefulnessAlpha (the value score.ts reads),
    // NOT here. `feedback` is the on/off switch only — a stray alpha must not silently
    // shadow the canonical one. `.strictObject` enforces this structurally.
    const result = RagConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.keys(result.data.feedback)).toEqual(["enabled"]);
      expect(
        (result.data.feedback as { usefulnessAlpha?: number }).usefulnessAlpha,
      ).toBeUndefined();
    }
  });

  it("rejects a stray usefulnessAlpha inside feedback (strictObject enforces single-knob)", () => {
    // An operator who mistakenly adds feedback.usefulnessAlpha gets a parse error, not a
    // silent no-op — the single canonical knob is rag.scoring.usefulnessAlpha.
    const result = RagConfigSchema.safeParse({ feedback: { enabled: true, usefulnessAlpha: 0.5 } });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown key inside feedback (strictObject)", () => {
    const result = RagConfigSchema.safeParse({ feedback: { bogusKey: 1 } });
    expect(result.success).toBe(false);
  });

  it("accepts an explicit feedback.enabled: true (the opt-in path)", () => {
    const result = RagConfigSchema.safeParse({ feedback: { enabled: true } });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.feedback.enabled).toBe(true);
      // Even opted-in, feedback still carries no alpha (the knob stays on scoring).
      expect(
        (result.data.feedback as { usefulnessAlpha?: number }).usefulnessAlpha,
      ).toBeUndefined();
    }
  });

  it("is additive — every pre-existing RagConfig knob default is unchanged when feedback is added (opt-out flips the $0 enabled toggles ON; tuning constants frozen)", () => {
    // Snapshot the existing defaults (rerank/scoring/entityLane + the top-level fields) so a
    // regression on any of them trips here, not silently downstream (the schema-cascade class).
    // The $0-at-recall `enabled` toggles flip ON (opt-out posture); every
    // tuning CONSTANT (caps/weights/alphas) stays exactly as shipped — the FROZEN values.
    const result = RagConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      // Top-level defaults.
      expect(result.data.enabled).toBe(true);
      expect(result.data.maxResults).toBe(5);
      expect(result.data.maxContextChars).toBe(4000);
      expect(result.data.minScore).toBe(0.1);
      expect(result.data.includeTrustLevels).toEqual(["system", "learned"]);
      // rerank sub-object (opt-out: enabled ON; caps/timeout frozen).
      expect(result.data.rerank.enabled).toBe(true);
      expect(result.data.rerank.maxCandidates).toBe(40);
      expect(result.data.rerank.minResults).toBe(1);
      expect(result.data.rerank.timeoutMs).toBe(800);
      // scoring sub-object (the five canonical alphas — FROZEN, incl. trustAlpha).
      expect(result.data.scoring.recencyAlpha).toBe(0.2);
      expect(result.data.scoring.temporalAlpha).toBe(0.2);
      expect(result.data.scoring.proofAlpha).toBe(0.1);
      expect(result.data.scoring.trustAlpha).toBe(0.1);
      expect(result.data.scoring.usefulnessAlpha).toBe(0.1);
      // entityLane sub-object (opt-out: enabled ON; seedCount/cap/weight frozen).
      expect(result.data.entityLane.enabled).toBe(true);
      expect(result.data.entityLane.seedCount).toBe(5);
      expect(result.data.entityLane.perEntityCap).toBe(200);
      expect(result.data.entityLane.weight).toBe(1.0);
      // lanes sub-object (parity weights FROZEN; temporal +
      // graphSpread enabled flipped ON by the opt-out posture).
      expect(result.data.lanes.fts.weight).toBe(1.0);
      expect(result.data.lanes.vector.weight).toBe(1.5);
      expect(result.data.lanes.temporal.enabled).toBe(true);
      expect(result.data.lanes.temporal.weight).toBe(1.0);
      expect(result.data.lanes.temporal.windowDays).toBe(7);
      expect(result.data.lanes.graphSpread.enabled).toBe(true);
      expect(result.data.lanes.graphSpread.weight).toBe(1.0);
      expect(result.data.lanes.graphSpread.maxDepth).toBe(2);
      expect(result.data.lanes.graphSpread.fanOut).toBe(8);
    }
  });
});

// ---------------------------------------------------------------------------
// RagConfigSchema.mmr (MMR diversity re-rank, opt-in /
// default-OFF; λ bounded [0,1] — 1.0 = pure relevance = byte-identical order)
// ---------------------------------------------------------------------------

describe("RagConfigSchema.mmr", () => {
  it("defaults the MMR re-rank ON (opt-out posture) with lambda 0.7", () => {
    // Opt-out posture: MMR diversity re-rank is $0 at recall (an on-device
    // embedding read + greedy re-rank, no API budget), default-ON. λ=1.0 would be pure relevance
    // (byte-identical); the default λ=0.7 trades a small relevance margin for diversity.
    const result = RagConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mmr.enabled).toBe(true);
      expect(result.data.mmr.lambda).toBe(0.7);
    }
  });

  it("accepts an explicit MMR opt-in (enabled:true + tuned lambda)", () => {
    const result = RagConfigSchema.safeParse({ mmr: { enabled: true, lambda: 0.4 } });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mmr.enabled).toBe(true);
      expect(result.data.mmr.lambda).toBe(0.4);
    }
  });

  it("rejects a lambda above 1 (z.number().min(0).max(1) — an out-of-range λ inverts the rel/diversity balance)", () => {
    const result = RagConfigSchema.safeParse({ mmr: { lambda: 1.1 } });
    expect(result.success).toBe(false);
  });

  it("rejects a negative lambda (z.number().min(0).max(1))", () => {
    const result = RagConfigSchema.safeParse({ mmr: { lambda: -0.1 } });
    expect(result.success).toBe(false);
  });

  it("accepts lambda at the 0 and 1 boundaries (min/max inclusive — 1.0 = pure relevance = identity)", () => {
    expect(RagConfigSchema.safeParse({ mmr: { lambda: 0 } }).success).toBe(true);
    expect(RagConfigSchema.safeParse({ mmr: { lambda: 1 } }).success).toBe(true);
  });

  it("rejects an unknown key inside mmr (strictObject)", () => {
    const result = RagConfigSchema.safeParse({ mmr: { enabled: false, lambda: 0.7, foo: 1 } });
    expect(result.success).toBe(false);
  });

  it("accepts a partial mmr override and fills the rest from defaults", () => {
    const result = RagConfigSchema.safeParse({ mmr: { enabled: true } });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mmr.enabled).toBe(true);
      expect(result.data.mmr.lambda).toBe(0.7);
    }
  });
});

// ---------------------------------------------------------------------------
// RagConfigSchema.forget (the recall-side gate for the
// FadeMem per-type decay factor, default-OFF; OFF ⇒ forgetFactor exactly 1.0,
// byte-identical recall; the neutral-importance byte-identity holds even when ON)
// ---------------------------------------------------------------------------

describe("RagConfigSchema.forget", () => {
  it("defaults the FadeMem decay gate ON (opt-out posture)", () => {
    // Opt-out posture: the FadeMem decay gate is $0 at recall (a pure
    // closed-form decay over event age, no API budget), default-ON. The neutral-importance
    // byte-identity holds even when ON: at event-age 0 the factor is exactly 1.0, so a fresh /
    // neutral row never silently shifts.
    const result = RagConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.forget.enabled).toBe(true);
    }
  });

  it("accepts an explicit forget opt-in (enabled:true)", () => {
    const result = RagConfigSchema.safeParse({ forget: { enabled: true } });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.forget.enabled).toBe(true);
    }
  });

  it("rejects an unknown key inside forget (strictObject — the single-knob invariant; a smuggled forgetAlpha is REJECTED here)", () => {
    // forget carries ONLY the on/off toggle. The magnitude lives at rag.scoring.forgetAlpha
    // (one canonical knob, no drift) — a stray field on `rag.forget` is rejected at parse.
    const result = RagConfigSchema.safeParse({ forget: { enabled: false, forgetAlpha: 0.5 } });
    expect(result.success).toBe(false);
  });

  it("rejects a non-boolean enabled (z.boolean())", () => {
    const result = RagConfigSchema.safeParse({ forget: { enabled: "yes" } });
    expect(result.success).toBe(false);
  });

  it("parses an existing config that omits forget and fills it ON (opt-out additive guard)", () => {
    // The top-level `.default()` fills `forget` when absent. The opt-out
    // posture defaults the $0 decay gate ON (neutral at event-age 0). The pre-existing tuning
    // constants below stay frozen — the schema-cascade regression guard.
    const result = RagConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.forget.enabled).toBe(true);
      // and the pre-existing alphas are unchanged (the schema-cascade regression guard); mmr is
      // likewise a $0 capability flipped ON by the opt-out posture.
      expect(result.data.scoring.recencyAlpha).toBe(0.2);
      expect(result.data.mmr.enabled).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// RagConfigSchema.queryUnderstanding (LLM-free query
// understanding toggles, all opt-in / default-OFF — byte-identical when off)
// ---------------------------------------------------------------------------

describe("RagConfigSchema.queryUnderstanding", () => {
  it("defaults all query-understanding toggles ON (opt-out posture)", () => {
    // Opt-out posture: each toggle is a $0-at-recall DETERMINISTIC,
    // LLM-FREE capability (no LLM call on the recall hot path), default-ON. intentReweight,
    // synonyms, and temporalParse all flip ON together under the opt-out posture.
    const result = RagConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.queryUnderstanding.intentReweight).toBe(true);
      expect(result.data.queryUnderstanding.synonyms).toBe(true);
      expect(result.data.queryUnderstanding.temporalParse).toBe(true);
    }
  });

  it("accepts an explicit query-understanding opt-in (each toggle independently)", () => {
    const result = RagConfigSchema.safeParse({
      queryUnderstanding: { intentReweight: true, synonyms: true, temporalParse: true },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.queryUnderstanding.intentReweight).toBe(true);
      expect(result.data.queryUnderstanding.synonyms).toBe(true);
      expect(result.data.queryUnderstanding.temporalParse).toBe(true);
    }
  });

  it("accepts a partial queryUnderstanding override and fills the rest from the (ON) defaults", () => {
    // An explicit per-toggle override wins; the unspecified toggles fill from the opt-out
    // ON defaults. Here temporalParse is force-OFF while intentReweight + synonyms fill ON.
    const result = RagConfigSchema.safeParse({ queryUnderstanding: { temporalParse: false } });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.queryUnderstanding.intentReweight).toBe(true);
      expect(result.data.queryUnderstanding.synonyms).toBe(true);
      expect(result.data.queryUnderstanding.temporalParse).toBe(false);
    }
  });

  it("rejects an unknown key inside queryUnderstanding (strictObject)", () => {
    const result = RagConfigSchema.safeParse({ queryUnderstanding: { bogusToggle: true } });
    expect(result.success).toBe(false);
  });

  it("rejects a non-boolean toggle (z.boolean())", () => {
    const result = RagConfigSchema.safeParse({ queryUnderstanding: { synonyms: "yes" } });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RagConfigSchema additive guard: an existing config that
// OMITS the new mmr + queryUnderstanding knobs still parses, and every
// pre-existing default is unchanged (the schema-cascade regression guard).
// ---------------------------------------------------------------------------

describe("RagConfigSchema additive (mmr + queryUnderstanding)", () => {
  it("parses an existing config that omits mmr + queryUnderstanding and fills them ON (opt-out)", () => {
    // The top-level `.default()` on each sub-object fills them when absent. The
    // opt-out posture defaults these $0 capabilities ON; the lambda tuning constant stays frozen.
    const result = RagConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mmr.enabled).toBe(true);
      expect(result.data.mmr.lambda).toBe(0.7);
      expect(result.data.queryUnderstanding.intentReweight).toBe(true);
      expect(result.data.queryUnderstanding.synonyms).toBe(true);
      expect(result.data.queryUnderstanding.temporalParse).toBe(true);
    }
  });

  it("is additive — every pre-existing RagConfig default is unchanged when mmr + queryUnderstanding are added", () => {
    // Snapshot the existing defaults so a regression on any of them trips here, not silently
    // downstream (the schema-cascade class — the memoryReasoning precedent).
    const result = RagConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      // Top-level defaults.
      expect(result.data.enabled).toBe(true);
      expect(result.data.maxResults).toBe(5);
      expect(result.data.maxContextChars).toBe(4000);
      expect(result.data.minScore).toBe(0.1);
      expect(result.data.includeTrustLevels).toEqual(["system", "learned"]);
      // rerank + scoring + entityLane + feedback sub-objects: $0 enabled toggles flipped ON by
      // the opt-out posture; the usefulnessAlpha tuning constant frozen.
      expect(result.data.rerank.enabled).toBe(true);
      expect(result.data.scoring.usefulnessAlpha).toBe(0.1);
      expect(result.data.entityLane.enabled).toBe(true);
      expect(result.data.feedback.enabled).toBe(true);
      // lanes sub-object (parity weights frozen; temporal/causal/graphSpread enabled ON).
      expect(result.data.lanes.fts.weight).toBe(1.0);
      expect(result.data.lanes.vector.weight).toBe(1.5);
      expect(result.data.lanes.temporal.enabled).toBe(true);
      expect(result.data.lanes.causal.enabled).toBe(true);
      expect(result.data.lanes.graphSpread.enabled).toBe(true);
    }
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

  it("rejects a provider entry with an empty id at schema parse", () => {
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
