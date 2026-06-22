// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  IMMUTABLE_CONFIG_PREFIXES,
  MUTABLE_CONFIG_OVERRIDES,
  isImmutableConfigPath,
  matchesOverridePattern,
  getMutableOverridesForSection,
} from "./immutable-keys.js";

describe("IMMUTABLE_CONFIG_PREFIXES", () => {
  it("contains original prefixes: security, gateway.tls, gateway.tokens", () => {
    expect(IMMUTABLE_CONFIG_PREFIXES).toContain("security");
    expect(IMMUTABLE_CONFIG_PREFIXES).toContain("gateway.tls");
    expect(IMMUTABLE_CONFIG_PREFIXES).toContain("gateway.tokens");
  });

  it("contains expanded prefixes: agents, channels, gateway.host, gateway.port, integrations", () => {
    expect(IMMUTABLE_CONFIG_PREFIXES).toContain("agents");
    expect(IMMUTABLE_CONFIG_PREFIXES).toContain("channels");
    expect(IMMUTABLE_CONFIG_PREFIXES).toContain("gateway.host");
    expect(IMMUTABLE_CONFIG_PREFIXES).toContain("gateway.port");
    expect(IMMUTABLE_CONFIG_PREFIXES).toContain("integrations");
  });

  it("contains immutable prefixes: providers, approvals, browser.noSandbox", () => {
    expect(IMMUTABLE_CONFIG_PREFIXES).toContain("providers");
    expect(IMMUTABLE_CONFIG_PREFIXES).toContain("approvals");
    expect(IMMUTABLE_CONFIG_PREFIXES).toContain("browser.noSandbox");
  });

  it("contains immutable prefix: daemon.logging", () => {
    expect(IMMUTABLE_CONFIG_PREFIXES).toContain("daemon.logging");
  });

  it("contains immutable prefix: tooling (capability layer)", () => {
    expect(IMMUTABLE_CONFIG_PREFIXES).toContain("tooling");
  });

  it("has exactly 15 entries", () => {
    expect(IMMUTABLE_CONFIG_PREFIXES).toHaveLength(15);
  });
});

