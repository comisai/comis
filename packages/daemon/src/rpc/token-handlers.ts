/**
 * Token management RPC handler module.
 * Provides 4 handlers for runtime token management:
 *   tokens.list   -- List all active tokens (id, scopes, createdAt -- never secrets)
 *   tokens.create -- Create a new token with specified scopes (returns secret once)
 *   tokens.revoke -- Revoke (disable) a token by ID
 *   tokens.rotate -- Atomically rotate a token (revoke old + create new)
 * Includes a mutable TokenRegistry that tracks token metadata at runtime,
 * seeded from the gateway config tokens on startup.
 * @module
 */

import { randomUUID } from "node:crypto";
import { generateStrongToken, generateRotationId } from "@comis/core";
import { persistToConfig, type PersistToConfigDeps } from "./persist-to-config.js";

import type { RpcHandler } from "./types.js";

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
      createdAt: Date.now(),
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
        createdAt: Date.now(),
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

/** Dependencies required by token management RPC handlers. */
export interface TokenHandlerDeps {
  tokenRegistry: TokenRegistry;
  /** Callback to add a token to the live gateway TokenStore for auth verification. */
  addToTokenStore: (entry: { id: string; secret: string; scopes: string[] }) => void;
  /** Callback to remove a token from the live gateway TokenStore. */
  removeFromTokenStore: (id: string) => void;
  /** Optional persistence deps for writing changes to config.yaml. When omitted, changes are memory-only. */
  persistDeps?: PersistToConfigDeps;
}

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
    "tokens.list": async (params) => {
      const trustLevel = params._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for token listing");
      }
      return {
        tokens: deps.tokenRegistry.list().map((t) => ({
          id: t.id,
          scopes: t.scopes,
          createdAt: t.createdAt,
        })),
      };
    },

    /**
     * Create a new token with specified scopes.
     * Returns the secret exactly once in the response.
     */
    "tokens.create": async (params) => {
      const trustLevel = params._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for token creation");
      }

      const scopes = params.scopes as string[] | undefined;
      if (!Array.isArray(scopes) || scopes.length === 0) {
        throw new Error("Missing or empty required parameter: scopes");
      }
      const id = (params.id as string | undefined) ?? randomUUID();
      // Generate a 64-char base64url secret with 384 bits of entropy
      const secret = generateStrongToken();

      const entry = deps.tokenRegistry.create(id, secret, scopes);
      deps.addToTokenStore({ id, secret, scopes });

      // Best-effort persistence to config.yaml -- secret-free
      if (deps.persistDeps) {
        const ctx = params._context as { userId?: string; traceId?: string } | undefined;
        const existingTokens = (deps.persistDeps.container.config.gateway?.tokens ?? [])
          .map((t: { id: string; scopes?: readonly string[] }) => ({ id: t.id, scopes: [...(t.scopes ?? [])] }));
        const persistResult = await persistToConfig(deps.persistDeps, {
          patch: { gateway: { tokens: [...existingTokens, { id, scopes }] } },
          actionType: "tokens.create",
          entityId: id,
          actingUser: ctx?.userId ?? (params._agentId as string | undefined),
          traceId: ctx?.traceId ?? (params._traceId as string | undefined),
        });
        if (!persistResult.ok) {
          deps.persistDeps.logger.warn(
            { method: "tokens.create", tokenId: id, err: persistResult.error, hint: "Token created in memory but config persistence failed", errorKind: "config" as const },
            "Token config persistence failed",
          );
        }
      }

      return {
        id,
        secret,
        scopes: entry.scopes,
        createdAt: entry.createdAt,
        message: "Token created. Save the secret now -- it will not be shown again.",
      };
    },

    /**
     * Revoke (disable) a token by ID.
     */
    "tokens.revoke": async (params) => {
      const trustLevel = params._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for token revocation");
      }

      const id = params.id as string | undefined;
      if (!id) {
        throw new Error("Missing required parameter: id");
      }
      const revoked = deps.tokenRegistry.revoke(id);
      if (!revoked) {
        throw new Error("Token not found or already revoked");
      }
      deps.removeFromTokenStore(id);

      // Best-effort persistence to config.yaml -- secret-free
      if (deps.persistDeps) {
        const ctx = params._context as { userId?: string; traceId?: string } | undefined;
        const existingTokens = (deps.persistDeps.container.config.gateway?.tokens ?? [])
          .map((t: { id: string; scopes?: readonly string[] }) => ({ id: t.id, scopes: [...(t.scopes ?? [])] }));
        const filteredTokens = existingTokens.filter((t) => t.id !== id);
        const persistResult = await persistToConfig(deps.persistDeps, {
          patch: { gateway: { tokens: filteredTokens } },
          actionType: "tokens.revoke",
          entityId: id,
          actingUser: ctx?.userId ?? (params._agentId as string | undefined),
          traceId: ctx?.traceId ?? (params._traceId as string | undefined),
        });
        if (!persistResult.ok) {
          deps.persistDeps.logger.warn(
            { method: "tokens.revoke", tokenId: id, err: persistResult.error, hint: "Token revoked in memory but config persistence failed", errorKind: "config" as const },
            "Token config persistence failed",
          );
        }
      }

      return { id, revoked: true, message: "Token revoked" };
    },

    /**
     * Atomically rotate a token (revoke old + create new).
     * Returns the new secret exactly once.
     */
    "tokens.rotate": async (params) => {
      const trustLevel = params._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for token rotation");
      }

      const id = params.id as string | undefined;
      if (!id) {
        throw new Error("Missing required parameter: id");
      }

      // Look up the old token to inherit its scopes
      const oldEntry = deps.tokenRegistry.get(id);
      if (!oldEntry || oldEntry.revoked) {
        throw new Error("Token not found or already revoked");
      }
      const scopes = [...oldEntry.scopes];

      // Revoke old token
      deps.tokenRegistry.revoke(id);
      deps.removeFromTokenStore(id);

      // Create new token with rotated ID (random suffix) and same scopes
      const newId = generateRotationId(id);
      const newSecret = generateStrongToken();

      const newEntry = deps.tokenRegistry.create(newId, newSecret, scopes);
      deps.addToTokenStore({ id: newId, secret: newSecret, scopes });

      // Best-effort persistence to config.yaml -- secret-free
      if (deps.persistDeps) {
        const ctx = params._context as { userId?: string; traceId?: string } | undefined;
        const existingTokens = (deps.persistDeps.container.config.gateway?.tokens ?? [])
          .map((t: { id: string; scopes?: readonly string[] }) => ({ id: t.id, scopes: [...(t.scopes ?? [])] }));
        const rotatedTokens = [...existingTokens.filter((t) => t.id !== id), { id: newId, scopes }];
        const persistResult = await persistToConfig(deps.persistDeps, {
          patch: { gateway: { tokens: rotatedTokens } },
          actionType: "tokens.rotate",
          entityId: `${id} -> ${newId}`,
          actingUser: ctx?.userId ?? (params._agentId as string | undefined),
          traceId: ctx?.traceId ?? (params._traceId as string | undefined),
        });
        if (!persistResult.ok) {
          deps.persistDeps.logger.warn(
            { method: "tokens.rotate", tokenId: `${id} -> ${newId}`, err: persistResult.error, hint: "Token rotated in memory but config persistence failed", errorKind: "config" as const },
            "Token config persistence failed",
          );
        }
      }

      return {
        oldId: id,
        newId,
        newSecret,
        scopes: newEntry.scopes,
        createdAt: newEntry.createdAt,
        message: "Token rotated. Save the new secret now.",
      };
    },
  };
}
