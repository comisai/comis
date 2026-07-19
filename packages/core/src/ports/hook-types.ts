// SPDX-License-Identifier: Apache-2.0
import type { SessionKey } from "../domain/session-key.js";
import type { ChannelEndpoint, ConversationScope } from "../domain/conversation-scope.js";
import type { DeliveryAuthority } from "./delivery-queue.js";

// ─── Hook Name Unions ────────────────────────────────────────────────

/**
 * All lifecycle hook names supported by the plugin system.
 *
 * Hooks are categorized by domain:
 * - Agent: before_agent_start
 * - Compaction: before_compaction, after_compaction
 * - Delivery: before_delivery, after_delivery
 * - Session: session_start, session_end
 * - Gateway: gateway_start, gateway_stop
 *
 * There are deliberately no tool / agent_end hook lanes (before_tool_call,
 * after_tool_call, tool_result_persist, agent_end) — they would have zero
 * in-tree production registrations.
 */
export type HookName =
  | "before_agent_start"
  | "before_compaction"
  | "after_compaction"
  | "before_delivery"
  | "after_delivery"
  | "session_start"
  | "session_end"
  | "gateway_start"
  | "gateway_stop";

/** Hooks that return a result object to modify behavior (run sequentially). */
export type ModifyingHookName =
  | "before_agent_start"
  | "before_compaction"
  | "before_delivery";

/** Hooks that are observational only — no result, fire-and-forget (run in parallel). */
export type VoidHookName = Exclude<HookName, ModifyingHookName>;

// ─── Agent Hook Types ────────────────────────────────────────────────

/** Event payload for the before_agent_start hook. */
export interface HookBeforeAgentStartEvent {
  readonly systemPrompt: string;
  readonly messages: unknown[];
}

/** Context available during before_agent_start hook execution. */
export interface HookBeforeAgentStartContext {
  readonly agentId: string;
  readonly sessionKey?: SessionKey;
  readonly workspaceDir?: string;
  /** Whether this is the first user message in the current session. */
  readonly isFirstMessageInSession?: boolean;
}

/** Result returned by modifying before_agent_start handlers. */
export interface HookBeforeAgentStartResult {
  readonly systemPrompt?: string;
  readonly prependContext?: string;
}

// ─── Compaction Hook Types ───────────────────────────────────────────

/** Event payload for the before_compaction hook. */
export interface HookBeforeCompactionEvent {
  readonly sessionKey: SessionKey;
  readonly messageCount: number;
  readonly estimatedTokens?: number;
}

/** Context available during compaction hook execution. */
export interface HookBeforeCompactionContext {
  readonly agentId: string;
}

/** Result returned by modifying before_compaction handlers. */
export interface HookBeforeCompactionResult {
  readonly cancel?: boolean;
  readonly cancelReason?: string;
}

/** Event payload for the after_compaction hook. */
export interface HookAfterCompactionEvent {
  readonly sessionKey: SessionKey;
  readonly removedCount: number;
  readonly retainedCount: number;
  readonly durationMs: number;
}

/** Context available during after_compaction hook execution. */
export interface HookAfterCompactionContext {
  readonly agentId: string;
}

// ─── Session Hook Types ──────────────────────────────────────────────

/** Event payload for the session_start hook. */
export interface HookSessionStartEvent {
  readonly conversationScope: ConversationScope;
  readonly isNew: boolean;
}

/** Context available during session_start hook execution. */
export interface HookSessionStartContext {
  readonly agentId?: string;
}

/** Event payload for the session_end hook. */
export interface HookSessionEndEvent {
  readonly conversationScope: ConversationScope;
  readonly reason: string;
  readonly durationMs?: number;
}

/** Context available during session_end hook execution. */
export interface HookSessionEndContext {
  readonly agentId?: string;
}

// ─── Gateway Hook Types ──────────────────────────────────────────────

/** Event payload for the gateway_start hook. */
export interface HookGatewayStartEvent {
  readonly port: number;
  readonly host: string;
  readonly tls: boolean;
}

/** Context available during gateway_start hook execution. */
export interface HookGatewayStartContext {
  readonly [key: string]: never;
}

/** Event payload for the gateway_stop hook. */
export interface HookGatewayStopEvent {
  readonly reason: string;
}

/** Context available during gateway_stop hook execution. */
export interface HookGatewayStopContext {
  readonly [key: string]: never;
}

// ─── Delivery Hook Types ─────────────────────────────────────────────

/** Event payload for the before_delivery hook. */
export interface HookBeforeDeliveryEvent {
  readonly text: string;
  readonly channelType: string;
  readonly channelId: string;
  readonly options: Record<string, unknown>;
  readonly origin: string;
}

/** Context available during before_delivery hook execution. */
export interface HookBeforeDeliveryContext {
  readonly sessionKey?: string;
  readonly agentId?: string;
  readonly traceId?: string;
  readonly deliveryAuthority?: DeliveryAuthority;
  readonly destinationEndpoint?: ChannelEndpoint;
}

/** Result returned by modifying before_delivery handlers. */
export interface HookBeforeDeliveryResult {
  readonly text?: string;
  readonly cancel?: boolean;
  readonly cancelReason?: string;
  readonly metadata?: Record<string, unknown>;
}

/** Event payload for the after_delivery hook. */
export interface HookAfterDeliveryEvent {
  readonly text: string;
  readonly channelType: string;
  readonly channelId: string;
  readonly result: unknown;
  readonly durationMs: number;
  readonly origin: string;
}

/** Context available during after_delivery hook execution. */
export interface HookAfterDeliveryContext {
  readonly sessionKey?: string;
  readonly agentId?: string;
  readonly traceId?: string;
  readonly deliveryAuthority?: DeliveryAuthority;
  readonly destinationEndpoint?: ChannelEndpoint;
}

// ─── Hook Handler Map ────────────────────────────────────────────────

/**
 * Maps each hook name to its typed handler signature.
 *
 * Modifying hooks return a result object (or void to skip modification).
 * Void hooks return nothing (observational only).
 */
export interface HookHandlerMap {
  // Modifying hooks (sequential execution, return merged result)
  before_agent_start: (
    event: HookBeforeAgentStartEvent,
    ctx: HookBeforeAgentStartContext,
  ) => Promise<HookBeforeAgentStartResult | void> | HookBeforeAgentStartResult | void;

  before_compaction: (
    event: HookBeforeCompactionEvent,
    ctx: HookBeforeCompactionContext,
  ) => Promise<HookBeforeCompactionResult | void> | HookBeforeCompactionResult | void;

  before_delivery: (
    event: HookBeforeDeliveryEvent,
    ctx: HookBeforeDeliveryContext,
  ) => Promise<HookBeforeDeliveryResult | void> | HookBeforeDeliveryResult | void;

  // Void hooks (parallel execution, fire-and-forget)
  after_compaction: (
    event: HookAfterCompactionEvent,
    ctx: HookAfterCompactionContext,
  ) => Promise<void> | void;

  after_delivery: (
    event: HookAfterDeliveryEvent,
    ctx: HookAfterDeliveryContext,
  ) => Promise<void> | void;

  session_start: (
    event: HookSessionStartEvent,
    ctx: HookSessionStartContext,
  ) => Promise<void> | void;

  session_end: (
    event: HookSessionEndEvent,
    ctx: HookSessionEndContext,
  ) => Promise<void> | void;

  gateway_start: (
    event: HookGatewayStartEvent,
    ctx: HookGatewayStartContext,
  ) => Promise<void> | void;

  gateway_stop: (
    event: HookGatewayStopEvent,
    ctx: HookGatewayStopContext,
  ) => Promise<void> | void;
}
