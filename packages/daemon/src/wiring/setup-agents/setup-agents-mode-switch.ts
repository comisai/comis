// SPDX-License-Identifier: Apache-2.0
/**
 * Context-engine mode-switch detection at the daemon rebuild seam.
 *
 * Extracted from {@link setupSingleAgent} (setup-agents-runtime.ts) to keep
 * that file under the per-subdirectory size cap. Two cohesive helpers:
 *
 * - {@link detectAndRecordModeSwitch} — detect a `pipeline⇄dag` switch by
 *   comparing the PRIOR `contextEngine.version` (still on
 *   `container.config.agents[agentId]` before the rebuild overwrite) to the
 *   new effective version. On a real change it records a pending `{from,to}`
 *   in the shared `pendingModeSwitches` Map and INFO-logs the switch
 *   (event↔log duality, AGENTS.md §2.7).
 * - {@link makeConsumePendingModeSwitch} — the one-shot delete-on-read closure
 *   threaded into the executor deps so the DAG reconcile seam emits
 *   `context:mode_switched` exactly once per real switch.
 *
 * @module
 */

import { ContextEngineConfigSchema } from "@comis/core";
import type { ComisLogger } from "@comis/infra";

/** The closed mode-switch carrier value: prior and current engine versions. */
export type ModeSwitch = { from: "pipeline" | "dag"; to: "pipeline" | "dag" };

/** Per-agent pending mode-switch carrier (shared, constructed once in the registry). */
export type PendingModeSwitches = Map<string, ModeSwitch>;

/**
 * Detect a context-engine MODE SWITCH at the rebuild seam and record it.
 *
 * `prevVersion` is read from `container.config.agents[agentId]`, which still
 * holds the PRIOR config on a config-reload re-invocation (and is undefined on
 * the very first build). A real switch = the prior version is defined AND
 * differs from the new one. This MUST run BEFORE the caller overwrites
 * `container.config.agents[agentId]` with `effectiveConfig`.
 *
 * The new version falls back to the schema default when unset — parity with
 * the per-turn engine build, which reads `ContextEngineConfigSchema.parse({})`
 * (executor-context-engine-setup.ts).
 *
 * We deliberately do NOT use `fullImport` as the trigger: `fullImport` fires
 * for every brand-new DAG-default conversation (now the common case), which is
 * NOT a switch. The pending switch is consumed one-shot by the DAG engine at
 * the next reconcile, which emits `context:mode_switched` with the real import
 * cost.
 *
 * @param agentId - Agent being (re)built.
 * @param prevVersion - The prior `contextEngine.version` (read before the overwrite).
 * @param newVersion - The new effective `contextEngine.version` (may be undefined).
 * @param pendingModeSwitches - Shared per-agent carrier Map to record into.
 * @param agentLogger - Logger for the INFO boundary line.
 */
export function detectAndRecordModeSwitch(
  agentId: string,
  prevVersion: "pipeline" | "dag" | undefined,
  newVersion: "pipeline" | "dag" | undefined,
  pendingModeSwitches: PendingModeSwitches,
  agentLogger: ComisLogger,
): void {
  // The new version falls back to the schema default when unset, matching the
  // per-turn engine build (ContextEngineConfigSchema.parse({})).
  const resolvedNew = newVersion ?? ContextEngineConfigSchema.parse({}).version;
  if (prevVersion && prevVersion !== resolvedNew) {
    pendingModeSwitches.set(agentId, { from: prevVersion, to: resolvedNew });
    // INFO boundary log (AGENTS.md §2.7 event↔log duality): the switch both
    // logs here at the rebuild seam AND emits context:mode_switched at the
    // reconcile seam, so an operator can reconstruct it from logs OR events.
    // No errorKind — this is an INFO line, not a WARN/ERROR.
    agentLogger.info(
      {
        agentId,
        from: prevVersion,
        to: resolvedNew,
        hint: "engine mode switched via config reload; takes effect next turn",
      },
      "Context engine mode switch detected",
    );
  }
}

/**
 * Build the one-shot delete-on-read consumer for a pending engine-mode switch.
 *
 * Threaded through PiExecutorDeps -> setupContextEngine -> DagContextEngineDeps
 * so the DAG reconcile seam can emit `context:mode_switched` once (with the real
 * import cost) and then clear the pending flag. Returns undefined when there is
 * no pending switch (e.g. a brand-new DAG-default conversation), so no false
 * event fires. consume = delete-on-read.
 *
 * @param pendingModeSwitches - The shared per-agent carrier Map.
 * @returns A consumer closure keyed by agentId.
 */
export function makeConsumePendingModeSwitch(
  pendingModeSwitches: PendingModeSwitches,
): (id: string) => ModeSwitch | undefined {
  return (id: string): ModeSwitch | undefined => {
    const s = pendingModeSwitches.get(id);
    if (s) pendingModeSwitches.delete(id);
    return s;
  };
}
