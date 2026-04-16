import { z } from "zod";

// ---------------------------------------------------------------------------
// Node Driver Action
// ---------------------------------------------------------------------------

/**
 * Discriminated union of actions a node type driver can return.
 *
 * Each variant is identified by its `action` field, enabling exhaustive
 * `switch` handling in the graph coordinator.
 */
export type NodeDriverAction =
  /** Ask the coordinator to start one sub-agent. */
  | { action: "spawn"; agentId: string; task: string; model?: string; maxSteps?: number; reuseSessionKey?: string }
  /** Start multiple sub-agents in parallel. */
  | { action: "spawn_all"; spawns: Array<{ agentId: string; task: string; model?: string; maxSteps?: number }> }
  /** Node finished successfully with output text and optional artifacts. */
  | { action: "complete"; output: string; artifacts?: Array<{ filename: string; content: string }> }
  /** Node failed with an error message and optional artifacts. */
  | { action: "fail"; error: string; artifacts?: Array<{ filename: string; content: string }> }
  /** Do nothing -- wait for more turns. */
  | { action: "wait" }
  /** Prompt a human for input and block until response or timeout. */
  | { action: "wait_for_input"; message: string; timeoutMs: number }
  /** Report progress to observers (stage, current/total counters). */
  | { action: "progress"; stage: string; current: number; total: number; detail?: string };

// ---------------------------------------------------------------------------
// Node Driver Context
// ---------------------------------------------------------------------------

/**
 * Read-only execution context passed to every driver method.
 *
 * Provides the driver with node metadata, type-specific configuration,
 * and a state bag for persisting opaque data between turns (e.g.,
 * current debate round, vote tally).
 */
export interface NodeDriverContext {
  /** Unique node identifier within the graph. */
  readonly nodeId: string;
  /** Task description assigned to this node. */
  readonly task: string;
  /** Type-specific configuration validated against the driver's configSchema. */
  readonly typeConfig: Record<string, unknown>;
  /** Absolute path to the shared directory for inter-node file exchange. */
  readonly sharedDir: string;
  /** Human-readable graph label, if one was provided. */
  readonly graphLabel: string | undefined;
  /** Default agent ID inherited from the graph executor. */
  readonly defaultAgentId: string;
  /** Registered name of this node's type (matches NodeTypeDriver.typeId). */
  readonly typeName: string;
  /** Retrieve opaque driver state persisted between turns. Returns undefined on first call. */
  getState<T = unknown>(): T | undefined;
  /** Persist opaque driver state for retrieval on subsequent turns. */
  setState<T = unknown>(state: T): void;
}

// ---------------------------------------------------------------------------
// Node Type Driver
// ---------------------------------------------------------------------------

/**
 * Interface for a pluggable graph node type driver.
 *
 * Drivers are pure synchronous functions -- no async, no I/O, no side effects.
 * They receive context and return action objects that the graph coordinator
 * interprets and executes. Created via factory functions (e.g., `createDebateDriver()`).
 */
export interface NodeTypeDriver {
  /** Unique type identifier (e.g., "debate", "vote", "map-reduce"). */
  readonly typeId: string;
  /** Human-readable driver name for display purposes. */
  readonly name: string;
  /** Short description of what this driver does. */
  readonly description: string;
  /** Zod schema for validating type-specific node configuration. */
  readonly configSchema: z.ZodObject<z.ZodRawShape>;
  /** Default timeout in milliseconds for nodes using this driver. */
  readonly defaultTimeoutMs: number;
  /** Estimate execution duration based on type-specific config (used for scheduling hints). */
  estimateDurationMs(config: Record<string, unknown>): number;
  /** Called once when the node starts -- return the first action (typically spawn or spawn_all). */
  initialize(ctx: NodeDriverContext): NodeDriverAction;
  /** Called after a single sub-agent completes -- decide the next action. */
  onTurnComplete(ctx: NodeDriverContext, agentOutput: string): NodeDriverAction;
  /** Called after all parallel sub-agents complete -- decide the next action. Optional; required only for drivers that use spawn_all. */
  onParallelTurnComplete?(ctx: NodeDriverContext, outputs: Array<{ agentId: string; output: string }>): NodeDriverAction;
  /** Called when the node is aborted (timeout, graph cancellation). Clean up any driver state. */
  onAbort(ctx: NodeDriverContext): void;
  /** Return accumulated partial output if the driver has meaningful work to preserve. Called before marking a node as failed. */
  getPartialOutput?(ctx: NodeDriverContext): string | undefined;
}
