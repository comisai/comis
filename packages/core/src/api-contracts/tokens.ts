// SPDX-License-Identifier: Apache-2.0
/**
 * Tokens-domain RPC contracts. Mirrors
 * `packages/daemon/src/api/token-handlers.ts`.
 *
 * Phase 35 Wave C plan 35-09 (Wave C domain #4). The token-handlers.ts
 * factory exposes 4 admin-scoped methods that gate runtime token
 * lifecycle management for the web SPA's admin UI:
 *
 *   - `tokens.list`   (admin) — enumerate token METADATA (id, scopes,
 *                                createdAt). Secrets NEVER cross the
 *                                daemon → web boundary on this method
 *                                (TokenRegistry never stores secrets by
 *                                construction — token-handlers.ts
 *                                line 70-72).
 *   - `tokens.create` (admin) — mint a new token with caller-supplied
 *                                scopes. Returns the secret EXACTLY ONCE
 *                                in the response payload (secret-once
 *                                policy: re-fetch is impossible — the
 *                                secret is not persisted in the
 *                                registry).
 *   - `tokens.revoke` (admin) — disable a token by id. Idempotent at the
 *                                handler level (re-revoking a revoked
 *                                token raises "Token not found or
 *                                already revoked"; the contract models
 *                                the success-path shape only).
 *   - `tokens.rotate` (admin) — atomically revoke an existing token and
 *                                mint a replacement with the same scopes.
 *                                The new id uses a random suffix
 *                                (generateRotationId) — NOT a Date.now()
 *                                derivation. Returns `newSecret`
 *                                EXACTLY ONCE in the response payload.
 *
 * All 4 contracts have `scopes: ["admin"] as const`, mirroring the
 * registration in `packages/daemon/src/wiring/setup-gateway-api.ts`
 * line 248-250 (`registerRpcPassthrough(..., ["tokens.list",
 * "tokens.create", "tokens.revoke", "tokens.rotate"], "admin")`).
 *
 * **BLOCKER 1 exemption.** tokens are managed via the web SPA only.
 * `grep -rln 'tokens\.\(list\|create\|revoke\|rotate\)'
 * packages/cli/src/commands/` returns empty — no CLI consumer to
 * retarget through `callTyped`. The web SPA's `tokens.*` consumers
 * (packages/web/src/api/types/rpc-registry.ts line 363-378 +
 * packages/web/src/views/security.test.ts) consume their own typed RPC
 * registry, not `@comis/core` directly; Wave D's codegen path will
 * source web types from this contract registry in a later phase.
 *
 * Response shapes match the handler's actual return values verbatim:
 *   - `tokens.list` returns `{ tokens: TokenEntryMetadata[] }` where
 *     `TokenEntryMetadata` is the secret-free `{ id, scopes, createdAt }`
 *     projection (token-handlers.ts line 115-121). `revoked` is NOT
 *     included because the handler filters out revoked entries before
 *     returning (`registry.list()` returns only `!revoked` entries —
 *     token-handlers.ts line 60).
 *   - `tokens.create` returns
 *     `{ id, secret, scopes, createdAt, message }` (token-handlers.ts
 *     line 165-171). `secret` is the SOLE place the plaintext token
 *     appears in the response — it does NOT appear in any audit-event
 *     metadata, logger payload, or persisted config (the registry
 *     stores metadata only; setup-gateway-api.ts persistence patch is
 *     secret-free — see token-handlers.test.ts line 478-481).
 *   - `tokens.revoke` returns `{ id, revoked: true, message }`
 *     (token-handlers.ts line 214). `revoked` is `z.literal(true)`
 *     rather than `z.boolean()` because failure paths throw rather than
 *     returning `{ revoked: false }`.
 *   - `tokens.rotate` returns
 *     `{ oldId, newId, newSecret, scopes, createdAt, message }`
 *     (token-handlers.ts line 271-278). `newSecret` is the SOLE place
 *     the new plaintext token appears — same secret-once invariant as
 *     `tokens.create`.
 *
 * The TokenEntryMetadataSchema mirrors the secret-free
 * `{ id, scopes, createdAt }` projection from
 * `TokenRegistry.list()` (token-handlers.ts line 60-61). The handler
 * explicitly omits `revoked` from the response rows because
 * `registry.list()` filters revoked entries before returning.
 *
 * @module
 */
import { z } from "zod";
import { defineContract } from "./types.js";

// ---------------------------------------------------------------------------
// Shared TokenEntryMetadata schema (secret-free; mirrors
// TokenRegistryEntry projection from token-handlers.ts line 115-121)
// ---------------------------------------------------------------------------

/**
 * Secret-free shape returned per row by `tokens.list`. Mirrors the
 * `{ id, scopes, createdAt }` projection in
 * `packages/daemon/src/api/token-handlers.ts` line 115-121.
 *
 * Explicitly omitted: `secret` (never stored in TokenRegistry by
 * construction — token-handlers.ts line 70-72) and `revoked` (the
 * handler filters revoked entries before returning — token-handlers.ts
 * line 60). No `.passthrough()` here, so default Zod STRIPS unknown
 * keys — the dev-mode `response.parse(...)` gate in the handler
 * doubles as a residency canary by PROJECTING away any accidental
 * `secret` field before the response crosses the daemon → web
 * boundary.
 */
