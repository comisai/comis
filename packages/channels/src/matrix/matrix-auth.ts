// SPDX-License-Identifier: Apache-2.0
/**
 * Matrix authentication lifecycle: turn configured credentials into an
 * authenticated client, validated by `whoami`.
 *
 * Two paths, both returning a `Result` (never throwing across the port):
 *  - token: build a client with the access token, then `whoami` to prove the
 *    token is live before the caller starts syncing. The token is the configured
 *    one when set (an explicit operator choice); otherwise the one a prior
 *    password login PERSISTED — reusing it (and its device id) is what lets the
 *    device identity survive a restart instead of minting a fresh device. A
 *    rejected stored token falls back to a password re-login when one is
 *    configured; a token-only deployment with no password is a hard auth error.
 *  - password: build a pre-login client, run the `m.login.password` flow pinning
 *    the persisted device id so the homeserver reuses the same device, and
 *    persist the RETURNED access token + device id so the device identity (and
 *    therefore its E2EE keys) survives a restart — a password re-login on every
 *    boot would mint a fresh device and orphan its keys. Persistence merges onto
 *    the existing durable state so a prior sync token / watermark is preserved;
 *    a blind overwrite would reset the watermark and replay the backlog.
 *
 * Secret safety (T-4): the access token and password are never logged and never
 * embedded in a returned error. Failure branches attach only the secret-safe
 * `errorKind` + `hint` from the shared classifier; the underlying error (which
 * may echo a credential) is classified, not rendered.
 *
 * The `matrix-js-sdk` client is reached through an injected `createClientImpl`
 * seam that defaults to `sdk.createClient`, so the lifecycle is unit-testable
 * without a homeserver.
 *
 * @module
 */

import * as sdk from "matrix-js-sdk";
import type { MatrixClient, ICreateClientOpts } from "matrix-js-sdk";
import type { ComisLogger } from "@comis/core";
import type { Result } from "@comis/shared";
import { ok, err, fromPromise } from "@comis/shared";
import { classifyMatrixError, type MatrixErrorInput } from "./errors.js";
import type { MatrixState, MatrixStateStore } from "./matrix-state.js";

/** The `whoami` response shape (the SDK does not export its interface). */
type WhoamiResponse = Awaited<ReturnType<MatrixClient["whoami"]>>;

/** Inputs the auth lifecycle needs; secrets are resolved to strings upstream. */
export interface MatrixAuthDeps {
  /** Homeserver base URL (SSRF-validated before it reaches here). */
  homeserverUrl: string;
  /** Full MXID; required for password login, optional for token login. */
  userId?: string;
  /** Bot access token (token login). Never logged. */
  accessToken?: string;
  /** Password (password login). Never logged. */
  password?: string;
  /** A device id to pin, when configured. */
  deviceId?: string;
  /** Durable store the password path persists the returned token + device id into. */
  stateStore: MatrixStateStore;
  /** Logger; failure branches emit only secret-safe fields. */
  logger: ComisLogger;
  /** Test seam: defaults to `sdk.createClient` in production. */
  createClientImpl?: typeof sdk.createClient;
}

/** The authenticated client plus the identity `whoami`/login resolved. */
export interface MatrixAuthResult {
  /** The authenticated `matrix-js-sdk` client, ready for the caller to sync. */
  client: MatrixClient;
  /** The resolved full MXID. */
  userId: string;
  /** The resolved device id, when the homeserver reported one. */
  deviceId?: string;
  /**
   * The access token this result authenticated with. The caller persists it (a
   * password login mints a fresh one) so the next boot reuses it via the token
   * path rather than re-logging in and minting a fresh device.
   */
  accessToken?: string;
}

/** Fresh credentials a password re-login yields for the token-expiry seam. */
export interface MatrixReauthCredentials {
  /** The freshly minted access token — applied to the live client + persisted. */
  accessToken: string;
  /** The device id the re-login resolved (reused so the identity is preserved). */
  deviceId?: string;
}