describe("isImmutableConfigPath", () => {
  it("rejects exact prefix match: security", () => {
    expect(isImmutableConfigPath("security")).toBe(true);
  });

  it("rejects child path: security.audit.enabled", () => {
    expect(isImmutableConfigPath("security", "audit.enabled")).toBe(true);
  });

  it("rejects gateway.tls child: gateway tls.certPath", () => {
    expect(isImmutableConfigPath("gateway", "tls.certPath")).toBe(true);
  });

  it("rejects exact gateway.tokens: gateway tokens", () => {
    expect(isImmutableConfigPath("gateway", "tokens")).toBe(true);
  });

  it("rejects gateway.tokens child: gateway tokens.0.name", () => {
    expect(isImmutableConfigPath("gateway", "tokens.0.name")).toBe(true);
  });

  // agents (top-level section is immutable)
  it("rejects exact agents section", () => {
    expect(isImmutableConfigPath("agents")).toBe(true);
  });

  it("allows agents child (model override): agents default.model", () => {
    expect(isImmutableConfigPath("agents", "default.model")).toBe(false);
  });

  it("rejects agents deep child: agents default.budgets.maxDailyUsd", () => {
    expect(isImmutableConfigPath("agents", "default.budgets.maxDailyUsd")).toBe(true);
  });

  it("rejects agents model routes: agents default.modelRoutes.default", () => {
    expect(isImmutableConfigPath("agents", "default.modelRoutes.default")).toBe(true);
  });

  // channels
  it("rejects exact channels section", () => {
    expect(isImmutableConfigPath("channels")).toBe(true);
  });

  it("rejects channels child: channels slack.botToken", () => {
    expect(isImmutableConfigPath("channels", "slack.botToken")).toBe(true);
  });

  it("rejects channels deep child: channels discord.guildId", () => {
    expect(isImmutableConfigPath("channels", "discord.guildId")).toBe(true);
  });

  // gateway.host
  it("rejects gateway.host exact match", () => {
    expect(isImmutableConfigPath("gateway", "host")).toBe(true);
  });

  // gateway.port
  it("rejects gateway.port exact match", () => {
    expect(isImmutableConfigPath("gateway", "port")).toBe(true);
  });

  // integrations
  it("rejects exact integrations section", () => {
    expect(isImmutableConfigPath("integrations")).toBe(true);
  });

  it("rejects integrations child: integrations github.token", () => {
    expect(isImmutableConfigPath("integrations", "github.token")).toBe(true);
  });

  it("rejects integrations deep child: integrations openai.apiKey", () => {
    expect(isImmutableConfigPath("integrations", "openai.apiKey")).toBe(true);
  });

  // providers
  it("rejects exact providers section", () => {
    expect(isImmutableConfigPath("providers")).toBe(true);
  });

  it("rejects providers child: providers entries.anthropic.apiKeyName", () => {
    expect(isImmutableConfigPath("providers", "entries.anthropic.apiKeyName")).toBe(true);
  });

  // approvals
  it("rejects exact approvals section", () => {
    expect(isImmutableConfigPath("approvals")).toBe(true);
  });

  it("rejects approvals child: approvals rules", () => {
    expect(isImmutableConfigPath("approvals", "rules")).toBe(true);
  });

  it("rejects approvals deep child: approvals defaultMode", () => {
    expect(isImmutableConfigPath("approvals", "defaultMode")).toBe(true);
  });

  // browser.noSandbox
  it("rejects browser.noSandbox exact match", () => {
    expect(isImmutableConfigPath("browser", "noSandbox")).toBe(true);
  });

  // daemon.logging
  it("rejects daemon.logging exact match", () => {
    expect(isImmutableConfigPath("daemon", "logging")).toBe(true);
  });

  it("rejects daemon.logging.filePath child", () => {
    expect(isImmutableConfigPath("daemon", "logging.filePath")).toBe(true);
  });

  it("rejects daemon.logging.maxSize child", () => {
    expect(isImmutableConfigPath("daemon", "logging.maxSize")).toBe(true);
  });

  it("rejects daemon.logging.maxFiles child", () => {
    expect(isImmutableConfigPath("daemon", "logging.maxFiles")).toBe(true);
  });

  it("rejects daemon.logging.compress child", () => {
    expect(isImmutableConfigPath("daemon", "logging.compress")).toBe(true);
  });

  it("allows daemon top-level (not immutable)", () => {
    expect(isImmutableConfigPath("daemon")).toBe(false);
  });

  it("allows daemon.watchdogIntervalMs (not logging)", () => {
    expect(isImmutableConfigPath("daemon", "watchdogIntervalMs")).toBe(false);
  });

  it("allows daemon.logLevels (mutable at runtime, not file logging)", () => {
    expect(isImmutableConfigPath("daemon", "logLevels")).toBe(false);
  });

  // Mutable paths (not immutable)
  it("allows browser section (top-level)", () => {
    expect(isImmutableConfigPath("browser")).toBe(false);
  });

  it("allows browser.headless (mutable at runtime)", () => {
    expect(isImmutableConfigPath("browser", "headless")).toBe(false);
  });

  it("allows browser.viewport.width (mutable at runtime)", () => {
    expect(isImmutableConfigPath("browser", "viewport.width")).toBe(false);
  });

  it("allows models section (mutable at runtime)", () => {
    expect(isImmutableConfigPath("models")).toBe(false);
  });

  it("allows models.aliases (mutable at runtime)", () => {
    expect(isImmutableConfigPath("models", "aliases")).toBe(false);
  });

  it("allows messages section (mutable at runtime)", () => {
    expect(isImmutableConfigPath("messages")).toBe(false);
  });

  it("allows messages.splitMaxChars (mutable at runtime)", () => {
    expect(isImmutableConfigPath("messages", "splitMaxChars")).toBe(false);
  });

  // Non-immutable paths
  it("allows scheduler section", () => {
    expect(isImmutableConfigPath("scheduler")).toBe(false);
  });

  it("allows memory section (top-level)", () => {
    expect(isImmutableConfigPath("memory")).toBe(false);
  });

  it("allows memory key: memory maxEntries", () => {
    expect(isImmutableConfigPath("memory", "maxEntries")).toBe(false);
  });

  it("allows gateway non-sensitive key: gateway maxBatchSize", () => {
    expect(isImmutableConfigPath("gateway", "maxBatchSize")).toBe(false);
  });

  it("allows gateway non-sensitive key: gateway rateLimit.maxRequests", () => {
    expect(isImmutableConfigPath("gateway", "rateLimit.maxRequests")).toBe(false);
  });

  // Partial prefix protection
  it("does not match partial prefix: securityExtra", () => {
    expect(isImmutableConfigPath("securityExtra")).toBe(false);
  });

  it("does not match partial prefix with key: securityExtra foo", () => {
    expect(isImmutableConfigPath("securityExtra", "foo")).toBe(false);
  });

  it("does not match partial prefix: channelsExtra", () => {
    expect(isImmutableConfigPath("channelsExtra")).toBe(false);
  });

  it("does not match partial prefix: integrationsExtra", () => {
    expect(isImmutableConfigPath("integrationsExtra")).toBe(false);
  });

  // Mutable overrides: operational agent settings
  it("allows agents.default.skills.watchEnabled (mutable override)", () => {
    expect(isImmutableConfigPath("agents", "default.skills.watchEnabled")).toBe(false);
  });

  it("allows agents.default.skills.watchDebounceMs (mutable override)", () => {
    expect(isImmutableConfigPath("agents", "default.skills.watchDebounceMs")).toBe(false);
  });

  it("allows agents.default.skills.discoveryPaths (mutable override)", () => {
    expect(isImmutableConfigPath("agents", "default.skills.discoveryPaths")).toBe(false);
  });

  it("allows agents.default.maxSteps (mutable override)", () => {
    expect(isImmutableConfigPath("agents", "default.maxSteps")).toBe(false);
  });

  // Bug A regression: persona is no longer a mutable override;
  // it was a dead reference -- PerAgentConfigSchema is z.strictObject and has
  // no `persona` field, so the override entry only leaked a misleading
  // capability hint to LLMs. With the entry removed, the agents immutable
  // prefix wins and these paths are now rejected.
  it("rejects agents.default.persona (dead override removed)", () => {
    expect(isImmutableConfigPath("agents", "default.persona")).toBe(true);
  });

  // Mutable overrides: promptTimeout runtime tuning
  it("allows agents.*.promptTimeout.promptTimeoutMs (mutable override for timeout tuning)", () => {
    expect(isImmutableConfigPath("agents", "default.promptTimeout.promptTimeoutMs")).toBe(false);
  });

  it("allows agents.*.promptTimeout.retryPromptTimeoutMs (mutable override for retry timeout tuning)", () => {
    expect(isImmutableConfigPath("agents", "default.promptTimeout.retryPromptTimeoutMs")).toBe(false);
  });

  // LAT-02 (Phase 177): the makespan-ceiling multiplier joins the promptTimeout
  // runtime-tuning family. matchesOverridePattern entries are per-leaf, so the
  // two sibling entries above do NOT cover the new key -- it needs its own line.
  it("allows agents.*.promptTimeout.stallCeilingMultiplier (mutable override for makespan-ceiling tuning, LAT-02)", () => {
    expect(isImmutableConfigPath("agents", "default.promptTimeout.stallCeilingMultiplier")).toBe(false);
  });

  // Mutable overrides: per-channel media processing toggles
  it("allows channels.telegram.mediaProcessing (mutable override)", () => {
    expect(isImmutableConfigPath("channels", "telegram.mediaProcessing")).toBe(false);
  });

  it("allows channels.telegram.mediaProcessing.describeVideos (child of mutable override)", () => {
    expect(isImmutableConfigPath("channels", "telegram.mediaProcessing.describeVideos")).toBe(false);
  });

  it("allows channels.discord.mediaProcessing.transcribeAudio (mutable override)", () => {
    expect(isImmutableConfigPath("channels", "discord.mediaProcessing.transcribeAudio")).toBe(false);
  });

  // Channel credentials remain immutable despite mediaProcessing override
  it("rejects channels.telegram.botToken (NOT overridden, still immutable)", () => {
    expect(isImmutableConfigPath("channels", "telegram.botToken")).toBe(true);
  });

  // Security-sensitive agent settings remain immutable despite overrides
  it("allows agents.default.model (mutable override for model switching)", () => {
    expect(isImmutableConfigPath("agents", "default.model")).toBe(false);
  });

  it("rejects agents.default.budgets.maxDailyUsd (NOT overridden, still immutable)", () => {
    expect(isImmutableConfigPath("agents", "default.budgets.maxDailyUsd")).toBe(true);
  });

  it("rejects agents.default.toolPolicy (NOT overridden, still immutable)", () => {
    expect(isImmutableConfigPath("agents", "default.toolPolicy")).toBe(true);
  });

  it("rejects agents.default.modelRoutes.default (NOT overridden, still immutable)", () => {
    expect(isImmutableConfigPath("agents", "default.modelRoutes.default")).toBe(true);
  });

  it("allows agents.default.provider (mutable override for provider switching)", () => {
    expect(isImmutableConfigPath("agents", "default.provider")).toBe(false);
  });

  it("allows agents.default.model.sub (child of mutable override)", () => {
    expect(isImmutableConfigPath("agents", "default.model.sub")).toBe(false);
  });

  it("allows agents.mybot.provider (wildcard mutable override)", () => {
    expect(isImmutableConfigPath("agents", "mybot.provider")).toBe(false);
  });

  // Mutable override: MCP server management
  it("allows integrations.mcp.servers (mutable override for MCP management)", () => {
    expect(isImmutableConfigPath("integrations", "mcp.servers")).toBe(false);
  });

  // Other integrations remain immutable
  it("rejects integrations.mcp (parent path still immutable)", () => {
    expect(isImmutableConfigPath("integrations", "mcp")).toBe(true);
  });
});

