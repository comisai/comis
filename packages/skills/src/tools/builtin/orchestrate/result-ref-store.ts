// SPDX-License-Identifier: Apache-2.0
/**
 * `result-ref-store` — the workspace-confined disk I/O + GC behind the minimal
 * `ResultRef`. It materializes a high-volume tool return to
 * `<workspace>/results/<id>.<kind>` and hands back a structured `ResultRef`; the
 * big payload stays on disk as DATA and is sliced in-jail (`jq`/`grep`/`read`)
 * the same turn, so only the tiny handle re-enters context (the
 * "materialize-then-extract" pattern — an untrusted web/MCP payload never
 * re-enters as control).
 *
 * This is the DISK half on top of the PURE math (`@comis/core`
 * `result-ref.ts`: `checkPerFileCap`/`selectEvictions`/`isExpired`/
 * `computeExpiresAt`) — the store does the fs, the core owns the GC arithmetic.
 *
 * It is NET-NEW and DISTINCT from `microcompaction-guard.ts` (do NOT
 * conflate):
 *   - dir: `<workspace>/results/` (the jail's writable root), NOT
 *     `<sessionDir>/tool-results/`.
 *   - return: the structured `ResultRef` (`{ref,kind,bytes,...}`), NOT a string.
 *   - lifecycle: per-run, GC'd on orchestrate-run end (the runner calls
 *     `gcRun`/`cleanupRun`), NOT session-lifetime.
 * It REUSES only the contained-write helpers (`ensureContainedDir`/
 * `writeRegularFile`, `@comis/observability` fs-safe.ts:408/582) — the same
 * substrate `microcompaction-guard.ts:31,90-107` calls — with the workspace as
 * the `confinedBaseDir`.
 *
 * Skills layer: imports `@comis/core` + `@comis/observability` + `@comis/shared`
 * only (NO `@comis/agent`/`@comis/daemon` — the proven microcompaction path).
 * All paths go through `safePath` (AGENTS.md §2.2 — no `path.join` for
 * caller-influenced segments); all time is the injected `nowMs` (§2.8 — the
 * runner injects the clock; this module reads no ambient clock).
 *
 * @module
 */
import {
  checkPerFileCap,
  computeExpiresAt,
  isExpired,
  safePath,
  selectEvictions,
  toSafeErrorLogString,
  PER_FILE_CAP_BYTES,
  type ComisLogger,
  type ResultRef,
} from "@comis/core";
import { ensureContainedDir, writeRegularFile } from "@comis/observability";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// Constants — the store's own knobs (the cap/GC math lives in @comis/core).
// ---------------------------------------------------------------------------

/** The fixed subdir under the jailed workspace that holds materialized results. */
const RESULTS_DIR = "results";

/**
 * The maximum bytes of a `ResultRef.preview`. The preview re-enters context
 * with the handle, so it MUST stay tiny regardless of payload size — a bounded
 * head, never the whole (untrusted, possibly multi-MB) payload.
 */
const PREVIEW_MAX_BYTES = 2048;

/**
 * The default time-to-live for a materialized result, in milliseconds. After
 * this the run-GC (`gcRun`) evicts the file even before the aggregate cap is
 * hit. 30 min is a sane M1 default (a single orchestrate run is far shorter);
 * the runner may override via `ctx.ttlMs`.
 */
const DEFAULT_TTL_MS = 30 * 60 * 1000;

/**
 * The TTL for a durable CHECKPOINT ResultRef (RESUME-05) — deliberately far
 * LONGER than {@link DEFAULT_TTL_MS} so a checkpoint outlives a full run PLUS a
 * resume window: a run may last up to MAX_TIMEOUT_MS (~10 min) and then sit as a
 * resumable durable row until an operator (or the boot sweep) resumes it, so the
 * last checkpoint must survive well beyond the 30-min ordinary-result default.
 * 24 h gives an overnight run that times out a full day to be resumed before the
 * orphan sweep reclaims the (still capped) blob. The runner threads this via
 * `MaterializeContext.ttlMs`; the per-file (8 MiB) + per-run aggregate caps are
 * UNCHANGED — a checkpoint is capped exactly like any ResultRef (T-WS4-02), only
 * its lifetime is longer.
 */
export const CHECKPOINT_TTL_MS = 24 * 60 * 60 * 1000;

/** The materialized-content kinds (mirrors `ResultRef.kind`). */
type ResultKind = ResultRef["kind"];

// ---------------------------------------------------------------------------
// Dependencies + the public surface.
// ---------------------------------------------------------------------------

