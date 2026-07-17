// SPDX-License-Identifier: Apache-2.0
/**
 * Gateway admin-scope + auth-gate helpers.
 *
 * Hosts the pure trust-level derivation, the redacted execution-requested
 * log-field builder, and the `/config` chat command handler (with its
 * admin-only trust gate). Plus the optional GreetingGenerator construction
 * that the gateway uses to produce LLM-powered /new and /reset greetings.
 *
 * @module
 */

import { readFileSync } from "node:fs";
import { emitObservationalEventSafely, fingerprint, formatSessionKey, safePath, systemDateFrom } from "@comis/core";
import type { AppConfig, AppContainer, ComisLogger, SessionKey } from "@comis/core";
import type { RpcCall } from "@comis/skills/platform-tools";
import { createGreetingGenerator, type GreetingGenerator, type GreetingTrigger, type CostTracker } from "@comis/agent";
import { createCommandHandler, type CommandHandlerDeps } from "@comis/orchestrator";
import { suppressError } from "@comis/shared";

// ===========================================================================
// Execution-request log redaction helper
// ===========================================================================

/**
 * Build the structured log fields for the gateway "Agent execution requested"
 * INFO line. Replaces the previous behavior of logging the first 200 chars
 * of the raw user message (no message bodies in logs at any level). Emits
 * message length plus a short SHA-256 prefix
 * for correlation, never the body itself.
 *
 * @param input.agentId       Resolved agent ID (already trust-derived).
 * @param input.message       Raw user message (may be empty / undefined).
 * @param input.connectionId  Optional WebSocket connection ID.
 * @returns Object suitable for `logger.info(obj, "Agent execution requested")`.
 */
