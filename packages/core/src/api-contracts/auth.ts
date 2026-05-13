// SPDX-License-Identifier: Apache-2.0
/**
 * Auth-domain RPC contracts. Mirrors
 * `packages/daemon/src/api/auth-handlers.ts`.
 *
 * Phase 35 Wave C plan 35-07 (Wave C domain #2). The auth-handlers.ts
 * factory exposes 2 admin-scoped methods that gate encrypted-OAuth-store
 * profile management:
 *
 *   - `auth.list`   (admin) — list stored OAuth profiles, projected
 *                              through {@link RedactedOAuthProfileSchema}
 *                              to strip `access`/`refresh`/`accountId`
 *                              BEFORE the response crosses the daemon →
 *                              CLI boundary. See auth-handlers.ts
 *                              `redactProfileForRpc` for the projection.
 *   - `auth.logout` (admin) — delete a stored profile by `profileId`.
 *                              Emits a destructive audit event regardless
 *                              of outcome (success/failure).
 *
 * Both contracts return token-free shapes. The contract's response schema
 * MUST stay aligned with `RedactedOAuthProfile` in auth-handlers.ts:
 *
 *   `{ provider, profileId, expires, email?, displayName? }`
 *
 * `access`, `refresh`, and `accountId` are intentionally absent from the
 * schema — modelling them here would defeat the residency canary in
 * `auth-handlers.test.ts` (the dev-mode `response.parse(...)` gate would
 * accept token-bearing payloads as well-shaped, masking a leak).
 *
 * @module
 */
import { z } from "zod";
import { defineContract } from "./types.js";

// ---------------------------------------------------------------------------
// Shared token-free projection schema
// ---------------------------------------------------------------------------

/**
 * Token-free OAuth profile shape returned by `auth.list`. Mirrors the
 * `RedactedOAuthProfile` interface in
 * `packages/daemon/src/api/auth-handlers.ts` (lines 56-64) — kept
 * structurally identical so the handler's `redactProfileForRpc` output
 * round-trips through `AuthListContract.response.parse(...)` cleanly.
 *
 * Explicitly omitted: `access`, `refresh`, `accountId`. The dev-mode
 * `response.parse(...)` gate in the handler doubles as a residency
 * canary — if any of those keys ever sneak into the response shape,
 * the parse fails (no `passthrough()` here).
 */
const RedactedOAuthProfileSchema = z.object({
  provider: z.string(),
  profileId: z.string(),
  expires: z.number(),
  email: z.string().optional(),
  displayName: z.string().optional(),
});

// ---------------------------------------------------------------------------
// auth.list
// ---------------------------------------------------------------------------

/**
 * `auth.list` — enumerate stored OAuth profile metadata. Admin-only.
 *
 * Request: optional `provider` filter (e.g., `"openai-codex"`). When
 * absent, the handler enumerates every stored profile.
 *
 * Response: `{ profiles: RedactedOAuthProfile[] }`. The array MAY be
 * empty when no encrypted store is configured (auth-handlers.ts line
 * 124-135 returns `{ profiles: [] }` in that case rather than failing).
 */
export const AuthListContract = defineContract({
  method: "auth.list",
  request: z.object({
    provider: z.string().optional(),
  }),
  response: z.object({
    profiles: z.array(RedactedOAuthProfileSchema),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// auth.logout
// ---------------------------------------------------------------------------

/**
 * `auth.logout` — delete a stored OAuth profile by `profileId`. Admin-only.
 *
 * Request: `{ profileId: string }` — the storage key
 * (e.g., `"openai-codex:user@example.com"`). Non-empty by contract; the
 * handler raises `"Missing required parameter: profileId"` for empty
 * strings via bespoke pre-Zod validation (auth-handlers.ts line 191-194).
 *
 * Response: `{ profileId: string, deleted: boolean }`. `deleted` is the
 * port's truthful answer — `false` when the profileId did not exist
 * (no-op delete, still emits a destructive audit event with
 * `metadata.existed: false`).
 */
export const AuthLogoutContract = defineContract({
  method: "auth.logout",
  request: z.object({
    profileId: z.string().min(1),
  }),
  response: z.object({
    profileId: z.string(),
    deleted: z.boolean(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// Domain array — registered into API_CONTRACTS_ORDERED in index.ts.
// ---------------------------------------------------------------------------

/**
 * Auth-domain contract array. Registered into
 * `API_CONTRACTS_ORDERED` by `packages/core/src/api-contracts/index.ts`.
 *
 * Plan 35-19 (Wave C closure) supersedes the placeholder aggregation in
 * `index.ts` with the final alphabetical aggregation across all 14
 * domains — this array remains unchanged.
 */
export const AUTH_CONTRACTS = [AuthListContract, AuthLogoutContract] as const;