/** The auth lifecycle handle. */
export interface MatrixAuth {
  /** Authenticate via the configured token or password; validate with whoami. */
  authenticate(): Promise<Result<MatrixAuthResult, Error>>;
  /**
   * Re-run the password login to mint a fresh token (pinning the same device
   * id), for the mid-run token-expiry recovery seam. Errs when no password is
   * configured — the caller then keeps the loud-health path instead.
   */
  reauthenticate(): Promise<Result<MatrixReauthCredentials, Error>>;
}

/** Extract the classifier's normalized fields from a thrown SDK error. */
function toMatrixErrorInput(cause: unknown): MatrixErrorInput {
  const e = cause as { errcode?: unknown; httpStatus?: unknown } | null;
  const input: MatrixErrorInput = { cause };
  if (e !== null && typeof e.errcode === "string") input.errcode = e.errcode;
  if (e !== null && typeof e.httpStatus === "number") input.status = e.httpStatus;
  return input;
}

/** Build create-client options without setting undefined optionals. */
function buildCreateOpts(
  deps: MatrixAuthDeps,
  accessToken: string | undefined,
  deviceId: string | undefined,
): ICreateClientOpts {
  const opts: ICreateClientOpts = { baseUrl: deps.homeserverUrl };
  if (deps.userId !== undefined) opts.userId = deps.userId;
  if (deviceId !== undefined) opts.deviceId = deviceId;
  if (accessToken !== undefined) opts.accessToken = accessToken;
  return opts;
}

/**
 * Create the Matrix auth lifecycle.
 *
 * @param deps - Credentials, the state store, a logger, and the client seam.
 * @returns A handle whose `authenticate()` yields a validated client.
 */
