// SPDX-License-Identifier: Apache-2.0
/**
 * `orchestrate-durable` — the resumable-durable-row lifecycle for the flat
 * `orchestrate` runner, kept OUT of the runner so `orchestrate-tool.ts` stays
 * under the file-size cap (the same extraction that moved the jailed-child
 * engine into `orchestrate-repair.ts`).
 *
 * The flat runner becomes the first RE-RUNNABLE durable kind. When the durable
 * store seam is threaded (i.e. the resume surface is enabled) the runner:
 *   1. registers a resumable row carrying the PINNED script path (`scriptRef`,
 *      the workspace-relative `<runId>.<language>`) at run START, so a
 *      mid-pipeline daemon restart's boot sweep finds it;
 *   2. on a TIMEOUT, re-affirms the row resumable and SKIPS the run-end
 *      `cleanupRun`, so the pinned script + the last checkpoint survive for a
 *      later resume — their lifetime is owned by the durable row + the
 *      checkpoint's longer TTL, and the orphan sweep reclaims a truly-dead run;
 *   3. on an explicit resume, loads the PINNED bytes back and re-spawns THEM —
 *      a resume NEVER accepts new script bytes.
 *
 * Everything here is pure over TWO injected seams — a narrow durable-run store
 * port (`upsertCheckpoint`/`getByCheckpoint`) and an fs read seam — so the whole
 * lifecycle is macOS-unit-testable with no real sqlite or spawn. The store port
 * is a structural subset of the daemon's durable-run store, so the daemon threads
 * the real store directly and @comis/skills never imports it concretely (the
 * mint-lease closure precedent).
 *
 * The row is content-free: `{rootRunId, scriptRef, checkpointRef}` — a path + an
 * id pointer, never the script bytes or the checkpoint body. The build mirrors
 * the graph coordinator's checkpoint row but with a FLAT `spawnTree` (a
 * `string[]`, so the DAG-vs-flat discriminator routes it to the flat arm) and
 * never writes outward-send sequencing, which belongs to the separate outward
 * ledger store.
 *
 * @module
 */
import { existsSync, readFileSync, unlinkSync } from "node:fs";

import {
  safePath,
  systemSetInterval,
  systemClearInterval,
  toSafeErrorLogString,
  type ComisLogger,
  type DurableRunRecord,
  type DurableRunResumeClaim,
  type DurableRunResumeClaimOutcome,
  type DurableRootBudget,
  type DeliveryOrigin,
  type AgentCapability,
  type UserTrustLevel,
} from "@comis/core";
import { ok, err, suppressError, type Result } from "@comis/shared";

// ---------------------------------------------------------------------------
// Injected seams.
// ---------------------------------------------------------------------------

/**
 * The narrow durable-run store port the orchestrate runner needs — the two
 * methods it calls, a structural subset of the daemon's durable-run store, so
 * the daemon threads the real store directly and @comis/skills never imports it.
 */
export interface OrchestrateDurableRuns {
  /** Idempotent upsert keyed on `checkpointId`. */
  upsertCheckpoint(record: DurableRunRecord): Promise<Result<void, Error>>;
  /** Read a durable execution checkpoint. */
  getByCheckpoint(checkpointId: string): Promise<Result<DurableRunRecord | undefined, Error>>;
  /** Atomically consume a source checkpoint and create its running replacement. */
  claimForResume?(
    claim: DurableRunResumeClaim,
  ): Promise<Result<DurableRunResumeClaimOutcome, Error>>;
  /**
   * Mark the row terminal on a NON-resumable completion (success or a non-timeout
   * failure) so `listResumable` stops re-surfacing a finished run on every boot and
   * the orphan sweep never false-orphans it — mirroring the graph coordinator /
   * sub-agent runner terminal write. A structural subset of the daemon's
   * `DurableRunPort.markCompleted`; optional so a minimal store stub compiles (the
   * concrete store always provides it, and the runner skips it on a resumable timeout).
   */
  markCompleted?(checkpointId: string): Promise<Result<void, Error>>;
  /** Quarantine a replacement whose pinned artifact cannot be loaded. */
  markOrphaned?(checkpointId: string, reason: string): Promise<Result<void, Error>>;
  /**
   * Advance the run's `lastHeartbeatAt` while its process is alive — the keep-alive
   * the durable watchdog's whole premise depends on ("a long-running run stamps its
   * heartbeat; a crashed process stops"). A structural subset of the daemon's
   * `DurableRunPort.touchHeartbeat`; optional so a minimal store stub compiles (the
   * concrete store always provides it). Absent ⇒ no keep-alive (a live no-checkpoint
   * run degrades to the prior at-risk behavior, never worse).
   */
  touchHeartbeat?(checkpointId: string, atMs: number): Promise<Result<void, Error>>;
}

