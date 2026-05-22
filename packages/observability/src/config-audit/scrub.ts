// SPDX-License-Identifier: Apache-2.0
/**
 * Retroactive config-audit scrubber.
 *
 * `scrubConfigAuditLog({filePath})` rewrites the existing audit log
 * with up-to-date redaction:
 *
 *   1. Read all lines from `filePath` (preserving final-newline
 *      semantics).
 *   2. For each line:
 *        - Try `JSON.parse(line)`. On success, re-run through
 *          `sanitizeForPersistence` + `redactConfigAuditArgv` —
 *          this catches old records that pre-date the current
 *          redactor patterns or argv-redactor.
 *        - On parse failure, push the raw line verbatim (preserves
 *          forensic evidence for analysis) and increment
 *          `skippedMalformed`.
 *   3. Write the rewritten content to `<filePath>.scrub.tmp` with
 *      mode `0o600`.
 *   4. **Pre-rename concurrent-append guard**: re-stat the original
 *      file. If `size !== bytesBefore` (someone appended between
 *      our read and our rename), unlink the tmp and return
 *      `{aborted: true}`.
 *   5. Atomic rename: `fs.renameSync(tmpPath, filePath)`.
 *
 * The scrubber is idempotent — re-running over an already-scrubbed
 * file produces a byte-identical output (modulo non-determinism in
 * the underlying redactor, which today is deterministic).
 *
 * `comis doctor --repair` drives this scrubber via the daemon's
 * `config.audit.scrub` RPC.
 *
 * @module
 */

import * as fs from "node:fs";

import { ok, err, type Result } from "@comis/shared";
import { writeRegularFile } from "../shared/fs-safe.js";

import { safeJsonStringify } from "../shared/safe-json-stringify.js";

import { emitSerializationErrorSentinel } from "./serialization-sentinel.js";
import { encodeAuditRecord } from "./encode-record.js";

/** Error class for the scrubber. */
export class ScrubConfigAuditError extends Error {
  public readonly name = "ScrubConfigAuditError" as const;
  public readonly code: string;
  constructor(message: string, code = "SCRUB_FAILED") {
    super(message);
    this.code = code;
  }
}

/** Result payload of a successful scrub. */
export interface ScrubResult {
  /** Number of records rewritten (parsed + sanitized). */
  readonly rewrittenRecords: number;
  /** Number of malformed lines passed through verbatim. */
  readonly skippedMalformed: number;
  /** True if the byte-length guard tripped (concurrent append). */
  readonly aborted: boolean;
}

/** Params for `scrubConfigAuditLog`. */
export interface ScrubParams {
  readonly filePath: string;
  /**
   * Optional callback invoked AFTER the scrubber reads the file and
   * BEFORE it writes the tmp. Tests use this to inject a concurrent
   * append; production callers leave it undefined.
   */
  readonly injectedAfterRead?: () => void;
  /**
   * Opt-in real-path confinement base forwarded to `writeRegularFile`
   * (the scrub tmp-write). Production callers (doctor --repair,
   * config.audit.scrub RPC) pass `getDefaultConfigAuditConfinedBase()`
   * so an ancestor-symlink escape is rejected at the open() boundary.
   * Tests omit it.
   */
  readonly confinedBaseDir?: string;
}

/** Re-encode a single parsed record through the shared encoder.
 *  Non-object inputs (parse-yielded primitives) are encoded verbatim;
 *  object inputs delegate to `encodeAuditRecord` which owns the
 *  argv-redact + sanitize + sentinel-fallback pipeline.
 *  Exported for test-driven verification. */
export function reEncodeRecord(parsed: unknown): string {
  if (parsed === null || typeof parsed !== "object") {
    // Not an object — leave alone (encode as-is).
    const json = safeJsonStringify(parsed);
    if (json === undefined) return emitSerializationErrorSentinel();
    return json + "\n";
  }
  return encodeAuditRecord(parsed as Record<string, unknown>);
}

