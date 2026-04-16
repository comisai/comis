/**
 * Security domain types.
 *
 * Interfaces for security events, input guard summaries,
 * and provider health cards used in the security view.
 */

/** Security event from the audit/guard systems */
export interface SecurityEvent {
  readonly id: string;
  readonly type: "injection" | "output_guard" | "secret_access" | "input_guard" | "memory_tainted" | "warn";
  readonly severity: "low" | "medium" | "high" | "critical";
  readonly message: string;
  readonly details: Record<string, unknown>;
  readonly timestamp: number;
  readonly agentId?: string;
}

/** Summary of input security guard activity over a period */
export interface InputSecurityGuardSummary {
  readonly blockedAttempts: number;
  readonly patternsTriggered: string[];
  readonly period: string;
}

/** Failover event from model:fallback_attempt or model:fallback_exhausted SSE.
 *  model:fallback_attempt provides all fields.
 *  model:fallback_exhausted provides only {provider, model, totalAttempts, timestamp},
 *  so fromProvider/fromModel/toProvider/toModel/error/attemptNumber are optional. */
export interface FailoverEvent {
  readonly fromProvider?: string;
  readonly fromModel?: string;
  readonly toProvider?: string;
  readonly toModel?: string;
  readonly error?: string;
  readonly attemptNumber?: number;
  readonly timestamp: number;
  readonly exhausted?: boolean;
  /** Provider from model:fallback_exhausted payload (set when exhausted=true). */
  readonly provider?: string;
  /** Model from model:fallback_exhausted payload (set when exhausted=true). */
  readonly model?: string;
  /** Total attempts from model:fallback_exhausted payload. */
  readonly totalAttempts?: number;
}

/** Auth cooldown entry from model:auth_cooldown SSE */
export interface AuthCooldownEntry {
  readonly keyName: string;
  readonly provider: string;
  readonly cooldownMs: number;
  readonly failureCount: number;
  readonly timestamp: number;
}

/** Health card for an LLM provider */
export interface ProviderHealthCard {
  readonly providerId: string;
  readonly name: string;
  readonly status: "healthy" | "degraded" | "down";
  readonly cacheHitRate: number;
  readonly failoverCount: number;
  readonly lastFailover?: number;
  readonly authCooldownUntil?: number;
}
