// SPDX-License-Identifier: Apache-2.0
// @allow-throw: createOrderPreservingResultBuffer (221-05) invariant guards — RangeError on a non-negative-integer toolCallCount / out-of-range record index; Error on duplicate-fill or incomplete-flush (a hole would tear the cache-stable prefix). These are programmer-error fail-fast guards on the buffer's contract (it is called once-per-index by construction by the executor loop), not recoverable runtime conditions; consumed on the executor tool-parallelism path.
/**
 * Tool Parallelism: Read-only classifier and mutation serializer.
 *
 * The SDK's "parallel" tool execution mode runs ALL tools concurrently.
 * This is correct for read-only tools but unsafe for mutating tools
 * (exec, write, edit, etc.) which may have ordering dependencies or
 * filesystem conflicts.
 *
 * The mutation serializer wraps mutating tool execute() methods with a
 * shared async mutex so they run one at a time, even when the SDK fires
 * them concurrently in parallel mode. Read-only tools pass through
 * without serialization.
 *
 * @module
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getToolMetadata } from "@comis/core";

// ---------------------------------------------------------------------------
// Read-only tool classification
// ---------------------------------------------------------------------------

/** Minimal logger interface for parallelism warnings. */
interface ParallelismLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Determine whether a tool is read-only (safe for concurrent execution).
 *
 * Two-tier classification chain:
 *   1. Explicit metadata declaration (getToolMetadata registry)
 *   2. MCP heuristic (mcp__-prefixed tools manage their own state)
 *
 * Unknown tools default to false (mutating) as a safety measure.
 */
export function isReadOnlyTool(name: string, _logger?: ParallelismLogger): boolean {
  // Priority 1: explicit metadata declaration
  const meta = getToolMetadata(name);
  if (meta?.isReadOnly !== undefined) return meta.isReadOnly;

  // Priority 2: MCP heuristic (MCP servers manage their own state)
  if (name.startsWith("mcp__")) return true;

  // Unknown tool: default to mutating for safety.
  return false;
}

/**
 * Determine whether a tool is safe for concurrent execution.
 *
 * Unlike isReadOnlyTool(), this considers tools that mutate state but
 * target independent resources (e.g., message sends to different channels).
 * Falls back to isReadOnly when isConcurrencySafe metadata is unset.
 */
export function isConcurrencySafe(name: string, logger?: ParallelismLogger): boolean {
  const meta = getToolMetadata(name);
  if (meta?.isConcurrencySafe !== undefined) return meta.isConcurrencySafe;
  // Default: same as isReadOnly
  return isReadOnlyTool(name, logger);
}

// ---------------------------------------------------------------------------
// Async mutex
// ---------------------------------------------------------------------------

/**
 * Minimal async mutex — no external dependencies.
 * Each call to run() queues behind the previous, ensuring serial execution.
 */