describe("MUTABLE_CONFIG_OVERRIDES", () => {
  it("contains exactly 12 override patterns", () => {
    // Bug A removed the dead "agents.*.persona" entry (12 -> 11); LAT-02
    // (Phase 177) added agents.*.promptTimeout.stallCeilingMultiplier (11 -> 12).
    expect(MUTABLE_CONFIG_OVERRIDES).toHaveLength(12);
  });

  it("agent/channel patterns use * wildcard for second segment", () => {
    const wildcardPatterns = MUTABLE_CONFIG_OVERRIDES.filter(
      (p) => p.startsWith("agents.") || p.startsWith("channels."),
    );
    for (const pattern of wildcardPatterns) {
      const parts = pattern.split(".");
      expect(parts[1]).toBe("*");
    }
  });
});

describe("matchesOverridePattern", () => {
  // Note: tests use agents.*.maxSteps as the wildcard fixture (a real entry in
  // MUTABLE_CONFIG_OVERRIDES). The function is generic; the pattern choice is
  // illustrative only. (Previously these tests used agents.*.persona; that
  // entry was removed in Bug A.)
  it("matches exact path to pattern", () => {
    expect(matchesOverridePattern("agents.default.maxSteps", "agents.*.maxSteps")).toBe(true);
  });

  it("rejects path shorter than pattern", () => {
    expect(matchesOverridePattern("agents.default", "agents.*.maxSteps")).toBe(false);
  });

  it("rejects path with wrong literal segment", () => {
    expect(matchesOverridePattern("agents.default.model", "agents.*.maxSteps")).toBe(false);
  });

  it("wildcard matches any single segment", () => {
    expect(matchesOverridePattern("agents.mybot.maxSteps", "agents.*.maxSteps")).toBe(true);
    expect(matchesOverridePattern("agents.production-bot.maxSteps", "agents.*.maxSteps")).toBe(true);
  });

  it("rejects path missing intermediate segment", () => {
    expect(matchesOverridePattern("agents.maxSteps", "agents.*.maxSteps")).toBe(false);
  });
});