/**
 * Scrub the config-audit log file in place. Atomic rename guarantees
 * the file is never partially written; the concurrent-append guard
 * keeps us from clobbering a record added between read and write.
 */
export async function scrubConfigAuditLog(
  params: ScrubParams,
): Promise<Result<ScrubResult, ScrubConfigAuditError>> {
  const filePath = params.filePath;
  const tmpPath = filePath + ".scrub.tmp";

  let bytesBefore: number;
  let raw: string;
  try {
    bytesBefore = fs.statSync(filePath).size;
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (e) {
    return err(
      new ScrubConfigAuditError(
        `Failed to read audit log: ${(e as Error).message}`,
        "READ_FAILED",
      ),
    );
  }

  // Process line-by-line. Preserve final-newline behavior — the
  // appender always ends each record with "\n", so a trailing empty
  // string from .split("\n") is expected and skipped.
  const lines = raw.split("\n");
  const out: string[] = [];
  let rewrittenRecords = 0;
  let skippedMalformed = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (i === lines.length - 1 && line.length === 0) {
      // Final trailing newline.
      continue;
    }
    try {
      const parsed = JSON.parse(line) as unknown;
      out.push(reEncodeRecord(parsed).trimEnd());
      rewrittenRecords += 1;
    } catch {
      out.push(line);
      skippedMalformed += 1;
    }
  }
  const rewritten = out.join("\n") + "\n";

  // Symlink-safe writeRegularFile from ../shared/fs-safe.js. Default
  // unlinkExisting:true closes the symlink-pre-stage window — an
  // attacker who stages a symlink at tmpPath pointing to an arbitrary
  // file the daemon can write would have the symlink unlinked before
  // open. The subsequent O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW
  // open creates a fresh regular file with mode 0o600 (defensive
  // fchmod), with O_EXCL preventing TOCTOU re-creation between unlink
  // and open.
  const writeResult = writeRegularFile({
    path: tmpPath,
    content: rewritten,
    // unlinkExisting defaults to true — leaves the symlink window closed.
    // Forward the caller's confinement base (typically `~/.comis/`) so
    // an ancestor-symlink escape is rejected before the open() call.
    // The scrub tmp lives at `<filePath>.scrub.tmp` which, for the
    // legitimate ~/.comis/logs/config-audit.jsonl path, is inside
    // ~/.comis/.
    ...(params.confinedBaseDir !== undefined
      ? { confinedBaseDir: params.confinedBaseDir }
      : {}),
  });
  if (!writeResult.ok) {
    return err(
      new ScrubConfigAuditError(
        `Failed to write scrub tmp: ${writeResult.error.message}`,
        "WRITE_TMP_FAILED",
      ),
    );
  }

  // Test hook: simulate a concurrent append.
  if (params.injectedAfterRead) {
    try {
      params.injectedAfterRead();
    } catch {
      // The injection itself may throw — fall through; the
      // byte-length guard below catches state changes.
    }
  }

  // Concurrent-append guard.
  let bytesAfter: number;
  try {
    bytesAfter = fs.statSync(filePath).size;
  } catch (e) {
    // The original file disappeared — clean up tmp and report.
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Ignore unlink errors.
    }
    return err(
      new ScrubConfigAuditError(
        `Audit log vanished during scrub: ${(e as Error).message}`,
        "ORIGINAL_VANISHED",
      ),
    );
  }
  if (bytesAfter !== bytesBefore) {
    // File grew — abort. Leave the original intact.
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Ignore.
    }
    return ok({
      rewrittenRecords: 0,
      skippedMalformed: 0,
      aborted: true,
    });
  }

  // Atomic rename.
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Ignore.
    }
    return err(
      new ScrubConfigAuditError(
        `Failed to rename scrub tmp: ${(e as Error).message}`,
        "RENAME_FAILED",
      ),
    );
  }

  return ok({ rewrittenRecords, skippedMalformed, aborted: false });
}
