// SPDX-License-Identifier: Apache-2.0
/**
 * Agent domain types.
 *
 * Interfaces for agent configuration, detail views, billing,
 * and enriched agent info used in the agent list grid.
 */

/** Agent configuration returned by daemon */
export interface AgentInfo {
  readonly id: string;
  readonly name?: string;
  readonly provider: string;
  readonly model: string;
  readonly status: string;
  readonly messagesToday?: number;
  readonly tokenUsageToday?: number;
}

/** Full agent configuration (from agents.get RPC) */
export interface AgentDetail extends AgentInfo {
  readonly maxSteps?: number;
  readonly temperature?: number;
  readonly thinkingLevel?: string;
  readonly maxTokens?: number;
  readonly cacheRetention?: "none" | "short" | "long";
  readonly maxContextChars?: number;
  readonly budgets?: {
    readonly perExecution?: number;
    readonly perHour?: number;
    readonly perDay?: number;
  };
  readonly circuitBreaker?: {
    readonly state: "closed" | "open" | "half-open";
    readonly failures: number;
    readonly threshold?: number;
    readonly resetTimeoutMs?: number;
  };
  readonly safety?: {
    readonly contextGuard?: { enabled: boolean; warnPct: number; blockPct: number };
    readonly sdkRetry?: { enabled: boolean; maxRetries: number; baseDelayMs: number };
    readonly modelFailover?: { fallbackCount: number };
  };
  readonly routingBindings?: ReadonlyArray<{ pattern: string; agentId: string }>;
  readonly rag?: { enabled: boolean; maxResults?: number; maxContextChars?: number; minScore?: number; trustLevels?: string[] };
  readonly modelFailover?: {
    readonly fallbackModels?: string[];
    readonly authProfiles?: unknown[];
    readonly allowedModels?: string[];
    readonly maxAttempts?: number;
    readonly cooldownInitialMs?: number;
    readonly cooldownMultiplier?: number;
    readonly cooldownCapMs?: number;
  };
  readonly sessionPolicy?: {
    readonly resetMode?: string;
    readonly idleTimeoutMs?: number;
    readonly dailyResetHour?: number;
    readonly timezone?: string;
  };
  readonly concurrency?: { maxConcurrent?: number; maxQueued?: number; queueMode?: string };
  readonly skills?: {
    readonly discoveryPaths?: string[];
    readonly toolPolicyProfile?: string;
    readonly allowList?: string[];
    readonly denyList?: string[];
    readonly builtinTools?: Record<string, boolean>;
  };
  readonly broadcastGroups?: ReadonlyArray<{ name: string; targets: string[]; enabled: boolean }>;
  readonly heartbeat?: {
    readonly enabled?: boolean;
    readonly intervalMs?: number;
    readonly showOk?: boolean;
    readonly showAlerts?: boolean;
    readonly target?: {
      readonly channelType?: string;
      readonly channelId?: string;
      readonly chatId?: string;
      readonly isDm?: boolean;
    };
    readonly prompt?: string;
    readonly model?: string;
    readonly session?: string;
    readonly allowDm?: boolean;
    readonly lightContext?: boolean;
    readonly ackMaxChars?: number;
    readonly responsePrefix?: string;
    readonly skipHeartbeatOnlyDelivery?: boolean;
    readonly alertThreshold?: number;
    readonly alertCooldownMs?: number;
    readonly staleMs?: number;
  };
  readonly advanced?: Record<string, unknown>;
}

/** Enriched agent info combining AgentInfo with billing/budget data for the agent list grid. */
export interface EnrichedAgentInfo extends AgentInfo {
  readonly costToday: number;
  readonly budgetUtilization: number;
  readonly suspended: boolean;
  readonly messagesToday: number;
}

/** Agent billing/usage stats (from obs.billing.byAgent RPC) */
export interface AgentBilling {
  readonly messagesToday: number;
  readonly tokensToday: number;
  readonly activeSessions: number;
  readonly costToday: number;
  readonly totalCacheSaved?: number;
  readonly budgetUsed?: {
    readonly perExecution?: { used: number };
    readonly perHour?: { used: number };
    readonly perDay?: { used: number };
  };
}

/** Billing breakdown by agent from obs.billing.byAgent */
export interface BillingByAgent {
  readonly agentId: string;
  readonly totalTokens: number;
  readonly percentOfTotal: number;
  readonly cost: number;
}

/** Sub-agent run entry from subagent.list RPC (matches daemon SubAgentRun). */
export interface SubAgentRunDto {
  readonly runId: string;
  readonly status: "running" | "completed" | "failed" | "queued";
  readonly agentId: string;
  readonly task: string;
  readonly sessionKey: string;
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly queuedAt?: number;
  readonly depth: number;
  readonly result?: {
    readonly response: string;
    readonly tokensUsed: { readonly total: number };
    readonly cost: { readonly total: number };
    readonly finishReason: string;
    readonly stepsExecuted: number;
  };
  readonly error?: string;
  readonly callerSessionKey?: string;
}

/** Sub-agent info for orchestrated multi-agent pipelines */
export interface SubAgentInfo {
  readonly id: string;
  readonly agentId: string;
  readonly parentAgentId: string;
  readonly status: "running" | "completed" | "failed" | "archived" | "rejected";
  readonly task: string;
  readonly model: string;
  readonly tokens: number;
  readonly cost: number;
  readonly startedAt: number;
  readonly completedAt?: number;
}
