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
 * port (`upsertCheckpoint`/`getByRootRun`) and an fs read seam — so the whole
 * lifecycle is macOS-unit-testable with no real sqlite or spawn. The store port
 * is a structural subset of the daemon's durable-run store, so the daemon threads
 * the real store directly and @comis/skills never imports it concretely (the
 * mint-lease closure precedent).
 *
 * The row is content-free: `{rootRunId, scriptRef, checkpointRef}` — a path + an
 * id pointer, never the script bytes or the checkpoint body. The build mirrors
 * the graph coordinator's checkpoint row but with a FLAT `spawnTree` (a
 * `string[]`, so the DAG-vs-flat discriminator routes it to the flat arm) and
 * NEVER writes the outward-send counter (`stepIndex` maps to `outward_step`,
 * owned solely by the store's `allocateOutwardStep`; `upsertCheckpoint` omits
 * the column, so a checkpoint between two outward sends cannot reset it).
 *
 * @module
 */
import { existsSync, readFileSync, unlinkSync } from "node:fs";

import { safePath, type ComisLogger, type DurableRunRecord } from "@comis/core";
import { ok, err, type Result } from "@comis/shared";

// ---------------------------------------------------------------------------
// Injected seams.
// ---------------------------------------------------------------------------

/**
 * The narrow durable-run store port the orchestrate runner needs — the two
 * methods it calls, a structural subset of the daemon's durable-run store, so
 * the daemon threads the real store directly and @comis/skills never imports it.
 */
export interface OrchestrateDurableRuns {
  /** Idempotent upsert keyed on `rootRunId`; COALESCE-preserves a prior checkpointRef/scriptRef. */
  upsertCheckpoint(record: DurableRunRecord): Promise<Result<void, Error>>;
  /** Read the durable row for a root run id (the resume lookup). */
  getByRootRun(rootRunId: string): Promise<Result<DurableRunRecord | undefined, Error>>;
  /**
   * Mark the row terminal on a NON-resumable completion (success or a non-timeout
   * failure) so `listResumable` stops re-surfacing a finished run on every boot and
   * the orphan sweep never false-orphans it — mirroring the graph coordinator /
   * sub-agent runner terminal write. A structural subset of the daemon's
   * `DurableRunPort.markCompleted`; optional so a minimal store stub compiles (the
   * concrete store always provides it, and the runner skips it on a resumable timeout).
   */
  markCompleted?(rootRunId: string): Promise<Result<void, Error>>;
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
   * ref resolves in the new run. (F-WS4-A.)
   */
  readonly checkpointRef?: string;
}

/** Inputs shared by the row builders (the content-free durable pointers + clock). */
export interface DurableRowInput {
  /** The tree-stable root run id — the durable row's idempotency key. */
  readonly rootRunId: string;
  /** The pinned script path relative to the workspace (`<runId>.<language>`). */
  readonly scriptRef: string;
  /** The last checkpoint ref, when one exists (omitted at run start). */
  readonly checkpointRef?: string;
  /** The injected wall clock (no ambient-clock read). */
  readonly nowMs: number;
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
    rootRunId: input.rootRunId,
    spawnTree: [],
    caps: [],
    leaseIds: [],
    budgetConsumed: 0,
    cronOrigin: null,
    stepIndex: -1,
    status: "running",
    lastHeartbeatAt: input.nowMs,
    scriptRef: input.scriptRef,
    ...(input.checkpointRef !== undefined ? { checkpointRef: input.checkpointRef } : {}),
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
  input: { rootRunId: string; scriptRef: string; workspacePath: string; runId: string },
  logger?: ComisLogger,
): Promise<void> {
  if (runs === undefined) return; // resume surface off — nothing durable to finalize.
  const done = await runs.markCompleted?.(input.rootRunId);
  if (done !== undefined && !done.ok) {
    logger?.warn(
      { runId: input.runId, rootRunId: input.rootRunId, err: done.error, errorKind: "internal" as const, hint: "the durable row could not be marked completed — the watchdog re-anchor cap eventually orphans the stale 'running' row after repeated no-progress attempts (no live impact)" },
      "orchestrate durable markCompleted failed (non-fatal)",
    );
  }
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- safePath-confined to the run workspace; scriptRef is a store-minted <runId>.<language> path
    unlinkSync(safePath(input.workspacePath, input.scriptRef));
  } catch (e) {
    logger?.debug(
      { runId: input.runId, err: e instanceof Error ? e : undefined, hint: "best-effort unlink of the pinned script failed; a later workspace teardown reclaims it" },
      "orchestrate pinned-script cleanup failed (non-fatal)",
    );
  }
}

// ---------------------------------------------------------------------------
// The pinned-byte resume loader.
// ---------------------------------------------------------------------------

/** A refusal class resolveScriptSource surfaces to the runner (mapped to a tool error). */
export interface ResumeInputRefusal {
  /** The tool-error code the runner throws (a subset of the tool-error codes). */
  readonly code: "not_implemented" | "not_found";
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
  ctx: { workspacePath: string; runId: string },
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
  const loaded = await loadResumeSpec(runs, fs, {
    resumeRunId: params.resumeRunId,
    workspacePath: ctx.workspacePath,
  });
  if (!loaded.ok) {
    return err({ code: "not_found", message: "The orchestrate run to resume could not be loaded.", hint: loaded.error });
  }
  return ok({
    script: loaded.value.scriptBytes,
    language: loaded.value.language,
    scriptName: loaded.value.scriptRef,
    checkpointRef: loaded.value.checkpointRef,
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
  input: { resumeRunId: string; workspacePath: string },
): Promise<Result<ResumeSpec, string>> {
  const rowResult = await runs.getByRootRun(input.resumeRunId);
  if (!rowResult.ok) return err("the durable run lookup failed");
  const row = rowResult.value;
  if (row === undefined) return err("no durable run found to resume");
  const scriptRef = row.scriptRef;
  if (!scriptRef) return err("the durable run has no pinned script — not a resumable run");
  const language = languageFromScriptRef(scriptRef);
  if (language === undefined) return err("the pinned script has no recognized language extension");
  let absPath: string;
  try {
    absPath = safePath(input.workspacePath, scriptRef);
  } catch {
    return err("the pinned script path escapes the workspace");
  }
  if (!fs.exists(absPath)) return err("the pinned script is gone (checkpoint reclaimed)");
  let scriptBytes: string;
  try {
    scriptBytes = fs.read(absPath);
  } catch {
    return err("the pinned script could not be read");
  }
  return ok({ scriptRef, scriptBytes, language, checkpointRef: row.checkpointRef ?? undefined });
}

/** Derive the interpreter language from a `<runId>.<language>` scriptRef extension. */
function languageFromScriptRef(scriptRef: string): "ts" | "js" | "py" | undefined {
  const ext = scriptRef.slice(scriptRef.lastIndexOf(".") + 1);
  return ext === "ts" || ext === "js" || ext === "py" ? ext : undefined;
}
