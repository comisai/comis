// SPDX-License-Identifier: Apache-2.0
/**
 * The single daemon-side skill-import orchestration + serialized commit.
 *
 * `runSkillImport` is the ONE path every import source flows through: it builds
 * the real `resolveBundle` Phase-A seam (from the current MCP config + the
 * installed-bundle trust root), injects it into `stageImport` so the bundle
 * check runs PRE-WRITE (a reject leaves zero live writes — the closed
 * post-move gap), and hands the staged result to `commitStagedImport`. The
 * GitHub / upload retrofit reuses this verbatim so Phase-A always runs pre-write.
 *
 * `commitStagedImport` is the transactional install. It runs the WHOLE critical
 * section under the per-`<scope>:<owner>:<name>` keyed lock (the module
 * singleton from `@comis/skills` — never a second daemon-side instance) with a
 * pinned order:
 *   1. collision routing (fresh / provenance-matched update / flat refuse);
 *   2. write the `commit.json` intent marker, assert same-device, MOVE the
 *      kept-only staged tree live (update parks the previous install first);
 *   3. write the provenance pin;
 *   4. re-discover skills;
 *   5. re-check the bundled MCP-server names + persist (imported tier).
 * Steps 3–5 run inside a SHARED GLOBAL lock nested in the per-skill lock: the
 * provenance store is one shared file (cross-skill concurrent writes would
 * otherwise lose a record), and the MCP-name re-check + persist must serialize
 * so two DIFFERENT-skill imports declaring the SAME server name cannot both
 * install (the second's re-check happens-after the first's persist and refuses).
 * Any failure at 3–5 unwinds the move AND the pin before the lock releases
 * (fresh: remove the moved-in dir + the just-written record; update: restore the
 * parked previous install AND re-write its prior provenance record), so no
 * installed-but-unprovenanced skill survives and a failed update never loses the
 * prior install — nor its pin, whose loss would silently re-present a
 * remote-authored skill as the platform-trusted `bundled` tier. A hard crash
 * mid-commit is reconciled at boot via `commit.json` (see `import-boot-sweep.ts`).
 *
 * @module
 */

import { existsSync, statSync, renameSync, rmSync } from "node:fs";
import { ok, err, type Result } from "@comis/shared";
import { safePath, systemNowMs, type McpServerEntry, type ErrorKind, type TypedEventBus } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import { ensureContainedDir, writeRegularFile } from "@comis/observability";
import {
  stageImport,
  provenanceKey,
  readProvenanceStore as skillsReadProvenanceStore,
  writeProvenanceRecord as skillsWriteProvenanceRecord,
  removeProvenanceRecord as skillsRemoveProvenanceRecord,
  withSkillImportLock,
  SKILL_IMPORT_COMMIT_LOCK,
  type StagedImport,
  type ImportReject,
  type ImportStage,
  type BundleCheckSeam,
  type SkillScope,
  type StageAuditContext,
  type AcquireInput,
  type UnpackCaps,
  type AcquisitionSource,
  type ProvenanceRecord,
} from "@comis/skills";
import { resolveBundle } from "./bundle-mcp-resolver.js";
import { formatBundleError } from "./bundle-install-helper.js";
import type { InstalledBundleState } from "./bundle-install-state.js";

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** The commit-intent marker file name written into the staging root. */
export const COMMIT_MARKER_FILENAME = "commit.json";

/**
 * The commit-intent marker persisted BEFORE the move so a crash mid-commit is
 * reconcilable at boot. `mode` selects the boot-sweep reconciliation branch;
 * `record` is the intended pin (its `contentHash` is what the update-case guard
 * compares against the on-disk record to decide "was the re-pin completed?").
 */
export interface CommitIntent {
  readonly mode: "fresh" | "update";
  /** Absolute path of the live skill directory the staged tree moved into. */
  readonly targetPath: string;
  /** sha256 over the installed set (== the intended record's contentHash). */
  readonly contentHash: string;
  /** The intended provenance record. */
  readonly record: ProvenanceRecord;
}

