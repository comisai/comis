// SPDX-License-Identifier: Apache-2.0
/**
 * Matrix authentication lifecycle: turn configured credentials into an
 * authenticated client, validated by `whoami`.
 *
 * Two paths, both returning a `Result` (never throwing across the port):
 *  - token: build a client with the configured access token, then `whoami` to
 *    prove the token is live before the caller starts syncing.
 *  - password: build a pre-login client, run the `m.login.password` flow, and
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
}

/** The auth lifecycle handle. */
export interface MatrixAuth {
  /** Authenticate via the configured token or password; validate with whoami. */
  authenticate(): Promise<Result<MatrixAuthResult, Error>>;
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
function buildCreateOpts(deps: MatrixAuthDeps, accessToken: string | undefined): ICreateClientOpts {
  const opts: ICreateClientOpts = { baseUrl: deps.homeserverUrl };
  if (deps.userId !== undefined) opts.userId = deps.userId;
  if (deps.deviceId !== undefined) opts.deviceId = deps.deviceId;
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

  return {
    async authenticate(): Promise<Result<MatrixAuthResult, Error>> {
      // --- Token path: an access token is configured. ---
      if (deps.accessToken !== undefined && deps.accessToken.length > 0) {
        const client = createClientImpl(buildCreateOpts(deps, deps.accessToken));
        const who = await validateWithWhoami(client, "Matrix token validation failed");
        if (!who.ok) return err(who.error);

        const resolvedUserId = who.value.user_id.length > 0 ? who.value.user_id : deps.userId;
        if (resolvedUserId === undefined || resolvedUserId.length === 0) {
          return err(new Error("Matrix token login could not resolve a user id from whoami"));
        }
        const result: MatrixAuthResult = { client, userId: resolvedUserId };
        const resolvedDeviceId = who.value.device_id ?? deps.deviceId;
        if (resolvedDeviceId !== undefined) result.deviceId = resolvedDeviceId;
        return ok(result);
      }

      // --- Password path: no token, a password is configured. ---
      if (deps.password !== undefined && deps.password.length > 0) {
        if (deps.userId === undefined || deps.userId.length === 0) {
          return err(new Error("Matrix password login requires a userId"));
        }
        const client = createClientImpl(buildCreateOpts(deps, undefined));
        const loginData = {
          user: deps.userId,
          password: deps.password,
          ...(deps.deviceId !== undefined ? { device_id: deps.deviceId } : {}),
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

        // Persist the returned token + device id so the device identity survives
        // a restart. Merge onto existing state so a prior sync token / watermark
        // is preserved — a blind overwrite would reset the watermark → replay.
        const existing = await deps.stateStore.load();
        const base: MatrixState = existing.ok ? existing.value : { watermarks: {} };
        const saved = await deps.stateStore.save({
          ...base,
          accessToken: access_token,
          deviceId: device_id,
        });
        if (!saved.ok) return err(saved.error);

        const who = await validateWithWhoami(client, "Matrix credential validation failed");
        if (!who.ok) return err(who.error);

        return ok({ client, userId: user_id, deviceId: device_id });
      }

      return err(new Error("Matrix authentication requires an access token or a password"));
    },
  };
}
