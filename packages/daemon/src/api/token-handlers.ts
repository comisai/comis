// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.
/**
 * Token management RPC handler module.
 * Provides 4 handlers for runtime token management:
 *   tokens.list   -- List all active tokens (id, scopes, createdAt -- never secrets)
 *   tokens.create -- Create a new token with specified scopes (returns secret once)
 *   tokens.revoke -- Revoke (disable) a token by ID
 *   tokens.rotate -- Atomically rotate a token (revoke old + create new)
 * Includes a mutable TokenRegistry that tracks token metadata at runtime,
 * seeded from the gateway config tokens on startup.
 *
 * Handlers use the `@comis/core` contract registry. Method keys are
 * computed-property names (`[TokensListContract.method]:`) so the
 * bidirectional 1:1 architecture test resolves them through
 * `defineContract({ method, ... })` declarations in
 * `packages/core/src/api-contracts/tokens.ts`. The dispatcher-injected
 * `_X` internal fields are stripped via `stripInternalFields` BEFORE
 * `contract.request.parse(...)` — never model internals in the contract
 * schema. The admin trust check + internal-field reads (`_context`,
 * `_agentId`, `_traceId` for the audit-trail user/trace attribution
 * path) all happen against `rawParams` BEFORE the strip step (the gate +
 * audit-context stays separate from the contract schema).
 *
 * The bespoke pre-Zod validation (admin gate, scope-empty guard, missing-id
 * guard, rotation-source-existence guard) is intentionally retained for
 * user-friendly error UX and security defense-in-depth. The contract
 * parse runs AFTER the bespoke guards and serves to (a) narrow params
 * types for the rest of the handler body and (b) provide a
 * defense-in-depth gate against future drift between the contract schema
 * and the bespoke checks. The dev-mode `Contract.response.parse(...)`
 * gate before each return doubles as a residency canary — for the
 * secret-free `tokens.list` response, default Zod STRIPS unknown keys,
 * so a future change that accidentally adds a `secret` field on a row
 * has the value REMOVED from the parsed output before it crosses the
 * daemon → web-SPA boundary. (`tokens.create` and `tokens.rotate`
 * intentionally DO model the freshly-minted `secret`/`newSecret` in
 * their response schemas — the secret-once policy mandates that the
 * caller see the value EXACTLY once.)
 *
 * Tokens are managed via the web SPA only — no CLI consumer exists for
 * `tokens.list|create|revoke|rotate` in `packages/cli/src/commands/`.
 * @module
 */

import { randomUUID } from "node:crypto";
import {
  generateStrongToken,
  generateRotationId,
  isEnvRefString,
  TokensListContract,
  TokensCreateContract,
  TokensRevokeContract,
  TokensRotateContract,
  stripInternalFields,
  systemGetEnv,
  systemNowMs,
} from "@comis/core";
import { persistToConfig, readOnDiskConfig } from "./shared/persist-to-config.js";

import type { PersistToConfigDeps } from "./shared/persist-to-config.js";
import type { RpcHandler } from "./types.js";

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

/**
 * Map the in-memory token entries to their persistable shape.
 *
 * Plaintext secrets are STRIPPED (secret-free persistence; boot resolves
 * `GATEWAY_TOKEN_<ID>` from env/secret store instead) — but `${VAR}` secret
 * REFERENCES are preserved verbatim: a ref is a pointer, not a secret, and
 * dropping one severs the existing token on the next config reload. The
 * references can only come from the ON-DISK YAML — `container.config` holds
 * the substituted plaintext. Live finding (2026-06-12 C7 run): tokens.create
 * rebuilt gateway.tokens from the in-memory view, severing the admin entry's
 * `${COMIS_GATEWAY_TOKEN}` ref; the post-persist reload minted an ephemeral
 * replacement and locked the operator out of the gateway.
 */
