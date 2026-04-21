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
import { ok, err, type Result } from "@comis/shared";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EmailCredentialOpts {
  imapHost: string;
  imapPort: number;
  secure: boolean;
  auth: { user: string; pass?: string; accessToken?: string };
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
  });

  try {
    await client.connect();
    await client.logout();
    return ok({ user: opts.auth.user });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(
      new Error(
        `Email credential validation failed for ${opts.auth.user}: ${message}`,
      ),
    );
  }
}