/**
 * A scheduler seam for {@link startDurableKeepAlive}: schedule `cb` every `ms` and
 * return a `stop()` that cancels it. The production default wraps an unref'd
 * `setInterval`; tests inject a fake that captures the callback.
 */
export type KeepAliveScheduler = (cb: () => void, ms: number) => () => void;

/**
 * Default durable heartbeat keep-alive interval (ms). Must stay well under the
 * watchdog's stale-heartbeat threshold (default 120s) so a run at the timeout
 * ceiling keeps a fresh heartbeat and is never reaped as a crash. Mirrors the
 * sub-agent runner's 30s.
 */
export const DEFAULT_DURABLE_KEEPALIVE_MS = 30_000;

/** The production keep-alive scheduler — an unref'd interval so it never pins the event loop. */
export const defaultKeepAliveScheduler: KeepAliveScheduler = (cb, ms) => {
  const handle = systemSetInterval(cb, ms);
  handle.unref();
  return () => systemClearInterval(handle);
};

/**
 * Start a best-effort keep-alive that stamps the durable row's `lastHeartbeatAt`
 * on every tick while the flat orchestrate child is alive, and return a `stop()`
 * for the caller's `finally`.
 *
 * WHY: the flat runner registers a `running` durable row at start but only advances
 * its heartbeat on an explicit `checkpoint()` or the timeout re-affirm. Every OTHER
 * long-running durable runner (the sub-agent runner) stamps a periodic keep-alive, so
 * the watchdog can treat "lapsed heartbeat" as "process gone". Without one here, a
 * live run that runs longer than a few stale-thresholds without checkpointing looks
 * dead: the no-progress re-anchor cap orphans it and reclaims its workspace mid-run.
 * This restores that contract for the flat runner.
 *
 * Uses a FRESH `now()` per tick (not the registration timestamp). No-op when the store
 * can't `touchHeartbeat` (never schedules). Errors are swallowed (best-effort — a failed
 * touch never disrupts the run; the watchdog reaps only if it persists past the cap).
 */
export function startDurableKeepAlive(input: {
  runs: OrchestrateDurableRuns;
  checkpointId: string;
  now: () => number;
  keepAliveMs: number;
  scheduler?: KeepAliveScheduler;
  logger?: ComisLogger;
}): () => void {
  const { runs, checkpointId, now, keepAliveMs, logger } = input;
  const touch = runs.touchHeartbeat?.bind(runs);
  if (!touch) return () => {};
  const scheduler = input.scheduler ?? defaultKeepAliveScheduler;
  return scheduler(() => {
    // Best-effort: a failed/throwing touch never disrupts the run; the watchdog only
    // reaps if the lapse persists past the cap. suppressError replaces an empty .catch.
    suppressError(
      touch(checkpointId, now()).then((r) => {
        if (!r.ok) {
          logger?.debug(
            {
              checkpointId,
              err: toSafeErrorLogString(r.error),
              errorKind: "internal" as const,
              hint: "durable keep-alive touch failed; the watchdog may orphan-sweep this run if it persists",
            },
            "orchestrate durable keep-alive: touch failed",
          );
        }
      }),
      "durable keep-alive touch (best-effort)",
    );
  }, keepAliveMs);
}

