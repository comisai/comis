// SPDX-License-Identifier: Apache-2.0
/**
 * BOOT-01/02: Startup invariant collector and WARN emitter.
 *
 * Collects counts from all registries after boot completes and emits a single
 * `daemon:startup_invariants` INFO record. If any invariant indicates duplicate
 * adapter wiring, emits a WARN with errorKind:"config" BEFORE the daemon accepts
 * traffic (per design §5 D10, §9.2).
 *
 * Called from daemon.ts bootShutdown() immediately after emitStartupBanner().
 *
 * @module
 */
import type { ComisLogger } from "@comis/infra";
import type { ChannelPort } from "@comis/core";

// ---------------------------------------------------------------------------
// StartupInvariants interface (verbatim from design §5 D10)
// ---------------------------------------------------------------------------

/**
 * Snapshot of daemon wiring state captured at the end of successful boot.
 * All values are counts or boolean flags — no secrets, paths, or message bodies.
 * See design §12 security note.
 */
export interface StartupInvariants {
  adaptersByChannelType: Record<string, number>;       // expected count === 1 per type
  handlersPerAdapter:    Record<string, number>;       // expected === 1 per adapter
  pluginRegistryCount:   number;
  channelRegistryCount:  number;
  depSlotConsistency: {
    adaptersList:     boolean;   // expected false (removed in 2026-05-24 fix)
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
   * (the only site that knows which slots were used). Post-fix wiring:
   * { adaptersList: false, channelRegistry: true }.
   */
  depSlotConsistency: {
    adaptersList:    boolean;   // expected false post-fix
    channelRegistry: boolean;   // expected true post-fix
  };
}

// ---------------------------------------------------------------------------
// Emitter
// ---------------------------------------------------------------------------

/**
 * Collect startup invariants and emit:
 *   1. One `daemon:startup_invariants` INFO record with all 8 fields (BOOT-01).
 *   2. WARN(s) with errorKind:"config" + §6.1 hint when duplicate wiring detected (BOOT-02).
 *
 * Must be called AFTER all boot stages complete and BEFORE the DaemonInstance
 * handle is returned (i.e., before the daemon accepts traffic).
 *
 * Does NOT crash the daemon — logs loud and continues (operator decides).
 */
export function emitStartupInvariants(deps: StartupInvariantsDeps): void {
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

  // ── BOOT-01: emit the INFO record ────────────────────────────────────────
  deps.logger.info(invariants, "daemon:startup_invariants");

  // ── BOOT-02: emit WARN(s) on duplicate wiring ────────────────────────────
  // Check AFTER the INFO emit so the record is always present even when WARNs
  // fire. Both checks use the verbatim §6.1 hint per REQUIREMENTS.md BOOT-02.

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
}
