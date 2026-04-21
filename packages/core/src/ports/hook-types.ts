// SPDX-License-Identifier: Apache-2.0
import type { SessionKey } from "../domain/session-key.js";

// ─── Hook Name Unions ────────────────────────────────────────────────

/**
 * All lifecycle hook names supported by the plugin system.
 *
 * Hooks are categorized by domain:
 * - Agent: before_agent_start, agent_end
 * - Tool: before_tool_call, after_tool_call, tool_result_persist
 * - Compaction: before_compaction, after_compaction
 * - Session: session_start, session_end
 * - Gateway: gateway_start, gateway_stop
 */
export type HookName =
  | "before_agent_start"
  | "agent_end"
  | "before_tool_call"
  | "after_tool_call"
  | "tool_result_persist"
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
  | "before_tool_call"
  | "tool_result_persist"
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

/** Event payload for the agent_end hook. */
export interface HookAgentEndEvent {
  readonly durationMs: number;
  readonly tokenUsage?: { prompt: number; completion: number; total: number };
  readonly success: boolean;
  readonly error?: string;
}

/** Context available during agent_end hook execution. */
export interface HookAgentEndContext {
  readonly agentId: string;
  readonly sessionKey?: SessionKey;
  readonly workspaceDir?: string;
}

// ─── Tool Hook Types ─────────────────────────────────────────────────

/** Event payload for the before_tool_call hook. */
export interface HookBeforeToolCallEvent {
  readonly toolName: string;
  readonly params: Record<string, unknown>;
}

/** Context available during tool hook execution. */
export interface HookBeforeToolCallContext {
  readonly agentId: string;
  readonly sessionKey?: SessionKey;
}

/** Result returned by modifying before_tool_call handlers. */
export interface HookBeforeToolCallResult {
  readonly params?: Record<string, unknown>;
  readonly block?: boolean;
  readonly blockReason?: string;
}

/** Event payload for the after_tool_call hook. */
export interface HookAfterToolCallEvent {
  readonly toolName: string;
  readonly params: Record<string, unknown>;
  readonly result: unknown;
  readonly durationMs: number;
  readonly success: boolean;
}

/** Context available during after_tool_call hook execution. */
export interface HookAfterToolCallContext {
  readonly agentId: string;
  readonly sessionKey?: SessionKey;
}

/** Event payload for the tool_result_persist hook. Synchronous execution. */
export interface HookToolResultPersistEvent {
  readonly toolName: string;
  readonly result: string;
}

/** Context available during tool_result_persist hook execution. */
export interface HookToolResultPersistContext {
  readonly agentId: string;
  readonly sessionKey?: SessionKey;
}

/** Result returned by modifying tool_result_persist handlers. */
export interface HookToolResultPersistResult {
  readonly result?: string;
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
  readonly sessionKey: SessionKey;
  readonly isNew: boolean;
}

/** Context available during session_start hook execution. */
export interface HookSessionStartContext {
  readonly agentId?: string;
}

/** Event payload for the session_end hook. */
export interface HookSessionEndEvent {
  readonly sessionKey: SessionKey;
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
}

// ─── Hook Handler Map ────────────────────────────────────────────────

/**
 * Maps each hook name to its typed handler signature.
 *
 * Modifying hooks return a result object (or void to skip modification).
 * Void hooks return nothing (observational only).
 *
 * NOTE: tool_result_persist handlers MUST be synchronous — this hook
 * runs in a synchronous code path (session transcript append).
 */
export interface HookHandlerMap {
  // Modifying hooks (sequential execution, return merged result)
  before_agent_start: (
    event: HookBeforeAgentStartEvent,
    ctx: HookBeforeAgentStartContext,
  ) => Promise<HookBeforeAgentStartResult | void> | HookBeforeAgentStartResult | void;

  before_tool_call: (
    event: HookBeforeToolCallEvent,
    ctx: HookBeforeToolCallContext,
  ) => Promise<HookBeforeToolCallResult | void> | HookBeforeToolCallResult | void;

  /** Synchronous only — do NOT return a Promise from this handler. */
  tool_result_persist: (
    event: HookToolResultPersistEvent,
    ctx: HookToolResultPersistContext,
  ) => HookToolResultPersistResult | void;

  before_compaction: (
    event: HookBeforeCompactionEvent,
    ctx: HookBeforeCompactionContext,
  ) => Promise<HookBeforeCompactionResult | void> | HookBeforeCompactionResult | void;

  before_delivery: (
    event: HookBeforeDeliveryEvent,
    ctx: HookBeforeDeliveryContext,
  ) => Promise<HookBeforeDeliveryResult | void> | HookBeforeDeliveryResult | void;

  // Void hooks (parallel execution, fire-and-forget)
  agent_end: (
    event: HookAgentEndEvent,
    ctx: HookAgentEndContext,
  ) => Promise<void> | void;

  after_tool_call: (
    event: HookAfterToolCallEvent,
    ctx: HookAfterToolCallContext,
  ) => Promise<void> | void;

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