function createAsyncMutex() {
  let current = Promise.resolve();
  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      let release: () => void;
      const next = new Promise<void>((resolve) => {
        release = resolve;
      });
      const prev = current;
      current = next;
      await prev;
      try {
        return await fn();
      } finally {
        release!();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Mutation serializer
// ---------------------------------------------------------------------------

/**
 * Create a mutation serializer that wraps mutating tool execute() methods
 * with a shared async mutex.
 *
 * Returns a function that accepts a ToolDefinition array and returns a new
 * array where:
 * - Read-only tools are passed through unchanged (same execute reference).
 * - Mutating tools have their execute() wrapped to serialize through the mutex.
 *
 * Each call to createMutationSerializer() creates an independent mutex,
 * so different executor sessions do not block each other.
 */
export function createMutationSerializer(): (
  tools: ToolDefinition[],
) => ToolDefinition[] {
  const mutex = createAsyncMutex();

  return (tools: ToolDefinition[]): ToolDefinition[] =>
    tools.map((tool) => {
      if (isConcurrencySafe(tool.name)) {
        return tool;
      }

      // Wrap mutating tool's execute with the shared mutex
      const originalExecute = tool.execute.bind(tool);
      return {
        ...tool,
        execute(
          ...args: Parameters<ToolDefinition["execute"]>
        ): ReturnType<ToolDefinition["execute"]> {
          return mutex.run(() => originalExecute(...args));
        },
      } as ToolDefinition;
    });
}

// ---------------------------------------------------------------------------
// STREAM-01: order-preserving, cache-stable result buffer
// ---------------------------------------------------------------------------

/**
 * Order-preserving result collector for concurrent tool execution.
 *
 * The SDK runs read-only tools concurrently (parallel mode), so their
 * `execute()` promises resolve in COMPLETION order — which is
 * nondeterministic across turns. If concurrent results were placed into the
 * message array in completion order, the cached prompt prefix would change
 * turn-over-turn and bust the prompt cache (T-221-STREAM-01, a cost DoS).
 *
 * SDK-side guarantee (Q-STREAM-1 spike, @earendil-works/pi-coding-agent
 * 0.79.3): the SDK already "appends persisted tool results in assistant
 * source order" (CHANGELOG #3503) regardless of which tool finishes first,
 * and `createMutationSerializer` above wraps `execute()` WITHOUT reordering
 * results. So the cache-stable ordering holds at the message-array level.
 *
 * This buffer makes that contract EXPLICIT and TESTABLE in Comis code rather
 * than depending solely on the SDK changelog: a consumer that collects
 * concurrent completions records each by its TOOL-CALL index and flushes in
 * that source order once every call has resolved. The flushed array is a pure
 * function of `(index → result)`, so it is byte-identical across runs with
 * different completion interleavings — cache-stable by construction.
 *
 * Pure + synchronous: no timers, no clock, no I/O — safe under the executor's
 * no-globals discipline.
 *
 * @typeParam T - the per-tool-call result type the consumer collects.
 */
export interface OrderPreservingResultBuffer<T> {
  /**
   * Record the result for the tool-call at `index` (0-based, in source order).
   * Throws on an out-of-range index (no matching tool-call slot) or a duplicate
   * record for an already-filled slot (no silent overwrite — a double-delivery
   * is a bug, not a benign no-op).
   */
  record(index: number, result: T): void;
  /** True once every tool-call slot has a recorded result. */
  isComplete(): boolean;
  /**
   * Return the results in tool-call (source) order. Throws if any slot is
   * still unfilled — flushing an incomplete set would emit a hole and tear the
   * cached prefix. Returns a fresh array each call (the buffer is not consumed).
   */
  flush(): T[];
}

/**
 * Create an {@link OrderPreservingResultBuffer} sized for `toolCallCount`
 * concurrently-dispatched tool calls. `toolCallCount` is the number of
 * tool-calls in the assistant turn; a zero-call turn is trivially complete and
 * flushes `[]`.
 */
export function createOrderPreservingResultBuffer<T>(
  toolCallCount: number,
): OrderPreservingResultBuffer<T> {
  if (!Number.isInteger(toolCallCount) || toolCallCount < 0) {
    throw new RangeError(
      `createOrderPreservingResultBuffer: toolCallCount must be a non-negative integer, got ${toolCallCount}`,
    );
  }

  // Sparse-by-intent: a slot is "filled" iff present in `filled`. Storing the
  // result separately from a presence Set lets a falsy result (e.g. "") count
  // as filled without an `undefined`-vs-absent ambiguity.
  const results = new Array<T>(toolCallCount);
  const filled = new Set<number>();

  return {
    record(index: number, result: T): void {
      if (!Number.isInteger(index) || index < 0 || index >= toolCallCount) {
        throw new RangeError(
          `OrderPreservingResultBuffer.record: index ${index} out of range [0, ${toolCallCount})`,
        );
      }
      if (filled.has(index)) {
        throw new Error(
          `OrderPreservingResultBuffer.record: duplicate result for already-filled tool-call index ${index}`,
        );
      }
      results[index] = result;
      filled.add(index);
    },
    isComplete(): boolean {
      return filled.size === toolCallCount;
    },
    flush(): T[] {
      if (filled.size !== toolCallCount) {
        throw new Error(
          `OrderPreservingResultBuffer.flush: incomplete — ${filled.size}/${toolCallCount} tool-call results recorded; ` +
            `flushing now would emit a hole and tear the cache-stable prefix`,
        );
      }
      return results.slice();
    },
  };
}
