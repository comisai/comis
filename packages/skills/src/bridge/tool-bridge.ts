// SPDX-License-Identifier: Apache-2.0
/**
 * Tool bridge: Collects built-in tools and assembles the two-tier tool pipeline.
 *
 * This is the integration layer between the skill system and the agent executor.
 * It provides built-in tools and platform tools to the agent.
 *
 * Key functions:
 * - getBuiltinTools: Collects enabled built-in tools from config
 * - assembleToolPipeline: Two-tier tool pipeline with policy and audit
 *
 * @module
 */

import { registerAllToolMetadata } from "./tool-metadata-registry.js";
registerAllToolMetadata();

import type { SecretManager } from "@comis/core";
import type { SkillsConfig } from "@comis/core";
import type { TypedEventBus } from "@comis/core";
import type { WrapExternalContentOptions } from "@comis/core";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { applyToolPolicy } from "../policy/tool-policy.js";
import { wrapWithAudit } from "./tool-audit.js";
import { wrapWithMetadataEnforcement } from "./tool-metadata-enforcement.js";
import { wrapWithCredentialInjection } from "./credential-injector.js";
import type { CredentialInjector } from "./credential-injector.js";
import { createComisFileTools } from "../builtin/file/file-tools.js";
import type { FileStateTracker } from "../builtin/file/file-state-tracker.js";
import type { LazyPaths } from "../builtin/file/safe-path-wrapper.js";
import { createWebFetchTool } from "../builtin/web-fetch-tool.js";
import { createWebSearchTool } from "../builtin/web-search-tool.js";
import { resolveSourceProfile, type ToolSourceProfile } from "../builtin/tool-source-profiles.js";

// ---------------------------------------------------------------------------
// Built-in tool collection
// ---------------------------------------------------------------------------

/** Minimal pino-compatible logger interface for tool bridge logging. */
interface ToolBridgeLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Collect enabled built-in tools based on config toggles.
 *
 * @param config - Skills configuration with builtinTools toggles
 * @param workspacePath - Workspace root path for file/bash operations
 * @param secretManager - Optional secret manager for API keys
 * @returns Array of enabled AgentTool instances
 */
export function getBuiltinTools(
  config: SkillsConfig,
  workspacePath: string,
  secretManager?: SecretManager,
  logger?: ToolBridgeLogger,
  onSuspiciousContent?: WrapExternalContentOptions["onSuspiciousContent"],
  readOnlyPaths?: string[],
  /** Per-agent source profile overrides from config. */
  toolSourceProfiles?: Record<string, Partial<ToolSourceProfile>>,
  /** Shared read+write paths for graph pipeline nodes. */
  sharedPaths?: LazyPaths,
  /** Optional per-session FileStateTracker for file safety guards. */
  fileStateTracker?: FileStateTracker,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentTool generic requires `any` per pi-agent-core API
): AgentTool<any>[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentTool generic requires `any` per pi-agent-core API
  const tools: AgentTool<any>[] = [];

  // Resolve source profiles for web tools
  const fetchProfile = resolveSourceProfile("web_fetch", toolSourceProfiles?.web_fetch);
  const searchProfile = resolveSourceProfile("web_search", toolSourceProfiles?.web_search);

  // Web Search -- pass resolved profile values
  if (config.builtinTools.webSearch) {
    tools.push(createWebSearchTool({
      apiKey: secretManager?.get("SEARCH_API_KEY"),
      perplexity: { apiKey: secretManager?.get("PERPLEXITY_API_KEY") },
      tavily: { apiKey: secretManager?.get("TAVILY_API_KEY") },
      exa: { apiKey: secretManager?.get("EXA_API_KEY") },
      jina: { apiKey: secretManager?.get("JINA_API_KEY") },
      grok: { apiKey: secretManager?.get("XAI_API_KEY") },
      totalCharsBudget: searchProfile.maxChars,
      onSuspiciousContent,
    }));
  }

  // Web Fetch -- pass resolved profile values
  if (config.builtinTools.webFetch) {
    tools.push(createWebFetchTool({
      maxCharsCap: fetchProfile.maxChars,
      maxResponseBytes: fetchProfile.maxResponseBytes,
      onSuspiciousContent,
    }));
  }

  // File tools (Comis-native)
  const fileTools = createComisFileTools(config, workspacePath, logger, readOnlyPaths, sharedPaths, fileStateTracker);
  tools.push(...fileTools);

  return tools;
}

// ---------------------------------------------------------------------------
// Platform tool provider type
// ---------------------------------------------------------------------------

/** Platform tools are injected by the caller (agent executor, daemon). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentTool generic requires `any` per pi-agent-core API
export type PlatformToolProvider = () => AgentTool<any>[];

// ---------------------------------------------------------------------------
// Two-tier tool pipeline
// ---------------------------------------------------------------------------

/**
 * Dependencies for the two-tier tool assembly pipeline.
 */