/** Injected collaborators (AGENTS.md §2.4). */
export interface ResultRefStoreDeps {
  /** Structured logger — instrument the materialize + the refuse/failure branches. */
  readonly logger: ComisLogger;
}

/** Per-materialize context the runner threads in (workspace + run + injected clock). */
export interface MaterializeContext {
  /** The jailed workspace path — the writable root + `confinedBaseDir`. */
  readonly workspacePath: string;
  /** The orchestrate run id (scopes the lifecycle; NOT part of the on-disk path). */
  readonly runId: string;
  /** The injected wall clock (no ambient-clock read — §2.8). */
  readonly nowMs: number;
  /** Optional TTL override (ms); defaults to {@link DEFAULT_TTL_MS}. */
  readonly ttlMs?: number;
}

/** Context for the per-run GC sweep (aggregate cap + TTL eviction). */
export interface GcRunContext {
  readonly workspacePath: string;
  readonly runId: string;
  /** The per-run aggregate budget; `selectEvictions` evicts oldest-first past it. */
  readonly aggregateCapBytes: number;
  /** The injected wall clock — drives the TTL-expiry eviction. */
  readonly nowMs: number;
}

/** Context for the run-end cleanup. */
export interface CleanupRunContext {
  readonly workspacePath: string;
  readonly runId: string;
}

/** Context for the per-run materialized-aggregate read (read-only enumeration). */
export interface RunAggregateContext {
  /** The jailed workspace path whose run-scoped results directory is enumerated. */
  readonly workspacePath: string;
  /** The orchestrate run whose isolated results directory is enumerated. */
  readonly runId: string;
}

/** The content-free error a refuse/failed-write returns (never the payload). */
export interface MaterializeError {
  /** A short, content-free reason (safe to surface to the agent/logs). */
  readonly error: string;
}

/** The `result-ref-store` public surface (the runner owns the run lifecycle). */
export interface ResultRefStore {
  /**
   * Write `payload` to `<workspacePath>/results/<id>.<kind>` and return a
   * `ResultRef`. Refuses (a content-free {@link MaterializeError}, writes
   * nothing) when the payload exceeds the per-file cap; returns `undefined`
   * only if the contained write itself failed (the caller honest-degrades).
   */
  materialize(
    payload: string | Buffer,
    toolName: string,
    ctx: MaterializeContext,
  ): Promise<ResultRef | MaterializeError | undefined>;
  /** Evict oldest-first past the aggregate cap + drop any TTL-expired files. */
  gcRun(ctx: GcRunContext): Promise<void>;
  /** Remove the run's `results/` entries on run end. */
  cleanupRun(ctx: CleanupRunContext): Promise<void>;
  /**
   * Read the run's materialized-result aggregate — the file count and total
   * bytes currently under `<workspace>/results/`. READ-ONLY (it enumerates,
   * never evicts), so the runner can capture it BEFORE {@link cleanupRun} wipes
   * the dir. Content-free: counts + bytes only, never a path or content.
   * Optional so a minimal stub store need not implement it; the concrete
   * {@link createResultRefStore} always provides it.
   */
  runAggregate?(ctx: RunAggregateContext): { count: number; bytes: number };
}

// ---------------------------------------------------------------------------
// Pure helpers (no fs, no clock) — kind inference, preview, id.
// ---------------------------------------------------------------------------

/**
 * Infer the materialized {@link ResultKind} from the payload + the producing
 * tool. A Buffer is always `binary`; a string is sniffed: NDJSON (every
 * non-blank line is a JSON value) → `jsonl`; a single JSON object/array →
 * `json`; an HTML doc → `html`; otherwise `text`. (CSV is not auto-detected in
 * M1 — a tool that knows it is tabular can extend this later.)
 */
export function inferKind(payload: string | Buffer): ResultKind {
  if (Buffer.isBuffer(payload)) return "binary";

  const trimmed = payload.trim();
  if (trimmed.length === 0) return "text";

  // HTML: a doctype or an <html> root (cheap, order-before-JSON since an HTML
  // doc never parses as JSON anyway).
  const lower = trimmed.slice(0, 200).toLowerCase();
  if (lower.startsWith("<!doctype html") || lower.startsWith("<html")) return "html";

  // NDJSON: ≥2 non-blank lines, each a parseable JSON value.
  const lines = trimmed.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length >= 2 && lines.every((l) => isJsonValue(l.trim()))) return "jsonl";

  // A single JSON object/array.
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    if (isJsonValue(trimmed)) return "json";
  }

  return "text";
}

