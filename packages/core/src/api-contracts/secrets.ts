// SPDX-License-Identifier: Apache-2.0
/**
 * Secrets-domain RPC contracts. Mirrors
 * `packages/daemon/src/api/secrets-handlers.ts`.
 *
 * Phase 35 Wave C plan 35-08 (Wave C domain #3). The secrets-handlers.ts
 * factory exposes 4 admin-scoped methods that gate encrypted-secret
 * management (AES-256-GCM SQLite store via `SecretStorePort`):
 *
 *   - `secrets.set`    (admin) — store or update an encrypted secret.
 *                                Rate-limited at 5 writes/minute. The
 *                                `value` parameter NEVER appears in any
 *                                log call or audit event (residency
 *                                invariant MEM-CTX-PORTS-14 + RES-PIT-31-3).
 *   - `secrets.get`    (admin) — retrieve plaintext for a single secret by
 *                                name. Rate-limited at 60 reads/minute.
 *                                Plaintext is returned to the authenticated
 *                                caller as the SOLE output of the handler
 *                                (no logger / audit-event field carries it).
 *   - `secrets.list`   (admin) — enumerate secret METADATA (name, provider,
 *                                timestamps, usage count). Plaintext values
 *                                are NEVER part of the response.
 *   - `secrets.delete` (admin) — remove a secret. Rate-limited at 5
 *                                deletes/minute. Emits a destructive audit
 *                                event regardless of outcome.
 *
 * All 4 contracts have `scopes: ["admin"] as const`, locking in the Phase
 * 31 invariant (RES-PIT-31-3) at the contract-registry level: every
 * `/^secrets\./` method is admin-only. The existing AST architecture test
 * in `packages/core/src/__tests__/architecture.test.ts` enforces the
 * same invariant against `setup-gateway-api.ts`; this file adds a second,
 * orthogonal enforcement point (the contract registry itself).
 *
 * Response shapes match the handler's actual return values verbatim:
 *   - `secrets.set` returns `{ name, stored: boolean }`
 *     (NOT `{ name, set: boolean }` as the plan's <interfaces> block
 *     suggested — confirmed by reading secrets-handlers.ts line 341).
 *   - `secrets.get` returns `{ name, exists: boolean, value?: string }`.
 *   - `secrets.list` returns `{ secrets: SecretMetadata[] }`
 *     (NOT `{ names: string[] }` as the plan's <interfaces> block
 *     suggested — the handler returns the full SecretMetadata rows from
 *     `SecretStorePort.list()`; the CLI table renderer at
 *     `packages/cli/src/commands/secrets.ts:289-330` consumes the full
 *     metadata shape).
 *   - `secrets.delete` returns `{ name, deleted: boolean }`.
 *
 * The SecretMetadata shape mirrors `packages/core/src/ports/secret-store.ts`
 * (lines 9-26). `value` is intentionally absent from the schema (no
 * `.passthrough()`) — modelling it would defeat the dev-mode
 * `response.parse(...)` projection that doubles as a residency canary
 * by stripping any accidental `value` field before the response crosses
 * the daemon → CLI boundary.
 *
 * @module
 */
import { z } from "zod";
import { defineContract } from "./types.js";

// ---------------------------------------------------------------------------
// Shared SecretMetadata schema (value-free; mirrors SecretStorePort)
// ---------------------------------------------------------------------------

/**
 * Metadata-only shape returned by `secrets.list`. Mirrors the
 * `SecretMetadata` interface in `packages/core/src/ports/secret-store.ts`
 * (lines 9-26) — kept structurally identical so the handler's
 * `SecretStorePort.list()` output round-trips through
 * `SecretsListContract.response.parse(...)` cleanly.
 *
 * Explicitly omitted: `value` / `plaintext`. No `.passthrough()` here, so
 * default Zod STRIPS unknown keys — the dev-mode `response.parse(...)`
 * gate in the handler doubles as a residency canary by PROJECTING away
 * any accidental `value` field before the response crosses the daemon
 * → CLI boundary.
 */