/**
 * Run `fn` with a durable heartbeat keep-alive active for its whole duration, so a
 * long LIVE flat orchestrate run is never mistaken for a crash and reaped by the
 * watchdog's no-progress re-anchor cap. Starts the keep-alive (via
 * {@link startDurableKeepAlive}) before awaiting `fn`, stops it in a `finally`, and
 * returns `fn`'s result. A no-op wrapper when `runs` is undefined (durability off).
 * Keeps the start/stop lifecycle out of the caller (one call site) — the runner just
 * wraps its child-execution await.
 */
export async function withDurableKeepAlive<T>(
  runs: OrchestrateDurableRuns | undefined,
  checkpointId: string,
  opts: { now: () => number; logger?: ComisLogger; keepAliveMs?: number; scheduler?: KeepAliveScheduler },
  fn: () => Promise<T>,
): Promise<T> {
  const stop =
    runs === undefined
      ? () => {}
      : startDurableKeepAlive({
          runs,
          checkpointId,
          now: opts.now,
          keepAliveMs: opts.keepAliveMs ?? DEFAULT_DURABLE_KEEPALIVE_MS,
          ...(opts.scheduler ? { scheduler: opts.scheduler } : {}),
          ...(opts.logger ? { logger: opts.logger } : {}),
        });
  try {
    return await fn();
  } finally {
    stop();
  }
}

/**
 * The fs read seam — injected so the resume loader is pure/macOS-unit-testable.
 * The production default reads the real workspace file.
 */
export interface OrchestrateDurableFs {
  /** Whether the resolved absolute path exists. */
  exists(absPath: string): boolean;
  /** Read the pinned script bytes (utf8); the caller catches a throw. */
  read(absPath: string): string;
}

/** The production fs seam — the real workspace read. */
export const defaultOrchestrateDurableFs: OrchestrateDurableFs = {
  exists: (absPath) => existsSync(absPath),
  read: (absPath) => readFileSync(absPath, "utf8"),
};

/** The pinned re-spawn spec the loader resolves — the PINNED bytes are the sole source. */
export interface ResumeSpec {
  /** The pinned script path relative to the workspace (`<runId>.<language>`). */
  readonly scriptRef: string;
  /** The pinned script bytes — re-spawned VERBATIM, never a re-supplied param. */
  readonly scriptBytes: string;
  /** The interpreter language, derived from the scriptRef extension. */
  readonly language: "ts" | "js" | "py";
  /**
   * The resumed run's last checkpointRef, carried onto the NEW run's durable row so
   * the replayed script's `comis_tools.resume()` returns the resumed run's checkpoint
   * (skip-completed-work), not an empty new-root checkpoint. `undefined` when the
   * resumed run never checkpointed. The blob is workspace-scoped (same agent) so the
   * ref resolves in the new run.
   */
  readonly checkpointRef?: string;
  /** Persisted authority ceiling carried onto the replacement attempt. */
  readonly authority: ResumeAuthority;
}

export interface ResumePrincipal {
  readonly agentId: string;
  readonly sessionKey: string;
  readonly ownerTenantId: string;
  readonly ownerUserId: string;
  readonly deliveryOrigin: DeliveryOrigin | null;
  readonly trustLevel: UserTrustLevel;
  readonly caps: readonly AgentCapability[];
}

export interface ResumeAuthority extends ResumePrincipal {
  readonly rootRunId: string;
  readonly sourceCheckpointId: string;
}

/** Inputs shared by the row builders (the content-free durable pointers + clock). */
export interface DurableRowInput {
  /** Unique identity of this orchestrate execution. */
  readonly checkpointId: string;
  /** Tree-stable root used for budget and revocation. */
  readonly rootRunId: string;
  readonly agentId: string;
  readonly sessionKey: string;
  readonly ownerTenantId: string;
  readonly ownerUserId: string;
  readonly deliveryOrigin: DeliveryOrigin | null;
  readonly caps: readonly AgentCapability[];
  readonly leaseIds: readonly string[];
  /** Absolute tree-wide budget state; restart and sibling rows preserve it exactly. */
  readonly rootBudget: DurableRootBudget;
  /** The pinned script path relative to the workspace (`<runId>.<language>`). */
  readonly scriptRef: string;
  /** The last checkpoint ref, when one exists (omitted at run start). */
  readonly checkpointRef?: string;
  /** The injected wall clock (no ambient-clock read). */
  readonly nowMs: number;
  /** Exact authenticated trust inherited by a restart re-minted lease. */
  readonly trustLevel: UserTrustLevel;
}

