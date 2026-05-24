// SPDX-License-Identifier: Apache-2.0
/**
 * Phase 68 BUNDLE Plan 01 — extracted persistMcpServers helper.
 *
 * Extracted from `packages/daemon/src/api/mcp-handlers.ts` (lines 85-227 in
 * the pre-extraction file). Two motivations:
 *
 *   1. AGENTS.md §2.3 rule-of-three. Phase 62 was the first consumer
 *      (mcp.connect / mcp.disconnect). Phase 68's bundle-install path
 *      (Plan 04) and boot-orchestrator (Plan 05) are the SECOND and THIRD
 *      consumers. The Phase 62 CONTEXT.md `<deferred>` note explicitly
 *      called this out: "Helper extraction (persistMcpServers → shared
 *      module) — defer until Phase 68 becomes the second consumer."
 *
 *   2. File-size cap. `mcp-handlers.ts` was at 798/800 lines pre-extraction;
 *      adding the bundle-install entry-points would have pushed it past the
 *      cap. Extracting frees ~140 lines.
 *
 * SINGLE-WRITER invariant: this helper is the ONLY sanctioned mutation path
 * for `container.config.integrations.mcp.servers`. The bundle resolver
 * computes a `nextServers: McpServerEntry[]` array; the install handler /
 * boot orchestrator pass it through THIS function. Raw writes to the
 * servers array (e.g. `deepMerge` patches at the config-handler layer) are
 * explicitly rejected at config-handlers.ts (R9).
 *
 * Behavior is byte-identical to the pre-extraction body in mcp-handlers.ts.
 * The ONLY structural change is that the `actionType` parameter union has
 * been widened to also accept the two NEW literals Plans 04 and 05 will
 * pass (`"skills.bundle.install"` / `"skills.bundle.boot"`). Existing
 * callers (`mcp.connect`, `mcp.disconnect`) are unaffected — the original
 * two literals remain in the union — and the helper does NOT branch on
 * actionType internally (it is threaded through to persistToConfig and the
 * audit JSONL record as a provenance string).
 *
 * @module
 */

// `McpServerEntry` — the Zod-inferred shape of a persisted MCP server
// entry (integrations.mcp.servers[i]) — is the canonical type for the
// persistMcpServers helper's new-array computation. Already re-exported
// from `@comis/core` (packages/core/src/exports/config.ts:188), so a
// direct named import is the correct path here (no deep-path subpath).
import type { McpServerEntry } from "@comis/core";
import { persistToConfig } from "./persist-to-config.js";
import {
  buildConfigAuditBase,
  appendConfigAuditWithOutcome,
} from "../../config/audit-hook.js";
// Phase 64 RELY-07/08: diff + 500ms debounce + singleton all extracted (Phase 63 precedent).
import { getCoalescer, computeMcpDiff } from "../mcp-config-mutated-coalescer.js";
import type { WorkspaceApiDeps } from "../types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * D-04 outcome shape — the persistMcpServers result spliced into
 * McpConnect/McpDisconnect responses (and, in Phase 68, the
 * skills.import / skills.create / skills.upload bundle-install path).
 */
export interface PersistMcpResult {
  persistence: "persisted" | "runtime_only" | "skipped";
  warning?: string;
}

/**
 * Phase 47: Persist the full integrations.mcp.servers array to config.yaml
 * + emit one config-audit JSONL record. Idempotent — re-calling with the
 * same actionType/entityId produces multiple JSONL records but converges
 * the YAML to the desired state.
 *
 * Mirrors the channels.enable persist call (channel-handlers.ts:232-248)
 * with three deviations:
 *   1. Full-array patch (deepMerge replaces arrays; caller computes it).
 *   2. Direct appendConfigAuditWithOutcome call after persistToConfig
 *      because persistToConfig's audit:event has no JSONL subscriber
 *      (RESEARCH.md §"R8 Audit JSONL Field-Name Verification").
 *   3. Returns D-04 outcome for the caller to splice into the response.
 *
 * @param deps - Workspace API deps slice (must contain persistDeps for the
 *   persist path to fire; otherwise short-circuits to "skipped").
 * @param servers - The FULL new integrations.mcp.servers array. Caller is
 *   responsible for the read-current + filter-by-name + append/remove
 *   computation (deepMerge replaces arrays wholesale).
 * @param actionType - Provenance literal threaded to the persistToConfig
 *   audit record AND the JSONL record's callerSource. The four legal values
 *   are the two Phase 62 originals ("mcp.connect" / "mcp.disconnect") plus
 *   the two Phase 68 bundle literals ("skills.bundle.install" /
 *   "skills.bundle.boot"). Helper does NOT branch on this value internally.
 * @param entityId - The server_name (or, for bundle calls, the skill-id);
 *   surfaced in audit:event provenance.
 * @param ctx - Internal _context bag with optional userId + traceId.
 */
