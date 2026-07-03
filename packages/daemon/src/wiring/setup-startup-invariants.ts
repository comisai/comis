// SPDX-License-Identifier: Apache-2.0
/**
 * Startup invariant collector and WARN emitter.
 *
 * Collects counts from all registries after boot completes and emits a single
 * `daemon:startup_invariants` INFO record. If any invariant indicates duplicate
 * adapter wiring, emits a WARN with errorKind:"config" BEFORE the daemon accepts
 * traffic.
 *
 * Called from daemon.ts bootShutdown() immediately after emitStartupBanner().
 *
 * @module
 */
import type { ComisLogger } from "@comis/infra";
import type { ChannelPort } from "@comis/core";

// ---------------------------------------------------------------------------
// Imports for startup sweep
// ---------------------------------------------------------------------------
import { sweepRotatedFiles } from "@comis/observability";
import type { RotationPolicy } from "@comis/observability";

// ---------------------------------------------------------------------------
// Imports for health aggregator
// ---------------------------------------------------------------------------
import { createHealthAggregator } from "@comis/observability";
import type { AlertBudgetPolicy } from "@comis/observability";
import type { TypedEventBus } from "@comis/core";

// ---------------------------------------------------------------------------
// StartupInvariants interface
// ---------------------------------------------------------------------------

/**
 * Snapshot of daemon wiring state captured at the end of successful boot.
 * All values are counts or boolean flags — no secrets, paths, or message bodies.
 */
export interface StartupInvariants {
  adaptersByChannelType: Record<string, number>;       // expected count === 1 per type
  handlersPerAdapter:    Record<string, number>;       // expected === 1 per adapter
  pluginRegistryCount:   number;
  channelRegistryCount:  number;
  depSlotConsistency: {
    adaptersList:     boolean;   // expected false (the legacy adaptersList dep slot is no longer wired)
    channelRegistry:  boolean;   // expected true
  };
  agentCount:           number;
  toolCatalogSize:      number;
  mcpServerCount:       number;
}

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface StartupInvariantsDeps {
  /** Daemon structured logger — info + warn called at this module's emit sites. */
  logger: ComisLogger;
  /** Post-dedup adapter map (channelType -> adapter). Populated by channelManager.startAll(). */
  adaptersByType: ReadonlyMap<string, ChannelPort>;
  /** Pre-dedup raw registration count per channelType. Goes to 2 in regression wiring. */
  rawHandlerCounts: ReadonlyMap<string, number>;
  /** Channel plugin map (channelType -> ChannelPluginPort). */
  channelPlugins: ReadonlyMap<string, unknown>;
  /** Plugin registry — count() surfaces the number of registered plugins. */
  pluginRegistry: { count(): number };
  /** MCP client manager — getTools() returns the flat tool catalog. */
  mcpClientManager: { getTools(): { name: string }[] };
  /** Agent config map (agentId -> PerAgentConfig). */
  agentsConfig: Record<string, unknown>;
  /**
   * Dep slot consistency flags — passed explicitly by the daemon composition root
   * (the only site that knows which slots were used). Required wiring:
   * { adaptersList: false, channelRegistry: true }.
   */
  depSlotConsistency: {
    adaptersList:    boolean;   // expected false
    channelRegistry: boolean;   // expected true
  };
  /**
   * Optional cross-stream log rotation policy.
   * When provided (together with logsDir), triggers a non-blocking
   * startup sweep via sweepRotatedFiles after the invariant emit.
   */
  logRotationPolicy?: RotationPolicy;
  /**
   * Directory containing observability log files (e.g. ~/.comis/logs/).
   * Required when logRotationPolicy is set for the startup sweep to run.
   */
  logsDir?: string;
  /**
   * Optional alert budget policy.
   * When provided (together with eventBus), attaches the health aggregator.
   * The returned unsubscribe function should be called on daemon shutdown.
   */
  alertBudgetPolicy?: AlertBudgetPolicy;
  /**
   * Typed event bus — required when alertBudgetPolicy is set for the
   * aggregator subscription to attach.
   */
  eventBus?: TypedEventBus;
}

// ---------------------------------------------------------------------------
// Emitter
// ---------------------------------------------------------------------------

