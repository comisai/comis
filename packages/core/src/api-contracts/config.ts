// SPDX-License-Identifier: Apache-2.0
/**
 * Config + env + gateway-infrastructure RPC contracts. Mirrors the
 * combined surface of
 * `packages/daemon/src/api/config-handlers.ts` (10 methods) and
 * `packages/daemon/src/api/env-handlers.ts` (2 methods).
 *
 * The two handler-factory files share a single contract file because they
 * consume the same `ConfigApiDeps` cluster slice and form one logical
 * domain (config management + env-secret management both gate the same
 * on-disk YAML / .env files + both trigger SIGUSR2 restarts).
 *
 * Combined surface (12 methods total):
 *
 *   From config-handlers.ts (8 config.* + 2 gateway.* methods):
 *
 *   - `config.read`     (admin) — read full config OR single section,
 *                                  secrets redacted before return.
 *   - `config.schema`   (admin) — JSON Schema for the full config OR a
 *                                  named section (UI form generation).
 *   - `config.patch`    (admin) — dot-notation key edit. The `value`
 *                                  field uses
 *                                  `z.record(z.string(), z.unknown())`
 *                                  to preserve the loose modeling
 *                                  precedent for arbitrary user-supplied
 *                                  config trees. The handler validates
 *                                  the post-merge config against
 *                                  `AppConfigSchema` (separate gate from
 *                                  the contract parse — contract is
 *                                  type narrowing only).
 *   - `config.apply`    (admin) — entire-section replacement. `value`
 *                                  is also loose
 *                                  `z.record(z.string(), z.unknown())`
 *                                  for the same reason as `config.patch`.
 *   - `config.history`  (admin) — git log of config commits. Returns
 *                                  `{ entries[], error? }` — the
 *                                  graceful-degradation shape used when
 *                                  the config-git manager is absent.
 *   - `config.diff`     (admin) — git diff. Returns `{ diff, error? }`.
 *   - `config.rollback` (admin) — restore config to a prior commit
 *                                  (triggers SIGUSR2 restart).
 *   - `config.gc`       (admin) — git GC + optional history squash.
 *   - `gateway.status`  (admin) — daemon process metadata (pid, uptime,
 *                                  memory, nodeVersion, configPaths,
 *                                  sections).
 *   - `gateway.restart` (admin) — schedule SIGUSR2 restart. Returns
 *                                  `{ restarting: true, systemd, warning? }`.
 *
 *   From env-handlers.ts (2 env.* methods):
 *
 *   - `env.set`         (admin) — write a secret to the encrypted
 *                                  SecretStorePort OR the plaintext
 *                                  .env file. Triggers SIGUSR2 restart.
 *   - `env.list`        (admin) — enumerate secret NAMES (with optional
 *                                  glob filter). Values are NEVER
 *                                  returned — the response schema
 *                                  intentionally omits a `value` field
 *                                  so a future leak surfaces at
 *                                  dev-mode `response.parse(...)` time
 *                                  (residency canary).
 *
 * All contracts in this file have `scopes: ["admin"] as const`. Two
 * registration planes:
 *   - `config.*` + `gateway.*` are registered via
 *     `registerRpcPassthrough(..., "admin")` in
 *     `packages/daemon/src/wiring/setup-gateway-api.ts` lines 80-84 +
 *     341-343 — direct WebSocket clients (CLI, web SPA) call them.
 *   - `env.set` + `env.list` are NOT registered on the gateway router;
 *     they are dispatched ONLY via `rpcCall(...)` from the
 *     `gateway_tool` agent action handler at
 *     `packages/skills/src/platform-tools/tools/gateway-tool.ts` lines
 *     316 + 349. The in-handler `_trustLevel === "admin"` check is the
 *     sole gate (the gateway-tool passes `_trustLevel: "admin"` on
 *     every call). The contract scope `["admin"]` documents the
 *     intended trust model regardless of registration plane — the
 *     bidirectional architecture test walks handler-factory files for
 *     1:1 mapping (registration-plane-agnostic).
 *
 * **Loose-record precedent.** `config.patch` + `config.apply`
 * carry `value: z.record(z.string(), z.unknown())` (the
 * RECORD_VALUE_ESCAPE_HATCH at `scripts/contracts/walk-zod-schema.ts`
 * line 25 permits `z.unknown` ONLY as the value-type inside a
 * `z.record`). Modelling these tighter would require pinning every
 * AppConfigSchema section's wire shape (12 top-level sections,
 * recursively nested). The handler's
 * `AppConfigSchema.safeParse(merged)` (config-handlers.ts:626) is the
 * authoritative validation; the contract parse is type narrowing +
 * a coarse defense-in-depth gate.
 *
 * **Param-name reality.** The actual handler reads the canonical
 * `{ section, key, value }` shape. `config.rollback` reads `sha`
 * (handler:1092); `config.gc` reads `olderThan?: string`
 * (handler:1130). Contracts model the actual handler-read names
 * verbatim (single source of truth).
 *
 * @module
 */