function persistableTokenEntries(
  persistDeps: PersistToConfigDeps,
  tokens: ReadonlyArray<{ id: string; secret?: unknown; scopes?: readonly string[] }>,
): Array<{ id: string; scopes: string[]; secret?: string }> {
  const onDisk = readOnDiskConfig(persistDeps);
  const onDiskTokens = ((onDisk.gateway as { tokens?: unknown } | undefined)?.tokens ?? []) as Array<{
    id?: unknown;
    secret?: unknown;
  }>;
  const refById = new Map<string, string>();
  for (const entry of onDiskTokens) {
    if (
      typeof entry?.id === "string" &&
      typeof entry.secret === "string" &&
      isEnvRefString(entry.secret)
    ) {
      refById.set(entry.id, entry.secret);
    }
  }
  return tokens.map((t) => {
    const ref = refById.get(t.id);
    return {
      id: t.id,
      scopes: [...(t.scopes ?? [])],
      ...(ref !== undefined && { secret: ref }),
    };
  });
}

/**
 * The env/secret-store key boot uses to resolve a config token entry that
 * carries no inline secret (mirrors `resolveGatewayTokens`).
 */
function gatewayTokenEnvKey(tokenId: string): string {
  return `GATEWAY_TOKEN_${tokenId.toUpperCase().replace(/-/g, "_")}`;
}

/** Subset of AuthApiDeps the durable-secret helpers need. */
type SecretSinkDeps = Pick<TokenHandlerDeps, "secretStore" | "mutableSecretManager" | "logger">;

/**
 * Persist a freshly-minted token secret under its `GATEWAY_TOKEN_<ID>` key —
 * encrypted at rest for restart durability, and upserted into the live
 * SecretManager map so the post-persist config reload resolves it without a
 * race. Best-effort: a store failure is logged with the key the operator
 * must set manually (the boot WARN names the same key).
 */
function storeMintedTokenSecret(deps: SecretSinkDeps, tokenId: string, secret: string, actionType: string): void {
  const envKey = gatewayTokenEnvKey(tokenId);
  const stored = deps.secretStore.set(envKey, secret, {
    description: `gateway token '${tokenId}' (minted via ${actionType})`,
  });
  if (!stored.ok) {
    deps.logger.warn(
      { method: actionType, tokenId, envVar: envKey, err: stored.error, hint: `Token works until restart only — set ${envKey} in the environment or secret store for persistence`, errorKind: "config" as const },
      "Minted token secret could not be stored",
    );
  }
  deps.mutableSecretManager.upsert(envKey, secret);
}