describe("getMutableOverridesForSection", () => {
  it("returns concrete patchable paths for agents section with key", () => {
    const paths = getMutableOverridesForSection("agents", "default");
    expect(paths).toEqual([
      "agents.default.skills.watchEnabled",
      "agents.default.skills.watchDebounceMs",
      "agents.default.skills.discoveryPaths",
      "agents.default.maxSteps",
      "agents.default.promptTimeout.promptTimeoutMs",
      "agents.default.promptTimeout.retryPromptTimeoutMs",
      "agents.default.promptTimeout.stallCeilingMultiplier",
      "agents.default.operationModels",
      "agents.default.model",
      "agents.default.provider",
    ]);
  });

  it("returns concrete patchable paths for channels section with key", () => {
    const paths = getMutableOverridesForSection("channels", "telegram");
    expect(paths).toEqual(["channels.telegram.mediaProcessing"]);
  });

  it("returns empty array for section with no mutable overrides", () => {
    const paths = getMutableOverridesForSection("security");
    expect(paths).toEqual([]);
  });

  it("returns empty array for non-immutable section", () => {
    const paths = getMutableOverridesForSection("memory");
    expect(paths).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Bug A regression: dead "agents.*.persona" override removed.
// PerAgentConfigSchema is z.strictObject and has no `persona` field, so the
// override entry could never produce a successful patch -- it only leaked a
// misleading capability hint to LLMs (formatRedirectHint emitted "you can
// also patch agents.<id>.persona") which the LLM echoed back as
// `persona:` in agents_manage.create config, triggering Zod
// unrecognized_keys rejection (18 fleet-creation failures in production).
// ---------------------------------------------------------------------------
describe("MUTABLE_CONFIG_OVERRIDES (regression: persona removed)", () => {
  it("does NOT contain the dead 'agents.*.persona' override", () => {
    expect(MUTABLE_CONFIG_OVERRIDES).not.toContain("agents.*.persona");
  });

  it("getMutableOverridesForSection('agents', <id>) yields no persona-bearing path", () => {
    const paths = getMutableOverridesForSection("agents", "ta-fundamentals");
    for (const p of paths) {
      expect(p).not.toMatch(/persona/);
    }
  });
});

// ---------------------------------------------------------------------------
// Tooling root prefix is operator-only.
// Three-path test: root + known child + future-child (forward-compat).
// Plus invariant: no MUTABLE_CONFIG_OVERRIDES shadows tooling.*.
// ---------------------------------------------------------------------------
describe("isImmutableConfigPath -- tooling root prefix", () => {
  it("rejects exact tooling section (root write)", () => {
    expect(isImmutableConfigPath("tooling")).toBe(true);
  });

  it("rejects known child: tooling.capabilityClusters.clusters", () => {
    expect(isImmutableConfigPath("tooling", "capabilityClusters.clusters")).toBe(true);
  });

  it("rejects known child: tooling.mcp.capabilityHints.finance-data.cluster", () => {
    expect(
      isImmutableConfigPath("tooling", "mcp.capabilityHints.finance-data.cluster"),
    ).toBe(true);
  });

  it("rejects known child: tooling.skills.capabilityHints.foo.replacesPackages", () => {
    expect(
      isImmutableConfigPath("tooling", "skills.capabilityHints.foo.replacesPackages"),
    ).toBe(true);
  });

  it("rejects known child: tooling.installDetours.mode", () => {
    expect(isImmutableConfigPath("tooling", "installDetours.mode")).toBe(true);
  });

  it("rejects known child: tooling.capabilityIndex.enabled", () => {
    expect(isImmutableConfigPath("tooling", "capabilityIndex.enabled")).toBe(true);
  });

  it("rejects future sibling key (forward-compatibility): tooling.futureSiblingKey", () => {
    expect(isImmutableConfigPath("tooling", "futureSiblingKey")).toBe(true);
  });

  it("rejects deep future child: tooling.fooBarBaz.nested.deep", () => {
    expect(isImmutableConfigPath("tooling", "fooBarBaz.nested.deep")).toBe(true);
  });

  it("no MUTABLE_CONFIG_OVERRIDES shadows tooling.*", () => {
    const overrides = MUTABLE_CONFIG_OVERRIDES.filter(
      (p) => p.startsWith("tooling.") || p === "tooling",
    );
    expect(overrides).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// D16 §8.1: executor section is OPERATOR-ONLY — broker anti-exfiltration
// guard. An LLM-driven agent MUST NOT be able to self-configure
// executor.broker.bindings to route credentials to an attacker-controlled host.
// "executor" as a top-level prefix catches all three write paths:
//   1. config.patch keyed write  — isImmutableConfigPath("executor", "broker.bindings")
//   2. config.patch whole-section — isImmutableConfigPath("executor", undefined)
//   3. config.apply section       — isImmutableConfigPath("executor")
// ---------------------------------------------------------------------------
describe("executor section is operator-only (broker anti-exfiltration guard)", () => {
  it("isImmutableConfigPath rejects keyed config.patch on executor.broker.bindings", () => {
    expect(isImmutableConfigPath("executor", "broker.bindings")).toBe(true);
  });

  it("isImmutableConfigPath rejects whole-section config.patch on executor", () => {
    expect(isImmutableConfigPath("executor", undefined)).toBe(true);
  });

  it("isImmutableConfigPath rejects config.apply on executor section", () => {
    expect(isImmutableConfigPath("executor")).toBe(true);
  });

  it("isImmutableConfigPath allows broker top-level section (not executor)", () => {
    expect(isImmutableConfigPath("broker")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SECURITY: contextEngine.version is OPERATOR-ONLY (immutable to the
// agent config.patch RPC). The pipeline<->dag switch is applied by an OPERATOR
// config RELOAD (re-runs setupSingleAgent), NEVER by the agent's own
// config.patch, which MUST reject. This locks the anti-self-escalation posture:
// an agent cannot self-switch into DAG to widen its own ctx_* tool exposure
// (the §8.1 force-include would otherwise be self-exploitable).
//
// These are REGRESSION / BOUNDARY LOCKS (AGENTS.md §2.10): the boundary already
// holds, so they are GREEN on arrival. They FAIL only if a future change
// WEAKENS it — e.g. adding `agents.*.contextEngine.version` to
// MUTABLE_CONFIG_OVERRIDES (override-wins would then make it agent-mutable).
// Verified negative control: with that entry added, the not-in-overrides
// asserts below flip to red — proving these are real locks, not no-ops.
// DO NOT add contextEngine.version to MUTABLE_CONFIG_OVERRIDES.
// ---------------------------------------------------------------------------
describe("contextEngine.version is operator-only (immutable to config.patch)", () => {
  it("rejects agents.default.contextEngine.version (config.patch must NOT switch engine mode)", () => {
    expect(isImmutableConfigPath("agents", "default.contextEngine.version")).toBe(true);
  });

  it("rejects an arbitrary agentId: agents.trader-1.contextEngine.version (fail-closed under 'agents')", () => {
    expect(isImmutableConfigPath("agents", "trader-1.contextEngine.version")).toBe(true);
  });

  it("rejects the full-path form: agents.default.contextEngine.version", () => {
    expect(isImmutableConfigPath("agents.default.contextEngine.version")).toBe(true);
  });

  it("rejects the parent path too: agents.default.contextEngine", () => {
    expect(isImmutableConfigPath("agents", "default.contextEngine")).toBe(true);
  });

  it("MUTABLE_CONFIG_OVERRIDES does NOT contain agents.*.contextEngine.version (operator-only boundary locked)", () => {
    expect(MUTABLE_CONFIG_OVERRIDES).not.toContain("agents.*.contextEngine.version");
  });

  it("no MUTABLE_CONFIG_OVERRIDES entry mentions contextEngine (anti-self-escalation lock)", () => {
    expect(MUTABLE_CONFIG_OVERRIDES.some((p) => p.includes("contextEngine"))).toBe(false);
  });

  it("getMutableOverridesForSection('agents', <id>) yields no contextEngine-bearing path", () => {
    const paths = getMutableOverridesForSection("agents", "trader-1");
    for (const p of paths) {
      expect(p).not.toMatch(/contextEngine/);
    }
  });
});

// ---------------------------------------------------------------------------
// D-09 / SC#4: proxy section is operator-only — agents must not self-configure
// egress routing. A single "proxy" prefix covers all subpaths via the existing
// prefix-match logic in isImmutableConfigPath.
// ---------------------------------------------------------------------------
describe("isImmutableConfigPath — proxy section (D-09, SC#4)", () => {
  it("rejects proxy section top-level write", () => {
    expect(isImmutableConfigPath("proxy")).toBe(true);
  });

  it("rejects proxy.enabled (agent must not toggle proxy on/off)", () => {
    expect(isImmutableConfigPath("proxy", "enabled")).toBe(true);
  });

  it("rejects proxy.proxyUrl (agent must not redirect egress)", () => {
    expect(isImmutableConfigPath("proxy", "proxyUrl")).toBe(true);
  });

  it("rejects proxy.tls.caFile (agent must not substitute CA bundle)", () => {
    expect(isImmutableConfigPath("proxy", "tls.caFile")).toBe(true);
  });

  it("rejects proxy.loopbackMode (agent must not alter loopback policy)", () => {
    expect(isImmutableConfigPath("proxy", "loopbackMode")).toBe(true);
  });
});