// ---------------------------------------------------------------------------
// The resumable-row lifecycle.
// ---------------------------------------------------------------------------

/**
 * Build the resumable durable-run record: a FLAT `spawnTree` (so the resume
 * engine's DAG-vs-flat discriminator routes it to the flat arm), `status:
 * "running"` (the boot-resume scan set), the pinned `scriptRef`, and `stepIndex:
 * -1` (the never-sent sentinel; the store omits the `outward_step` column on the
 * upsert, so the outward-send counter is untouched). Content-free.
 */
export function buildResumableRow(input: DurableRowInput): DurableRunRecord {
  return {
    checkpointId: input.checkpointId,
    rootRunId: input.rootRunId,
    agentId: input.agentId,
    sessionKey: input.sessionKey,
    ownerTenantId: input.ownerTenantId,
    ownerUserId: input.ownerUserId,
    deliveryOrigin: input.deliveryOrigin,
    spawnTree: [],
    caps: [...input.caps],
    leaseIds: [...input.leaseIds],
    budgetConsumed: input.rootBudget.usdConsumed,
    rootBudget: input.rootBudget,
    cronOrigin: null,
    trustLevel: input.trustLevel,
    status: "running",
    lastHeartbeatAt: input.nowMs,
    scriptRef: input.scriptRef,
    checkpointRef: input.checkpointRef ?? null,
  };
}

/**
 * Register the run as a resumable durable row at run START (scriptRef set), so a
 * daemon restart mid-run finds it. Forwards the store's Result — the caller
 * treats a failure as non-fatal (the run still proceeds; the timeout path
 * re-affirms the row).
 */
export function registerDurableRun(
  runs: OrchestrateDurableRuns,
  input: DurableRowInput,
): Promise<Result<void, Error>> {
  return runs.upsertCheckpoint(buildResumableRow(input));
}

/**
 * The skip-clean decision on a run failure: when the durable store seam is
 * present (the resume surface is on), re-affirm the row resumable and signal the
 * runner to SKIP the run-end cleanup, so the pinned script + the last checkpoint
 * survive for a resume. The re-affirm is best-effort — the row already exists
 * from run start, so a store error does NOT flip the decision. With no store
 * seam it is a no-op and the run cleans normally.
 */
export async function markResumable(
  runs: OrchestrateDurableRuns | undefined,
  input: DurableRowInput,
): Promise<{ skipCleanup: boolean }> {
  if (runs === undefined) return { skipCleanup: false };
  await runs.upsertCheckpoint(buildResumableRow(input));
  return { skipCleanup: true };
}

/**
 * Terminal cleanup for a NON-resumable orchestrate run (success OR a non-timeout
 * failure): mark the durable row completed — so `listResumable` stops re-surfacing
 * a finished run and the boot sweep never false-orphans it, mirroring the graph
 * coordinator / sub-agent runner terminal write — and unlink the pinned
 * `<runId>.<language>` script at the workspace ROOT (the run-end `cleanupRun` wipes
 * only `results/`). Only a resumable TIMEOUT keeps the row + script, and it never
 * calls this. Best-effort: a store/fs failure is logged (never thrown into the
 * run's terminal path); `markCompleted` absent (a minimal stub) ⇒ that half no-ops.
 */