/** Drop a revoked/rotated token's stored secret from the store and live map. */
function dropStoredTokenSecret(deps: SecretSinkDeps, tokenId: string): void {
  const envKey = gatewayTokenEnvKey(tokenId);
  const deleted = deps.secretStore.delete(envKey);
  if (!deleted.ok) {
    deps.logger.warn(
      { tokenId, envVar: envKey, err: deleted.error, hint: `Remove ${envKey} from the secret store manually`, errorKind: "config" as const },
      "Revoked token secret could not be removed from the store",
    );
  }
  deps.mutableSecretManager.remove(envKey);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Metadata entry for a managed token (never stores secrets). */
export interface TokenRegistryEntry {
  id: string;
  scopes: readonly string[];
  createdAt: number;
  revoked: boolean;
}

/** Mutable runtime token registry for management operations. */
export interface TokenRegistry {
  list(): TokenRegistryEntry[];
  get(id: string): TokenRegistryEntry | undefined;
  create(id: string, secret: string, scopes: string[]): TokenRegistryEntry;
  revoke(id: string): boolean;
}

/**
 * Create a mutable token registry seeded from gateway config tokens.
 * The registry tracks metadata only -- secrets are never stored in the
 * registry (secret-once policy: secrets are only returned at creation time).
 * @param initialTokens - Token entries from gateway config to seed the registry
 * @returns TokenRegistry instance
 */
export function createTokenRegistry(
  initialTokens: ReadonlyArray<{ id: string; scopes: readonly string[] }>,
): TokenRegistry {
  const entries = new Map<string, TokenRegistryEntry>();
  for (const t of initialTokens) {
    entries.set(t.id, {
      id: t.id,
      scopes: t.scopes,
      createdAt: systemNowMs(),
      revoked: false,
    });
  }
  return {
    list: () => Array.from(entries.values()).filter((e) => !e.revoked),
    get: (id) => entries.get(id),
    create: (id, _secret, scopes) => {
      const entry: TokenRegistryEntry = {
        id,
        scopes,
        createdAt: systemNowMs(),
        revoked: false,
      };
      entries.set(id, entry);
      return entry;
    },
    revoke: (id) => {
      const entry = entries.get(id);
      if (!entry || entry.revoked) return false;
      entry.revoked = true;
      return true;
    },
  };
}

/** Dependencies required by token management RPC handlers.
 *
 * Single source of truth: AuthApiDeps (shared with auth-handlers +
 * secrets-handlers).
 *
 * NOTE: `TokenRegistry` is still exported from this file as the canonical
 * runtime type; `AuthApiDeps.tokenRegistry` declares a structurally-identical
 * inline shape to avoid a bidirectional madge cycle.
 */
import type { AuthApiDeps as TokenHandlerDeps } from "./types.js";
export type { TokenHandlerDeps };

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a record of token management RPC handlers bound to the given deps.
 */
export function createTokenHandlers(deps: TokenHandlerDeps): Record<string, RpcHandler> {
  return {
    /**
     * List all active tokens.
     * Returns id, scopes, and createdAt -- never secrets.
     */
    [TokensListContract.method]: async (rawParams) => {
      // Admin trust check FIRST — separate from the contract schema.
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for token listing");
      }

      // Strip dispatcher-injected _X internals BEFORE contract parse.
      // Then type-narrow via the contract — defense-in-depth.
      const userParams = stripInternalFields(rawParams);
      TokensListContract.request.parse(userParams);

      const result = {
        tokens: deps.tokenRegistry.list().map((t) => ({
          id: t.id,
          scopes: t.scopes,
          createdAt: t.createdAt,
        })),
      };
      // Dev-mode response validation gate. `TokenEntryMetadataSchema`
      // omits `secret` and does NOT use `.passthrough()` — default Zod
      // STRIPS unknown keys, so any accidental `secret` field on a row
      // is PROJECTED AWAY from the parsed output before the response
      // crosses the daemon → web-SPA boundary. Production skips for
      // cold-start budget; the trust boundary is the TokenRegistry which
      // never stores secrets by construction.
      if (systemGetEnv("NODE_ENV") !== "production") {
        TokensListContract.response.parse(result);
      }
      return result;
    },

    /**
     * Create a new token with specified scopes.
     * Returns the secret exactly once in the response.
     */
    [TokensCreateContract.method]: async (rawParams) => {
      // Admin trust check FIRST — separate from the contract schema.
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for token creation");
      }

      // Bespoke pre-Zod scope guard — produces the legacy "Missing or
      // empty required parameter: scopes" UX, which is more actionable
      // than Zod's noisier `.min(1)` error. The contract's
      // `z.array(z.string()).min(1)` is defense-in-depth.
      const scopes = rawParams.scopes as string[] | undefined;
      if (!Array.isArray(scopes) || scopes.length === 0) {
        throw new Error("Missing or empty required parameter: scopes");
      }

      // Strip dispatcher-injected _X internals BEFORE contract parse.
      // The contract parse runs AFTER the bespoke guard and serves as
      // type-narrowing + defense-in-depth.
      const userParams = stripInternalFields(rawParams);
      const params = TokensCreateContract.request.parse(userParams);

      const id = params.id ?? randomUUID();
      // Generate a 64-char base64url secret with 384 bits of entropy
      const secret = generateStrongToken();

      const entry = deps.tokenRegistry.create(id, secret, [...params.scopes]);
      deps.addToTokenStore({ id, secret, scopes: [...params.scopes] });
      // Durable + live BEFORE the config persist, so the debounced
      // post-persist reload resolves GATEWAY_TOKEN_<ID> instead of
      // minting an ephemeral replacement.
      storeMintedTokenSecret(deps, id, secret, "tokens.create");

      // Best-effort persistence to config.yaml -- secret-free for the new
      // entry; existing ${VAR} references preserved. Reads
      // `_context`/`_agentId`/`_traceId` from rawParams (BEFORE strip)
      // because those internal fields carry audit-trail attribution
      // that must NOT be modelled in the contract schema.
      if (deps.persistDeps) {
        const ctx = rawParams._context as { userId?: string; traceId?: string } | undefined;
        const existingTokens = persistableTokenEntries(
          deps.persistDeps,
          deps.persistDeps.container.config.gateway?.tokens ?? [],
        );
        const persistResult = await persistToConfig(deps.persistDeps, {
          patch: { gateway: { tokens: [...existingTokens, { id, scopes: [...params.scopes] }] } },
          actionType: "tokens.create",
          entityId: id,
          actingUser: ctx?.userId ?? (rawParams._agentId as string | undefined),
          traceId: ctx?.traceId ?? (rawParams._traceId as string | undefined),
        });
        if (!persistResult.ok) {
          deps.persistDeps.logger.warn(
            { method: "tokens.create", tokenId: id, err: persistResult.error, hint: "Token created in memory but config persistence failed", errorKind: "config" as const },
            "Token config persistence failed",
          );
        }
      }

      const result = {
        id,
        secret,
        scopes: entry.scopes,
        createdAt: entry.createdAt,
        message: "Token created. Save the secret now -- it will not be shown again.",
      };
      // Dev-mode response validation gate. `secret` IS modelled in
      // `TokensCreateContract.response` (secret-once policy: the caller
      // MUST see the freshly-minted token EXACTLY once — no
      // re-fetch). The parse is a defense-in-depth shape check.
      if (systemGetEnv("NODE_ENV") !== "production") {
        TokensCreateContract.response.parse(result);
      }
      return result;
    },

    /**
     * Revoke (disable) a token by ID.
     */
    [TokensRevokeContract.method]: async (rawParams) => {
      // Admin trust check FIRST — separate from the contract schema.
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for token revocation");
      }

      // Bespoke pre-Zod id guard — produces the legacy "Missing required
      // parameter: id" UX, which is more actionable than Zod's noisier
      // `.min(1)` error. The contract's `z.string().min(1)` is
      // defense-in-depth.
      const idRaw = rawParams.id as string | undefined;
      if (!idRaw) {
        throw new Error("Missing required parameter: id");
      }

      // Strip dispatcher-injected _X internals BEFORE contract parse.
      // The contract parse runs AFTER the bespoke guard and serves as
      // type-narrowing + defense-in-depth.
      const userParams = stripInternalFields(rawParams);
      const params = TokensRevokeContract.request.parse(userParams);
      const id = params.id;

      const revoked = deps.tokenRegistry.revoke(id);
      if (!revoked) {
        throw new Error("Token not found or already revoked");
      }
      deps.removeFromTokenStore(id);
      dropStoredTokenSecret(deps, id);

      // Best-effort persistence to config.yaml -- secret-free, existing
      // ${VAR} references preserved.
      if (deps.persistDeps) {
        const ctx = rawParams._context as { userId?: string; traceId?: string } | undefined;
        const existingTokens = persistableTokenEntries(
          deps.persistDeps,
          deps.persistDeps.container.config.gateway?.tokens ?? [],
        );
        const filteredTokens = existingTokens.filter((t) => t.id !== id);
        const persistResult = await persistToConfig(deps.persistDeps, {
          patch: { gateway: { tokens: filteredTokens } },
          actionType: "tokens.revoke",
          entityId: id,
          actingUser: ctx?.userId ?? (rawParams._agentId as string | undefined),
          traceId: ctx?.traceId ?? (rawParams._traceId as string | undefined),
        });
        if (!persistResult.ok) {
          deps.persistDeps.logger.warn(
            { method: "tokens.revoke", tokenId: id, err: persistResult.error, hint: "Token revoked in memory but config persistence failed", errorKind: "config" as const },
            "Token config persistence failed",
          );
        }
      }

      const result = { id, revoked: true as const, message: "Token revoked" };
      // Dev-mode response validation gate.
      if (systemGetEnv("NODE_ENV") !== "production") {
        TokensRevokeContract.response.parse(result);
      }
      return result;
    },

    /**
     * Atomically rotate a token (revoke old + create new).
     * Returns the new secret exactly once.
     */
    [TokensRotateContract.method]: async (rawParams) => {
      // Admin trust check FIRST — separate from the contract schema.
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for token rotation");
      }

      // Bespoke pre-Zod id guard — same UX as tokens.revoke.
      const idRaw = rawParams.id as string | undefined;
      if (!idRaw) {
        throw new Error("Missing required parameter: id");
      }

      // Strip dispatcher-injected _X internals BEFORE contract parse.
      const userParams = stripInternalFields(rawParams);
      const params = TokensRotateContract.request.parse(userParams);
      const id = params.id;

      // Look up the old token to inherit its scopes
      const oldEntry = deps.tokenRegistry.get(id);
      if (!oldEntry || oldEntry.revoked) {
        throw new Error("Token not found or already revoked");
      }
      const scopes = [...oldEntry.scopes];

      // Revoke old token
      deps.tokenRegistry.revoke(id);
      deps.removeFromTokenStore(id);
      dropStoredTokenSecret(deps, id);

      // Create new token with rotated ID (random suffix) and same scopes
      const newId = generateRotationId(id);
      const newSecret = generateStrongToken();

      const newEntry = deps.tokenRegistry.create(newId, newSecret, scopes);
      deps.addToTokenStore({ id: newId, secret: newSecret, scopes });
      storeMintedTokenSecret(deps, newId, newSecret, "tokens.rotate");

      // Best-effort persistence to config.yaml -- secret-free for the new
      // entry; existing ${VAR} references preserved.
      if (deps.persistDeps) {
        const ctx = rawParams._context as { userId?: string; traceId?: string } | undefined;
        const existingTokens = persistableTokenEntries(
          deps.persistDeps,
          deps.persistDeps.container.config.gateway?.tokens ?? [],
        );
        const rotatedTokens = [...existingTokens.filter((t) => t.id !== id), { id: newId, scopes }];
        const persistResult = await persistToConfig(deps.persistDeps, {
          patch: { gateway: { tokens: rotatedTokens } },
          actionType: "tokens.rotate",
          entityId: `${id} -> ${newId}`,
          actingUser: ctx?.userId ?? (rawParams._agentId as string | undefined),
          traceId: ctx?.traceId ?? (rawParams._traceId as string | undefined),
        });
        if (!persistResult.ok) {
          deps.persistDeps.logger.warn(
            { method: "tokens.rotate", tokenId: `${id} -> ${newId}`, err: persistResult.error, hint: "Token rotated in memory but config persistence failed", errorKind: "config" as const },
            "Token config persistence failed",
          );
        }
      }

      const result = {
        oldId: id,
        newId,
        newSecret,
        scopes: newEntry.scopes,
        createdAt: newEntry.createdAt,
        message: "Token rotated. Save the new secret now.",
      };
      // Dev-mode response validation gate. `newSecret` IS modelled in
      // `TokensRotateContract.response` (secret-once policy: same as
      // tokens.create — the caller MUST see the freshly-minted token
      // EXACTLY once).
      if (systemGetEnv("NODE_ENV") !== "production") {
        TokensRotateContract.response.parse(result);
      }
      return result;
    },
  };
}
