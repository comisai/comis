// SPDX-License-Identifier: Apache-2.0
/**
 * The `--session` / `--deep` embed engine for the support bundle.
 *
 * `classifySessionRef` routes a `--session <ref>` the same way `comis explain`
 * does (a sessionKey, a traceId, or an autonomy run's rootRunId), and
 * `embedSession` turns that ref into an offline `IncidentReport` and — on
 * `--deep` — the REAL session `.jsonl` path resolved through the pointer seam.
 *
 * The two disk-touching steps are injectable seams defaulting to the sanctioned
 * offline readers, so unit tests inject fixtures and never load the daemon
 * runtime graph the real seams lazy-import. Both steps are failure-tolerant:
 * an assembler throw becomes an `explain` warning, an unresolved deep file
 * becomes a `trace-export` warning, and `embedSession` never throws — a bundle
 * is still produced (partial), with an honest record of what could not be read.
 *
 * `embedSession` only RESOLVES the deep session file; writing the trace bundle
 * needs the bundle directory and belongs to the generate orchestration.
 *
 * @module
 */

import type { IncidentReport } from "@comis/core";

import { assembleIncidentReportOffline, resolveSessionFileOffline } from "../util/offline-obs.js";
import type { SupportBundleWarning } from "./types.js";

/**
 * The classified `--session` ref — exactly one of the three id forms
 * `assembleIncidentReportOffline` accepts. Mirrors `comis explain`'s routing.
 */
export interface ClassifiedSessionRef {
  sessionKey?: string;
  traceId?: string;
  rootRunId?: string;
}

/**
 * Route a `--session <ref>` to its id form, mirroring `comis explain` exactly.
 *
 * The `root-` prefix is the disambiguator for an autonomy run's rootRunId and is
 * checked FIRST — a synthetic in-process root is `root-session-<key>` and
 * contains a colon, yet must NOT route to sessionKey. Otherwise a sessionKey is
 * an agent-scoped session key (has a colon) and a traceId is a UUID (no colon).
 *
 * @param ref - the raw `--session` argument.
 * @returns exactly one populated id field.
 */
export function classifySessionRef(ref: string): ClassifiedSessionRef {
  if (ref.startsWith("root-")) return { rootRunId: ref };
  if (ref.includes(":")) return { sessionKey: ref };
  return { traceId: ref };
}

/** Injectable seams + inputs for one `--session`/`--deep` embed. */
export interface EmbedSessionDeps {
  /** The raw `--session` ref (sessionKey | traceId | rootRunId). */
  readonly ref: string;
  /** Whether `--deep` was requested — resolves the real session file when true. */
  readonly deep: boolean;
  /** The `~/.comis` root the offline readers resolve against. */
  readonly dataDir: string;
  /** Report depth, forwarded to the assembler when set. */
  readonly depth?: "summary" | "full";
  /**
   * The IncidentReport assembler, defaulting to the sanctioned offline seam
   * (`assembleIncidentReportOffline`, which resolves the session INTERNALLY via
   * the pointer discipline). Injected in tests with a hermetic fixture so a unit
   * run never loads the @comis/daemon runtime graph.
   */
  readonly assembleIncident?: (
    dataDir: string,
    params: { sessionKey?: string; traceId?: string; rootRunId?: string; depth?: "summary" | "full" },
  ) => Promise<IncidentReport>;
  /**
   * The sessionKey → real `.jsonl` resolver, defaulting to the sanctioned
   * offline daemon seam (`resolveSessionFileOffline`). Injected in tests so the
   * deep path stays hermetic.
   */
  readonly resolveSessionFile?: (dataDir: string, sessionKey: string) => Promise<string | undefined>;
}

/** The embed outcome: the report, the resolved deep file, and any section warnings. */
export interface EmbedSessionResult {
  readonly explain?: IncidentReport;
  readonly deepSessionFile?: string;
  readonly warnings: SupportBundleWarning[];
}

/** Best-effort human-readable reason from a Result error or thrown value. */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error !== null && typeof error === "object" && "reason" in error) {
    const reason = (error as { reason?: unknown }).reason;
    if (typeof reason === "string") return reason;
  }
  return String(error);
}

/**
 * Assemble the `--session` IncidentReport and, on `--deep`, resolve the real
 * session file — the reusable engine the generate orchestration composes.
 *
 * Steps: (1) classify the ref and forward it (plus `depth`) to the assembler;
 * (2) on an assembler throw, record an `explain` warning and return with no
 * report (never throw); (3) on `--deep` with a report, resolve the session file
 * via the pointer seam using the report's ALREADY-RESOLVED `sessionKey` (the
 * assembler canonicalized a traceId/rootRunId ref to a sessionKey for free —
 * strictly better than any raw-ref path), recording a `trace-export` warning if
 * it cannot be resolved. The explain report survives an unresolved deep file.
 *
 * @param deps - the ref, flags, data dir, and injectable seams.
 * @returns `{ explain?, deepSessionFile?, warnings }` — always resolves, never throws.
 */
export async function embedSession(deps: EmbedSessionDeps): Promise<EmbedSessionResult> {
  const assembleIncident = deps.assembleIncident ?? assembleIncidentReportOffline;
  const resolveSessionFile = deps.resolveSessionFile ?? resolveSessionFileOffline;
  const warnings: SupportBundleWarning[] = [];

  const params = {
    ...classifySessionRef(deps.ref),
    ...(deps.depth !== undefined ? { depth: deps.depth } : {}),
  };

  let explain: IncidentReport;
  try {
    explain = await assembleIncident(deps.dataDir, params);
  } catch (thrown) {
    warnings.push({
      source: "explain",
      code: "explain_assembly_failed",
      count: 1,
      message: `Incident report could not be assembled for the session ref: ${describeError(thrown)}`,
    });
    return { warnings };
  }

  if (!deps.deep) return { explain, warnings };

  const deepSessionFile = await resolveSessionFile(deps.dataDir, explain.sessionKey);
  if (deepSessionFile === undefined) {
    warnings.push({
      source: "trace-export",
      code: "session_file_unresolved",
      count: 1,
      message:
        "The deep trace export was skipped: the session file could not be resolved " +
        "from the pointer record on disk.",
    });
    return { explain, warnings };
  }

  return { explain, deepSessionFile, warnings };
}