/** Options describing WHERE the import came from + how to route a collision. */
export interface RunSkillImportOpts {
  /** Acquisition channel (NOT the trust tier). */
  readonly source: AcquisitionSource;
  /** Source URL, or `upload:sha256:<hash>` for an upload. */
  readonly identifier: string;
  /** Target scope. */
  readonly scope: SkillScope;
  /** Owning / acting agent id. */
  readonly agentId: string;
  /** Overrides ONLY the pin-divergence warning on a provenance-matched update. */
  readonly confirm?: boolean;
}

/** Arguments handed to the injected imported-tier MCP persist seam. */
export interface PersistImportedBundleArgs {
  readonly skillId: string;
  /** The full next servers array (bundle entries carry `enabled: false`). */
  readonly nextServers: readonly McpServerEntry[];
  /** The skill's own bundle entries (for the ownership ledger). */
  readonly bundleEntries: readonly McpServerEntry[];
}

/**
 * Persist an imported-tier MCP bundle: `enabled: false`, NEVER auto-connected
 * (per-server opt-in re-runs OSV at the connect site). The real seam writes the
 * config + ownership ledger (Linux-tier); tests inject a stub. Omitted ⇒ the
 * persist step is skipped (the re-check still runs).
 */
export type PersistImportedBundle = (
  args: PersistImportedBundleArgs,
) => Promise<Result<void, { message: string }>>;

/** Dependencies for {@link runSkillImport} / {@link commitStagedImport}. */
export interface SkillImportDeps {
  /** Comis data dir (the provenance store + tmp staging live under it). */
  readonly dataDir: string;
  /** The live skills dir (usually `<dataDir>/skills`). */
  readonly skillsDir: string;
  /** The private staging root (usually `<dataDir>/tmp`). */
  readonly tmpRoot: string;
  /** Object-first logger (also forwarded to the pipeline + resolver). */
  readonly logger: ComisLogger;
  /** Bounded-unpack caps (from `config.skills.import`). */
  readonly caps: UnpackCaps;
  /** Body-length ceiling (from `config.promptSkills.maxBodyLength`). */
  readonly maxBodyLength: number;
  /** Forwarded to `resolveBundle` (from `config.integrations.mcp`). */
  readonly osvCheckEnabled?: boolean;
  readonly osvCacheTtlMs?: number;
  /** Current `integrations.mcp.servers` (read at stage-time AND commit re-check). */
  readonly readCurrentMcpServers: () => readonly McpServerEntry[];
  /** The installed-bundle trust root (`installed-bundles.json`). */
  readonly readInstalledBundleState: () => InstalledBundleState;
  /** Re-discover skills after the move (registry.init()). */
  readonly reinitRegistry: () => void;
  /** Persist the imported-tier MCP bundle (Linux-tier; omitted ⇒ skipped). */
  readonly persistImportedBundle?: PersistImportedBundle;
  /** Injectable provenance seams (default ⇒ the `@comis/skills` singletons). */
  readonly writeProvenanceRecord?: typeof skillsWriteProvenanceRecord;
  readonly removeProvenanceRecord?: typeof skillsRemoveProvenanceRecord;
  readonly readProvenanceStore?: typeof skillsReadProvenanceStore;
  /** Optional bus + actor context for obs. */
  readonly eventBus?: TypedEventBus;
  readonly audit?: StageAuditContext;
  /** ISO clock for provenance timestamps (injected — no ambient wall-clock read). */
  readonly now: () => string;
  /** Optional deterministic staging id (tests). */
  readonly stagingId?: string;
}

/** A content-free provenance digest for the install response. */
export interface ProvenanceSummary {
  readonly source: AcquisitionSource;
  readonly identifier: string;
  readonly contentHash: string;
  readonly importedAt: string;
}