/** Whether `s` parses as JSON (guards the kind sniff). */
function isJsonValue(s: string): boolean {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse the lifecycle stamps a store-written basename encodes —
 * `<createdAtMs36>-<seq36>-<expiresAtMs36>.<kind>`. The base-36 stamps are the
 * authoritative, injected-clock-consistent timestamps the GC evaluates against
 * `nowMs`. A name that does not match the scheme (a stray/foreign file) falls
 * back to the OS `mtimeMs` for both stamps (treated as never-TTL-expired by the
 * caller, which is the safe default — the aggregate cap still bounds it).
 */
function parseStamps(
  name: string,
  fallbackMs: number,
): { createdAtMs: number; expiresAtMs: number } {
  const base = name.replace(/\.[^.]+$/, ""); // strip the `.<kind>` extension
  const parts = base.split("-");
  if (parts.length === 3) {
    const createdAtMs = parseInt(parts[0]!, 36);
    const expiresAtMs = parseInt(parts[2]!, 36);
    if (Number.isFinite(createdAtMs) && Number.isFinite(expiresAtMs)) {
      return { createdAtMs, expiresAtMs };
    }
  }
  // Unknown name → createdAt from mtime, but NEVER TTL-expire it on a guessed
  // stamp (the aggregate cap still bounds it). +Infinity = no TTL eviction.
  return { createdAtMs: fallbackMs, expiresAtMs: Number.POSITIVE_INFINITY };
}

/**
 * Build a bounded preview (≤ {@link PREVIEW_MAX_BYTES}) that rides the handle
 * into context. For text, a UTF-8 head; for binary, a short safe descriptor
 * (never the raw bytes). The slice is byte-bounded, not char-bounded, so a
 * multi-byte head never overflows the cap.
 */
export function buildPreview(payload: string | Buffer, kind: ResultKind): string {
  if (kind === "binary" || Buffer.isBuffer(payload)) {
    const len = Buffer.isBuffer(payload) ? payload.byteLength : Buffer.byteLength(payload);
    return `[binary ${len} bytes]`;
  }
  // Byte-bounded head: slice the UTF-8 buffer, then decode (a trailing partial
  // multibyte char decodes to U+FFFD — acceptable for a preview).
  const buf = Buffer.from(payload, "utf8");
  if (buf.byteLength <= PREVIEW_MAX_BYTES) return payload;
  return buf.subarray(0, PREVIEW_MAX_BYTES).toString("utf8");
}

/**
 * Convert an execution id into one bounded, separator-free directory segment.
 * The digest is stable across daemon restarts and never embeds caller-controlled
 * path syntax, so every run owns exactly one directory under `results/`.
 */
export function safeResultRunId(runId: string): string {
  return createHash("sha256").update(runId, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// The store factory.
// ---------------------------------------------------------------------------

/**
 * Create a `result-ref-store` bound to the injected deps. The store carries a
 * per-instance monotonic counter so two materializes within the same injected
 * `nowMs` never collide on an id — deterministic by call order, with no
 * ambient-clock read and no randomness (§2.8 purity).
 */
export function createResultRefStore(deps: ResultRefStoreDeps): ResultRefStore {
  const log = deps.logger.child({ submodule: "result-ref-store" });
  const seqByRun = new Map<string, number>();

  /**
   * A collision-free, deterministic basename that ENCODES the lifecycle stamps
   * the GC needs: `<createdAtMs36>-<seq36>-<expiresAtMs36>`. Both timestamps come
   * from the injected `nowMs` (no ambient-clock read, no randomness — §2.8), so
   * the run-GC evaluates TTL + eviction-age against the SAME injected clock,
   * never the OS
   * mtime (which would diverge from a synthetic/replayed clock). The basename is
   * opaque to the agent (the `ResultRef.ref` is a handle, not a parsed path).
   */
  function nextBasename(runId: string, createdAtMs: number, expiresAtMs: number): string {
    const n = seqByRun.get(runId) ?? 0;
    seqByRun.set(runId, n + 1);
    return `${createdAtMs.toString(36)}-${n.toString(36)}-${expiresAtMs.toString(36)}`;
  }

  async function materialize(
    payload: string | Buffer,
    toolName: string,
    ctx: MaterializeContext,
  ): Promise<ResultRef | MaterializeError | undefined> {
    const bytes = Buffer.isBuffer(payload)
      ? payload.byteLength
      : Buffer.byteLength(payload, "utf8");

    // 1. Per-file cap — refuse (content-free) BEFORE any write.
    const capCheck = checkPerFileCap(bytes, PER_FILE_CAP_BYTES);
    if (!capCheck.ok) {
      log.warn(
        {
          toolName,
          bytes,
          // "resource": a size/budget limit exceeded (the closed ErrorKind union).
          // The specific reason rides the `error` return + the hint.
          errorKind: "resource" as const,
          hint: `Result is ${bytes}B, over the ${PER_FILE_CAP_BYTES}B per-file cap — narrow the tool call (a query/limit) so the return fits.`,
        },
        "Refusing to materialize an over-cap result",
      );
      return { error: `result_ref_too_large: ${bytes} > ${PER_FILE_CAP_BYTES}` };
    }

    const kind = inferKind(payload);
    // Stamp the lifecycle up-front so the basename can ENCODE it (the GC reads
    // these back off the name, injected-clock-consistent — see nextBasename).
    const ttlMs = ctx.ttlMs ?? DEFAULT_TTL_MS;
    const expiresAtMs = ctx.nowMs + ttlMs;
    const fileName = `${nextBasename(ctx.runId, ctx.nowMs, expiresAtMs)}.${kind}`;

    // 2. Resolve the workspace-confined path. safePath throws on a traversal
    //    escape; the id is store-generated (not the caller's runId) so this is
    //    belt-and-suspenders — caught and honest-degraded, never an unhandled
    //    throw (T-212-14).
    let absPath: string;
    let resultsDir: string;
    try {
      absPath = safePath(
        ctx.workspacePath,
        RESULTS_DIR,
        safeResultRunId(ctx.runId),
        fileName,
      );
      resultsDir = dirname(absPath);
    } catch (e) {
      log.warn(
        {
          toolName,
          // "validation": a path validation rejection (closed ErrorKind union).
          errorKind: "validation" as const,
          err: toSafeErrorLogString(e),
          hint: "The results/ path escaped the workspace — refusing the write.",
        },
        "Refusing to materialize outside the workspace",
      );
      return { error: "path_traversal: results path escapes the workspace" };
    }

    // 3. Contained write (REUSE the fs-safe helpers; confinedBaseDir=workspace).
    const dirResult = ensureContainedDir({
      dir: resultsDir,
      mode: 0o700,
      confinedBaseDir: ctx.workspacePath,
    });
    const writeResult = writeRegularFile({
      path: absPath,
      content: payload,
      confinedBaseDir: ctx.workspacePath,
    });
    if (!dirResult.ok || !writeResult.ok) {
      log.warn(
        {
          toolName,
          bytes,
          // "internal": an unexpected I/O / confinement failure on the write.
          errorKind: "internal" as const,
          err: toSafeErrorLogString(
            dirResult.ok ? writeResult.ok ? undefined : writeResult.error : dirResult.error,
          ),
          hint: "The contained write was rejected (confinement escape or I/O error) — the result was NOT materialized.",
        },
        "Failed to write a materialized result",
      );
      return undefined;
    }

    const ref: ResultRef = {
      ref: `${RESULTS_DIR}/${safeResultRunId(ctx.runId)}/${fileName}`,
      kind,
      bytes,
      preview: buildPreview(payload, kind),
      expiresAt: computeExpiresAt(ctx.nowMs, ttlMs),
    };

    log.debug(
      { step: "materialize", toolName, bytes, kind, ref: ref.ref },
      "Materialized a high-volume result to the workspace",
    );
    return ref;
  }

  async function gcRun(ctx: GcRunContext): Promise<void> {
    const entries = listRunResults(ctx.workspacePath, ctx.runId);
    if (entries.length === 0) return;

    // a) TTL: drop any file whose per-file expiry (ENCODED in the basename at
    //    materialize time, off the injected clock) is past `nowMs`. We read the
    //    authoritative `expiresAtMs` from the name rather than the OS mtime so a
    //    synthetic/replayed clock stays consistent (the runner injects nowMs).
    //    A non-finite expiry (a foreign file with no parseable stamp →
    //    +Infinity) is NEVER TTL-expired — and we must NOT route it through
    //    computeExpiresAt, whose `.toISOString()` throws on an invalid Date; the
    //    aggregate cap still bounds such a file.
    const survivors: RunResultEntry[] = [];
    for (const entry of entries) {
      const expired =
        Number.isFinite(entry.expiresAtMs) &&
        isExpired(computeExpiresAt(entry.expiresAtMs, 0), ctx.nowMs);
      if (expired) {
        bestEffortUnlink(entry.path, "ttl-expired");
      } else {
        survivors.push(entry);
      }
    }

    // b) Aggregate cap: evict oldest-first until under the per-run budget.
    const toEvict = selectEvictions(
      survivors.map((e) => ({ path: e.path, bytes: e.bytes, createdAtMs: e.createdAtMs })),
      ctx.aggregateCapBytes,
    );
    for (const path of toEvict) {
      bestEffortUnlink(path, "aggregate-cap");
    }

    if (toEvict.length > 0 || survivors.length !== entries.length) {
      log.debug(
        {
          step: "gc",
          runId: ctx.runId,
          ttlEvicted: entries.length - survivors.length,
          capEvicted: toEvict.length,
        },
        "Swept the run's results/ (TTL + aggregate cap)",
      );
    }
  }

  async function cleanupRun(ctx: CleanupRunContext): Promise<void> {
    const resultsDir = resolveResultsDir(ctx.workspacePath, ctx.runId);
    if (resultsDir === undefined || !existsSync(resultsDir)) return;
    try {
      rmSync(resultsDir, { recursive: true, force: true });
      log.debug({ step: "cleanup", runId: ctx.runId }, "Cleaned the run's results/ on run end");
    } catch (e) {
      log.warn(
        {
          runId: ctx.runId,
          err: toSafeErrorLogString(e),
          // "internal": an unexpected I/O failure during best-effort cleanup.
          errorKind: "internal" as const,
          hint: "Best-effort cleanup of results/ failed — a later run-GC or workspace teardown will reclaim it.",
        },
        "Failed to clean a run's results/",
      );
    }
  }

  /** Resolve one run's isolated results directory defensively. */
  function resolveResultsDir(workspacePath: string, runId: string): string | undefined {
    try {
      return safePath(workspacePath, RESULTS_DIR, safeResultRunId(runId));
    } catch {
      return undefined;
    }
  }

  /**
   * List the run's results with byte size + the lifecycle stamps (best-effort).
   * `createdAtMs`/`expiresAtMs` are parsed from the basename (the authoritative,
   * injected-clock-consistent source); the OS `mtimeMs` is only the fallback for
   * a name that does not match our scheme (defensive — should not occur for
   * store-written files).
   */
  function listRunResults(workspacePath: string, runId: string): RunResultEntry[] {
    const resultsDir = resolveResultsDir(workspacePath, runId);
    if (resultsDir === undefined || !existsSync(resultsDir)) return [];
    let names: string[];
    try {
      names = readdirSync(resultsDir);
    } catch {
      return [];
    }
    const out: RunResultEntry[] = [];
    for (const name of names) {
      let path: string;
      try {
        path = safePath(resultsDir, name);
      } catch {
        continue; // skip anything that doesn't resolve under results/
      }
      try {
        const st = statSync(path);
        if (!st.isFile()) continue;
        const stamps = parseStamps(name, st.mtimeMs);
        out.push({
          path,
          bytes: st.size,
          createdAtMs: stamps.createdAtMs,
          expiresAtMs: stamps.expiresAtMs,
        });
      } catch {
        // file vanished between readdir and stat — ignore.
      }
    }
    return out;
  }

  /** Unlink a file best-effort; a failure is logged (§2.2), never thrown. */
  function bestEffortUnlink(path: string, reason: string): void {
    try {
      unlinkSync(path);
    } catch (e) {
      log.debug(
        { err: toSafeErrorLogString(e), hint: `best-effort unlink (${reason}) failed; will retry on next GC/cleanup` },
        "Suppressed a results/ unlink failure",
      );
    }
  }

  /**
   * Fold the run's materialized results into a content-free `{count, bytes}`
   * aggregate by re-using {@link listRunResults}. READ-ONLY — it enumerates and
   * sums, never unlinks — so the runner may call it BEFORE gcRun/cleanupRun to
   * learn what the run materialized. An absent/empty `results/` folds to
   * `{count:0, bytes:0}` (listRunResults returns [] defensively — no error).
   */
  function runAggregate(ctx: RunAggregateContext): { count: number; bytes: number } {
    const entries = listRunResults(ctx.workspacePath, ctx.runId);
    let bytes = 0;
    for (const entry of entries) {
      bytes += entry.bytes;
    }
    return { count: entries.length, bytes };
  }

  return { materialize, gcRun, cleanupRun, runAggregate };
}

/** An on-disk results entry (path + size + lifecycle stamps) for the GC sweep. */
interface RunResultEntry {
  readonly path: string;
  readonly bytes: number;
  /** Materialize time (from the basename) — drives oldest-first eviction. */
  readonly createdAtMs: number;
  /** Per-file expiry (from the basename) — drives TTL eviction. */
  readonly expiresAtMs: number;
}
