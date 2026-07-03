// SPDX-License-Identifier: Apache-2.0
/**
 * Config audit record v1 types + Zod schemas.
 *
 * Two record shapes are persisted to the daemon-wide
 * `~/.comis/logs/config-audit.jsonl` file:
 *
 *   - `ConfigWriteAuditRecord` — every successful or failed config
 *     write goes through this shape. Carries caller provenance
 *     (pid/ppid/argv/cwd/execArgv), watch-mode state, file-state
 *     snapshots (existsBefore + previousHash/Bytes + flat stat fields +
 *     next* mirrors), the `changedPathCount` accounting that
 *     `comis config audit show` surfaces, suspicious heuristics
 *     (see `suspicious.ts`), and optional `errorCode` /
 *     `errorMessage` for failed writes (`result: "failed"` or
 *     `"rejected"`).
 *
 *   - `ConfigObserveAuditRecord` — read-side audit records for
 *     `event: "config.observe"` events (currently unused by the writer
 *     hooks, but the file format reserves space for it).
 *
 * Both shapes match the record schemas verbatim:
 *
 *   - `event` is the discriminant ("config.write" | "config.observe").
 *   - `source` is the fixed literal `"config-io"`.
 *     The call-site provenance (last-known-good-save / restore /
 *     config-patch-rpc / cli-sync-tooling) lives in the
 *     `callerSource: string` field so consumers (CLI audit
 *     show, downstream forensics) can read it.
 *   - Stat fields are FLAT (previousDev / previousIno / previousMode /
 *     previousNlink / previousUid / previousGid plus next* mirrors).
 *     `dev` and `ino` are `string | null` — POSIX
 *     `stat.st_dev` and `st_ino` can exceed JS safe-integer range on
 *     some filesystems, so they're stringified.
 *   - `tsMs` is dropped. Filtering by time uses `Date.parse(ts)`.
 *
 * Both shapes carry the `traceSchema:"comis-config-audit"` +
 * `schemaVersion:1` invariant at the top level so a future
 * v2-renaming/restructuring can be parsed alongside v1 records by a
 * single reader.
 *
 * Both TS types AND Zod schemas are exported so contract definitions
 * can reference the schemas directly without re-deriving them
 * (Type ⇄ Schema paired SSOT).
 *
 * @module
 */

import { z } from "zod";

/** Suspicious-heuristics literal union per `suspicious.ts`. */
const SuspiciousFlagSchema = z.enum([
  "unknown-binary",
  "non-comis-argv",
  "permission-restricted-caller",
]);
export type SuspiciousFlag = z.infer<typeof SuspiciousFlagSchema>;

/**
 * Outcome of the config-write attempt.
 *
 *   - `rename`        — atomic-write tmp + rename succeeded.
 *   - `copy-fallback` — atomic rename failed; the writer fell back to
 *     copy + truncate-on-success semantics.
 *   - `rejected`      — pre-write validation rejected the patch (e.g.
 *     schema fail, immutable-path block).
 *   - `failed`        — write attempted but the OS-level call threw
 *     (EACCES, ENOSPC, disk-full, etc.); `errorCode` + `errorMessage`
 *     carry the cause.
 */
const ConfigWriteResultSchema = z.enum([
  "rename",
  "copy-fallback",
  "rejected",
  "failed",
]);
export type ConfigWriteResult = z.infer<typeof ConfigWriteResultSchema>;

/**
 * Caller-provenance source — preserves the original four-value enum
 * (last-known-good-save / -restore, config-patch-rpc,
 * cli-sync-tooling) as the new `callerSource` field. Kept open
 * (`z.string()`) so additional call sites can extend without a
 * schema change; the daemon writes one of the four canonical values
 * today but the contract is "any non-empty caller identifier".
 */
export type ConfigWriteSource = string;

/**
 * File-stat snapshot — POSIX fields with `dev`/`ino` stringified for
 * JS-safe-integer overflow protection. The internal
 * `snapshotStat` helper in `append.ts` returns this shape and the
 * `finalize`/`createBase` helpers flatten it into the record's flat
 * fields (no nested object on disk). Kept as a plain type interface
 * (not a Zod schema) because the nested object never lands on disk;
 * the schema isn't reusable as a parser anymore.
 */
export interface FileStatSnapshot {
  readonly dev: string | null;
  readonly ino: string | null;
  readonly mode: number | null;
  readonly nlink: number | null;
  readonly uid: number | null;
  readonly gid: number | null;
}

/**
 * Full `ConfigWriteAuditRecord` shape.
 *
 * Field groups:
 *   - **Identity** — `traceSchema`, `schemaVersion`, `event`,
 *     `source`, `callerSource`, `configPath`.
 *   - **Caller provenance** — `pid`, `ppid`, `argv`, `cwd`,
 *     `execArgv`, `watchMode`, `watchSession`, `watchCommand`.
 *   - **Pre-write state** — `existsBefore`, `previousHash`,
 *     `previousBytes`, `previousDev/Ino/Mode/Nlink/Uid/Gid`,
 *     `hasMetaBefore`.
 *   - **Post-write state** — `nextHash`, `nextBytes`,
 *     `nextDev/Ino/Mode/Nlink/Uid/Gid`, `hasMetaAfter`,
 *     `changedPathCount`.
 *   - **Outcome** — `result`, optional `errorCode`, `errorMessage`.
 *   - **Heuristics** — `suspicious` array.
 *   - **Timestamp** — `ts` (ISO string); time-window filters use
 *     `Date.parse(ts)`. `tsMs` is intentionally absent.
 */