export function createMatrixAuth(deps: MatrixAuthDeps): MatrixAuth {
  const createClientImpl = deps.createClientImpl ?? sdk.createClient;
  const log = deps.logger;

  /** Run `whoami`; classify + log (secret-safe) on failure. */
  async function validateWithWhoami(
    client: MatrixClient,
    context: string,
  ): Promise<Result<WhoamiResponse, Error>> {
    const res = await fromPromise(client.whoami());
    if (!res.ok) {
      const classified = classifyMatrixError(toMatrixErrorInput(res.error));
      log.warn(
        { channelType: "matrix", errorKind: classified.errorKind, hint: classified.hint },
        context,
      );
      return err(new Error(`${context}: ${classified.hint}`));
    }
    return ok(res.value);
  }

  /**
   * Token path: build a client with `accessToken` (pinning `deviceId`), then
   * `whoami`-validate before the caller syncs. Returns the token on the result
   * so the caller can persist it for the next boot.
   */
  async function authenticateWithToken(
    accessToken: string,
    deviceId: string | undefined,
  ): Promise<Result<MatrixAuthResult, Error>> {
    const client = createClientImpl(buildCreateOpts(deps, accessToken, deviceId));
    const who = await validateWithWhoami(client, "Matrix token validation failed");
    if (!who.ok) return err(who.error);

    const resolvedUserId = who.value.user_id.length > 0 ? who.value.user_id : deps.userId;
    if (resolvedUserId === undefined || resolvedUserId.length === 0) {
      return err(new Error("Matrix token login could not resolve a user id from whoami"));
    }
    const result: MatrixAuthResult = { client, userId: resolvedUserId, accessToken };
    const resolvedDeviceId = who.value.device_id ?? deviceId;
    if (resolvedDeviceId !== undefined) result.deviceId = resolvedDeviceId;
    return ok(result);
  }

  /**
   * Password path: build a pre-login client, run `m.login.password` pinning
   * `deviceId` so the homeserver reuses the same device, persist the returned
   * token + device id (merged onto prior state), then `whoami`-validate.
   */
  async function runPasswordLogin(
    password: string,
    deviceId: string | undefined,
    persistedState: MatrixState | undefined,
  ): Promise<Result<MatrixAuthResult, Error>> {
    if (deps.userId === undefined || deps.userId.length === 0) {
      return err(new Error("Matrix password login requires a userId"));
    }
    const client = createClientImpl(buildCreateOpts(deps, undefined, deviceId));
    const loginData = {
      user: deps.userId,
      password,
      ...(deviceId !== undefined ? { device_id: deviceId } : {}),
    };
    const loginRes = await fromPromise(client.login("m.login.password", loginData));
    if (!loginRes.ok) {
      const classified = classifyMatrixError(toMatrixErrorInput(loginRes.error));
      log.warn(
        { channelType: "matrix", errorKind: classified.errorKind, hint: classified.hint },
        "Matrix password login failed",
      );
      return err(new Error(`Matrix password login failed: ${classified.hint}`));
    }
    const { access_token, device_id, user_id } = loginRes.value;

    // Persist the returned token + device id so the device identity survives a
    // restart. Merge onto existing state so a prior sync token / watermark is
    // preserved — a blind overwrite would reset the watermark → replay.
    const base: MatrixState = persistedState ?? { watermarks: {} };
    const saved = await deps.stateStore.save({
      ...base,
      accessToken: access_token,
      deviceId: device_id,
    });
    if (!saved.ok) return err(saved.error);

    const who = await validateWithWhoami(client, "Matrix credential validation failed");
    if (!who.ok) return err(who.error);

    const result: MatrixAuthResult = { client, userId: user_id, accessToken: access_token };
    if (device_id !== undefined) result.deviceId = device_id;
    return ok(result);
  }

  return {
    async authenticate(): Promise<Result<MatrixAuthResult, Error>> {
      // Load persisted identity FIRST: a token minted by a prior password login
      // is reused (with its device id) so the E2EE device identity survives a
      // restart, instead of re-running password login and minting a fresh device.
      const persisted = await deps.stateStore.load();
      const persistedState = persisted.ok ? persisted.value : undefined;
      const hasPassword = deps.password !== undefined && deps.password.length > 0;
      // The device id to pin: an operator-configured one wins; else the one a
      // prior login persisted, so a re-login reuses the same device.
      const effectiveDeviceId = deps.deviceId ?? persistedState?.deviceId;

      // Token path: a configured token wins (explicit operator choice); else the
      // token a prior password login persisted (device-identity reuse).
      const configToken =
        deps.accessToken !== undefined && deps.accessToken.length > 0 ? deps.accessToken : undefined;
      const persistedToken =
        persistedState?.accessToken !== undefined && persistedState.accessToken.length > 0
          ? persistedState.accessToken
          : undefined;
      const tokenToTry = configToken ?? persistedToken;

      if (tokenToTry !== undefined) {
        const viaToken = await authenticateWithToken(tokenToTry, effectiveDeviceId);
        if (viaToken.ok) return viaToken;
        // A rejected token is a hard auth error UNLESS a password is configured,
        // in which case recover by re-logging in (reusing the persisted device).
        if (!hasPassword) return viaToken;
        log.info(
          {
            channelType: "matrix",
            errorKind: "auth" as const,
            hint: "The stored Matrix access token was rejected; re-logging in with the configured password to mint a fresh token for the same device",
          },
          "Matrix stored access token rejected: falling back to password login",
        );
      }

      // Password path: first boot, or a rejected stored token with a password set.
      if (deps.password !== undefined && deps.password.length > 0) {
        return runPasswordLogin(deps.password, effectiveDeviceId, persistedState);
      }

      return err(new Error("Matrix authentication requires an access token or a password"));
    },

    async reauthenticate(): Promise<Result<MatrixReauthCredentials, Error>> {
      // Only a password can mint a fresh token mid-run; a token-only deployment
      // has nothing to re-login with (the caller keeps the loud-health path).
      if (deps.password === undefined || deps.password.length === 0) {
        return err(new Error("Matrix re-authentication requires a configured password"));
      }
      const persisted = await deps.stateStore.load();
      const persistedState = persisted.ok ? persisted.value : undefined;
      // Reuse the same device id so the E2EE identity is preserved across the
      // re-login (the whole point of persisting it in the first place).
      const deviceId = deps.deviceId ?? persistedState?.deviceId;
      const relogin = await runPasswordLogin(deps.password, deviceId, persistedState);
      if (!relogin.ok) return err(relogin.error);
      const { accessToken, deviceId: reloginDeviceId } = relogin.value;
      if (accessToken === undefined) {
        return err(new Error("Matrix re-login did not return an access token"));
      }
      const creds: MatrixReauthCredentials = { accessToken };
      if (reloginDeviceId !== undefined) creds.deviceId = reloginDeviceId;
      return ok(creds);
    },
  };
}
