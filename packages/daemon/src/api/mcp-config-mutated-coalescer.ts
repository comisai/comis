// SPDX-License-Identifier: Apache-2.0
/**
 * config:mutated event coalescer with 500ms trailing-edge debounce for
 * Phase 64 RELY-08. Extracted from mcp-handlers.ts to keep that leaf under
 * the 800-line per-file cap (Phase 63 precedent: looksLikePlaintextSecret).
 * Bulk operations (Phase 68 skill-install adding N MCPs) produce ONE event
 * per 500ms window with merged { added, removed } diff arrays. The factory
 * returns closure-captured state; mcp-handlers.ts goes through getCoalescer
 * for the process-wide singleton. _resetConfigMutatedCoalescer mirrors the
 * _resetSigusr1Timer / _resetMutationFence test seam at
 * persist-to-config.ts:72/99 for beforeEach state isolation.
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

// Process-wide singleton (one daemon = one config = one event bus). Lazy-init
// on first persistMcpServers call with eventBus available; getCoalescer returns
// the same instance after. _resetConfigMutatedCoalescer is the test seam.
let singleton: ConfigMutatedCoalescer | undefined;

/** Lazy get-or-create the process-wide coalescer. Called from mcp-handlers.ts. */
export function getCoalescer(eventBus: TypedEventBus, logger: ComisLogger): ConfigMutatedCoalescer {
  if (singleton === undefined) singleton = createConfigMutatedCoalescer(eventBus, logger);
  return singleton;
}

/**
 * Test seam mirroring _resetSigusr1Timer / _resetMutationFence. Cancels the
 * armed timer + clears pending diff Maps, AND drops the singleton so the
 * next getCoalescer call re-creates with the current test's eventBus +
 * logger references. Without dropping the singleton, an integration test
 * that constructs a fresh container per test (the mcp-persistence harness
 * pattern) would see the timer fire against the prior test's eventBus
 * mock — silently no-op'ing the assertion on the current mock.
 */
export function _resetConfigMutatedCoalescer(): void {
  singleton?._resetForTests();
  singleton = undefined;
}

/**
 * Compute the {added, removed} diff between previous and current
 * `integrations.mcp.servers` arrays. Dedup by entry `name`. Lives in the
 * coalescer module (NOT inlined at the call site) so mcp-handlers.ts stays
 * under the 800-line cap by construction (extraction-first; Phase 63 precedent).
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