export function buildExecutionRequestedLogFields(input: {
  agentId: string;
  message: string | undefined;
  connectionId: string | undefined;
}): {
  agentId: string;
  messageLen: number;
  messageHash?: string;
  connectionId?: string;
} {
  const raw = input.message ?? "";
  const fields: {
    agentId: string;
    messageLen: number;
    messageHash?: string;
    connectionId?: string;
  } = {
    agentId: input.agentId,
    messageLen: raw.length,
  };
  if (raw.length > 0) {
    fields.messageHash = fingerprint(raw);
  }
  if (input.connectionId !== undefined) {
    fields.connectionId = input.connectionId;
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Trust level derivation
// ---------------------------------------------------------------------------

/**
 * Derive user trust level from token scopes.
 * Admin scope or wildcard grants admin trust. All others default to user
 * (fail-closed). This matches the checkScope wildcard behavior in token-auth.ts.
 */
export function deriveTrustLevel(scopes: readonly string[] | undefined): "admin" | "user" {
  if (scopes?.includes("admin") || scopes?.includes("*")) return "admin";
  return "user";
}

/**
 * Resolve the agent id for an execute request. An ABSENT agentId defaults to
 * `defaultAgentId` (intended); an explicit but UNKNOWN agentId is an ERROR, not a
 * silent fallback.
 *
 * Falling back on an explicit unknown agent id could silently route a request to
 * a paid default provider. The thrown error is `clientFacing` so the gateway
 * surfaces its message verbatim instead of the generic "Internal error" reserved
 * for provider and internal faults.
 */
export function resolveExecAgentId(
  agents: Record<string, unknown>,
  rawAgentId: string | undefined,
  defaultAgentId: string,
): string {
  if (rawAgentId !== undefined && !agents[rawAgentId]) {
    throw Object.assign(
      new Error(`unknown agent: ${rawAgentId} (available: ${Object.keys(agents).join(", ")})`),
      { clientFacing: true },
    );
  }
  return rawAgentId ?? defaultAgentId;
}

// ---------------------------------------------------------------------------
// /config chat command handler
// ---------------------------------------------------------------------------

/**
 * Handle /config chat command via RPC dispatch.
 * Supports: show [section], set <path> <value>, history
 */
export async function handleConfigChatCommand(
  args: string[],
  rpcCall: RpcCall,
  scopes?: readonly string[],
): Promise<{ handled: boolean; response?: string }> {
  const subcommand = args[0] ?? "show";

  try {
    // Trust gate: config read operations require admin trust
    if (subcommand === "show" || subcommand === "history") {
      const trustLevel = deriveTrustLevel(scopes);
      if (trustLevel !== "admin") {
        return {
          handled: true,
          response: "Config read requires admin trust. Your token does not have admin scope.",
        };
      }
    }

    if (subcommand === "show") {
      const section = args[1];
      const result = await rpcCall("config.read", { section }) as Record<string, unknown>;
      if (section) {
        // Format single section as key: value pairs
        const lines = [`**Config: ${section}**`, ""];
        for (const [key, value] of Object.entries(result)) {
          const display = typeof value === "object" ? JSON.stringify(value) : String(value);
          lines.push(`${key}: ${display}`);
        }
        return { handled: true, response: lines.join("\n") };
      }
      // Full config: list sections with key counts
      const config = result.config as Record<string, unknown>;
      const sections = result.sections as string[];
      const lines = ["**Config Sections**", ""];
      for (const sec of sections) {
        const sectionData = config[sec];
        const keyCount = sectionData && typeof sectionData === "object" ? Object.keys(sectionData).length : 0;
        lines.push(`${sec} (${keyCount} keys)`);
      }
      return { handled: true, response: lines.join("\n") };
    }

    if (subcommand === "set") {
      // Trust gate: only admin trust can modify config
      const trustLevel = deriveTrustLevel(scopes);
      if (trustLevel !== "admin") {
        return { handled: true, response: "Config modification requires admin trust. Your token does not have admin scope." };
      }

      const path = args[1];
      const rawValue = args.slice(2).join(" ");
      if (!path || !rawValue) {
        return { handled: true, response: "Usage: /config set <section.key> <value>" };
      }
      const dotIdx = path.indexOf(".");
      if (dotIdx === -1) {
        return { handled: true, response: "Path must include section.key (e.g., agent.budget.maxTokens)" };
      }
      const section = path.slice(0, dotIdx);
      const key = path.slice(dotIdx + 1);
      let value: unknown;
      try { value = JSON.parse(rawValue); } catch { value = rawValue; }

      const patchResult = await rpcCall("config.patch", { section, key, value, _trustLevel: trustLevel }) as Record<string, unknown>;
      if (patchResult.patched) {
        return { handled: true, response: `Config updated: ${path} = ${JSON.stringify(value)}. Daemon is restarting.` };
      }
      return { handled: true, response: "Config update failed" };
    }

    if (subcommand === "history") {
      const result = await rpcCall("config.history", { limit: 5 }) as { entries: Array<{ sha: string; timestamp: string; message: string }>; error?: string };
      if (result.error) {
        return { handled: true, response: result.error };
      }
      if (!result.entries || result.entries.length === 0) {
        return { handled: true, response: "No config history found" };
      }
      const lines = ["**Config History**", ""];
      for (const entry of result.entries) {
        const sha = entry.sha.slice(0, 7);
        const date = systemDateFrom(entry.timestamp).toLocaleString();
        lines.push(`${sha} | ${date} | ${entry.message}`);
      }
      return { handled: true, response: lines.join("\n") };
    }

    return { handled: true, response: `Unknown config subcommand: ${subcommand}. Available: show, set, history` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { handled: true, response: `Config command failed: ${msg}` };
  }
}

// ---------------------------------------------------------------------------
// Greeting generator construction (admin-scoped LLM call for /new + /reset)
// ---------------------------------------------------------------------------

/**
 * Create the GreetingGenerator that the gateway uses to produce LLM-powered
 * greetings for session reset commands (/new, /reset). Returns undefined when
 * the default agent's provider has no API key (greeting falls back to static
 * "Session reset." in handleSlashCommand).
 */
export function buildGreetingGenerator(input: {
  agents: AppConfig["agents"];
  defaultAgentId: string;
  container: AppContainer;
}): GreetingGenerator | undefined {
  const { agents, defaultAgentId, container } = input;
  const defaultConfig = agents[defaultAgentId];
  if (!defaultConfig) return undefined;
  const greetingApiKey = container.secretManager.get(`${defaultConfig.provider.toUpperCase()}_API_KEY`) ?? "";
  if (!greetingApiKey) return undefined;
  return createGreetingGenerator({
    provider: defaultConfig.provider,
    modelId: defaultConfig.model,
    apiKey: greetingApiKey,
    timeoutMs: 5000,
  });
}

/**
 * Detect the greeting variant from wiring-tier state — NOT
 * from a `core/bootstrap.ts` hook. Pure: reads only
 * non-secret agent-config presence + an interactivity flag, never `process.env`
 * and never a secret (the API-key gate stays in {@link buildGreetingGenerator}).
 *
 * - `onboarding-limited`: a non-interactive/headless surface that cannot onboard.
 * - `onboarding-pending`: the agent record is incomplete (provider or model is
 *   missing), i.e. setup is unfinished.
 * - `standard`: a fully-configured agent on an interactive surface (the default).
 *
 * NOTE on the apiKey overlap: when the provider has no API key,
 * {@link buildGreetingGenerator} returns `undefined` and the LLM greeting never
 * fires (static fallback), so this helper only runs for a configured provider.
 */
export function detectGreetingTrigger(input: {
  agentConfig: AppConfig["agents"][string] | undefined;
  interactive: boolean;
}): GreetingTrigger {
  if (!input.interactive) return "onboarding-limited";
  const hasProvider = typeof input.agentConfig?.provider === "string" && input.agentConfig.provider.length > 0;
  const hasModel = typeof input.agentConfig?.model === "string" && input.agentConfig.model.length > 0;
  if (!hasProvider || !hasModel) return "onboarding-pending";
  return "standard";
}

// ---------------------------------------------------------------------------
// CommandHandlerDeps builder for the gateway handleSlashCommand adapter
// ---------------------------------------------------------------------------

/**
 * Inputs required to build the CommandHandlerDeps for the gateway slash
 * command handler (parity-matched to the pre-split adapter at
 * setup-gateway.ts:773-864).
 */
export interface SlashCommandDepsInput {
  execAgentId: string;
  defaultAgentId: string;
  execAgentConfig: AppConfig["agents"][string] | undefined;
  container: AppContainer;
  costTrackers: Map<string, CostTracker>;
  workspaceDirs: Map<string, string>;
  logger: ComisLogger;
  piSessionAdapters?: Map<string, {
    destroySession(key: SessionKey): Promise<void>;
    getSessionStats(key: SessionKey): {
      messageCount: number;
      createdAt?: number;
      tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
      cost?: number;
      userMessages?: number;
      assistantMessages?: number;
      toolCalls?: number;
      toolResults?: number;
    } | undefined;
  }>;
  /** Complete three-layer conversation forget (LCD + sessionStore + runtime)
   *  from createConversationReset. Live finding 2026-06-11: /new + /reset
   *  destroyed only the runtime session, so in DAG mode the LCD context items
   *  survived and the model saw the old conversation right back. When present,
   *  destroySession severs ALL layers; absent ⇒ legacy runtime-only destroy. */
  destroyConversation?: (agentId: string, key: SessionKey) => Promise<unknown>;
}

/**
 * Build CommandHandlerDeps for the gateway slash command path. Extracted
 * to keep the rpc leaf under its size cap while preserving the full
 * per-command behavior contract.
 */
export function buildSlashCommandDeps(input: SlashCommandDepsInput): CommandHandlerDeps {
  const { execAgentId, defaultAgentId, execAgentConfig, container, costTrackers, workspaceDirs, piSessionAdapters, destroyConversation, logger } = input;
  return {
    getSessionInfo: (key) => {
      const adapter = piSessionAdapters?.get(execAgentId);
      if (adapter) {
        const stats = adapter.getSessionStats(key);
        return {
          messageCount: stats?.messageCount ?? 0,
          createdAt: stats?.createdAt,
          tokensUsed: stats?.tokens,
        };
      }
      return { messageCount: 0 };
    },
    getAgentConfig: () => ({
      name: execAgentConfig?.name ?? "Unknown",
      model: execAgentConfig?.model ?? "unknown",
      provider: execAgentConfig?.provider ?? "unknown",
      maxSteps: execAgentConfig?.maxSteps ?? 10,
    }),
    destroySession: (key) => {
      // Complete three-layer forget when wired (live finding 2026-06-11:
      // runtime-only destroy left LCD context items the DAG re-presented).
      if (destroyConversation) {
        suppressError(destroyConversation(execAgentId, key), "fire-and-forget conversation destroy");
        emitObservationalEventSafely({ eventBus: container.eventBus, logger }, "session:expired", { sessionKey: key, reason: "gateway-reset" });
        return;
      }
      const adapter = piSessionAdapters?.get(execAgentId);
      if (adapter) {
        suppressError(adapter.destroySession(key), "fire-and-forget session destroy");
        emitObservationalEventSafely({ eventBus: container.eventBus, logger }, "session:expired", { sessionKey: key, reason: "gateway-reset" });
        return;
      }
    },
    getAvailableModels: () => [],
    getUsageBreakdown: () => {
      const tracker = costTrackers.get(execAgentId) ?? costTrackers.get(defaultAgentId);
      return tracker?.getByProvider() ?? [];
    },
    getSessionCost: (key) => {
      const tracker = costTrackers.get(execAgentId) ?? costTrackers.get(defaultAgentId);
      return tracker?.getBySession(formatSessionKey(key)) ?? { totalTokens: 0, totalCost: 0 };
    },
    getBootstrapInfo: () => {
      const wsDir = workspaceDirs.get(execAgentId);
      if (!wsDir) return [];
      const NAMES = ["SOUL.md", "IDENTITY.md", "USER.md", "AGENTS.md", "TOOLS.md", "HEARTBEAT.md", "BOOTSTRAP.md"];
      const results: Array<{ name: string; sizeChars: number }> = [];
      for (const name of NAMES) {
        try {
          const filePath = safePath(wsDir, name);
          results.push({ name, sizeChars: readFileSync(filePath, "utf-8").length });
        } catch { /* file missing, skip */ }
      }
      return results;
    },
    // Tool schemas assembled async; /context shows "Tool schemas: Not available".
    getToolInfo: () => [],
    getSDKSessionStats: (key) => {
      const adapter = piSessionAdapters?.get(execAgentId);
      if (!adapter) return undefined;
      const stats = adapter.getSessionStats(key);
      if (!stats) return undefined;
      return {
        userMessages: stats.userMessages ?? 0,
        assistantMessages: stats.assistantMessages ?? 0,
        toolCalls: stats.toolCalls ?? 0,
        toolResults: stats.toolResults ?? 0,
        totalMessages: stats.messageCount,
        tokens: {
          input: stats.tokens?.input ?? 0,
          output: stats.tokens?.output ?? 0,
          cacheRead: stats.tokens?.cacheRead ?? 0,
          cacheWrite: stats.tokens?.cacheWrite ?? 0,
          total: stats.tokens?.total ?? 0,
        },
        cost: stats.cost ?? 0,
      };
    },
    // Context usage requires a live AgentSession (only present during execution);
    // /status shows "N/A" between executions. PiEventBridge context guard tracks
    // live usage during execution.
    getContextUsage: (_key) => undefined,
    // Budget config stores token limits, not dollar amounts. Returns undefined
    // until cost-per-token rate wiring lands.
    getBudgetInfo: () => undefined,
  };
}

// Re-export CommandHandler factory so the rpc leaf consumes a single import.
export { createCommandHandler };
