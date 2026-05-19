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
 *     snapshots (`existsBefore`, `previousHash`, `nextHash`, byte
 *     sizes, stat-tuples), the `changedPathCount` accounting that
 *     `comis config audit show` surfaces, suspicious heuristics
 *     (see `suspicious.ts`), and optional `errorCode` /
 *     `errorMessage` for failed writes (`result: "failed"` or
 *     `"rejected"`).
 *
 *   - `ConfigObserveAuditRecord` — read-side audit records for
 *     `phase: "read"` events (currently unused by the writer hooks,
 *     but the file format reserves space for it; a future hook may
 *     wire a read-side audit). Same caller-provenance fields plus
 *     a single `source` field naming the read site.
 *
 * Both shapes carry the `traceSchema:"comis-config-audit"` +
 * `schemaVersion:1` invariant at the top level so a future
 * v2-renaming/restructuring can be parsed alongside v1 records by a
 * single reader. The two shapes share enough structure that the
 * audit log's `config.audit.list` RPC handler returns them as a
 * union; the read side is currently expected to be empty.
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
 *   - `rename`   — atomic-write tmp + rename succeeded.
 *   - `rejected` — pre-write validation rejected the patch (e.g.
 *     schema fail, immutable-path block).
 *   - `failed`   — write attempted but the OS-level call threw
 *     (EACCES, ENOSPC, disk-full, etc.); `errorCode` + `errorMessage`
 *     carry the cause.
 */
const ConfigWriteResultSchema = z.enum(["rename", "rejected", "failed"]);
export type ConfigWriteResult = z.infer<typeof ConfigWriteResultSchema>;

/**
 * Source of the config-write call. Identifies which of the three
 * hook sites emitted the record. Values match the literal strings
 * passed by each hook site (see `last-known-good.ts`,
 * `config-write.ts`, `cli/commands/config.ts`).
 */
const ConfigWriteSourceSchema = z.enum([
  "last-known-good-save",
  "last-known-good-restore",
  "config-patch-rpc",
  "cli-sync-tooling",
]);
export type ConfigWriteSource = z.infer<typeof ConfigWriteSourceSchema>;

/** File-stat snapshot — POSIX fields only; nullable when stat failed. */
const FileStatSnapshotSchema = z.object({
  dev: z.number().int().nullable(),
  ino: z.number().int().nullable(),
  mode: z.number().int().nullable(),
  nlink: z.number().int().nullable(),
  uid: z.number().int().nullable(),
  gid: z.number().int().nullable(),
});
export type FileStatSnapshot = z.infer<typeof FileStatSnapshotSchema>;

/**
 * Full `ConfigWriteAuditRecord` shape.
 *
 * Field groups:
 *   - **Identity** — `traceSchema`, `schemaVersion`, `phase`,
 *     `source`, `configPath`.
 *   - **Caller provenance** — `pid`, `ppid`, `argv`, `cwd`,
 *     `execArgv`, `watchMode`.
 *   - **Pre-write state** — `existsBefore`, `previousHash`,
 *     `previousBytes`, `previousStat`, `hasMetaBefore`.
 *   - **Post-write state** — `nextHash`, `nextBytes`, `nextStat`,
 *     `hasMetaAfter`, `changedPathCount`.
 *   - **Outcome** — `result`, optional `errorCode`, `errorMessage`.
 *   - **Heuristics** — `suspicious` array.
 *   - **Timestamps** — `ts` (ISO string), `tsMs` (epoch millis).
 */
export const ConfigWriteAuditRecordSchema = z.object({
  traceSchema: z.literal("comis-config-audit"),
  schemaVersion: z.literal(1),
  phase: z.literal("write"),

  // Identity
  source: ConfigWriteSourceSchema,
  configPath: z.string(),

  // Caller provenance
  pid: z.number().int(),
  ppid: z.number().int(),
  argv: z.array(z.string()),
  cwd: z.string(),
  execArgv: z.array(z.string()),
  watchMode: z.boolean(),

  // Pre-write state
  existsBefore: z.boolean(),
  previousHash: z.string().nullable(),
  previousBytes: z.number().int().nonnegative().nullable(),
  previousStat: FileStatSnapshotSchema.nullable(),
  hasMetaBefore: z.boolean(),

  // Post-write state
  nextHash: z.string().nullable(),
  nextBytes: z.number().int().nonnegative().nullable(),
  nextStat: FileStatSnapshotSchema.nullable(),
  hasMetaAfter: z.boolean(),
  changedPathCount: z.number().int().nonnegative().nullable(),

  // Outcome
  result: ConfigWriteResultSchema,
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),

  // Heuristics
  suspicious: z.array(SuspiciousFlagSchema),

  // Timestamps
  ts: z.string(),
  tsMs: z.number().int().nonnegative(),
});
export type ConfigWriteAuditRecord = z.infer<typeof ConfigWriteAuditRecordSchema>;

/**
 * `ConfigObserveAuditRecord` — read-side audit shape. Carries the
 * same caller-provenance + timestamp fields plus a single `source`
 * naming the read site. No file-state snapshots (reads do not change
 * state). Currently unused by writer hooks; reserved for a future
 * read-side audit hook.
 */
export const ConfigObserveAuditRecordSchema = z.object({
  traceSchema: z.literal("comis-config-audit"),
  schemaVersion: z.literal(1),
  phase: z.literal("read"),

  // Identity
  source: z.string(),
  configPath: z.string(),

  // Caller provenance
  pid: z.number().int(),
  ppid: z.number().int(),
  argv: z.array(z.string()),
  cwd: z.string(),
  execArgv: z.array(z.string()),
  watchMode: z.boolean(),

  // Heuristics
  suspicious: z.array(SuspiciousFlagSchema),

  // Timestamps
  ts: z.string(),
  tsMs: z.number().int().nonnegative(),
});
export type ConfigObserveAuditRecord = z.infer<typeof ConfigObserveAuditRecordSchema>;
