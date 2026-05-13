// SPDX-License-Identifier: Apache-2.0
/**
 * Encrypted OAuth-profile management RPC handlers.
 *
 * Provides:
 *   - `auth.list`     -- list stored OAuth profiles (admin-only). Returns PROFILE
 *                        METADATA ONLY -- `access`, `refresh`, and `accountId`
 *                        are stripped before serialization. The plaintext OAuth
 *                        tokens NEVER cross the daemon -> CLI boundary.
 *   - `auth.logout`   -- delete a stored profile (admin-only, audited).
 *
 * NOTE: there is intentionally NO `auth.status` daemon RPC method. The CLI
 * computes status locally (active/expired) by calling `profileStatus(expires)`
 * on each returned profile -- the OAuthCredentialStorePort surface has no
 * "active profile" concept (see
 * packages/core/src/ports/oauth-credential-store.ts lines 46-52).
 *
 * NOTE: there is intentionally NO `auth.login` daemon RPC method either.
 * Daemon-assisted OAuth login is out of scope for Phase 31 per design §8.2.7
 * (would require its own threat-model amendment).
 *
 * Reviewers: this file returns OAuth-token-bearing data structurally (the
 * un-projected `OAuthProfile[]` lives in handler closure scope between the
 * `list()` call and the projection). Apply the same residency discipline as
 * core/src/security/SECRET-RPC-CHECKLIST.md -- plan 31-08's
 * `checkSecretResidency` walker scope INCLUDES this file (Rule 1 + Rule 2).
 * Verify before merging any change.
 *
 * Storage: OAuthCredentialStorePort (encrypted secrets.db via AES-256-GCM in
 * encrypted mode; the file-backed selector throws if storage is "encrypted"
 * and no encryptedStore is injected -- this handler is only registered when
 * the daemon has an encrypted store).
 *
 * Phase 35 Wave C (Plan 35-07): refactored to use the `@comis/core`
 * contract registry. Method keys are computed-property names
 * (`[AuthListContract.method]:`) so the bidirectional 1:1 architecture
 * test resolves them through `defineContract({ method, ... })`
 * declarations in `packages/core/src/api-contracts/auth.ts`. The
 * dispatcher-injected `_X` internal fields are stripped via
 * `stripInternalFields` BEFORE `contract.request.parse(...)` (D-04
 * pitfall 6 — never model internals in the contract schema). The admin
 * trust check reads `rawParams._trustLevel` BEFORE the strip step (the
 * gate stays separate from the contract schema per D-04).
 *
 * The bespoke pre-Zod validation (admin gate, profileId presence guard,
 * config-pointer error for no-encrypted-store) is intentionally retained
 * for user-friendly error UX. The contract parse runs AFTER and serves
 * to (a) narrow params types for the rest of the handler body and
 * (b) provide a defense-in-depth gate against future drift between
 * the contract schema and the bespoke checks. The dev-mode
 * `Contract.response.parse(...)` gate before each return doubles as a
 * residency canary — if a future change accidentally leaks `access` /
 * `refresh` / `accountId` into the response shape, the parse fails
 * because those keys are intentionally absent from the contract schema.
 *
 * @module
 */

import {
  AuthListContract,
  AuthLogoutContract,
  stripInternalFields,
} from "@comis/core";
import type { OAuthProfile } from "@comis/core";

import type { RpcHandler } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies required by auth handlers.
 *
 * Re-aliased from the cluster slice in api/types.ts (Plan 34-08a; alias retarget
 * in Plan 34-08c). Single source of truth: AuthApiDeps (shared with
 * secrets-handlers + token-handlers). The cluster slice was widened in 34-08c
 * to cover auth-handler fields (oauthCredentialStore, container, logger).
 * DAEMON-API-03 Option A retarget — handler body unchanged.
 */
import type { AuthApiDeps as AuthHandlerDeps } from "./types.js";
export type { AuthHandlerDeps };

/** Token-free projection of OAuthProfile suitable for RPC return. */
interface RedactedOAuthProfile {
  provider: string;
  profileId: string;
  expires: number;
  email?: string;
  displayName?: string;
  // Explicitly omitted: access, refresh, accountId.
}