export async function persistMcpServers(
  deps: WorkspaceApiDeps,
  servers: McpServerEntry[],
  actionType: "mcp.connect" | "mcp.disconnect" | "skills.bundle.install" | "skills.bundle.boot",
  entityId: string,
  ctx: { userId?: string; traceId?: string } | undefined,
): Promise<PersistMcpResult> {
  if (!deps.persistDeps) {
    return { persistence: "skipped" };
  }

  // Local config path: LAST entry of configPaths if non-empty, else LAST
  // of defaultConfigPaths. Mirrors persist-to-config's own resolution.
  const localPath = deps.persistDeps.configPaths.length > 0
    ? deps.persistDeps.configPaths[deps.persistDeps.configPaths.length - 1]!
    : deps.persistDeps.defaultConfigPaths[deps.persistDeps.defaultConfigPaths.length - 1]!;

  // PHASE 1: capture pre-write state (previousHash, stat snapshot).
  const auditBase = buildConfigAuditBase(localPath, actionType);

  // PHASE 2: write.
  const persistResult = await persistToConfig(deps.persistDeps, {
    patch: { integrations: { mcp: { servers } } },
    skipRestart: true,
    actionType,
    entityId,
    ...(ctx?.userId !== undefined && { actingUser: ctx.userId }),
    ...(ctx?.traceId !== undefined && { traceId: ctx.traceId }),
  });

  // PHASE 3: finalize audit JSONL + return outcome.
  if (persistResult.ok) {
    appendConfigAuditWithOutcome(auditBase, { kind: "rename" }, deps.persistDeps.logger);

    // D-07/D-08/PERSIST-08: in-memory atomic swap. Disk write succeeded; refresh
    // `container.config.integrations` so concurrent readers (obs_query, mcp.list,
    // dashboards) see the new entry without a restart. Per D-08, clone the FULL
    // integrations subtree (NOT just .mcp.servers) so mid-update readers observe
    // the pre- OR post-state, never a partial array. Optional-chain on
    // `deps.container?.config` (test fixtures omit container). structuredClone is
    // a Node 22 built-in.
    if (deps.container?.config) {
      // Treat the subtree as a mutable record shape — IntegrationsConfigSchema
      // applies its strict-object defaults at config-load time, so by the
      // time this code runs in production `integrations.mcp` is always
      // present. Tests that pass through this path provide at least
      // `{ integrations: { mcp: { servers } } }`. We use a record shape
      // (not the IntegrationsConfig type) so the structuredClone result is
      // freely reassignable through the same key paths.
      type MutableIntegrations = Record<string, Record<string, unknown>>;
      const integrationsIn = deps.container.config.integrations as
        | MutableIntegrations
        | undefined;
      // WR-05: integrations missing in-memory still needs a swap value, but the
      // data-loss case (disk-state braveSearch/media/autoReply dropped from the
      // in-memory view until reload) gets an observable log line. In production
      // IntegrationsConfigSchema defaults guarantee `integrations` is present, so
      // this branch only fires in partial-load failures or test fixtures.
      if (integrationsIn === undefined) {
        deps.persistDeps.logger.warn(
          {
            method: actionType,
            entityId,
            hint:
              "container.config.integrations was undefined at the in-memory swap " +
              "site — any sibling subkeys (braveSearch, media, autoReply) " +
              "from disk are NOT visible in-memory until the next reload",
            errorKind: "config" as const,
          },
          "MCP persist swap: integrations subtree was undefined in-memory",
        );
      }
      // Phase 64 RELY-08: diff BEFORE swap; trailing-edge 500ms emit AFTER swap.
      const prev = (integrationsIn?.mcp?.servers as McpServerEntry[] | undefined) ?? [];
      const { added, removed } = computeMcpDiff(prev, servers);
      const cloned = structuredClone((integrationsIn ?? {}) as MutableIntegrations);
      if (!cloned.mcp) cloned.mcp = {};
      cloned.mcp.servers = servers;
      // Atomic single-property write. Readers reach `.integrations` via a
      // single property access on `container.config`; this assignment is
      // a single write, so JS's single-threaded execution model guarantees
      // observers see pre-OR-post, never partial.
      (deps.container.config as { integrations: unknown }).integrations = cloned;
      if (deps.eventBus) getCoalescer(deps.eventBus, deps.persistDeps.logger).schedule(added, removed);
    }

    return { persistence: "persisted" };
  } else {
    appendConfigAuditWithOutcome(
      auditBase,
      { kind: "failed", message: persistResult.error },
      deps.persistDeps.logger,
    );
    deps.persistDeps.logger.warn(
      {
        method: actionType,
        entityId,
        err: persistResult.error,
        hint: "MCP server runtime-mutated but config.yaml write failed",
        errorKind: "config" as const,
      },
      "MCP config persistence failed",
    );
    return { persistence: "runtime_only", warning: persistResult.error };
  }
}
