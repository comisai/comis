// SPDX-License-Identifier: Apache-2.0
/**
 * The `obs.audit.query` wire shape — the read surface onto the durable
 * `obs_audit_events` table. The SIBLING
 * of `obs.system.health` / `obs.explain`: a bounded, admin-gated, content-free
 * query over the persisted security-decision audit.
 *
 * Request: the {@link AuditQueryParams} filter shape (every field
 * optional; absent widens the scan). The handler clamps `limit` to a hard
 * ceiling (the store already does too — defense-in-depth). NO `.default()` (off
 * the 12-shape allowlist); the bounded default limit is applied store-side.
 *
 * Response: `{ rows }` — content-free `AuditEventRow`s (id / scope ids / ts /
 * closed-enum kind+classification+outcome+severity / `refs` scrubbed JSON blob).
 * NO secret value field exists on the row (structural — values are scrubbed at
 * write); a `value`-shaped field can never appear because the row type has no
 * such field. The rows ride the documented loose-record projection
 * (`z.record(z.string(), z.unknown())` — the `ObsRecordArray` mold the sibling
 * obs.* contracts use): the daemon handler's typed `AuditEventRow[]` + its
 * dev-mode `response.parse` are the authoritative shape validators; the wire
 * contract is narrowing + a budget-friendly defense-in-depth, NOT a per-field
 * re-declaration. The typed {@link AuditEventRowWire} documents the row shape
 * consumers (the CLI render, the SPA) narrow the loose wire rows back to.
 *
 * @module
 */
import { z } from "zod";
import { defineContract } from "./types.js";

/**
 * The content-free audit row shape (the `obs.audit.query` projection), mirroring
 * the `@comis/memory` `AuditEventRow` interface field-for-field — counts / ids /
 * closed enums / a scrubbed `refs` blob ONLY. There is NO `value` field (a secret
 * value never reaches a row). Exported as the TYPE consumers
 * narrow the loose wire rows to; the wire contract itself uses the loose-record
 * array (see the module JSDoc) to stay within the contracts bundle-size budget,
 * exactly as the sibling obs.* contracts do.
 */
export interface AuditEventRowWire {
  id: string;
  tenantId: string;
  agentId: string | null;
  ts: number;
  kind: string;
  classification: string | null;
  action: string | null;
  actor: string | null;
  outcome: string | null;
  severity: string | null;
  traceId: string | null;
  /** The scrubbed JSON blob (the `audit:event` metadata routed through
   *  sanitizeForPersistence — never raw values). */
  refs: string | null;
}

/** The `obs.audit.query` response — content-free rows (loose-record projection),
 *  ORDER BY ts DESC. The handler returns typed `AuditEventRow[]`; this loose
 *  array is the wire-boundary narrowing (the `ObsRecordArray` convention). Local
 *  (not re-exported from the `@comis/core` barrel) — the contract embeds it and
 *  `AuditQueryResponse` (the inferred TYPE) is the public surface. */
const AuditQueryResponseSchema = z.object({
  rows: z.array(z.record(z.string(), z.unknown())),
});

/** The `obs.audit.query` response shape. Inferred from the Zod schema. */
export type AuditQueryResponse = z.infer<typeof AuditQueryResponseSchema>;

/**
 * `obs.audit.query` — the admin-gated read RPC onto `obs_audit_events`.
 * The SIBLING of {@link ObsExplainContract} / `ObsSystemHealthContract`:
 * a bounded, deterministic, content-free query over the persisted audit. The
 * daemon handler enforces the dual-layer admin gate (gateway-router scope +
 * an in-handler `_trustLevel === "admin"` re-check) and strips internal fields
 * before the parse, mirroring `obs.system.health`.
 *
 * Request: the {@link AuditQueryParams} filter shape — every field optional; an
 * absent field widens the scan. All filters become bound parameters in a
 * parameterized WHERE store-side (never interpolated SQL).
 */
export const ObsAuditQueryContract = defineContract({
  method: "obs.audit.query",
  request: z.object({
    /** Event family (the closed AuditKind value, passed as a string). */
    kind: z.string().min(1).optional(),
    /** Risk class — `read|mutate|destructive` (chiefly the `audit` kind). */
    classification: z.string().min(1).optional(),
    /** Agent that performed the action. */
    agentId: z.string().min(1).optional(),
    /** Tenant scope (the `""` system-scope sentinel matches tenant-less events). */
    tenant: z.string().optional(),
    /** Action outcome (`success|failure|denied`). */
    outcome: z.string().min(1).optional(),
    /** Lower time bound (inclusive), epoch ms. */
    since: z.number().optional(),
    /** Upper time bound (inclusive), epoch ms. */
    until: z.number().optional(),
    /** Row cap. Bounded default + hard ceiling applied store-side. */
    limit: z.number().positive().optional(),
  }),
  response: AuditQueryResponseSchema,
  scopes: ["admin"] as const,
});