import { z } from "zod";
import { defineContract } from "./types.js";

// ---------------------------------------------------------------------------
// Shared sub-schemas (allowlist shapes only).
// ---------------------------------------------------------------------------

/**
 * Loose-tree value for config patch/apply payloads. Models the
 * **actual wire reality** of the handler — `config.patch` accepts
 * ALL of:
 *   (a) a primitive (`value: "debug"` for `config.patch logLevel`),
 *   (b) a nested record (`value: { mcp: { servers: [...] } }` for
 *       `config.patch integrations`),
 *   (c) an array of records (`value: [{...mcp server entry}, ...]`
 *       for `config.patch integrations.mcp.servers`).
 *
 * Wire reality:
 *   - CLI `comis config set logLevel info` sends primitive string
 *     (config.ts:226-230 JSON-parses; primitives fall back to raw).
 *   - CLI `comis config set integrations.mcp.servers '[{...}]'`
 *     JSON-parses to an array (config-handlers.test.ts lines
 *     727-907 — 7 distinct tests send `value: [array]`).
 *   - Empty array `value: []` is a valid no-op
 *     (config-handlers.test.ts:902).
 *
 * A strict record-only contract would break ALL of those. The
 * resolution is a `z.union` of the 5 wire-observable shapes — all
 * 5 ARE in the 12-shape allowlist:
 *   - `z.string` / `z.number` / `z.boolean` (12-shape allowlist)
 *   - `z.record(z.string(), z.unknown())` (record + RECORD_VALUE
 *     escape hatch)
 *   - `z.array(z.record(z.string(), z.unknown()))` (array of records
 *     with the same escape hatch on each element).
 *
 * Arrays of primitives (e.g. `value: ["a", "b"]`) are NOT covered
 * — no existing handler test exercises this path. If a future
 * caller sends a primitive array, the contract parse rejects; the
 * handler's `AppConfigSchema.safeParse(merged)` is then never
 * reached. Acceptable — primitive arrays are vanishingly rare in
 * the config tree (the existing AppConfigSchema sections all use
 * either record or array-of-record shapes for collections).
 *
 * The handler's `AppConfigSchema.safeParse(merged)` performs the
 * authoritative validation (config-handlers.ts:626); this loose
 * contract surface is intentional (the contract is type narrowing
 * + defense-in-depth, not the authoritative validator for config
 * payloads).
 */
const ConfigValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.record(z.string(), z.unknown()),
  z.array(z.record(z.string(), z.unknown())),
]);

/**
 * Git commit log entry shape returned by `config.history`. Mirrors the
 * `HistoryEntry` shape produced by `configGitManager.history(...)` —
 * see `packages/core/src/config/git-manager.ts` (`HistoryEntry`).
 */
const ConfigHistoryEntrySchema = z.object({
  sha: z.string(),
  timestamp: z.string(),
  message: z.string(),
  metadata: z.object({
    section: z.string(),
    key: z.string().optional(),
    agent: z.string().optional(),
    user: z.string().optional(),
    traceId: z.string().optional(),
    summary: z.string(),
  }),
});

/**
 * Per-secret row returned by `env.list`. Mirrors the projection at
 * `env-handlers.ts:294-300`: plaintext .env-file secrets carry only
 * `{ name, source: "envfile" }`; secrets backed by the
 * SecretStorePort carry the metadata bundle (provider, description,
 * timestamps, expiresAt). The contract MUST NOT include
 * a `value`-shaped field — env.list never returns values, and the
 * dev-mode `response.parse(...)` rejects any accidental
 * passthrough.
 */
const EnvListEntrySchema = z.object({
  name: z.string(),
  source: z.enum(["envfile", "secretstore"]),
  provider: z.string().optional(),
  description: z.string().optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
  expiresAt: z.number().optional(),
});

// ---------------------------------------------------------------------------
// config.read
// ---------------------------------------------------------------------------

