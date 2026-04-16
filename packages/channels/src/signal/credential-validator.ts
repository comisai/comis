/**
 * Signal Credential Validator: Checks signal-cli daemon health and account registration.
 *
 * Validates that the signal-cli daemon is reachable and optionally verifies
 * that a specific account is registered.
 *
 * @module
 */

import { ok, err, type Result } from "@comis/shared";
import { signalHealthCheck, signalRpcRequest } from "./signal-client.js";
import { createCredentialValidator } from "../shared/credential-validator-factory.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SignalBotInfo {
  /** The phone number registered with Signal */
  phoneNumber: string;
  /** The UUID of the Signal account */
  uuid?: string;
  /** Whether the account is registered */
  registered: boolean;
}

/** Options for Signal connection validation. */
interface SignalValidateOpts {
  baseUrl: string;
  account?: string;
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

/**
 * Validate the Signal connection by checking daemon health and account status.
 *
 * @param opts - Connection options: baseUrl and optional account
 * @returns SignalBotInfo on success, Error on failure
 */
export const validateSignalConnection: (opts: SignalValidateOpts) => Promise<Result<SignalBotInfo, Error>> =
  createCredentialValidator<SignalValidateOpts, SignalBotInfo>({
    platform: "Signal",
    validateInputs: (opts) => {
      if (!opts.baseUrl || opts.baseUrl.trim() === "") {
        return "baseUrl must not be empty";
      }
      return undefined;
    },
    callApi: async (opts) => {
      // Step 1: Health check
      const healthResult = await signalHealthCheck(opts.baseUrl);
      if (!healthResult.ok) {
        return err(healthResult.error);
      }

      // Step 2: If account is specified, verify via listAccounts
      if (opts.account) {
        const accountsResult = await signalRpcRequest("listAccounts", undefined, {
          baseUrl: opts.baseUrl,
        });

        if (!accountsResult.ok) {
          return err(new Error(`Failed to list Signal accounts: ${accountsResult.error.message}`));
        }

        const accounts = accountsResult.value;
        if (Array.isArray(accounts)) {
          const found = accounts.find((acc: Record<string, unknown>) => {
            const number = acc.number ?? acc.phoneNumber ?? acc.account;
            const uuid = acc.uuid;
            return (
              String(number) === opts.account ||
              String(uuid) === opts.account
            );
          });

          if (found) {
            return ok({
              phoneNumber: String(
                (found as Record<string, unknown>).number ??
                  (found as Record<string, unknown>).phoneNumber ??
                  opts.account,
              ),
              uuid: (found as Record<string, unknown>).uuid
                ? String((found as Record<string, unknown>).uuid)
                : undefined,
              registered: true,
            });
          }

          return ok({
            phoneNumber: opts.account,
            registered: false,
          });
        }
      }

      // No account specified -- just health check passed
      return ok({
        phoneNumber: opts.account ?? "unknown",
        registered: true,
      });
    },
  });