export interface ToolPipelineDeps {
  /** Skills configuration with toolPolicy and builtinTools. */
  config: SkillsConfig;
  /** Workspace root path for builtin tools. */
  workspacePath: string;
  /** Secret manager for API keys. */
  secretManager?: SecretManager;
  /** Platform tool providers (injected by caller). */
  platformTools?: PlatformToolProvider;
  /** Event bus for audit wrapper. */
  eventBus?: TypedEventBus;
  /** Optional structured logger for pipeline assembly. */
  logger?: ToolBridgeLogger;
  /** Optional agent ID for audit event attribution. */
  agentId?: string;
  /** Optional credential injector for transparent API key injection. */
  credentialInjector?: CredentialInjector;
  /** Optional callback for suspicious content detection in external content. */
  onSuspiciousContent?: WrapExternalContentOptions["onSuspiciousContent"];
  /** Optional read-only paths that read-only file tools (read/ls/grep/find) may access. */
  readOnlyPaths?: string[];
  /** Per-agent source profile overrides from config. */
  toolSourceProfiles?: Record<string, Partial<ToolSourceProfile>>;
  /** Shared read+write paths for graph pipeline nodes. */
  sharedPaths?: LazyPaths;
  /** Optional per-session FileStateTracker for file safety guards. */
  fileStateTracker?: FileStateTracker;
}

/**
 * Assemble the two-tier tool pipeline with policy filtering and audit wrapping.
 *
 * Pipeline stages:
 * 1. **Tier 1 - Builtin**: Enabled built-in tools from config toggles
 * 2. **Tier 2 - Platform**: Tools injected by the caller (channel adapters, daemon)
 * 3. **Policy filter**: Config-driven tool policy (profile + allow/deny)
 * 4. **Credential injection**: Transparent HTTP credential injection for matching URLs
 * 5. **Metadata enforcement**: Pre-flight validation and per-tool result size caps
 * 6. **Audit wrap**: Event emission for each tool invocation
 *
 * @param deps - Pipeline dependencies
 * @returns Filtered and instrumented array of AgentTools
 */
export async function assembleToolPipeline(
  deps: ToolPipelineDeps,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentTool generic requires `any` per pi-agent-core API
): Promise<AgentTool<any>[]> {
  // Tier 1 - Builtin
  const builtinTools = getBuiltinTools(deps.config, deps.workspacePath, deps.secretManager, deps.logger, deps.onSuspiciousContent, deps.readOnlyPaths, deps.toolSourceProfiles, deps.sharedPaths, deps.fileStateTracker);

  // Tier 2 - Platform
  const platformTools = deps.platformTools ? deps.platformTools() : [];

  // Combine all tiers
  let tools = [...builtinTools, ...platformTools];

  // Policy filter
  if (deps.config.toolPolicy) {
    const policyResult = applyToolPolicy(tools, deps.config.toolPolicy);
    tools = policyResult.tools;

    // Log denied tools at DEBUG level (internal step per CLAUDE.md logging rules)
    if (policyResult.filtered.length > 0 && deps.logger) {
      deps.logger.debug(
        {
          agentId: deps.agentId,
          profile: deps.config.toolPolicy.profile,
          filteredCount: policyResult.filtered.length,
          filtered: policyResult.filtered.map((f) => ({
            tool: f.toolName,
            reason: f.reason.kind,
            ...(f.reason.kind === "explicit_deny" && { denyEntry: f.reason.denyEntry }),
            ...(f.reason.kind === "not_in_profile" && { profile: f.reason.profile }),
          })),
        },
        "Tool policy filtered tools",
      );
    }

    // Emit audit event if eventBus available
    if (policyResult.filtered.length > 0 && deps.eventBus) {
      deps.eventBus.emit("tool:policy_filtered", {
        profile: deps.config.toolPolicy.profile,
        agentId: deps.agentId,
        filtered: policyResult.filtered.map((f) => ({
          toolName: f.toolName,
          reason: f.reason.kind === "explicit_deny"
            ? `explicit_deny:${f.reason.denyEntry}`
            : `not_in_profile:${f.reason.profile}`,
        })),
        timestamp: Date.now(),
      });
    }
  }

  // Credential injection -- after policy filter, before audit wrap
  if (deps.credentialInjector) {
    tools = tools.map((tool) =>
      wrapWithCredentialInjection(tool, deps.credentialInjector!),
    );
  }

  // Metadata enforcement -- ALWAYS runs (not gated by eventBus)
  // Handles pre-flight validation and per-tool result size caps.
  tools = tools.map((tool) => wrapWithMetadataEnforcement(tool));

  // Audit wrap
  if (deps.eventBus) {
    tools = tools.map((tool) => wrapWithAudit(tool, deps.eventBus!, deps.agentId));
  }

  return tools;
}