// ---------------------------------------------------------------------------
// Token-stripping projection
// ---------------------------------------------------------------------------

/**
 * Project an OAuthProfile to a token-free shape. The handler returns ONLY
 * these fields across the daemon -> CLI boundary.
 *
 * The function takes a SINGLE profile and returns a NEW object -- no spread
 * of the source, no closure escape. The full OAuthProfile is discarded
 * immediately after this call returns.
 */
function redactProfileForRpc(p: OAuthProfile): RedactedOAuthProfile {
  const out: RedactedOAuthProfile = {
    provider: p.provider,
    profileId: p.profileId,
    expires: p.expires,
  };
  if (p.email !== undefined) out.email = p.email;
  if (p.displayName !== undefined) out.displayName = p.displayName;
  return out;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the 2 admin-scoped encrypted-OAuth-profile RPC handlers.
 *
 * @param deps Injected dependencies (OAuthCredentialStorePort, AppContainer,
 *   ComisLogger). When `oauthCredentialStore` is undefined the handlers
 *   degrade gracefully: `auth.list` returns an empty array; `auth.logout`
 *   rejects with a config-pointer error.
 * @returns Handler map: `auth.list`, `auth.logout`.
 */
export function createAuthHandlers(
  deps: AuthHandlerDeps,
): Record<string, RpcHandler> {
  return {
    /**
     * auth.list -- enumerate OAuth profile metadata (provider + profileId +
     * expires + optional email/displayName). Admin only.
     *
     * The handler PROJECTS the un-projected OAuthProfile[] returned by the
     * port through `redactProfileForRpc` BEFORE serializing -- access,
     * refresh, and accountId are stripped from every row. The un-projected
     * array lives in handler closure scope between the `list()` call and
     * the projection; it does not escape via logger, audit event, or any
     * other binding.
     */
    [AuthListContract.method]: async (rawParams) => {
      const startMs = Date.now();
      // Admin trust check uses the dispatcher-injected `_trustLevel` —
      // intentionally NOT modeled in the contract schema (D-04). Read
      // from rawParams BEFORE the strip-and-parse step.
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for auth.list");
      }

      if (!deps.oauthCredentialStore) {
        // No encrypted store configured -- return empty list, not an error.
        // The CLI's encrypted branch should still see a usable response.
        deps.logger.debug(
          {
            method: "auth.list",
            durationMs: Date.now() - startMs,
          },
          "auth.list returning empty (no encrypted store configured)",
        );
        const emptyResult = { profiles: [] as RedactedOAuthProfile[] };
        // eslint-disable-next-line no-restricted-syntax -- D-10 LOCKED: dev-mode response validation gate; daemon side is the trust boundary.
        if (process.env.NODE_ENV !== "production") {
          AuthListContract.response.parse(emptyResult);
        }
        return emptyResult;
      }

      // Strip dispatcher-injected _X internals BEFORE contract parse
      // (D-04 + 35-RESEARCH.md Pitfall 6). Then type-narrow via the
      // contract — `params.provider` becomes `string | undefined` without
      // an `as` cast.
      const userParams = stripInternalFields(rawParams);
      const params = AuthListContract.request.parse(userParams);

      const filter =
        typeof params.provider === "string" && params.provider.length > 0
          ? { provider: params.provider }
          : undefined;

      const listResult = await deps.oauthCredentialStore.list(filter);
      if (!listResult.ok) {
        deps.logger.error(
          {
            method: "auth.list",
            durationMs: Date.now() - startMs,
            outcome: "failure",
            err: listResult.error,
            hint: "Check encrypted auth store (secrets.db) integrity and master key",
            errorKind: "config" as const,
          },
          "OAuth profile list failed",
        );
        throw new Error("Failed to list OAuth profiles");
      }

      // PROJECT to token-free shape -- STRIP access/refresh/accountId from
      // every row. This is the SOLE return path; the un-projected
      // OAuthProfile[] does not escape past this line.
      const redacted: RedactedOAuthProfile[] = listResult.value.map(
        redactProfileForRpc,
      );

      deps.logger.info(
        {
          method: "auth.list",
          count: redacted.length,
          durationMs: Date.now() - startMs,
          outcome: "success",
        },
        "OAuth profiles listed",
      );

      const result = { profiles: redacted };
      // Dev-mode residency canary: `response.parse(...)` rejects any
      // accidental access/refresh/accountId fields (they're intentionally
      // absent from RedactedOAuthProfileSchema). Production skips the
      // parse for cold-start budget compliance (WEB-CONTRACTS-17).
      // eslint-disable-next-line no-restricted-syntax -- D-10 LOCKED: dev-mode response validation gate; daemon side is the trust boundary.
      if (process.env.NODE_ENV !== "production") {
        AuthListContract.response.parse(result);
      }
      return result;
    },

    /**
     * auth.logout -- remove a stored OAuth profile by profileId.
     * Admin only. Emits a destructive audit event regardless of outcome
     * (success/failure).
     */
    [AuthLogoutContract.method]: async (rawParams) => {
      const startMs = Date.now();
      // Admin gate FIRST (separate from the contract schema per D-04).
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for auth.logout");
      }

      // Bespoke profileId guard runs BEFORE the contract parse so the
      // user-facing error message stays
      // `"Missing required parameter: profileId"` (legacy UX). The
      // contract's `z.string().min(1)` would otherwise raise a Zod
      // message that is noisier and less actionable for operators.
      const profileIdRaw = rawParams.profileId as string | undefined;
      if (!profileIdRaw || typeof profileIdRaw !== "string") {
        throw new Error("Missing required parameter: profileId");
      }

      if (!deps.oauthCredentialStore) {
        throw new Error(
          "Encrypted OAuth store not configured (SECRETS_MASTER_KEY missing or oauth.storage is 'file'). " +
            "Run `comis secrets init --write` then restart the daemon, or switch oauth.storage to 'file'.",
        );
      }

      // Strip dispatcher-injected _X internals + contract-parse for
      // type narrowing (defense-in-depth — the bespoke guard above
      // already ensures profileId is a non-empty string, so this parse
      // cannot fail by construction).
      const userParams = stripInternalFields(rawParams);
      const params = AuthLogoutContract.request.parse(userParams);
      const profileId = params.profileId;

      const delResult = await deps.oauthCredentialStore.delete(profileId);
      if (!delResult.ok) {
        deps.container.eventBus.emit("audit:event", {
          timestamp: Date.now(),
          agentId: "system",
          tenantId: deps.container.config.tenantId ?? "default",
          actionType: "auth.logout",
          classification: "destructive",
          outcome: "failure",
          metadata: { profileId, error: "delete_failed" },
        });
        deps.logger.error(
          {
            method: "auth.logout",
            profileId,
            durationMs: Date.now() - startMs,
            outcome: "failure",
            err: delResult.error,
            hint: "Check encrypted auth store (secrets.db) permissions",
            errorKind: "config" as const,
          },
          "OAuth profile delete failed",
        );
        throw new Error(`Failed to delete OAuth profile "${profileId}"`);
      }

      deps.container.eventBus.emit("audit:event", {
        timestamp: Date.now(),
        agentId: "system",
        tenantId: deps.container.config.tenantId ?? "default",
        actionType: "auth.logout",
        classification: "destructive",
        outcome: "success",
        metadata: { profileId, existed: delResult.value },
      });
      deps.logger.info(
        {
          method: "auth.logout",
          profileId,
          existed: delResult.value,
          durationMs: Date.now() - startMs,
          outcome: "success",
        },
        "OAuth profile deleted",
      );

      const result = { profileId, deleted: delResult.value };
      // eslint-disable-next-line no-restricted-syntax -- D-10 LOCKED: dev-mode response validation gate; daemon side is the trust boundary.
      if (process.env.NODE_ENV !== "production") {
        AuthLogoutContract.response.parse(result);
      }
      return result;
    },
  };
}
