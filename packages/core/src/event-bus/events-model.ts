// SPDX-License-Identifier: Apache-2.0
/**
 * ModelEvents: model-failover + provider-health lifecycle events
 * (model:* + provider:*).
 *
 * One cohesive domain group — mirroring how OrchestrationEvents /
 * TrajectoryEvents / TerminalEvents are their own sub-interfaces folded into
 * `EventMap` (events.ts); the keys reach the typed bus via the `EventMap`
 * composition.
 *
 * Find events by prefix: model:* (failover/auth-cooldown/catalog) and
 * provider:* (cross-agent degraded/recovered aggregation).
 *
 * Emit sites: the model retry loop (`packages/agent/src/executor/model-retry.ts`)
 * for the model:* failover keys and the provider-health monitor
 * (`packages/agent/src/safety/provider-health-monitor.ts`) for provider:*.
 *
 * @module
 */
export interface ModelEvents {
  /** Model failover: attempt to switch from one model to another.
   *  Turn-scoping ids (agentId/sessionKey/traceId) are optional — emit sites
   *  populate them so activity can attribute the event to a turn. */
  "model:fallback_attempt": {
    fromProvider: string;
    fromModel: string;
    toProvider: string;
    toModel: string;
    error: string;
    attemptNumber: number;
    timestamp: number;
    agentId?: string;
    sessionKey?: string;
    traceId?: string;
  };

  /** Model failover: all candidates exhausted */
  "model:fallback_exhausted": {
    provider: string;
    model: string;
    totalAttempts: number;
    timestamp: number;
    agentId?: string;
    sessionKey?: string;
    traceId?: string;
  };

  /** Last-known-working model fallback: attempt to use a recently successful model */
  "model:lkw_fallback_attempt": {
    fromProvider: string;
    fromModel: string;
    toProvider: string;
    toModel: string;
    timestamp: number;
    agentId?: string;
    sessionKey?: string;
    traceId?: string;
  };

  /** Auth profile entered cooldown after failure */
  "model:auth_cooldown": {
    keyName: string;
    provider: string;
    cooldownMs: number;
    failureCount: number;
    timestamp: number;
    agentId?: string;
    sessionKey?: string;
    traceId?: string;
  };

  /** Model catalog loaded from pi-ai static registry */
  "model:catalog_loaded": {
    providerCount: number;
    modelCount: number;
    timestamp: number;
  };

  /** Provider declared degraded based on cross-agent failure aggregation */
  "provider:degraded": { provider: string; failingAgents: number; timestamp: number };

  /** Provider recovered after successful call during degraded state */
  "provider:recovered": { provider: string; timestamp: number };
}