const SecretMetadataSchema = z.object({
  name: z.string(),
  provider: z.string().optional(),
  description: z.string().optional(),
  expiresAt: z.number().optional(),
  lastUsedAt: z.number().optional(),
  usageCount: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

// ---------------------------------------------------------------------------
// secrets.set
// ---------------------------------------------------------------------------

/**
 * `secrets.set` — store or update an encrypted secret. Admin-only.
 *
 * Request: `{ name, value, provider?, description?, expiresAt? }`.
 *   - `name` MUST match `/^[A-Z][A-Z0-9_]*$/` (uppercase identifier) and
 *     be ≤256 chars. Bespoke handler validation produces a user-friendly
 *     error message; the contract's `.min(1)` is defense-in-depth.
 *   - `value` MUST be a non-empty string, ≤8192 chars. Cannot be a
 *     redaction placeholder (handler rejects `[REDACTED]` / `[REDACTED:*]`
 *     literals — see secrets-handlers.ts line 273).
 *
 * Response: `{ name: string, stored: boolean }`. `stored` is always `true`
 * on success (the handler throws on failure paths).
 */
export const SecretsSetContract = defineContract({
  method: "secrets.set",
  request: z.object({
    name: z.string().min(1),
    value: z.string().min(1),
    provider: z.string().optional(),
    description: z.string().optional(),
    expiresAt: z.number().optional(),
  }),
  response: z.object({
    name: z.string(),
    stored: z.boolean(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// secrets.get
// ---------------------------------------------------------------------------

/**
 * `secrets.get` — retrieve plaintext for a single secret. Admin-only.
 *
 * Request: `{ name: string }` — the secret identifier.
 *
 * Response: `{ name: string, exists: boolean, value?: string }`.
 *   - `exists: false` + `value: undefined` when the secret is not found.
 *   - `exists: true` + `value: <plaintext>` on successful decrypt.
 *
 * The `value` field is the SOLE place plaintext appears in the response;
 * it does NOT appear in any audit-event metadata or logger payload (the
 * residency invariant is enforced at the handler in
 * `secrets-handlers.test.ts` via canary-string scanning).
 */
export const SecretsGetContract = defineContract({
  method: "secrets.get",
  request: z.object({
    name: z.string().min(1),
  }),
  response: z.object({
    name: z.string(),
    exists: z.boolean(),
    value: z.string().optional(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// secrets.list
// ---------------------------------------------------------------------------

/**
 * `secrets.list` — enumerate secret metadata. Admin-only.
 *
 * Request: `{}` — no parameters.
 *
 * Response: `{ secrets: SecretMetadata[] }`. The array MAY be empty when
 * the encrypted store is not configured (`SECRETS_MASTER_KEY` missing —
 * the handler returns `{ secrets: [] }` rather than failing; see
 * secrets-handlers.ts line 361).
 *
 * Plaintext values are NEVER part of `SecretMetadata`. The contract
 * `response.parse(...)` gate in the handler (dev-mode only) doubles as
 * a residency canary — `SecretMetadataSchema` omits `value` / `plaintext`
 * and does NOT call `.passthrough()`, so default Zod STRIPS any
 * accidental value-bearing field from the parsed output BEFORE the
 * response crosses the daemon → CLI boundary.
 */
export const SecretsListContract = defineContract({
  method: "secrets.list",
  request: z.object({}),
  response: z.object({
    secrets: z.array(SecretMetadataSchema),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// secrets.delete
// ---------------------------------------------------------------------------

/**
 * `secrets.delete` — remove a secret from the store. Admin-only.
 *
 * Request: `{ name: string }` — the secret identifier.
 *
 * Response: `{ name: string, deleted: boolean }`. `deleted` is the port's
 * truthful answer — `false` when the secret did not exist (no-op delete,
 * still emits a destructive audit event with `metadata.existed: false`).
 */
export const SecretsDeleteContract = defineContract({
  method: "secrets.delete",
  request: z.object({
    name: z.string().min(1),
  }),
  response: z.object({
    name: z.string(),
    deleted: z.boolean(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// Domain array — registered into API_CONTRACTS_ORDERED in index.ts.
// ---------------------------------------------------------------------------

/**
 * Secrets-domain contract array. Registered into
 * `API_CONTRACTS_ORDERED` by `packages/core/src/api-contracts/index.ts`.
 *
 * Plan 35-19 (Wave C closure) supersedes the placeholder aggregation in
 * `index.ts` with the final alphabetical aggregation across all 14
 * domains — this array remains unchanged.
 */
export const SECRETS_CONTRACTS = [
  SecretsSetContract,
  SecretsGetContract,
  SecretsListContract,
  SecretsDeleteContract,
] as const;
