// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.
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
 * `auth.set` (AuthSetContract, scopes:["admin"]) is the daemon-assisted
 * OAuth-login RPC, authorized by the §8.1 threat-model amendment in
 * DESIGN-credential-storage-modes.md. The CLI runs the OAuth browser/device
 * flow locally, then delegates persistence to this handler so the CLI never
 * imports @comis/memory or opens secrets.db.
 *
 * Reviewers: this file returns OAuth-token-bearing data structurally (the
 * un-projected `OAuthProfile[]` lives in handler closure scope between the
 * `list()` call and the projection). Apply the same residency discipline as
 * core/src/security/SECRET-RPC-CHECKLIST.md -- the `checkSecretResidency`
 * walker scope INCLUDES this file (Rule 1 + Rule 2). Verify before merging
 * any change.
 *
 * Storage: OAuthCredentialStorePort (encrypted secrets.db via AES-256-GCM in
 * encrypted mode; the file-backed selector throws if storage is "encrypted"
 * and no encryptedStore is injected -- this handler is only registered when
 * the daemon has an encrypted store).
 *
 * Uses the `@comis/core` contract registry. Method keys are computed-property
 * names (`[AuthListContract.method]:`) so the bidirectional 1:1 architecture
 * test resolves them through `defineContract({ method, ... })` declarations in
 * `packages/core/src/api-contracts/auth.ts`. The dispatcher-injected `_X`
 * internal fields are stripped via `stripInternalFields` BEFORE
 * `contract.request.parse(...)` — never model internals in the contract
 * schema. The admin trust check reads `rawParams._trustLevel` BEFORE the
 * strip step (the gate stays separate from the contract schema).
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

import { AuthorizationError } from "./errors.js";
import {
  AuthListContract,
  AuthLogoutContract,
  AuthSetContract,
  redactEmailForLog,
  stripInternalFields,
  systemGetEnv,
  systemNowMs,
} from "@comis/core";
import type { OAuthProfile } from "@comis/core";

