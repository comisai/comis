// SPDX-License-Identifier: Apache-2.0
/**
 * Heartbeat-handlers contract slice.
 *
 * Mirrors `packages/daemon/src/api/heartbeat-handlers.ts` (4 methods —
 * heartbeat.*). Spread order in `HEARTBEAT_HANDLERS_CONTRACTS` is
 * determinism-critical: it fixes this slice's position within
 * `ORCHESTRATOR_CONTRACTS`, keeping `contracts.generated.*` artifacts
 * byte-identical across builds.
 *
 * @module
 */
import { z } from "zod";
import { ChannelEndpointSchema } from "../../domain/conversation-scope.js";
import { defineContract } from "../types.js";

// ===========================================================================
// --- heartbeat-handlers.ts ---
// ===========================================================================

// ---------------------------------------------------------------------------
// heartbeat.states
// ---------------------------------------------------------------------------

/**
 * `heartbeat.states` — Read-only DTO array of per-agent heartbeat states.
 * Admin-scoped per setup-gateway-api.ts:327-329. Handler path:
 * heartbeat-handlers.ts:42-77.
 *
 * Request: `{}` (no params consumed).
 * Response: `{ agents: AgentHeartbeatState[] }`. Each entry: `{ agentId,
 *   enabled, intervalMs, lastRunMs, nextDueMs, consecutiveErrors,
 *   backoffUntilMs, tickStartedAtMs, lastAlertMs, lastErrorKind }`.
 *   `lastErrorKind` is `"transient" | "permanent" | null`.
 */
export const HeartbeatStatesContract = defineContract({
  method: "heartbeat.states",
  request: z.object({}),
  response: z.object({
    agents: z.array(z.object({
      agentId: z.string(),
      enabled: z.boolean(),
      intervalMs: z.number(),
      nextDueAtMs: z.number().int().nonnegative().safe().nullable(),
    }).strict()),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// heartbeat.get
// ---------------------------------------------------------------------------

/**
 * `heartbeat.get` — Read per-agent + effective heartbeat config. Admin-scoped
 * per setup-gateway-api.ts:327-329. Handler path: heartbeat-handlers.ts:82-110.
 *
 * Bespoke pre-Zod validation:
 *   - Missing `agentId` (or `_agentId`) → `"Missing required parameter: agentId"`.
 *   - Unknown agentId → `"Agent not found: <id>"`.
 *
 * Request: `{ agentId? }` (handler reads `_agentId` from rawParams as a
 *   fallback).
 * Response: `{ agentId, perAgent, effective? }`. `perAgent` is the loose-record
 *   per-agent heartbeat config (or `{}` for unconfigured agents). `effective`
 *   is the loose-record full resolved config (only present when global config
 *   is well-formed).
 */
export const HeartbeatGetContract = defineContract({
  method: "heartbeat.get",
  request: z.object({
    agentId: z.string().optional(),
  }),
  response: z.object({
    agentId: z.string(),
    perAgent: z.record(z.string(), z.unknown()),
    effective: z.record(z.string(), z.unknown()).optional(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// heartbeat.update
// ---------------------------------------------------------------------------

/**
 * `heartbeat.update` — Patch per-agent heartbeat config with deep-merge +
 * YAML persistence. Admin-scoped per setup-gateway-api.ts:327-329 AND
 * in-handler `_trustLevel === "admin"` gate. Handler path:
 * heartbeat-handlers.ts:115-206.
 *
 * Bespoke pre-Zod validation:
 *   - `_trustLevel !== "admin"` → `"Admin access required for heartbeat
 *     configuration"`.
 *   - Missing `agentId` → `"Missing required parameter: agentId"`.
 *   - Unknown agentId → `"Agent not found: <id>"`.
 *
 * Request: `{ agentId?, ...patchFields }`. A delivery-target change supplies
 *   one complete exact `ChannelEndpoint`; partial and flattened targets are
 *   rejected. The merged config is validated via
 *   `PerAgentHeartbeatConfigSchema.parse(merged)` in the handler.
 *
 * Response: `{ agentId, config, updated }`. `config` is the loose-record
 *   full PerAgentHeartbeatConfig.
 */
export const HeartbeatUpdateContract = defineContract({
  method: "heartbeat.update",
  request: z.strictObject({
    agentId: z.string().optional(),
    enabled: z.boolean().optional(),
    intervalMs: z.number().optional(),
    showOk: z.boolean().optional(),
    showAlerts: z.boolean().optional(),
    target: ChannelEndpointSchema.optional(),
    prompt: z.string().optional(),
    allowDm: z.boolean().optional(),
    lightContext: z.boolean().optional(),
    ackMaxChars: z.number().optional(),
    responsePrefix: z.string().optional(),
    alertThreshold: z.number().optional(),
    alertCooldownMs: z.number().optional(),
    staleMs: z.number().optional(),
  }),
  response: z.object({
    agentId: z.string(),
    config: z.record(z.string(), z.unknown()),
    updated: z.boolean(),
    nextDueAtMs: z.number().int().nonnegative().safe().nullable(),
  }).strict(),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// heartbeat.trigger
// ---------------------------------------------------------------------------

/**
 * `heartbeat.trigger` — Immediate per-agent heartbeat execution. Admin-scoped
 * per setup-gateway-api.ts:327-329 AND in-handler `_trustLevel === "admin"`
 * gate. Handler path: heartbeat-handlers.ts:211-230.
 *
 * Bespoke pre-Zod validation:
 *   - `_trustLevel !== "admin"` → `"Admin access required for heartbeat trigger"`.
 *   - Missing `agentId` → `"Missing required parameter: agentId"`.
 *   - an unavailable coordinator rejects trigger and periodic reconfiguration.
 *
 * Request: `{ agentId? }` (handler reads `_agentId` from rawParams as a
 *   fallback).
 * Response: `{ agentId, triggered }`.
 */
export const HeartbeatTriggerContract = defineContract({
  method: "heartbeat.trigger",
  request: z.object({
    agentId: z.string().optional(),
  }),
  response: z.object({
    agentId: z.string(),
    admission: z.discriminatedUnion("status", [
      z.strictObject({
        status: z.literal("accepted"),
        disposition: z.enum(["new_occurrence", "occurrence_upgraded"]),
        correlationId: z.string().min(1),
        lane: z.enum(["normal", "task"]),
        retainedReason: z.enum(["interval", "manual", "hook", "wake", "exec-event", "cron", "task"]),
      }),
      z.strictObject({
        status: z.literal("coalesced"),
        correlationId: z.string().min(1),
        lane: z.enum(["normal", "task"]),
        retainedReason: z.enum(["interval", "manual", "hook", "wake", "exec-event", "cron", "task"]),
      }),
    ]),
  }).strict(),
  scopes: ["admin"] as const,
});

/**
 * heartbeat-handlers slice (4 contracts — heartbeat.*). Spread order is
 * determinism-critical for codegen output stability.
 */
export const HEARTBEAT_HANDLERS_CONTRACTS = [
  HeartbeatStatesContract,
  HeartbeatGetContract,
  HeartbeatUpdateContract,
  HeartbeatTriggerContract,
] as const;