export async function finalizeCompletedRun(
  runs: OrchestrateDurableRuns | undefined,
  input: {
    checkpointId: string;
    rootRunId: string;
    scriptRef: string;
    workspacePath: string;
    runId: string;
  },
  logger?: ComisLogger,
): Promise<void> {
  if (runs === undefined) return; // resume surface off — nothing durable to finalize.
  const done = await runs.markCompleted?.(input.checkpointId);
  if (done !== undefined && !done.ok) {
    logger?.warn(
      { runId: input.runId, rootRunId: input.rootRunId, err: toSafeErrorLogString(done.error), errorKind: "internal" as const, hint: "the durable row could not be marked completed — the watchdog re-anchor cap eventually orphans the stale 'running' row after repeated no-progress attempts (no live impact)" },
      "orchestrate durable markCompleted failed (non-fatal)",
    );
  }
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- safePath-confined to the run workspace; scriptRef is a store-minted <runId>.<language> path
    unlinkSync(safePath(input.workspacePath, input.scriptRef));
  } catch (e) {
    logger?.debug(
      { runId: input.runId, err: toSafeErrorLogString(e), hint: "best-effort unlink of the pinned script failed; a later workspace teardown reclaims it" },
      "orchestrate pinned-script cleanup failed (non-fatal)",
    );
  }
}

/**
 * Settle a resume claim that failed before its replacement reached the jailed
 * child. The source has already been atomically consumed, so quarantine the
 * replacement and reclaim only the source run's isolated results plus pinned
 * script. Every cleanup limb is best-effort and content-safe; the caller keeps
 * the original pre-start error as the authoritative failure.
 */
export async function settleClaimedResumeFailure(
  runs: OrchestrateDurableRuns,
  input: {
    replacementCheckpointId: string;
    sourceCheckpointId: string;
    workspacePath: string;
    scriptRef: string;
    cleanupSourceResults: () => Promise<void>;
  },
  logger?: ComisLogger,
): Promise<void> {
  try {
    const orphaned = await runs.markOrphaned?.(
      input.replacementCheckpointId,
      "resume_prestart_failed",
    );
    if (orphaned !== undefined && !orphaned.ok) {
      logger?.warn(
        {
          err: toSafeErrorLogString(orphaned.error),
          errorKind: "internal" as const,
          hint: "the claimed replay replacement could not be quarantined; the durable watchdog must reclaim it",
        },
        "orchestrate resume replacement quarantine failed",
      );
    }
  } catch (error) {
    logger?.warn(
      {
        err: toSafeErrorLogString(error),
        errorKind: "internal" as const,
        hint: "the claimed replay replacement quarantine threw; the durable watchdog must reclaim it",
      },
      "orchestrate resume replacement quarantine threw",
    );
  }

  try {
    await input.cleanupSourceResults();
  } catch (error) {
    logger?.warn(
      {
        err: toSafeErrorLogString(error),
        errorKind: "internal" as const,
        hint: "source-run results cleanup failed after a claimed resume was refused; a later workspace sweep must reclaim them",
      },
      "orchestrate claimed-resume results cleanup failed",
    );
  }

  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- safePath confines the persisted script pointer to its exact agent workspace
    unlinkSync(safePath(input.workspacePath, input.scriptRef));
  } catch (error) {
    logger?.warn(
      {
        err: toSafeErrorLogString(error),
        errorKind: "internal" as const,
        hint: "pinned-script cleanup failed after a claimed resume was refused; a later workspace sweep must reclaim it",
      },
      "orchestrate claimed-resume script cleanup failed",
    );
  }
}

// ---------------------------------------------------------------------------
// The pinned-byte resume loader.
// ---------------------------------------------------------------------------

/** A refusal class resolveScriptSource surfaces to the runner (mapped to a tool error). */
export interface ResumeInputRefusal {
  /** The tool-error code the runner throws (a subset of the tool-error codes). */
  readonly code: "not_implemented" | "not_found" | "permission_denied";
  readonly message: string;
  readonly hint: string;
}

/** The resolved script source the runner spawns (fresh params, or the pinned bytes). */
export interface ResolvedScriptSource {
  readonly script: string;
  readonly language: "ts" | "js" | "py";
  /** The workspace-relative script path (`<runId>.<language>`, or the pinned scriptRef). */
  readonly scriptName: string;
  /**
   * On a RESUME (`resumeRunId`), the resumed run's last checkpointRef — the runner seeds it
   * onto the new run's durable row so the replayed script's `resume()` returns the resumed
   * run's checkpoint. `undefined` for a fresh run or a resumed run that never checkpointed.
   */
  readonly checkpointRef?: string;
  readonly resumeAuthority?: ResumeAuthority;
}