/**
 * Collect startup invariants and emit:
 *   1. One `daemon:startup_invariants` INFO record with all 8 fields.
 *   2. WARN(s) with errorKind:"config" + hint when duplicate wiring detected.
 *   3. Optional: attach health budget aggregator when alertBudgetPolicy + eventBus provided.
 *
 * Must be called AFTER all boot stages complete and BEFORE the DaemonInstance
 * handle is returned (i.e., before the daemon accepts traffic).
 *
 * Does NOT crash the daemon — logs loud and continues (operator decides).
 *
 * Returns the aggregator unsubscribe function when attached (call on daemon shutdown),
 * or `undefined` when alertBudgetPolicy/eventBus are not provided.
 */
export function emitStartupInvariants(deps: StartupInvariantsDeps): (() => void) | undefined {
  // ── Collect invariant fields ──────────────────────────────────────────────

  // adaptersByChannelType: one entry per dedup'd channelType (value always 1
  // in post-fix wiring — the seam is that handlersPerAdapter reflects the RAW
  // pre-dedup count, which is what exposes regressions).
  const adaptersByChannelType: Record<string, number> = Object.fromEntries(
    [...deps.adaptersByType.keys()].map((k) => [k, 1] as [string, number]),
  );

  // handlersPerAdapter: raw pre-dedup count per channelType.
  const handlersPerAdapter: Record<string, number> = Object.fromEntries(
    [...deps.rawHandlerCounts.entries()],
  );

  const pluginRegistryCount = deps.pluginRegistry.count();
  const channelRegistryCount = deps.channelPlugins.size;
  const agentCount = Object.keys(deps.agentsConfig).length;
  const toolCatalogSize = deps.mcpClientManager.getTools().length;
  // mcpServerCount: number of distinct MCP servers is approximated as 0 when
  // no getConnections() seam is present. The tool catalog size already surfaces
  // the relevant signal; the server count is a best-effort additive metric.
  const mcpServerCount = 0;

  const invariants: StartupInvariants = {
    adaptersByChannelType,
    handlersPerAdapter,
    pluginRegistryCount,
    channelRegistryCount,
    depSlotConsistency: deps.depSlotConsistency,
    agentCount,
    toolCatalogSize,
    mcpServerCount,
  };

  // ── Emit the INFO record ─────────────────────────────────────────────────
  deps.logger.info(invariants, "daemon:startup_invariants");

  // ── Non-blocking startup sweep ──────────────────────────────────────────
  // Fires AFTER the invariant emit so the sweep's best-effort WARN logs do
  // not pollute the invariant record. Errors are caught inside sweepRotatedFiles.
  if (deps.logRotationPolicy && deps.logsDir) {
    void sweepRotatedFiles(deps.logsDir, deps.logRotationPolicy, {
      logger: deps.logger,
    });
  }

  // ── Emit WARN(s) on duplicate wiring ─────────────────────────────────────
  // Check AFTER the INFO emit so the record is always present even when WARNs
  // fire.

  for (const [channelType, count] of Object.entries(handlersPerAdapter)) {
    if (count > 1) {
      deps.logger.warn(
        {
          channelType,
          count,
          hint: "Duplicate adapter registration detected; see AGENTS.md §6.1",
          errorKind: "config" as const,
        },
        "Duplicate adapter registration detected at startup",
      );
    }
  }

  if (deps.depSlotConsistency.adaptersList === true) {
    deps.logger.warn(
      {
        hint: "Duplicate adapter registration detected; see AGENTS.md §6.1",
        errorKind: "config" as const,
        adaptersList: true,
      },
      "Channel adapters wired via legacy deps.adapters slot; see AGENTS.md §6.1",
    );
  }

  // ── Attach health budget aggregator ──────────────────────────────────────
  // Attach AFTER the invariant emit so the aggregator is not running during
  // the record construction, and AFTER the rotation sweep so the
  // aggregator's first window starts with a clean log state.
  if (deps.alertBudgetPolicy && deps.eventBus) {
    return createHealthAggregator({
      eventBus: deps.eventBus,
      policy: deps.alertBudgetPolicy,
      logger: deps.logger,
    });
  }
  return undefined;
}
