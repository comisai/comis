// SPDX-License-Identifier: Apache-2.0
/**
 * Retrofit glue: route the shipped GitHub-import and raw-upload RPC paths
 * through the SINGLE `runSkillImport` orchestration so the unconditional content
 * scan + the MCP Phase-A check always run PRE-write (closing the shipped
 * write-then-scan-at-load gap), the install is stamped the `imported` trust
 * tier, and its provenance is pinned.
 *
 * This module builds the `SkillImportDeps` from the daemon container + wires the
 * imported-tier MCP persist seam (`applyImportedBundleInstall` — persists
 * `enabled:false`, never auto-connects) so the retrofit exercises the real
 * imported-tier posture rather than a parallel install path.
 *
 * @module
 */

import { createHash } from "node:crypto";
import { ok, type Result } from "@comis/shared";
import { safePath, systemNowDate, type McpServerEntry } from "@comis/core";
import {
  DEFAULT_UNPACK_CAPS,
  computeInstalledSetHash,
  readProvenanceStore,
  provenanceKey,
  type AcquireInput,
  type AcquisitionSource,
  type UnpackCaps,
  type SkillScope,
  type ImportReject,
} from "@comis/skills";
import { runSkillImport, type SkillImportDeps, type CommitResult } from "./import-commit.js";
import { readBundleInstallState } from "./bundle-install-state.js";
import { applyImportedBundleInstall } from "./bundle-install-helper.js";
import type { WorkspaceApiDeps } from "../api/types.js";

/** Fallback body-length ceiling when the agent has no explicit skills config. */
const DEFAULT_MAX_BODY_LENGTH = 20_000;

/** The optional actor context threaded from the dispatcher's raw params. */
export type ImportCtx = { userId?: string; traceId?: string } | undefined;

interface McpConfigRoot {
  servers?: McpServerEntry[];
  osvCheckEnabled?: boolean;
  osvCacheTtlMs?: number;
}

/** Resolve the per-agent unpack caps, defaulting to the schema defaults. */
function resolveCaps(deps: WorkspaceApiDeps, agentId: string): UnpackCaps {
  return deps.agents[agentId]?.skills?.import ?? DEFAULT_UNPACK_CAPS;
}

/** Resolve the per-agent body-length ceiling (the pipeline pre-validates against it). */
function resolveMaxBodyLength(deps: WorkspaceApiDeps, agentId: string): number {
  return deps.agents[agentId]?.skills?.promptSkills?.maxBodyLength ?? DEFAULT_MAX_BODY_LENGTH;
}

/**
 * Build the {@link SkillImportDeps} for one import from the daemon container.
 * `skillsDir` is the scope-resolved LIVE skills base dir — the commit moves the
 * staged tree into `<skillsDir>/<manifest-name>`. `caps`/`maxBodyLength` read
 * the config of the caps-owning agent (the default agent for a shared import).
 */
export function buildSkillImportDeps(
  deps: WorkspaceApiDeps,
  args: { scope: SkillScope; agentId: string; skillsDir: string; ctx: ImportCtx },
): SkillImportDeps {
  const dataDir = (deps.container.config.dataDir as string | undefined) ?? ".";
  const mcpRoot = (deps.container.config.integrations as { mcp?: McpConfigRoot } | undefined)?.mcp;
  const capsAgent = args.scope === "shared" ? deps.defaultAgentId : args.agentId;
  return {
    dataDir,
    skillsDir: args.skillsDir,
    tmpRoot: safePath(dataDir, "tmp"),
    logger: deps.logger,
    caps: resolveCaps(deps, capsAgent),
    maxBodyLength: resolveMaxBodyLength(deps, capsAgent),
    ...(mcpRoot?.osvCheckEnabled !== undefined && { osvCheckEnabled: mcpRoot.osvCheckEnabled }),
    ...(mcpRoot?.osvCacheTtlMs !== undefined && { osvCacheTtlMs: mcpRoot.osvCacheTtlMs }),
    readCurrentMcpServers: () => (mcpRoot?.servers ?? []) as McpServerEntry[],
    readInstalledBundleState: () => (dataDir.length > 0 ? readBundleInstallState(dataDir) : {}),
    reinitRegistry: () => {
      if (args.scope === "shared" && deps.skillRegistries) {
        for (const reg of deps.skillRegistries.values()) reg.init();
      } else {
        deps.skillRegistries?.get(args.agentId)?.init();
      }
    },
    // Imported tier: persist bundled MCP entries disabled + never auto-connect.
    persistImportedBundle: (bundleArgs) =>
      applyImportedBundleInstall(deps, dataDir, bundleArgs, args.ctx),
    ...(deps.eventBus && { eventBus: deps.eventBus }),
    now: () => systemNowDate().toISOString(),
  };
}