/**
 * Resolve what the runner spawns, applying the fail-CLOSED resume contract:
 *   - no `resumeRunId` ⇒ the fresh `script`/`language` params;
 *   - `resumeRunId` with the surface OFF (no store) ⇒ REFUSE `not_implemented`
 *     (NEVER silently run the caller's `script` — a resume takes no fresh bytes);
 *   - `resumeRunId` with the surface ON ⇒ load + return the PINNED bytes (the
 *     `script` param is IGNORED), or REFUSE `not_found` when it can't be loaded.
 */
export async function resolveScriptSource(
  params: { script: string; language: "ts" | "js" | "py"; resumeRunId?: string },
  runs: OrchestrateDurableRuns | undefined,
  fs: OrchestrateDurableFs,
  ctx: { workspacePath: string; runId: string; claimedAtMs: number; principal?: ResumePrincipal },
): Promise<Result<ResolvedScriptSource, ResumeInputRefusal>> {
  const scriptName = `${ctx.runId}.${params.language}`;
  if (params.resumeRunId === undefined) {
    return ok({ script: params.script, language: params.language, scriptName });
  }
  if (runs === undefined) {
    return err({
      code: "not_implemented",
      message:
        "Resume requires the durable-resume surface (autonomy.durability.orchestrateResume), which is not enabled for this agent.",
      hint: "Enable orchestrateResume for this agent, or omit resumeRunId to run a fresh script.",
    });
  }
  if (ctx.principal === undefined) {
    return err({
      code: "permission_denied",
      message: "Resume requires an authenticated execution principal.",
      hint: "Retry from the original owning session.",
    });
  }
  const loaded = await loadResumeSpec(runs, fs, {
    resumeRunId: params.resumeRunId,
    workspacePath: ctx.workspacePath,
    principal: ctx.principal,
    replacementCheckpointId: ctx.runId,
    claimedAtMs: ctx.claimedAtMs,
  });
  if (!loaded.ok) {
    const authorizationDenied = loaded.error.startsWith("resume authorization denied");
    return err({
      code: authorizationDenied ? "permission_denied" : "not_found",
      message: authorizationDenied
        ? "The current principal is not authorized to resume this run."
        : "The orchestrate run to resume could not be loaded.",
      hint: loaded.error,
    });
  }
  return ok({
    script: loaded.value.scriptBytes,
    language: loaded.value.language,
    scriptName: loaded.value.scriptRef,
    checkpointRef: loaded.value.checkpointRef,
    resumeAuthority: loaded.value.authority,
  });
}

/**
 * Load the pinned re-spawn spec for a resume: read the durable row, resolve the
 * pinned `scriptRef` CONFINED under the workspace (a `..`/absolute escape is
 * refused before any read), and read the pinned bytes. The pinned bytes are the
 * SOLE source — this loader takes no script param, so a resume can never smuggle
 * new bytes. Every failure (missing row, no scriptRef, unknown extension, a
 * missing or unreadable file, a store error, a traversal escape) honest-degrades
 * to an `err` reason the runner surfaces — never a throw that crashes the run.
 */
