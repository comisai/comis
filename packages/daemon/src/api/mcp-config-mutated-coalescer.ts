// SPDX-License-Identifier: Apache-2.0
/**
 * config:mutated event coalescer with 500ms trailing-edge debounce
 * for Phase 64 RELY-08.
 *
 * Extracted from `mcp-handlers.ts` to keep that leaf under the 800-line
 * per-file cap (precedent: Phase 63 commit 7e4e7c02 extracted
 * `looksLikePlaintextSecret` for the same reason). Bulk operations like
 * Phase 68 skill-install adding N MCPs produce ONE event per 500ms
 * window with merged `{ added, removed }` diff arrays.
 *
 * Closure-captured CoalescerState (NOT module-scope `let` mutables) --
 * the factory `createConfigMutatedCoalescer` returns a `{ schedule,
 * _resetForTests }` pair. One coalescer per daemon process;
 * `mcp-handlers.ts` instantiates lazily on first persist with eventBus
 * available.
 *
 * Exported `_resetConfigMutatedCoalescer` mirrors the `_resetSigusr1Timer` /
 * `_resetMutationFence` test seam at persist-to-config.ts:72/99, called
 * from every integration test's `beforeEach` to prevent state leakage
 * across vitest processes.
 *
 * @module
 */

import {
  systemSetTimeout,
  systemClearTimeout,
  systemNowMs,
  type SystemTimeoutHandle,
  type TypedEventBus,
  type ComisLogger,
  type McpServerEntry,
} from "@comis/core";

/** Phase 64 RELY-08 trailing-edge debounce window. */
const CONFIG_MUTATED_DEBOUNCE_MS = 500;

interface CoalescerState {
  pendingAdded: Map<string, McpServerEntry>;
  pendingRemoved: Map<string, McpServerEntry>;
  timer: SystemTimeoutHandle | undefined;
}

export interface ConfigMutatedCoalescer {
  schedule(added: readonly McpServerEntry[], removed: readonly McpServerEntry[]): void;
  _resetForTests(): void;
}

export function createConfigMutatedCoalescer(
  eventBus: TypedEventBus,
  _logger: ComisLogger,
): ConfigMutatedCoalescer {
  const state: CoalescerState = {
    pendingAdded: new Map(),
    pendingRemoved: new Map(),
    timer: undefined,
  };

  function schedule(
    added: readonly McpServerEntry[],
    removed: readonly McpServerEntry[],
  ): void {
    // Dedup-by-name merge:
    //   - add+remove for same name within the window -> cancels (no entry)
    //   - re-add for same name within the window -> last-wins
    for (const entry of added) {
      state.pendingRemoved.delete(entry.name);
      state.pendingAdded.set(entry.name, entry);
    }
    for (const entry of removed) {
      if (state.pendingAdded.delete(entry.name)) continue; // add+remove cancels
      state.pendingRemoved.set(entry.name, entry);
    }

    // Reset trailing-edge timer
    if (state.timer !== undefined) {
      systemClearTimeout(state.timer);
    }
    const handle = systemSetTimeout(() => {
      const finalAdded = [...state.pendingAdded.values()];
      const finalRemoved = [...state.pendingRemoved.values()];
      state.pendingAdded.clear();
      state.pendingRemoved.clear();
      state.timer = undefined;
      eventBus.emit("config:mutated", {
        path: "integrations.mcp.servers",
        added: finalAdded,
        removed: finalRemoved,
        timestamp: systemNowMs(),
      });
    }, CONFIG_MUTATED_DEBOUNCE_MS);
    handle.unref?.();
    state.timer = handle;
  }

  function _resetForTests(): void {
    if (state.timer !== undefined) {
      systemClearTimeout(state.timer);
    }
    state.pendingAdded.clear();
    state.pendingRemoved.clear();
    state.timer = undefined;
  }

  return { schedule, _resetForTests };
}

/**
 * Process-level test seam. mcp-handlers.ts owns the lazy singleton; integration
 * tests call _resetConfigMutatedCoalescer in beforeEach to clear pending state
 * and cancel the timer. Holder is undefined until mcp-handlers.ts registers
 * the instance at first persist; before registration the reset is a no-op.
 */
let registered: ConfigMutatedCoalescer | undefined;

/** Register the process-wide coalescer (called once from mcp-handlers.ts). */
export function registerCoalescerForTestReset(coalescer: ConfigMutatedCoalescer): void {
  registered = coalescer;
}

/** Test seam mirroring _resetSigusr1Timer / _resetMutationFence. */
export function _resetConfigMutatedCoalescer(): void {
  registered?._resetForTests();
}

/**
 * Compute the {added, removed} diff between previous and current
 * `integrations.mcp.servers` arrays. Lives in the coalescer module
 * (NOT inlined at the persistMcpServers call site) so the call site
 * stays narrow and the 800-line cap on `mcp-handlers.ts` is preserved
 * from the start (extraction-first per Phase 63 precedent). Dedup
 * uses entry `name` as the identity key.
 */
export function computeMcpDiff(
  previous: readonly McpServerEntry[],
  current: readonly McpServerEntry[],
): { added: McpServerEntry[]; removed: McpServerEntry[] } {
  const previousByName = new Map(previous.map((s) => [s.name, s] as const));
  const currentByName = new Map(current.map((s) => [s.name, s] as const));
  const added = current.filter((s) => !previousByName.has(s.name));
  const removed = previous.filter((s) => !currentByName.has(s.name));
  return { added, removed };
}