import type { RpcHandler } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies required by auth handlers.
 *
 * Re-aliased from the cluster slice in api/types.ts. Single source of
 * truth: AuthApiDeps (shared with secrets-handlers + token-handlers). The
 * cluster slice covers auth-handler fields (oauthCredentialStore, container,
 * logger).
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
 * Create the 3 admin-scoped encrypted-OAuth-profile RPC handlers.
 *
 * @param deps Injected dependencies (OAuthCredentialStorePort, AppContainer,
 *   ComisLogger). When `oauthCredentialStore` is undefined the handlers
 *   degrade gracefully: `auth.list` returns an empty array; `auth.logout`
 *   and `auth.set` reject with a config-pointer error.
 * @returns Handler map: `auth.list`, `auth.logout`, `auth.set`.
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
      const startMs = systemNowMs();
      // Admin trust check uses the dispatcher-injected `_trustLevel` —
      // intentionally NOT modeled in the contract schema. Read from
      // rawParams BEFORE the strip-and-parse step.
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new AuthorizationError("Admin access required for auth.list");
      }

      if (!deps.oauthCredentialStore) {
        // No encrypted store configured -- return empty list, not an error.
        // The CLI's encrypted branch should still see a usable response.
        deps.logger.debug(
          {
            method: "auth.list",
            durationMs: systemNowMs() - startMs,
          },
          "auth.list returning empty (no encrypted store configured)",
        );
        const emptyResult = { profiles: [] as RedactedOAuthProfile[] };
        if (systemGetEnv("NODE_ENV") !== "production") {
          AuthListContract.response.parse(emptyResult);
        }
        return emptyResult;
      }

      // Strip dispatcher-injected _X internals BEFORE contract parse,
      // then type-narrow via the contract — `params.provider` becomes
      // `string | undefined` without an `as` cast.
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
            durationMs: systemNowMs() - startMs,
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
          durationMs: systemNowMs() - startMs,
          outcome: "success",
        },
        "OAuth profiles listed",
      );

      const result = { profiles: redacted };
      // Dev-mode residency canary: `response.parse(...)` rejects any
      // accidental access/refresh/accountId fields (they're intentionally
      // absent from RedactedOAuthProfileSchema). Production skips the
      // parse for cold-start budget compliance.
      if (systemGetEnv("NODE_ENV") !== "production") {
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
      const startMs = systemNowMs();
      // Admin gate FIRST (separate from the contract schema).
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new AuthorizationError("Admin access required for auth.logout");
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
          "Encrypted OAuth store not configured (SECRETS_MASTER_KEY missing or security.storage is 'file' or 'env'). " +
            "Run `comis secrets init --write` then restart the daemon, or set security.storage: file in your config.yaml.",
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
          timestamp: systemNowMs(),
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
            durationMs: systemNowMs() - startMs,
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
        timestamp: systemNowMs(),
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
          durationMs: systemNowMs() - startMs,
          outcome: "success",
        },
        "OAuth profile deleted",
      );

      const result = { profileId, deleted: delResult.value };
      if (systemGetEnv("NODE_ENV") !== "production") {
        AuthLogoutContract.response.parse(result);
      }
      return result;
    },

    /**
     * auth.set -- persist a completed OAuthProfile received from the CLI after
     * the OAuth browser/device flow. Admin only. The CLI never opens secrets.db
     * or reads SECRETS_MASTER_KEY — it delegates the write to this handler.
     *
     * Response is token-free: `{ profileId, stored: true }`. Tokens live only
     * inside the encrypted store from this point forward.
     */
    [AuthSetContract.method]: async (rawParams) => {
      const startMs = systemNowMs();
      // 1. Admin gate — read BEFORE stripInternalFields (dispatcher injects _trustLevel).
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new AuthorizationError("Admin access required for auth.set");
      }

      // 2. Guard: store must exist (encrypted mode requires daemon-owned store;
      //    env mode rejects login at CLI level before reaching here).
      if (!deps.oauthCredentialStore) {
        throw new Error(
          "Encrypted OAuth store not configured. Daemon must be running with " +
            "security.storage: encrypted and SECRETS_MASTER_KEY set, " +
            "or set security.storage: file in config.yaml.",
        );
      }

      // 3. Strip dispatcher internals, then contract-parse (type narrowing +
      //    version:1 guard). The parse cannot fail by construction if the CLI
      //    used callTyped(AuthSetContract, ...) correctly.
      const userParams = stripInternalFields(rawParams);
      const params = AuthSetContract.request.parse(userParams);

      // 4. Build OAuthProfile (version pinned to 1 by contract literal guard).
      const profile: OAuthProfile = {
        provider: params.provider,
        profileId: params.profileId,
        access: params.access,
        refresh: params.refresh,
        expires: params.expires,
        accountId: params.accountId,
        email: params.email,
        displayName: params.displayName,
        version: 1,
      };

      // 5. Write through port.
      const writeResult = await deps.oauthCredentialStore.set(
        params.profileId,
        profile,
      );
      if (!writeResult.ok) {
        // Map SQLITE_BUSY to an actionable retryable error hint.
        const isBusy =
          writeResult.error.message.includes("database is locked") ||
          writeResult.error.message.includes("SQLITE_BUSY");
        const hint = isBusy
          ? "secrets.db is temporarily locked; wait a moment and retry the login command"
          : "Check secrets.db integrity and SECRETS_MASTER_KEY availability";
        deps.logger.error(
          {
            method: "auth.set",
            profileId: params.profileId,
            provider: params.provider,
            durationMs: systemNowMs() - startMs,
            outcome: "failure",
            err: writeResult.error,
            hint,
            errorKind: "config" as const,
          },
          "OAuth profile write failed",
        );
        throw new Error(`Failed to persist OAuth profile: ${hint}`);
      }

      // 6. Audit + log — ONLY provider/profileId/redacted-email.
      //    NEVER access, refresh, or accountId (residency requirement).
      deps.container.eventBus.emit("audit:event", {
        timestamp: systemNowMs(),
        agentId: "system",
        tenantId: deps.container.config.tenantId ?? "default",
        actionType: "auth.set",
        kind: "auth_mutation",
        outcome: "success",
        metadata: {
          provider: params.provider,
          profileId: params.profileId,
        },
      });
      // The identity field must NOT embed accountId when email is absent.
      // The residency rule (§6, auth-handlers.ts header) allows only
      // provider/profileId/redacted-email in log output. Using a non-
      // identifying sentinel keeps the log line informative without leaking
      // an account identifier when the OAuth provider returns no email.
      deps.logger.info(
        {
          method: "auth.set",
          provider: params.provider,
          profileId: params.profileId,
          identity:
            redactEmailForLog(params.email) ?? "<email-unavailable>",
          durationMs: systemNowMs() - startMs,
          outcome: "success",
        },
        "OAuth profile stored via daemon RPC",
      );

      // 7. Emit auth:profile_added so in-process subscribers (e.g., the
      //    encrypted-mode OAuthTokenManager cache invalidation wired in
      //    setup-agents-oauth.ts) can react without a daemon restart.
      //    The file-mode watcher emits this event via chokidar; encrypted
      //    mode has no watcher — this RPC handler is the only writer, so
      //    the emission lives here. Payload is metadata-only (no tokens).
      deps.container.eventBus.emit("auth:profile_added", {
        provider: params.provider,
        profileId: params.profileId,
        identity: redactEmailForLog(params.email) ?? "<email-unavailable>",
        source: "external" as const,
        timestamp: systemNowMs(),
      });

      // 8. Token-free response; dev-mode residency canary strips any
      //    accidental token additions (Zod closed schema is defense-in-depth).
      const result = { profileId: params.profileId, stored: true as const };
      if (systemGetEnv("NODE_ENV") !== "production") {
        AuthSetContract.response.parse(result);
      }
      return result;
    },
  };
}