export async function loadResumeSpec(
  runs: OrchestrateDurableRuns,
  fs: OrchestrateDurableFs,
  input: {
    resumeRunId: string;
    workspacePath: string;
    principal: ResumePrincipal;
    replacementCheckpointId?: string;
    claimedAtMs?: number;
  },
): Promise<Result<ResumeSpec, string>> {
  let row: DurableRunRecord | undefined;
  let claimedReplacementId: string | undefined;
  const failAfterClaim = async (message: string): Promise<Result<never, string>> => {
    if (claimedReplacementId !== undefined && runs.markOrphaned !== undefined) {
      try {
        await runs.markOrphaned(claimedReplacementId, "resume_artifact_validation_failed");
      } catch {
        // The original validation error remains authoritative. The durable
        // resume engine will retry the orphan write during its failure path.
      }
    }
    return err(message);
  };
  if (input.replacementCheckpointId !== undefined) {
    const claim = runs.claimForResume;
    if (claim === undefined || input.claimedAtMs === undefined) {
      return err("the durable resume claim surface is unavailable");
    }
    const claimed = await claim({
      checkpointId: input.resumeRunId,
      replacementCheckpointId: input.replacementCheckpointId,
      principal: input.principal,
      claimedAtMs: input.claimedAtMs,
    });
    if (!claimed.ok) return err("the durable resume claim failed");
    switch (claimed.value.kind) {
      case "claimed":
        row = claimed.value.record;
        claimedReplacementId = input.replacementCheckpointId;
        break;
      case "not_found":
        return err("no durable run found to resume");
      case "not_resumable":
        return err("the durable run is no longer resumable");
      case "authorization_denied":
        return err("resume authorization denied: execution owner mismatch");
      default: {
        const _exhaustive: never = claimed.value;
        return _exhaustive;
      }
    }
  } else {
    const rowResult = await runs.getByCheckpoint(input.resumeRunId);
    if (!rowResult.ok) return err("the durable run lookup failed");
    row = rowResult.value;
    if (row === undefined) return err("no durable run found to resume");
  }
  if (row.status !== "running") return failAfterClaim("the durable run is no longer resumable");
  const principal = input.principal;
  if (
    row.agentId !== principal.agentId
    || row.sessionKey !== principal.sessionKey
    || row.ownerTenantId !== principal.ownerTenantId
    || row.ownerUserId !== principal.ownerUserId
    || !sameDeliveryOrigin(row.deliveryOrigin, principal.deliveryOrigin)
  ) {
    return failAfterClaim("resume authorization denied: execution owner mismatch");
  }
  if (trustRank(principal.trustLevel) < trustRank(row.trustLevel)) {
    return failAfterClaim("resume authorization denied: the current principal was demoted below the persisted trust ceiling");
  }
  const currentCaps = new Set(principal.caps);
  const effectiveCaps = row.caps.filter((capability) => currentCaps.has(capability));
  const scriptRef = row.scriptRef;
  if (!scriptRef) return failAfterClaim("the durable run has no pinned script — not a resumable run");
  const language = languageFromScriptRef(scriptRef);
  if (language === undefined) return failAfterClaim("the pinned script has no recognized language extension");
  let absPath: string;
  try {
    absPath = safePath(input.workspacePath, scriptRef);
  } catch {
    return failAfterClaim("the pinned script path escapes the workspace");
  }
  if (!fs.exists(absPath)) return failAfterClaim("the pinned script is gone (checkpoint reclaimed)");
  let scriptBytes: string;
  try {
    scriptBytes = fs.read(absPath);
  } catch {
    return failAfterClaim("the pinned script could not be read");
  }
  return ok({
    scriptRef,
    scriptBytes,
    language,
    checkpointRef: row.checkpointRef ?? undefined,
    authority: {
      agentId: row.agentId,
      sessionKey: row.sessionKey,
      ownerTenantId: row.ownerTenantId,
      ownerUserId: row.ownerUserId,
      deliveryOrigin: row.deliveryOrigin,
      trustLevel: row.trustLevel,
      caps: effectiveCaps,
      rootRunId: row.rootRunId,
      sourceCheckpointId: row.checkpointId,
    },
  });
}

function trustRank(trustLevel: UserTrustLevel): number {
  switch (trustLevel) {
    case "guest": return 0;
    case "user": return 1;
    case "admin": return 2;
    default: {
      const _exhaustive: never = trustLevel;
      return _exhaustive;
    }
  }
}

function sameDeliveryOrigin(a: DeliveryOrigin | null, b: DeliveryOrigin | null): boolean {
  if (a === null || b === null) return a === b;
  return a.channelType === b.channelType
    && a.channelId === b.channelId
    && a.userId === b.userId
    && a.tenantId === b.tenantId
    && a.threadId === b.threadId;
}

/** Derive the interpreter language from a `<runId>.<language>` scriptRef extension. */
function languageFromScriptRef(scriptRef: string): "ts" | "js" | "py" | undefined {
  const ext = scriptRef.slice(scriptRef.lastIndexOf(".") + 1);
  return ext === "ts" || ext === "js" || ext === "py" ? ext : undefined;
}
