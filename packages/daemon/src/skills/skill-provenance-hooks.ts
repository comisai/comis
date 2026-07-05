// SPDX-License-Identifier: Apache-2.0
/**
 * Post-mutation provenance + MCP consequence hooks for the skill RPC handlers.
 *
 * Two hooks the delete / update handlers call after their file-system mutation:
 *
 *   - `unwindImportedSkillOnDelete` — after a skill directory is removed,
 *     disconnect + drop the skill's bundle-owned MCP entries AND remove its
 *     provenance record. The MCP unwind is keyed on the installed-bundles
 *     OWNERSHIP LEDGER (not the provenance store), so it also fires for a legacy
 *     bundle-owning skill that predates the provenance store. Without this an
 *     imported skill's disabled MCP entries would orphan in `config.yaml` after
 *     the skill is gone.
 *
 *   - `repinLocallyModifiedSkill` — after an authorized local edit, recompute the
 *     content hash over the edited install set, bump `updatedAt`, and mark the
 *     record `locallyModified` so a later re-import can see the divergence. A
 *     hand-created (unprovenanced) skill has no pin — the re-pin is then a no-op.
 *
 * Both take the shared GLOBAL import lock (`SKILL_IMPORT_COMMIT_LOCK`) around the
 * provenance mutation, because the provenance store is one shared file and the
 * import commit writes it under the SAME lock — a different lock domain would
 * let a concurrent import lose an update.
 *
 * Extracted from `skill-handlers.ts` so that file stays under the per-file line
 * cap; kept OUT of `bundle-install-helper.ts` so the delete/update tests exercise
 * the real hooks (that module is mocked wholesale in the handler test).
 *
 * @module
 */

import { readFileSync } from "node:fs";
import { ok, err, type Result } from "@comis/shared";
import { safePath, systemNowDate, type McpServerEntry } from "@comis/core";
import {
  readProvenanceStore,
  writeProvenanceRecord,
  removeProvenanceRecord,
  provenanceKey,
  computeInstalledSetHash,
  withSkillImportLock,
  SKILL_IMPORT_COMMIT_LOCK,
  type ProvenanceRecord,
} from "@comis/skills";
import { persistMcpServers } from "../api/shared/persist-mcp-servers.js";
import { readBundleInstallState, forgetBundle } from "./bundle-install-state.js";
import type { WorkspaceApiDeps } from "../api/types.js";

// ---------------------------------------------------------------------------
// Delete unwind (PROV-05)
// ---------------------------------------------------------------------------

/** Args identifying the deleted skill (scope/agent/name key the provenance store). */
export interface DeleteUnwindArgs {
  readonly scope: "local" | "shared";
  readonly agentId: string;
  readonly name: string;
  readonly ctx?: { userId?: string; traceId?: string };
}

/** What the delete unwind did (for logging + tests). */
export interface UnwindOutcome {
  /** Ledger-owned MCP server names for this skill (removed from the config). */
  readonly ownedServers: readonly string[];
  /** The subset that were live and were disconnected. */
  readonly disconnected: readonly string[];
  /** Whether a provenance record existed and was removed. */
  readonly provenanceRemoved: boolean;
}

/**
 * Unwind a deleted skill's bundle-owned MCP entries + provenance record.
 *
 * Reads the ownership ledger for `name`; for each owned server it disconnects a
 * live connection (best-effort) and drops the persisted entry (a single
 * `persistMcpServers` write of the filtered array). Then forgets the ledger
 * (fires for a legacy bundle-owning skill too, since the key is the ledger, not
 * the provenance record) and removes the provenance record.
 *
 * @returns the {@link UnwindOutcome} on success, or an operator-facing message
 *   when a ledger/store write fails (the caller logs it — the skill is already
 *   deleted, so the caller does not fail the delete on an unwind error).
 */
