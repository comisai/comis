// SPDX-License-Identifier: Apache-2.0
/**
 * Email credential validation via IMAP connect test.
 *
 * Attempts a temporary IMAP connection to verify credentials are valid.
 * Supports both password and OAuth2 (XOAUTH2) authentication.
 *
 * @module
 */

import { ImapFlow } from "imapflow";
import { ok, type Result } from "@comis/shared";
import { classifiedValidationErr } from "../shared/credential-validation-error.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EmailCredentialOpts {
  imapHost: string;
  imapPort: number;
  secure: boolean;
  auth: { user: string; pass?: string; accessToken?: string };
  /**
   * Optional proxy URL (credential-bearing) for the IMAP connection. ImapFlow
   * connects over raw TCP (with HTTP CONNECT for proxies) and does NOT honor
   * undici's global dispatcher, so the proxy must be passed explicitly —
   * mirrors the adapter's `proxy:` wiring. Without it this connect test goes
   * direct and fails in egress-locked networks even with valid credentials.
   */
  proxyUrl?: string;
}

export interface EmailCredentialInfo {
  user: string;
  serverGreeting?: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate email credentials by attempting an IMAP connection.
 *
 * Creates a temporary ImapFlow client, connects, and immediately logs out.
 * Returns ok with user info on success, err with descriptive message on failure.
 *
 * @param opts - IMAP host, port, security, and auth credentials
 * @returns Result with credential info or error
 */
export async function validateEmailCredentials(
  opts: EmailCredentialOpts,
): Promise<Result<EmailCredentialInfo, Error>> {
  const auth = opts.auth.accessToken
    ? { user: opts.auth.user, accessToken: opts.auth.accessToken }
    : { user: opts.auth.user, pass: opts.auth.pass };

  const client = new ImapFlow({
    host: opts.imapHost,
    port: opts.imapPort,
    secure: opts.secure,
    auth,
    // Disable ImapFlow's built-in logger — we use external logging
    logger: false as never,
    // Route through the egress proxy when configured (parity with the adapter).
    ...(opts.proxyUrl ? { proxy: opts.proxyUrl } : {}),
  });

  try {
    await client.connect();
    await client.logout();
    return ok({ user: opts.auth.user });
  } catch (e) {
    return classifiedValidationErr(
      e,
      `Email credential validation failed for ${opts.auth.user}`,
      `Email IMAP unreachable (network/proxy) for ${opts.auth.user}`,
    );
  }
}