const TokenEntryMetadataSchema = z.object({
  id: z.string(),
  scopes: z.array(z.string()),
  createdAt: z.number(),
});

// ---------------------------------------------------------------------------
// tokens.list
// ---------------------------------------------------------------------------

/**
 * `tokens.list` — enumerate active token metadata. Admin-only.
 *
 * Request: `{}` — no parameters.
 *
 * Response: `{ tokens: TokenEntryMetadata[] }`. Each row is the
 * secret-free `{ id, scopes, createdAt }` projection. Revoked entries
 * are filtered out by the registry before the array reaches the
 * caller.
 */
export const TokensListContract = defineContract({
  method: "tokens.list",
  request: z.object({}),
  response: z.object({
    tokens: z.array(TokenEntryMetadataSchema),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// tokens.create
// ---------------------------------------------------------------------------

/**
 * `tokens.create` — mint a new token with caller-supplied scopes.
 * Admin-only. Returns the secret EXACTLY ONCE in the response payload
 * (secret-once policy).
 *
 * Request: `{ id?: string, scopes: string[] }`.
 *   - `id` is optional — when absent the handler generates a UUID via
 *     `randomUUID()` (token-handlers.ts line 138).
 *   - `scopes` MUST be a non-empty array. Bespoke handler validation
 *     raises `"Missing or empty required parameter: scopes"` for empty
 *     arrays (token-handlers.ts line 135-137); the contract's
 *     `.min(1)` is defense-in-depth.
 *
 * Response: `{ id, secret, scopes, createdAt, message }`. `secret` is
 * a 64-char base64url string (`generateStrongToken()` provides 384 bits
 * of entropy). `message` is the operator-facing "Token created. Save
 * the secret now -- it will not be shown again." string.
 */
export const TokensCreateContract = defineContract({
  method: "tokens.create",
  request: z.object({
    id: z.string().optional(),
    scopes: z.array(z.string()).min(1),
  }),
  response: z.object({
    id: z.string(),
    secret: z.string(),
    scopes: z.array(z.string()),
    createdAt: z.number(),
    message: z.string(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// tokens.revoke
// ---------------------------------------------------------------------------

/**
 * `tokens.revoke` — disable a token by id. Admin-only.
 *
 * Request: `{ id: string }` — the token identifier. Non-empty by
 * contract; the handler raises `"Missing required parameter: id"` for
 * missing or empty strings via bespoke pre-Zod validation
 * (token-handlers.ts line 183-185).
 *
 * Response: `{ id, revoked: true, message }`. `revoked` is modelled
 * as `z.literal(true)` because the handler ONLY returns this shape on
 * success — non-existent or already-revoked tokens raise "Token not
 * found or already revoked" (token-handlers.ts line 188-190). No
 * `{ revoked: false }` shape is ever serialized.
 */
export const TokensRevokeContract = defineContract({
  method: "tokens.revoke",
  request: z.object({
    id: z.string().min(1),
  }),
  response: z.object({
    id: z.string(),
    revoked: z.literal(true),
    message: z.string(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// tokens.rotate
// ---------------------------------------------------------------------------

/**
 * `tokens.rotate` — atomically revoke an existing token and mint a
 * replacement with the same scopes. Admin-only.
 *
 * Request: `{ id: string }` — the existing token identifier.
 *
 * Response: `{ oldId, newId, newSecret, scopes, createdAt, message }`.
 *   - `newId` uses a random suffix (`generateRotationId`) — NOT a
 *     timestamp derivation. Format: `<oldId>-<base64url>`.
 *   - `newSecret` is the SOLE place the new plaintext token appears
 *     in the response (secret-once invariant — same as
 *     `tokens.create`).
 *   - `scopes` is the carried-forward scope set from the old token.
 */
export const TokensRotateContract = defineContract({
  method: "tokens.rotate",
  request: z.object({
    id: z.string().min(1),
  }),
  response: z.object({
    oldId: z.string(),
    newId: z.string(),
    newSecret: z.string(),
    scopes: z.array(z.string()),
    createdAt: z.number(),
    message: z.string(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// Domain array — registered into API_CONTRACTS_ORDERED in index.ts.
// ---------------------------------------------------------------------------

/**
 * Tokens-domain contract array. Registered into
 * `API_CONTRACTS_ORDERED` by `packages/core/src/api-contracts/index.ts`.
 *
 * Plan 35-19 (Wave C closure) supersedes the placeholder aggregation in
 * `index.ts` with the final alphabetical aggregation across all 14
 * domains — this array remains unchanged.
 */
export const TOKENS_CONTRACTS = [
  TokensListContract,
  TokensCreateContract,
  TokensRevokeContract,
  TokensRotateContract,
] as const;