export async function unwindImportedSkillOnDelete(
  deps: WorkspaceApiDeps,
  args: DeleteUnwindArgs,
): Promise<Result<UnwindOutcome, { message: string }>> {
  const dataDir = (deps.container?.config?.dataDir as string | undefined) ?? "";
  if (dataDir.length === 0) {
    return err({ message: "no data dir available to unwind the deleted skill's bundle state" });
  }
  const owned = Object.keys(readBundleInstallState(dataDir)[args.name] ?? {});
  const key = provenanceKey(args.scope, args.agentId, args.name);
  const disconnected: string[] = [];

  // Serialize the config mutation + provenance removal on the SAME global lock
  // the import commit uses, so a concurrent import cannot lose an update.
  return withSkillImportLock(
    SKILL_IMPORT_COMMIT_LOCK,
    async (): Promise<Result<UnwindOutcome, { message: string }>> => {
      if (owned.length > 0) {
        const ownedSet = new Set(owned);
        for (const serverName of owned) {
          const conn = deps.mcpClientManager.getConnection(serverName);
          if (conn === undefined) continue;
          try {
            await deps.mcpClientManager.disconnect(serverName);
            disconnected.push(serverName);
          } catch (e) {
            deps.logger.warn(
              {
                skillName: args.name,
                serverName,
                err: (e as Error).message,
                hint: "the persisted entry is still removed below; run 'mcp.disconnect' if the server lingers",
                errorKind: "dependency" as const,
              },
              "skill delete unwind: MCP disconnect failed",
            );
          }
        }
        const current = ((deps.container?.config?.integrations as
          | { mcp?: { servers?: McpServerEntry[] } }
          | undefined)?.mcp?.servers ?? []) as McpServerEntry[];
        const next = current.filter((s) => !ownedSet.has(s.name));
        const persistOutcome = await persistMcpServers(deps, next, "mcp.disconnect", args.name, args.ctx);
        if (persistOutcome.persistence === "runtime_only") {
          deps.logger.warn(
            {
              skillName: args.name,
              hint: "the bundled MCP entries were removed in-memory but the config.yaml write failed; re-run the delete or edit config.yaml",
              errorKind: "config" as const,
            },
            "skill delete unwind: config write failed",
          );
        }
      }

      // Forget the ownership ledger (fires for legacy bundle-owning skills too).
      const forgot = forgetBundle(dataDir, args.name);
      if (!forgot.ok) {
        return err({ message: `failed to forget the bundle ownership ledger: ${forgot.error.message}` });
      }

      // Remove the provenance record (idempotent for an absent key).
      const hadRecord = readProvenanceStore(dataDir)[key] !== undefined;
      const removed = await removeProvenanceRecord(dataDir, key);
      if (!removed.ok) {
        return err({ message: `failed to remove the provenance record: ${removed.error.message}` });
      }

      return ok({ ownedServers: owned, disconnected, provenanceRemoved: hadRecord });
    },
  );
}

// ---------------------------------------------------------------------------
// Update re-pin (PROV-04 local-edit path)
// ---------------------------------------------------------------------------

/** Args identifying the edited skill + its live directory (for the hash recompute). */
export interface RepinArgs {
  readonly scope: "local" | "shared";
  readonly agentId: string;
  readonly name: string;
  /** Absolute path to the live skill directory (the recorded files are read from here). */
  readonly location: string;
}

/** What the re-pin did (for logging + tests). */
export interface RepinOutcome {
  /** Whether a provenance record existed and was re-pinned. */
  readonly repinned: boolean;
  /** The recomputed content hash (present only when re-pinned). */
  readonly contentHash?: string;
}

/**
 * Re-pin a locally-edited imported skill's provenance record: recompute the
 * content hash over the recorded install set (read fresh from disk), bump
 * `updatedAt`, and set `locallyModified: true`. `importedAt` + the acquisition
 * `source`/`identifier` are preserved — this is an authorized, visible
 * divergence from the imported pin, not a new import.
 *
 * A skill with no provenance record (a hand-created skill, or a pre-provenance
 * legacy import) is a no-op (`repinned: false`) — there is no pin to refresh.
 */
export async function repinLocallyModifiedSkill(
  deps: WorkspaceApiDeps,
  args: RepinArgs,
): Promise<Result<RepinOutcome, { message: string }>> {
  const dataDir = (deps.container?.config?.dataDir as string | undefined) ?? "";
  if (dataDir.length === 0) {
    return err({ message: "no data dir available to re-pin the edited skill" });
  }
  const key = provenanceKey(args.scope, args.agentId, args.name);

  return withSkillImportLock(
    SKILL_IMPORT_COMMIT_LOCK,
    async (): Promise<Result<RepinOutcome, { message: string }>> => {
      const existing = readProvenanceStore(dataDir)[key];
      if (existing === undefined) {
        return ok({ repinned: false });
      }
      // Recompute the pin over the recorded files as they are on disk now.
      const files: Array<{ relPath: string; bytes: Buffer }> = [];
      for (const rel of existing.files) {
        let abs: string;
        try {
          abs = safePath(args.location, rel);
        } catch {
          return err({ message: `recorded file path '${rel}' would escape the skill directory` });
        }
        try {
          files.push({ relPath: rel, bytes: readFileSync(abs) });
        } catch (e) {
          return err({ message: `failed to read installed file '${rel}' for re-pin: ${(e as Error).message}` });
        }
      }
      const contentHash = computeInstalledSetHash(files);
      const updated: ProvenanceRecord = {
        ...existing,
        contentHash,
        updatedAt: systemNowDate().toISOString(),
        locallyModified: true,
      };
      const written = await writeProvenanceRecord(dataDir, updated);
      if (!written.ok) {
        return err({ message: `failed to re-pin the provenance record: ${written.error.message}` });
      }
      return ok({ repinned: true, contentHash });
    },
  );
}