/**
 * Provenance identifier for an uploaded file set — sha256 over the canonicalized
 * uploaded {path,content} set (an upload has no stable upstream identity, so its
 * update path is delete + re-upload).
 */
export function uploadFileSetIdentifier(
  files: readonly { path: string; content: string }[],
): string {
  const hash = computeInstalledSetHash(
    files.map((f) => ({ relPath: f.path, bytes: Buffer.from(f.content, "utf-8") })),
  );
  return `upload:sha256:${hash}`;
}

/** Provenance identifier for uploaded archive bytes — sha256 over the archive. */
export function archiveBytesIdentifier(base64: string): string {
  const hash = createHash("sha256").update(Buffer.from(base64, "base64")).digest("hex");
  return `upload:sha256:${hash}`;
}

/** The successful retrofit-import outcome, with the installed-file count. */
export interface RetrofitImportResult {
  readonly commit: CommitResult;
  readonly fileCount: number;
}

/**
 * Run one retrofit import through the staged pipeline. `skillsDir` is the
 * scope-resolved live base dir; the manifest name determines the final folder.
 */
export async function importThroughPipeline(
  deps: WorkspaceApiDeps,
  args: {
    acquireInput: AcquireInput;
    source: AcquisitionSource;
    identifier: string;
    scope: SkillScope;
    agentId: string;
    skillsDir: string;
    confirm?: boolean;
    ctx: ImportCtx;
  },
): Promise<Result<RetrofitImportResult, ImportReject>> {
  const importDeps = buildSkillImportDeps(deps, {
    scope: args.scope,
    agentId: args.agentId,
    skillsDir: args.skillsDir,
    ctx: args.ctx,
  });
  const res = await runSkillImport(
    args.acquireInput,
    {
      source: args.source,
      identifier: args.identifier,
      scope: args.scope,
      agentId: args.agentId,
      ...(args.confirm !== undefined && { confirm: args.confirm }),
    },
    importDeps,
  );
  if (!res.ok) return res;
  const rec =
    readProvenanceStore(importDeps.dataDir)[provenanceKey(args.scope, args.agentId, res.value.name)];
  return ok({ commit: res.value, fileCount: rec?.files.length ?? 0 });
}

/** Format an import reject for the RPC-facing thrown Error (message + hint). */
export function formatImportReject(reject: ImportReject): string {
  return `${reject.message} — ${reject.hint}`;
}

/**
 * Attach a content-free provenance summary to each listed skill from the durable
 * provenance store. Advisory downward only — a skill with no import record is
 * returned unchanged. Both scope keys are probed so local + shared imports are
 * covered without needing the per-skill scope up front.
 */
export function enrichWithProvenanceSummary<T extends { name: string }>(
  descriptions: readonly T[],
  dataDir: string,
  agentId: string,
): Array<
  T & {
    provenanceSummary?: { source: AcquisitionSource; registry?: string; hashPrefix: string; importedAt: string };
  }
> {
  if (!dataDir || dataDir.length === 0) return [...descriptions];
  const store = readProvenanceStore(dataDir);
  return descriptions.map((d) => {
    const rec =
      store[provenanceKey("local", agentId, d.name)] ??
      store[provenanceKey("shared", agentId, d.name)];
    if (rec === undefined) return d;
    return {
      ...d,
      provenanceSummary: {
        source: rec.source,
        ...(rec.registry !== undefined && { registry: rec.registry }),
        hashPrefix: rec.contentHash.slice(0, 12),
        importedAt: rec.importedAt,
      },
    };
  });
}