/**
 * `config.read` — read the full config OR a single named section.
 * Admin-only. Secrets are redacted before return via
 * `redactForDisplay(...)` (handler:53+64).
 *
 * Request: `{ section?: string }`. When `section` is absent, the
 * handler returns `{ config, sections }`. When present, it returns
 * the redacted section value DIRECTLY (the response is the section
 * object — for `section: "logLevel"` the response is the string;
 * for `section: "agents"` it is an object map). The contract models
 * the response as `z.unknown()` because the section-payload shape
 * varies per section AND because the handler returns the section
 * VALUE (not wrapped in `{ section: value }`) when a `section` param
 * is supplied (handler:464).
 *
 * Note: when `section` is absent the handler returns the wrapped
 * `{ config, sections }` shape (handler:466-469); when present it
 * returns the raw section value. Modelling both within a single Zod
 * shape that survives `z.toJSONSchema` is awkward, and the response
 * is loose-tree by nature (mirrors `config.patch.value` rationale —
 * authoritative validation is the AppConfigSchema, not the wire
 * contract). The 12-shape allowlist permits `z.unknown` ONLY as the
 * value-type of a `z.record`, so we wrap it in a single-key record
 * keyed by the wire shape's discriminator — but the existing
 * handler doesn't add a discriminator, so the cleanest path is to
 * model the response as the union of the two shapes via a single
 * `z.record(z.string(), z.unknown())` (the full-config shape is
 * `{ config, sections }`; the section shape is whatever sub-tree
 * the section carries).
 */
