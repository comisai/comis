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
import { systemDateFrom, systemNowMs } from "@comis/core";

import { sanitizeForPersistence } from "../redact/redact-secrets.js";
import { safeJsonStringify } from "../shared/safe-json-stringify.js";

import {
  redactConfigAuditArgv,
  CONFIG_AUDIT_ARGV_CAP,
} from "./argv-redactor.js";

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

/**
 * Sentinel emitted when re-encoding a parsed line fails. See identical
 * helper in append.ts:emitSerializationErrorSentinel for rationale.
 *
 * Uses `systemNowMs` from @comis/core (Pattern B per
 * test/support/architecture-allowlist.ts) — sanctioned helper that
 * preserves the no-direct-globals invariant. @comis/core is already
 * a dependency of @comis/observability for the existing
 * append.ts:42 import.
 */
function emitSerializationErrorSentinel(): string {
  // Uses `ts` (ISO string) per design §9.2; `tsMs` dropped in
  // 260519-rrm deviation G.
  const sentinel = {
    traceSchema: "comis-config-audit" as const,
    schemaVersion: 1 as const,
    __serializationError: "record-not-serializable" as const,
    ts: systemDateFrom(systemNowMs()).toISOString(),
  };
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return JSON.stringify(sentinel)! + "\n";
}

/**
 * Lenient migrator: rewrite an OLD-shape record (carrying `phase`,
 * nested `previousStat`/`nextStat`, `tsMs`, and the four-value `source`
 * enum) into the NEW design §9.2 shape (`event` discriminant, flat stat
 * fields, no `tsMs`, `source: "config-io"`, `callerSource` holding the
 * prior `source` value).
 *
 * LEGACY: pre-fix records may carry the old shape — read leniently,
 * write the new shape. Idempotent — passing a new-shape record through
 * is a no-op (the discriminant rename is the only mutating branch).
 */
function migrateRecordShape(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...obj };

  // Discriminant rename: old `phase` → new `event`.
  if (typeof out.phase === "string" && typeof out.event !== "string") {
    out.event = out.phase === "read" ? "config.observe" : "config.write";
    delete out.phase;
  }

  // Source migration: old four-value enum → new literal + callerSource.
  // Only do the rewrite when the existing `source` isn't already
  // "config-io" (idempotency).
  if (typeof out.source === "string" && out.source !== "config-io") {
    out.callerSource = out.source;
    out.source = "config-io";
  }

  // Drop tsMs (design §9.2 has no tsMs slot). If `ts` is absent but
  // `tsMs` is present, materialize an ISO string before dropping it.
  if (out.tsMs !== undefined) {
    if (typeof out.tsMs === "number" && typeof out.ts !== "string") {
      out.ts = systemDateFrom(out.tsMs).toISOString();
    }
    delete out.tsMs;
  }

  // Flatten previousStat / nextStat into the design's flat fields.
  // Old shape: { previousStat: { dev, ino, mode, nlink, uid, gid }, ... }
  // New shape: { previousDev, previousIno, ..., previousGid, ... }
  // dev/ino are stringified per design §9.2.
  const flatten = (
    nested: unknown,
    prefix: "previous" | "next",
  ): void => {
    if (nested === null || typeof nested !== "object") return;
    const stat = nested as Record<string, unknown>;
    const stringify = (v: unknown): string | null => {
      if (v === undefined || v === null) return null;
      if (typeof v === "bigint") return v.toString();
      if (typeof v === "number") return String(v);
      if (typeof v === "string") return v;
      return null;
    };
    out[`${prefix}Dev`] = stringify(stat.dev);
    out[`${prefix}Ino`] = stringify(stat.ino);
    out[`${prefix}Mode`] = typeof stat.mode === "number" ? stat.mode : null;
    out[`${prefix}Nlink`] = typeof stat.nlink === "number" ? stat.nlink : null;
    out[`${prefix}Uid`] = typeof stat.uid === "number" ? stat.uid : null;
    out[`${prefix}Gid`] = typeof stat.gid === "number" ? stat.gid : null;
  };
  if (out.previousStat !== undefined) {
    flatten(out.previousStat, "previous");
    delete out.previousStat;
  }
  if (out.nextStat !== undefined) {
    flatten(out.nextStat, "next");
    delete out.nextStat;
  }

  return out;
}

/** Re-encode a single parsed record through the redactor + sanitizer.
 *  Exported for test-driven verification. */
export function reEncodeRecord(parsed: unknown): string {
  if (parsed === null || typeof parsed !== "object") {
    // Not an object — leave alone (encode as-is).
    const json = safeJsonStringify(parsed);
    if (json === undefined) return emitSerializationErrorSentinel();
    return json + "\n";
  }
  // LEGACY: pre-260519-rrm records may carry the old shape — migrate
  // to the design §9.2 shape on read, write only the new shape.
  const migrated = migrateRecordShape(parsed as Record<string, unknown>);
  const withoutArgv: Record<string, unknown> = { ...migrated };
  delete (withoutArgv as { argv?: unknown }).argv;
  const sanitized = sanitizeForPersistence(withoutArgv) as Record<string, unknown>;
  // If the record carries an argv array, run it through the
  // dedicated redactor.
  const rawArgv = migrated.argv;
  if (Array.isArray(rawArgv)) {
    const safeArgv = rawArgv.map((v) =>
      typeof v === "string" ? v : String(v),
    );
    sanitized.argv = redactConfigAuditArgv(safeArgv).slice(
      0,
      CONFIG_AUDIT_ARGV_CAP,
    );
  } else if (rawArgv !== undefined) {
    sanitized.argv = rawArgv;
  }
  const json = safeJsonStringify(sanitized);
  if (json === undefined) return emitSerializationErrorSentinel();
  return json + "\n";
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