/** The successful commit outcome. */
export interface CommitResult {
  readonly name: string;
  /** The live skill directory. */
  readonly path: string;
  /** The trust tier — always `imported`. */
  readonly source: "imported";
  /** Which routing branch ran. */
  readonly mode: "fresh" | "update" | "noop";
  readonly provenanceSummary: ProvenanceSummary;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function mkReject(
  stage: ImportStage,
  message: string,
  hint: string,
  errorKind: ErrorKind,
  extra?: { bundleKind?: string; needsConfirm?: boolean },
): ImportReject {
  return {
    stage,
    message,
    hint,
    errorKind,
    ...(extra?.bundleKind !== undefined && { bundleKind: extra.bundleKind }),
    ...(extra?.needsConfirm !== undefined && { needsConfirm: extra.needsConfirm }),
  };
}

/** True when both paths resolve to the same filesystem device (rename is atomic). */
function sameDevice(a: string, b: string): boolean {
  try {
    return statSync(a).dev === statSync(b).dev;
  } catch {
    return false;
  }
}

/** Best-effort removal of the whole staging root (marker + parked + any leftover staged). */
function cleanupStaging(importRoot: string): void {
  try {
    rmSync(importRoot, { recursive: true, force: true });
  } catch {
    /* best effort — the boot sweep reclaims any leftover staging dir */
  }
}

/** Write the commit-intent marker into the staging root (0o600, symlink-safe). */
function writeCommitMarker(importRoot: string, intent: CommitIntent): Result<void, { message: string }> {
  let markerPath: string;
  try {
    markerPath = safePath(importRoot, COMMIT_MARKER_FILENAME);
  } catch {
    return err({ message: "the commit marker path could not be constructed safely" });
  }
  const wr = writeRegularFile({ path: markerPath, content: JSON.stringify(intent, null, 2) });
  return wr.ok ? ok(undefined) : err({ message: `failed to write the commit marker: ${wr.error.message}` });
}

/**
 * Fail-safe parse of a `commit.json` marker (consumed by the boot sweep). A
 * malformed / non-object marker yields `undefined` so a corrupt marker never
 * throws during reconciliation.
 */
export function parseCommitIntent(raw: string): CommitIntent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const o = parsed as Record<string, unknown>;
  const record = o["record"];
  if (
    (o["mode"] !== "fresh" && o["mode"] !== "update") ||
    typeof o["targetPath"] !== "string" ||
    typeof o["contentHash"] !== "string" ||
    record === null ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    typeof (record as Record<string, unknown>)["contentHash"] !== "string"
  ) {
    return undefined;
  }
  return {
    mode: o["mode"] as "fresh" | "update",
    targetPath: o["targetPath"] as string,
    contentHash: o["contentHash"] as string,
    record: record as ProvenanceRecord,
  };
}

function toSummary(record: ProvenanceRecord): ProvenanceSummary {
  return {
    source: record.source,
    identifier: record.identifier,
    contentHash: record.contentHash,
    importedAt: record.importedAt,
  };
}

/** Re-run the pure bundle resolver at commit time against the CURRENT config. */
async function resolveBundleForCommit(
  staged: StagedImport,
  deps: SkillImportDeps,
): Promise<Result<{ nextServers: readonly McpServerEntry[]; bundleEntries: readonly McpServerEntry[] } | null, { kind: string; message: string }>> {
  const bundleServers = staged.manifest.mcpServers;
  if (bundleServers === undefined || bundleServers.length === 0) return ok(null);
  const resolved = await resolveBundle({
    skillId: staged.skillName,
    manifestMcpServers: bundleServers,
    currentServers: deps.readCurrentMcpServers(),
    force: false,
    ...(deps.osvCheckEnabled !== undefined && { osvCheckEnabled: deps.osvCheckEnabled }),
    ...(deps.osvCacheTtlMs !== undefined && { osvCacheTtlMs: deps.osvCacheTtlMs }),
    logger: deps.logger,
    installedBundleState: deps.readInstalledBundleState(),
  });
  if (!resolved.ok) return err({ kind: resolved.error.kind, message: formatBundleError(resolved.error) });
  return ok({ nextServers: resolved.value.nextServers, bundleEntries: bundleServers });
}

