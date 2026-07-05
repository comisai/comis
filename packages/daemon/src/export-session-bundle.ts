// SPDX-License-Identifier: Apache-2.0
/**
 * `exportSessionBundleFromKey` — the testable unit behind the
 * `/export-trajectory` slash command's bundle export.
 *
 * A formatted sessionKey is resolved to its REAL session `.jsonl` via the
 * pointer discipline (`resolveSessionFilePath`) BEFORE the exporter is called.
 * The exporter CONSUMES `sessionFile` (it stats + SDK-opens it), so a
 * hand-built flat `<dataDir>/sessions/<id>.jsonl` path — which never exists on
 * disk — makes the export fail `session-file-not-readable` for every real
 * channel session. Resolving through the pointer is the ONE authoritative way
 * to find the file; a genuine miss returns an honest error rather than statting
 * a fabricated path.
 *
 * @module
 */

import { ok, err, type Result } from "@comis/shared";
import { exportTrajectoryBundle, type ExportTrajectoryBundleError } from "@comis/observability";
import { resolveSessionFilePath } from "./api/obs-handlers/obs-explain-readers.js";

/** Dependencies for `exportSessionBundleFromKey`. */
export interface ExportSessionBundleDeps {
  /** The `~/.comis` root the session tree lives under. */
  readonly dataDir: string;
  /** The workspace dir the exporter derives `trace-exports/` from. */
  readonly workspaceDir: string;
  /** A formatted SessionKey (`tenant:user:channel[:peer:...]`). */
  readonly sessionId: string;
  /**
   * Injectable exporter seam (defaults to the real `exportTrajectoryBundle`)
   * so a unit test can drive the resolution without writing a bundle.
   */
  readonly exportTrace?: typeof exportTrajectoryBundle;
}

/** Failure shape: the resolver miss OR a mapped exporter error kind. */
export interface ExportSessionBundleError {
  readonly kind: string;
  readonly reason: string;
}

/** Render an exporter error variant into a diagnosable reason string. */
function describeExportError(e: ExportTrajectoryBundleError): string {
  switch (e.kind) {
    case "session-file-too-large":
      return `session file too large (${e.bytes} bytes)`;
    case "session-file-not-readable":
      return `session file not readable: ${e.reason}`;
    case "bundle-dir-create-failed":
      return `bundle dir create failed: ${e.reason}`;
    case "bundle-file-write-failed":
      return `bundle file write failed (${e.file}): ${e.reason}`;
  }
}

/**
 * Resolve the sessionKey → real `.jsonl` via the pointer discipline, then export
 * the trajectory bundle into `<workspaceDir>/trace-exports/`.
 *
 * Returns `err({ kind: "session-not-resolvable" })` when no session artifacts
 * exist for the key (the caller can surface that instead of a stat failure on a
 * fabricated path), or the mapped exporter error kind on an export failure.
 */
export async function exportSessionBundleFromKey(
  deps: ExportSessionBundleDeps,
): Promise<Result<{ bundlePath: string }, ExportSessionBundleError>> {
  const sessionFile = resolveSessionFilePath(deps.dataDir, deps.sessionId);
  if (sessionFile === undefined) {
    return err({
      kind: "session-not-resolvable",
      reason: "no session artifacts found on disk for the requested session",
    });
  }

  const exportTrace = deps.exportTrace ?? exportTrajectoryBundle;
  const result = await exportTrace({
    sessionId: deps.sessionId,
    sessionKey: deps.sessionId,
    sessionFile,
    workspaceDir: deps.workspaceDir,
    traceId: deps.sessionId, // best-effort; the exporter uses it for naming only
    agentId: "unknown", // best-effort; the real agentId lives in the session header
  });
  if (!result.ok) {
    return err({ kind: result.error.kind, reason: describeExportError(result.error) });
  }
  return ok({ bundlePath: result.value.bundleDir });
}