export const ConfigWriteAuditRecordSchema = z.object({
  traceSchema: z.literal("comis-config-audit"),
  schemaVersion: z.literal(1),
  ts: z.string(),
  source: z.literal("config-io"),
  event: z.literal("config.write"),
  result: ConfigWriteResultSchema,

  // Identity / caller provenance.
  configPath: z.string(),
  callerSource: z.string(),
  pid: z.number().int(),
  ppid: z.number().int(),
  argv: z.array(z.string()),
  cwd: z.string(),
  execArgv: z.array(z.string()),
  watchMode: z.boolean(),
  watchSession: z.string().nullable(),
  watchCommand: z.string().nullable(),

  // File state — hashes + bytes.
  existsBefore: z.boolean(),
  previousHash: z.string().nullable(),
  nextHash: z.string().nullable(),
  previousBytes: z.number().int().nonnegative().nullable(),
  nextBytes: z.number().int().nonnegative().nullable(),

  // File state — flat POSIX stat fields. dev/ino stringified.
  previousDev: z.string().nullable(),
  nextDev: z.string().nullable(),
  previousIno: z.string().nullable(),
  nextIno: z.string().nullable(),
  previousMode: z.number().int().nullable(),
  nextMode: z.number().int().nullable(),
  previousNlink: z.number().int().nullable(),
  nextNlink: z.number().int().nullable(),
  previousUid: z.number().int().nullable(),
  nextUid: z.number().int().nullable(),
  previousGid: z.number().int().nullable(),
  nextGid: z.number().int().nullable(),

  changedPathCount: z.number().int().nonnegative().nullable(),
  hasMetaBefore: z.boolean(),
  hasMetaAfter: z.boolean(),

  // Heuristics.
  suspicious: z.array(SuspiciousFlagSchema),

  // Outcome detail (optional).
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
});
export type ConfigWriteAuditRecord = z.infer<typeof ConfigWriteAuditRecordSchema>;

/**
 * `ConfigObserveAuditRecord` — read-side audit shape.
 *
 * Field groups:
 *   - **Identity + caller provenance** — `traceSchema`,
 *     `schemaVersion`, `ts`, `source`, `event`, `phase`, `configPath`,
 *     `callerSource`, `pid`, `ppid`, `argv`, `cwd`, `execArgv`,
 *     `watchMode`.
 *   - **File state** — `exists`, `valid`, `hash`, `bytes`,
 *     `mtimeMs`, `ctimeMs`, `dev`, `ino`, `mode`, `nlink`, `uid`,
 *     `gid`. All nullable when `exists:false`.
 *   - **LKG triple** — `lastKnownGoodHash`, `lastKnownGoodBytes`,
 *     `lastKnownGoodMtimeMs`. All nullable when no LKG sibling.
 *   - **Backup triple** — `backupHash`, `backupBytes`,
 *     `backupMtimeMs`. All nullable when no backup sibling.
 *   - **Recovery quartet** — `clobberedPath`, `restoredFromBackup`,
 *     `restoredBackupPath`, `restoreErrorCode`, `restoreErrorMessage`.
 *     Quintet by count; grouped as the "recovery state" fields.
 *   - **Heuristics** — `suspicious` array.
 *
 * Every field is REQUIRED on the schema. The sole producer
 * (`createConfigObserveAuditRecord` in `append-observe.ts`) is updated in
 * lock-step to populate them. On-disk records written by prior versions of
 * the producer will not re-parse — this is the intentional forward-only
 * contract change.
 */
export const ConfigObserveAuditRecordSchema = z.object({
  traceSchema: z.literal("comis-config-audit"),
  schemaVersion: z.literal(1),
  ts: z.string(),
  source: z.literal("config-io"),
  event: z.literal("config.observe"),
  phase: z.literal("read"),

  // Identity / caller provenance.
  configPath: z.string(),
  callerSource: z.string(),
  pid: z.number().int(),
  ppid: z.number().int(),
  argv: z.array(z.string()),
  cwd: z.string(),
  execArgv: z.array(z.string()),
  watchMode: z.boolean(),

  // File-state fields — required, nullable when exists:false.
  exists: z.boolean(),
  valid: z.boolean(),
  hash: z.string().nullable(),
  bytes: z.number().int().nonnegative().nullable(),
  mtimeMs: z.number().nullable(),
  ctimeMs: z.number().nullable(),
  dev: z.string().nullable(),
  ino: z.string().nullable(),
  mode: z.number().int().nullable(),
  nlink: z.number().int().nullable(),
  uid: z.number().int().nullable(),
  gid: z.number().int().nullable(),

  // LKG triple — required, nullable when no LKG sibling.
  lastKnownGoodHash: z.string().nullable(),
  lastKnownGoodBytes: z.number().int().nonnegative().nullable(),
  lastKnownGoodMtimeMs: z.number().nullable(),

  // Backup triple — required, nullable when no backup sibling.
  backupHash: z.string().nullable(),
  backupBytes: z.number().int().nonnegative().nullable(),
  backupMtimeMs: z.number().nullable(),

  // Recovery state — required.
  clobberedPath: z.string().nullable(),
  restoredFromBackup: z.boolean(),
  restoredBackupPath: z.string().nullable(),
  restoreErrorCode: z.string().nullable(),
  restoreErrorMessage: z.string().nullable(),

  // Heuristics.
  suspicious: z.array(SuspiciousFlagSchema),
});
export type ConfigObserveAuditRecord = z.infer<typeof ConfigObserveAuditRecordSchema>;