/** Emit the reject obs (WARN + hint/errorKind, and a skill:failed import event). */
function emitReject(deps: SkillImportDeps, agentId: string, skillName: string, reject: ImportReject): void {
  deps.logger.warn(
    { step: reject.stage, errorKind: reject.errorKind, hint: reject.hint, skillName },
    `skill import commit rejected at ${reject.stage}: ${reject.message}`,
  );
  if (deps.eventBus) {
    deps.eventBus.emit("skill:failed", {
      skillName,
      error: reject.message,
      phase: "import",
      agentId,
      timestamp: systemNowMs(),
    });
  }
}

// ---------------------------------------------------------------------------
// The serialized commit
// ---------------------------------------------------------------------------

/**
 * Commit a fully-staged import. Serialized under the per-skill keyed lock with a
 * pinned order + mid-commit unwind; the provenance write + MCP re-check/persist
 * run under a shared global lock. Never throws.
 */
export async function commitStagedImport(
  staged: StagedImport,
  opts: RunSkillImportOpts,
  deps: SkillImportDeps,
): Promise<Result<CommitResult, ImportReject>> {
  const startedAt = systemNowMs();
  const name = staged.skillName;
  const key = provenanceKey(opts.scope, opts.agentId, name);
  const writeProv = deps.writeProvenanceRecord ?? skillsWriteProvenanceRecord;
  const removeProv = deps.removeProvenanceRecord ?? skillsRemoveProvenanceRecord;
  const readStore = deps.readProvenanceStore ?? skillsReadProvenanceStore;
  const nowIso = (): string => deps.now();
  const liveDir = safePath(deps.skillsDir, name);
  const parkedDir = safePath(staged.importRoot, "parked");

  const rejectAndClean = (reject: ImportReject): Result<CommitResult, ImportReject> => {
    cleanupStaging(staged.importRoot);
    emitReject(deps, opts.agentId, name, reject);
    return err(reject);
  };

  return withSkillImportLock(key, async (): Promise<Result<CommitResult, ImportReject>> => {
    // ---- STEP 1: collision routing ------------------------------------------
    const store = readStore(deps.dataDir);
    const existing = store[key];
    const liveExists = existsSync(liveDir);
    deps.logger.debug({ step: "collision", skillName: name, hasRecord: existing !== undefined, liveExists }, "skill import commit: routing");

    let mode: "fresh" | "update";
    let importedAt = nowIso();

    if (existing !== undefined) {
      const sameProvenance = existing.source === opts.source && existing.identifier === opts.identifier;
      if (!sameProvenance) {
        // Unprovenanced-for-this-source / foreign identifier ⇒ flat refuse (never confirm-able).
        return rejectAndClean(
          mkReject(
            "collision",
            `a skill named '${name}' is already recorded from a different source or identifier`,
            "delete the existing skill first, or re-import from its original source — a re-import may only replace a matching prior import",
            "precondition",
          ),
        );
      }
      if (existing.contentHash === staged.contentHash) {
        // Idempotent no-op: identical content re-imported.
        cleanupStaging(staged.importRoot);
        deps.logger.info({ step: "complete", skillName: name, mode: "noop", contentHash: staged.contentHash.slice(0, 12) }, "skill import commit: idempotent no-op");
        return ok({ name, path: liveDir, source: "imported", mode: "noop", provenanceSummary: toSummary(existing) });
      }
      if (opts.confirm !== true) {
        return rejectAndClean(
          mkReject(
            "commit",
            `re-import of '${name}' diverges from the pinned content hash`,
            "re-run with confirm to swap the installed skill and re-pin its provenance",
            "precondition",
            { needsConfirm: true },
          ),
        );
      }
      mode = liveExists ? "update" : "fresh";
      importedAt = existing.importedAt;
    } else {
      if (liveExists) {
        // A skill with this name exists but has no import record ⇒ flat refuse.
        return rejectAndClean(
          mkReject(
            "collision",
            `a skill named '${name}' already exists without an import record`,
            "delete the existing skill first; only a provenance-matched re-import may replace an installed skill",
            "precondition",
          ),
        );
      }
      mode = "fresh";
    }

    const record: ProvenanceRecord = {
      name,
      scope: opts.scope,
      agentId: opts.agentId,
      source: opts.source,
      identifier: opts.identifier,
      contentHash: staged.contentHash,
      scanVerdict: staged.scanVerdict,
      files: staged.keptFiles.map((f) => f.relPath),
      importedAt,
      updatedAt: nowIso(),
      importedBy: opts.agentId,
    };

    // ---- STEP 2: commit.json + same-device assert + move --------------------
    const ensured = ensureContainedDir({ dir: deps.skillsDir, mode: 0o700 });
    if (!ensured.ok) {
      return rejectAndClean(mkReject("commit", `failed to ensure the live skills directory: ${ensured.error.message}`, "ensure the data-dir skills directory is writable (0o700)", "resource"));
    }
    if (!sameDevice(staged.importRoot, deps.skillsDir)) {
      return rejectAndClean(
        mkReject(
          "commit",
          "the staging directory and the live skills directory are on different filesystems",
          `stage imports under a tmp directory on the same device as ${deps.skillsDir}; a cross-device move is not atomic`,
          "config",
        ),
      );
    }
    const marker = writeCommitMarker(staged.importRoot, { mode, targetPath: liveDir, contentHash: staged.contentHash, record });
    if (!marker.ok) {
      return rejectAndClean(mkReject("commit", marker.error.message, "ensure the staging directory is writable and not a symlink", "resource"));
    }

    let didPark = false;
    try {
      if (mode === "update" && liveExists) {
        renameSync(liveDir, parkedDir);
        didPark = true;
      }
      renameSync(staged.stagingDir, liveDir);
    } catch (e) {
      if (didPark && !existsSync(liveDir)) {
        try {
          renameSync(parkedDir, liveDir);
        } catch {
          /* best effort */
        }
      }
      return rejectAndClean(mkReject("commit", `failed to move the staged skill into place: ${(e as Error).message}`, "ensure the staging and skills directories share one writable filesystem", "resource"));
    }
    deps.logger.debug({ step: "commit", skillName: name, mode }, "skill import commit: moved staged tree live");

    const unwindMove = (): void => {
      try {
        rmSync(liveDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
      if (didPark) {
        try {
          renameSync(parkedDir, liveDir);
        } catch {
          /* best effort */
        }
      }
    };

    // Restore the pre-commit provenance pin after a STEP 4/5 failure. STEP 3's
    // write already OVERWROTE any prior record, so deleting it here would drop
    // the record entirely — the skill would then re-present as the platform-
    // trusted `bundled` tier (dynamic-context shell expansion re-enabled). When a
    // prior record existed (an update, or a re-import whose live dir had been
    // removed) the unwind re-writes it; a first-time fresh install removes the
    // just-written record because there was none to keep.
    const restorePin = async (): Promise<void> => {
      if (existing !== undefined) {
        await writeProv(deps.dataDir, existing);
      } else {
        await removeProv(deps.dataDir, key);
      }
    };

    // ---- STEPS 3-5 under the SHARED GLOBAL lock -----------------------------
    const committed = await withSkillImportLock(SKILL_IMPORT_COMMIT_LOCK, async (): Promise<Result<void, ImportReject>> => {
      // STEP 3: provenance write (global-serialized ⇒ no cross-skill lost update).
      const pw = await writeProv(deps.dataDir, record);
      if (!pw.ok) {
        return err(mkReject("commit", `failed to write the provenance record: ${pw.error.message}`, pw.error.hint, pw.error.errorKind));
      }
      // STEP 4: re-discover skills.
      try {
        deps.reinitRegistry();
      } catch (e) {
        await restorePin();
        return err(mkReject("commit", `skill registry re-init failed: ${(e as Error).message}`, "the moved skill is reconciled on the next boot sweep", "internal"));
      }
      // STEP 5: MCP-server-name re-check + Phase-B persist (imported tier).
      const rechecked = await resolveBundleForCommit(staged, deps);
      if (!rechecked.ok) {
        await restorePin();
        return err(
          mkReject(
            "commit",
            `bundled MCP declaration rejected at commit: ${rechecked.error.message}`,
            "a concurrent import claimed the same MCP server name; re-import after resolving the collision",
            "precondition",
            { bundleKind: rechecked.error.kind },
          ),
        );
      }
      if (rechecked.value !== null && deps.persistImportedBundle) {
        const { nextServers, bundleEntries } = rechecked.value;
        const bundleNames = new Set(bundleEntries.map((e) => e.name));
        // Imported tier: bundle entries persist disabled and are never auto-connected.
        const disabled = nextServers.map((e) => (bundleNames.has(e.name) ? { ...e, enabled: false } : e));
        const pr = await deps.persistImportedBundle({ skillId: name, nextServers: disabled, bundleEntries });
        if (!pr.ok) {
          await restorePin();
          return err(mkReject("commit", `failed to persist the imported MCP bundle: ${pr.error.message}`, "the moved skill is reconciled on the next boot sweep", "resource"));
        }
      }
      return ok(undefined);
    });

    if (!committed.ok) {
      unwindMove();
      emitReject(deps, opts.agentId, name, committed.error);
      cleanupStaging(staged.importRoot);
      return committed;
    }

    // ---- STEP 6: cleanup ----------------------------------------------------
    cleanupStaging(staged.importRoot);
    deps.logger.info(
      {
        step: "complete",
        skillName: name,
        mode,
        durationMs: systemNowMs() - startedAt,
        fileCount: staged.keptFiles.length,
        contentHash: staged.contentHash.slice(0, 12),
      },
      "skill import commit: installed",
    );
    return ok({ name, path: liveDir, source: "imported", mode, provenanceSummary: toSummary(record) });
  });
}

// ---------------------------------------------------------------------------
// The single orchestration
// ---------------------------------------------------------------------------

/**
 * Acquire → stage (real Phase-A pre-write seam) → commit. The one path every
 * import source flows through; the retrofit reuses it so Phase-A always runs
 * pre-write. Returns the {@link CommitResult}, or a typed {@link ImportReject}
 * that leaves zero live writes.
 */
export async function runSkillImport(
  acquireInput: AcquireInput,
  opts: RunSkillImportOpts,
  deps: SkillImportDeps,
): Promise<Result<CommitResult, ImportReject>> {
  // Build the REAL bundle-check seam: resolveBundle against the current config +
  // the installed-bundle trust root, run PRE-WRITE inside stageImport.
  const bundleCheck: BundleCheckSeam = async (manifest) => {
    const bundleServers = manifest.mcpServers;
    if (bundleServers === undefined || bundleServers.length === 0) return ok(undefined);
    const resolved = await resolveBundle({
      skillId: manifest.name,
      manifestMcpServers: bundleServers,
      currentServers: deps.readCurrentMcpServers(),
      force: false,
      ...(deps.osvCheckEnabled !== undefined && { osvCheckEnabled: deps.osvCheckEnabled }),
      ...(deps.osvCacheTtlMs !== undefined && { osvCacheTtlMs: deps.osvCacheTtlMs }),
      logger: deps.logger,
      installedBundleState: deps.readInstalledBundleState(),
    });
    if (!resolved.ok) return err({ kind: resolved.error.kind, message: formatBundleError(resolved.error) });
    return ok(undefined);
  };

  const staged = await stageImport(
    { source: acquireInput, scope: opts.scope, agentId: opts.agentId },
    {
      caps: deps.caps,
      maxBodyLength: deps.maxBodyLength,
      tmpRoot: deps.tmpRoot,
      logger: deps.logger,
      bundleCheck,
      ...(deps.eventBus && { eventBus: deps.eventBus }),
      ...(deps.audit && { audit: deps.audit }),
      ...(deps.stagingId !== undefined && { stagingId: deps.stagingId }),
    },
  );
  if (!staged.ok) return staged;

  return commitStagedImport(staged.value, opts, deps);
}

// The keyed mutex is the `@comis/skills` module singleton — this file NEVER
// instantiates a lock map of its own (a second instance would split the domain
// and void the concurrency guarantee).
