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
import { ok, err, type Result } from "@comis/shared";
import { safePath, systemNowDate, type McpServerEntry } from "@comis/core";
import {
  DEFAULT_UNPACK_CAPS,
  computeInstalledSetHash,
  readProvenanceStore,
  provenanceKey,
  resolveWellKnown,
  createSkillIndexCache,
  type AcquireInput,
  type AcquisitionSource,
  type UnpackCaps,
  type SkillScope,
  type ImportReject,
  type WellKnownResolved,
  type WellKnownResolveDeps,
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

// ---------------------------------------------------------------------------
// Well-known registry resolve behind the fail-closed allowlist gate (WK-02)
// ---------------------------------------------------------------------------

/** The reserved non-URL registry token a later ClawHub branch owns; never fetched here. */
const CLAWHUB_REGISTRY_TOKEN = "clawhub";

/**
 * Normalize a registry string to a comparable key: an http(s) URL collapses to
 * its port-preserving, lowercased-host origin (`new URL().origin`); the reserved
 * `clawhub` token passes through verbatim; any other non-URL string is returned
 * trimmed as-is, so it can never match a normalized origin (fail closed).
 */
function normalizeRegistryOrigin(registry: string): string {
  const trimmed = registry.trim();
  if (trimmed === CLAWHUB_REGISTRY_TOKEN) return CLAWHUB_REGISTRY_TOKEN;
  try {
    return new URL(trimmed).origin;
  } catch {
    return trimmed;
  }
}

/** Arguments for {@link resolveWellKnownFileSet}. */
export interface ResolveWellKnownFileSetArgs {
  /** The requested registry: a normalized origin, or the reserved clawhub token. */
  readonly registry: string;
  /** The registry index-lookup key — which advertised skill to fetch. */
  readonly name: string;
  readonly scope: SkillScope;
  readonly agentId: string;
  readonly ctx?: ImportCtx;
  /**
   * Test-only overrides forwarded verbatim to {@link resolveWellKnown}. Production
   * omits — the real SSRF validate/fetch primitives + an on-disk index cache run.
   */
  readonly overrides?: Pick<WellKnownResolveDeps, "validate" | "fetchImpl" | "cache">;
}

/**
 * Resolve a well-known registry skill to its `{ path → content }` file set, behind
 * the fail-closed allowlist gate.
 *
 * WK-02: the requested registry origin MUST be a member of the caps-owning agent's
 * `skills.import.registries`. The caps-owning agent is the DEFAULT agent for a
 * shared import and the caller for a local one (matches {@link resolveCaps} + the
 * shared-write guard), so a shared import can never inherit a non-default agent's
 * allowlist. A non-member refuses FLATLY — a config edit, NEVER `confirm`-
 * overridable (the gate does not branch on confirm) — and the refusal happens
 * BEFORE the resolver opens any connection. A default-empty allowlist therefore
 * blocks every registry import while leaving archive / GitHub imports untouched.
 *
 * On pass, the resolver runs with the agent's per-file caps + a bounded on-disk
 * index cache; its typed reject is mapped to the runner's {@link ImportReject}
 * (hint + errorKind preserved).
 */
export async function resolveWellKnownFileSet(
  deps: WorkspaceApiDeps,
  args: ResolveWellKnownFileSetArgs,
): Promise<Result<WellKnownResolved, ImportReject>> {
  const capsAgent = args.scope === "shared" ? deps.defaultAgentId : args.agentId;
  const registries = deps.agents[capsAgent]?.skills?.import?.registries ?? [];

  const requestedOrigin = normalizeRegistryOrigin(args.registry);
  const allowed = registries.some((entry) => normalizeRegistryOrigin(entry) === requestedOrigin);
  if (!allowed) {
    // Fail closed BEFORE any fetch. The allowlist is a config decision; confirm is
    // never consulted here, so a registry miss can never be overridden at import time.
    deps.logger.warn(
      {
        submodule: "wellknown-gate",
        errorKind: "precondition" as const,
        hint: "add the registry's normalized origin to skills.import.registries",
        registryOrigin: requestedOrigin,
      },
      "skill import: registry not in the skills.import.registries allowlist — refused",
    );
    return err({
      stage: "acquire",
      message: `the registry "${args.registry}" is not in the skills.import.registries allowlist`,
      hint: "add the registry's normalized origin to skills.import.registries to permit the import — this is a config edit; confirm does not override it",
      errorKind: "precondition",
    });
  }

  const caps = resolveCaps(deps, capsAgent);
  const dataDir = (deps.container.config.dataDir as string | undefined) ?? ".";
  const cache =
    args.overrides?.cache ?? createSkillIndexCache({ cacheDir: safePath(dataDir, "skill-index-cache") });

  const resolveDeps: WellKnownResolveDeps = {
    caps: { maxFileCount: caps.maxFileCount, maxFileBytes: caps.maxFileBytes },
    cache,
    logger: deps.logger,
    ...(args.overrides?.validate !== undefined && { validate: args.overrides.validate }),
    ...(args.overrides?.fetchImpl !== undefined && { fetchImpl: args.overrides.fetchImpl }),
  };

  const resolved = await resolveWellKnown({ registry: args.registry, name: args.name }, resolveDeps);
  if (!resolved.ok) {
    const e = resolved.error;
    return err({ stage: "acquire", message: e.message, hint: e.hint, errorKind: e.errorKind });
  }
  return resolved;
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