export const ConfigReadContract = defineContract({
  method: "config.read",
  request: z.object({
    section: z.string().optional(),
  }),
  response: z.record(z.string(), z.unknown()),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// config.schema
// ---------------------------------------------------------------------------

/**
 * `config.schema` — return JSON Schema for the full config OR a
 * single named section (UI form generation). Admin-only.
 *
 * Request: `{ section?: string }`.
 *
 * Response: `{ section?, schema, sections[] }`. The handler returns
 * `{ section, schema, sections }` when `section` is provided
 * (handler:1008) and `{ schema, sections }` otherwise (handler:1010).
 * The `schema` shape is a JSON-Schema-shaped object (loose record);
 * `sections` is the array of valid section names.
 */
export const ConfigSchemaContract = defineContract({
  method: "config.schema",
  request: z.object({
    section: z.string().optional(),
  }),
  response: z.object({
    section: z.string().optional(),
    schema: z.record(z.string(), z.unknown()),
    sections: z.array(z.string()),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// config.patch
// ---------------------------------------------------------------------------

/**
 * `config.patch` — dot-notation key edit. Admin-only. Rate-limited
 * (5/min — handler:447). Triggers SIGUSR2 restart on success
 * (handler:782).
 *
 * `value` is `z.record(z.string(), z.unknown())` — the loose-tree
 * precedent for arbitrary user-supplied config payloads. The
 * authoritative validation is the handler's
 * `AppConfigSchema.safeParse(merged)` (handler:626); the contract's
 * loose modeling is intentional.
 *
 * Request: `{ section, key?, value }` — the canonical shape the handler
 * accepts (handler:496). The `comis config set <dot-path> <value>`
 * command in `packages/cli/src/commands/config.ts` parses the dot-path
 * into `section + key` LOCALLY before the RPC call.
 *
 * Response: `{ patched: true, section, key?, value, restarting: true }`
 * (handler:786). On rate-limit or validation failure the handler
 * throws (no response shape).
 */
export const ConfigPatchContract = defineContract({
  method: "config.patch",
  request: z.object({
    section: z.string().optional(),
    key: z.string().optional(),
    value: ConfigValueSchema,
  }),
  response: z.object({
    patched: z.literal(true),
    section: z.string(),
    key: z.string().optional(),
    value: ConfigValueSchema,
    restarting: z.literal(true),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// config.apply
// ---------------------------------------------------------------------------

/**
 * `config.apply` — entire-section replacement (NOT deep-merge).
 * Admin-only. Rate-limited (shares the 5/min bucket with
 * `config.patch` — handler:821). Triggers SIGUSR2 restart on success
 * (handler:970).
 *
 * Request: `{ section, value }`. `value` is the entire section's new
 * value — same loose record as `config.patch.value`.
 *
 * Response: `{ applied: true, section, restarting: true }`
 * (handler:974).
 */
export const ConfigApplyContract = defineContract({
  method: "config.apply",
  request: z.object({
    section: z.string(),
    value: ConfigValueSchema,
  }),
  response: z.object({
    applied: z.literal(true),
    section: z.string(),
    restarting: z.literal(true),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// config.history
// ---------------------------------------------------------------------------

/**
 * `config.history` — git log of config commits. Admin-only.
 * Graceful-degradation: returns `{ entries: [], error }` when the
 * config-git manager is unavailable (handler:1050) — the contract
 * models this via the optional `error` field.
 *
 * Request: `{ limit?, section? }`.
 *
 * Response: `{ entries: ConfigHistoryEntry[], error? }`. Each entry
 * carries `{ sha, timestamp, message, metadata }` (see
 * `ConfigHistoryEntrySchema` above).
 */
export const ConfigHistoryContract = defineContract({
  method: "config.history",
  request: z.object({
    limit: z.number().optional(),
    section: z.string().optional(),
  }),
  response: z.object({
    entries: z.array(ConfigHistoryEntrySchema),
    error: z.string().optional(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// config.diff
// ---------------------------------------------------------------------------

/**
 * `config.diff` — git diff of the config working tree against the
 * given SHA (or HEAD). Admin-only. Graceful-degradation: returns
 * `{ diff: "", error }` when the config-git manager is unavailable
 * (handler:1071).
 *
 * Request: `{ sha?: string }`. The handler reads a single `sha`
 * (handler:1073).
 *
 * Response: `{ diff: string, error? }`.
 */
export const ConfigDiffContract = defineContract({
  method: "config.diff",
  request: z.object({
    sha: z.string().optional(),
  }),
  response: z.object({
    diff: z.string(),
    error: z.string().optional(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// config.rollback
// ---------------------------------------------------------------------------

/**
 * `config.rollback` — restore config to a prior git commit.
 * Admin-only. Triggers SIGUSR2 restart on success (handler:1102).
 *
 * Request: `{ sha: string }`. Modeled non-empty by contract
 * (`min(1)`); the bespoke pre-Zod guard at handler:1093-1095
 * (`"sha parameter is required for config rollback"`) catches the
 * user-facing case.
 *
 * Response: `{ rolledBack: true, sha, newCommitSha, restarting: true }`
 * (handler:1108).
 */
export const ConfigRollbackContract = defineContract({
  method: "config.rollback",
  request: z.object({
    sha: z.string().min(1),
  }),
  response: z.object({
    rolledBack: z.literal(true),
    sha: z.string(),
    newCommitSha: z.string(),
    restarting: z.literal(true),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// config.gc
// ---------------------------------------------------------------------------

/**
 * `config.gc` — git garbage collection + optional history squash.
 * Admin-only.
 *
 * Request: `{ olderThan?: string }`. The handler reads `olderThan`
 * (handler:1130) — when provided, the handler invokes
 * `configGitManager.squash(...)` with that age cutoff string.
 *
 * Response: `{ gc: true, squashed?, newRootSha? }` (handler:1144). The
 * latter two fields are present only when a squash was requested AND
 * succeeded.
 */
export const ConfigGcContract = defineContract({
  method: "config.gc",
  request: z.object({
    olderThan: z.string().optional(),
  }),
  response: z.object({
    gc: z.literal(true),
    squashed: z.number().optional(),
    newRootSha: z.string().optional(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// gateway.status
// ---------------------------------------------------------------------------

/**
 * `gateway.status` — daemon process metadata. Admin-only. Read-only
 * (no side effects).
 *
 * Request: `{}`.
 *
 * Response: `{ pid, uptime, memoryUsage, nodeVersion, configPaths[],
 * sections[], secretsStoreAvailable, version? }` (handler). `pid` is the daemon
 * process id; `uptime` is `process.uptime()` seconds; `memoryUsage` is
 * `process.memoryUsage().rss`; `nodeVersion` is `process.version`. `version`
 * is the daemon's own build version (`packages/daemon/package.json`), used by
 * `comis doctor`'s version-skew check to detect a stale CLI talking to a newer
 * daemon. It is OPTIONAL so an older daemon predating the field still satisfies
 * the contract (the CLI treats its absence as "version unknown" → skip).
 * `secretsStoreAvailable` is `true` when a writable store (file or
 * encrypted) is wired — used by the `env_set` preflight in
 * gateway-tool.ts to distinguish "writable store ready" from "env-only
 * (read-only) mode". In env mode this is `false` (adapter present but
 * read-only). Dev-mode strict `response.parse(result)` ensures the
 * handler MUST populate this field.
 */
export const GatewayStatusContract = defineContract({
  method: "gateway.status",
  request: z.object({}),
  response: z.object({
    pid: z.number(),
    uptime: z.number(),
    memoryUsage: z.number(),
    nodeVersion: z.string(),
    configPaths: z.array(z.string()),
    sections: z.array(z.string()),
    /** True when a writable store (file or encrypted) is wired and available for env.set. In env mode this is false (adapter present but read-only). */
    secretsStoreAvailable: z.boolean(),
    /**
     * Daemon build version (`packages/daemon/package.json`). Optional so an
     * older daemon predating this field still parses; `comis doctor`'s
     * version-skew check compares it against the CLI's own version and treats
     * absence as "version unknown".
     */
    version: z.string().optional(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// gateway.restart
// ---------------------------------------------------------------------------

/**
 * `gateway.restart` — schedule SIGUSR2 restart of the daemon.
 * Admin-only.
 *
 * Request: `{}`.
 *
 * Response: `{ restarting: true, systemd, warning? }` (handler:1033).
 * `systemd` is `true` when `NOTIFY_SOCKET` env var is set; `warning`
 * carries a non-systemd hint otherwise.
 */
export const GatewayRestartContract = defineContract({
  method: "gateway.restart",
  request: z.object({}),
  response: z.object({
    restarting: z.literal(true),
    systemd: z.boolean(),
    warning: z.string().optional(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// env.set
// ---------------------------------------------------------------------------

/**
 * `env.set` — write a secret to the active writable SecretStorePort.
 * Admin-only. Rate-limited (5/min — env-handlers.ts:90).
 * Triggers SIGUSR2 restart on success (env-handlers.ts:191).
 *
 * Request: `{ key, value }`. `key` is a uppercase + digits +
 * underscores identifier (env-handlers.ts:75 pattern); `value` is
 * any non-empty string (env-handlers.ts:136 guard). The contract
 * uses `z.string().min(1)` for both — the bespoke pre-Zod guards in
 * env-handlers.ts:120-156 (key-format, max-length, placeholder
 * rejection) produce operator-actionable error messages.
 *
 * Response: `{ set: true, key, storage, restarting }`.
 * `storage` is `"encrypted"` (AES-256-GCM) or `"file"` (plaintext
 * 0600 `secrets.json`). Rejected in `env` mode with an actionable
 * error — `env` is not a member of the storage enum, and the
 * preflight in `gateway-tool.ts` blocks the call before it reaches
 * the handler. `restarting` is a boolean (secret writes still trigger
 * a restart for now; the TYPE widens now so a later change can flip the
 * value without a schema change).
 *
 * **Residency canary.** The contract response schema deliberately
 * omits a `value` field — env.set NEVER returns the secret value
 * back to the caller. If a future change accidentally added a
 * `value` to the return, dev-mode `response.parse(...)` rejects
 * (the absent key is not in the schema; strict mode is implicit
 * because we don't `.passthrough()`).
 *
 * **Dev-mode canary.** `EnvSetContract.response.parse(result)` in
 * env-handlers.ts:237-238 acts as a residency canary and defense-in-depth
 * type guard. If a handler mistakenly returns `storage: "env"` the dev-mode
 * parse throws immediately — `"env"` is not in the enum.
 */
export const EnvSetContract = defineContract({
  method: "env.set",
  request: z.object({
    key: z.string().min(1),
    value: z.string().min(1),
  }),
  response: z.object({
    set: z.literal(true),
    key: z.string(),
    // Writable storage backends only: "encrypted" (AES-256-GCM via SecretStorePort)
    // or "file" (plaintext 0600 secrets.json). "env" is intentionally excluded —
    // env mode is read-only; any handler returning storage:"env" would fail the
    // dev-mode parse (the residency canary).
    storage: z.enum(["encrypted", "file"]),
    restarting: z.boolean(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// env.list
// ---------------------------------------------------------------------------

/**
 * `env.list` — enumerate secret NAMES (with optional glob filter).
 * Admin-only. Read-only. Rate-limited (30/min — env-handlers.ts:92).
 *
 * **CRITICAL: VALUES ARE NEVER RETURNED.** The contract response
 * schema enumerates only name + source + optional metadata
 * (provider, description, timestamps, expiresAt). A future leak
 * that added `value`/`plaintext`/`secret`/`ciphertext` to a row
 * would fail dev-mode `response.parse(...)` (strict mode is
 * implicit — no `.passthrough()`). Mirrors the "value-leak
 * canary" assertion in `env-handlers.test.ts:528-544`.
 *
 * Request: `{ filter?, limit? }`. `filter` is a glob pattern
 * (matchesSecretPattern from @comis/core); `limit` is the max rows
 * returned (default 100, max 500 — env-handlers.ts:252).
 *
 * Response: `{ secrets: EnvListEntry[], total, truncated }`
 * (env-handlers.ts:323). `total` is the pre-pagination count;
 * `truncated` is true when `total > limit`.
 */
export const EnvListContract = defineContract({
  method: "env.list",
  request: z.object({
    filter: z.string().optional(),
    limit: z.number().optional(),
  }),
  response: z.object({
    secrets: z.array(EnvListEntrySchema),
    total: z.number(),
    truncated: z.boolean(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// Domain array — registered into API_CONTRACTS_ORDERED in index.ts.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// config.audit.list
// ---------------------------------------------------------------------------

/**
 * `config.audit.list` — query the daemon-wide config-audit JSONL log.
 * Admin-only. Read-only.
 *
 * Returns up to `tail` (default 1000, max 1000) recent records,
 * optionally filtered by `since` / `until` ISO-8601 timestamps (or
 * relative `"1h"`/`"24h"` shortcuts), `suspiciousOnly`, or `pid`.
 *
 * The records returned are the union of `ConfigWriteAuditRecord`
 * (phase: "write") and `ConfigObserveAuditRecord` (phase: "read")
 * shapes — both live in @comis/observability. The contract response
 * is loose-modeled (`z.array(z.record(z.string(), z.unknown()))`) to
 * avoid a @comis/core → @comis/observability dep cycle. The
 * authoritative shape is `ConfigWriteAuditRecordSchema` /
 * `ConfigObserveAuditRecordSchema` exported from
 * @comis/observability; the contract is type narrowing only.
 */
export const ConfigAuditListContract = defineContract({
  method: "config.audit.list",
  request: z.object({
    since: z.string().optional(),
    until: z.string().optional(),
    suspiciousOnly: z.boolean().optional(),
    pid: z.number().int().optional(),
    /** Default applied at the handler. */
    tail: z.number().int().positive().max(1000).optional(),
  }),
  response: z.object({
    records: z.array(z.record(z.string(), z.unknown())),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// config.audit.scrub
// ---------------------------------------------------------------------------

/**
 * `config.audit.scrub` — retroactively re-run the redactor pipeline
 * over the historical audit log. Admin-only. Side-effects: rewrites
 * the audit log atomically via `scrubConfigAuditLog` from
 * @comis/observability.
 *
 * Request: `{ dryRun?: boolean }`. When `dryRun` is true, the handler
 * reads + sanitizes records to compute the counters but does NOT
 * write the result back; the file is left intact.
 *
 * Response: `{ rewrittenRecords, skippedMalformed, aborted }`.
 * `aborted=true` indicates the byte-length concurrent-append guard
 * tripped (someone appended between the scrubber's read and rename);
 * the log is left untouched on abort.
 */
export const ConfigAuditScrubContract = defineContract({
  method: "config.audit.scrub",
  request: z.object({
    dryRun: z.boolean().optional(),
  }),
  response: z.object({
    rewrittenRecords: z.number().int().nonnegative(),
    skippedMalformed: z.number().int().nonnegative(),
    aborted: z.boolean(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// Domain array — registered into API_CONTRACTS_ORDERED in index.ts.
// ---------------------------------------------------------------------------

/**
 * Config + env + gateway-infrastructure contract array. Registered
 * into `API_CONTRACTS_ORDERED` by
 * `packages/core/src/api-contracts/index.ts`.
 *
 * Order: alphabetical by method name, with config.* before env.*
 * before gateway.* (matches the AggregatorAlphabetical view).
 * Within config.*, methods are in alphabetical order. The
 * bidirectional 1:1 architecture test treats this array as an
 * unordered set, so ordering is documentation-only.
 */
export const CONFIG_CONTRACTS = [
  ConfigApplyContract,
  ConfigAuditListContract,
  ConfigAuditScrubContract,
  ConfigDiffContract,
  ConfigGcContract,
  ConfigHistoryContract,
  ConfigPatchContract,
  ConfigReadContract,
  ConfigRollbackContract,
  ConfigSchemaContract,
  EnvListContract,
  EnvSetContract,
  GatewayRestartContract,
  GatewayStatusContract,
] as const;
