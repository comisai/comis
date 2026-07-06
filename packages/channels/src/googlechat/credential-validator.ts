// SPDX-License-Identifier: Apache-2.0
/**
 * Google Chat Credential Validator: a fail-fast guard that the service-account
 * key and the per-mode inbound precondition required to register the adapter are
 * present and well-formed.
 *
 * Synchronous, transport-free, and secret-safe. It confirms the per-mode inbound
 * precondition — pubsub mode needs the Pub/Sub subscription; webhook mode needs
 * the inbound-JWT audience, receiving inbound over the gateway ingress rather
 * than a pull loop — and that the key parses into a service-account key JSON
 * carrying the two fields the outbound JWT mint needs (`private_key` and
 * `client_email`), naming any missing field in the error — never the secret
 * value, and never the raw key text on a parse failure. Minting a live token and
 * reaching the subscription are separate operational probes and are
 * intentionally out of scope here; this is parse-only.
 *
 * It also lints the sender allowlist: an email display id is mutable and
 * spoofable, so an email-shaped `allowFrom` entry surfaces an advisory WARN
 * steering the operator toward the immutable resource id. The lint never fails
 * validation.
 *
 * @module
 */

import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import type { ComisLogger } from "@comis/core";

/** Credentials and allowlist required to register the Google Chat adapter. */
export interface GoogleChatValidateOpts {
  /**
   * The resolved service-account key JSON string. Never echoed into an error or
   * a log field — only its parse result and field presence are inspected.
   */
  serviceAccountKey?: string;
  /** The Pub/Sub pull subscription resource name (required in pubsub mode). */
  subscriptionName?: string;
  /**
   * Inbound transport mode. Selects the per-mode precondition: `pubsub` (the
   * default when absent) requires {@link subscriptionName}; `webhook` requires
   * {@link audience} and needs no subscription.
   */
  mode?: "pubsub" | "webhook";
  /**
   * The inbound Bearer-JWT audience the webhook verifier binds to (the project
   * number or the endpoint URL). Required in webhook mode; ignored in pubsub mode.
   */
  audience?: string;
  /** The configured sender allowlist, linted for mutable email-shaped ids. */
  allowFrom?: string[];
  /**
   * Optional logger. When present, an email-shaped `allowFrom` entry emits an
   * advisory WARN; without it the lint is silent (validation is unaffected).
   */
  logger?: ComisLogger;
}

/** A field is missing when it is absent or all-whitespace. */
function isBlank(value: string | undefined): boolean {
  return !value || value.trim() === "";
}

/**
 * True when an allowlist entry looks like a bare email address rather than an
 * immutable resource id. Entries that are already an immutable `users/{id}` or
 * `spaces/{id}` are exempt.
 */
function isEmailShaped(entry: string): boolean {
  if (entry.startsWith("users/") || entry.startsWith("spaces/")) return false;
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(entry);
}

/**
 * Verify the Google Chat service-account key and the per-mode inbound
 * precondition required to register the adapter are present and well-formed,
 * parse-only.
 *
 * @param opts.serviceAccountKey - The service-account key JSON string
 * @param opts.subscriptionName - The Pub/Sub pull subscription resource name (pubsub mode)
 * @param opts.mode - Inbound transport mode; absent is treated as pubsub
 * @param opts.audience - The inbound Bearer-JWT audience (webhook mode)
 * @param opts.allowFrom - The sender allowlist (linted, never gated here)
 * @param opts.logger - Optional logger for the advisory allowlist lint
 * @returns ok when the key parses with the required fields and the per-mode
 *   precondition is met (pubsub → subscriptionName, webhook → audience); err
 *   naming the first missing or malformed field, never its value
 */
export function validateGoogleChatCredentials(
  opts: GoogleChatValidateOpts,
): Result<void, Error> {
  if (isBlank(opts.serviceAccountKey)) {
    return err(
      new Error("Google Chat credentials invalid: serviceAccountKey must not be empty"),
    );
  }
  // Per-mode inbound precondition. Webhook mode receives inbound over the gateway
  // ingress (no pull loop), so it needs no subscription; it instead needs the
  // audience the inbound Bearer-JWT verifier binds to. Failing fast here means an
  // unset audience is a boot config error, never a per-request auth-reject flood
  // at the ingress. An absent mode is treated as pubsub.
  if (opts.mode === "webhook") {
    if (isBlank(opts.audience)) {
      return err(
        new Error(
          "Google Chat credentials invalid: audience must not be empty (webhook mode)",
        ),
      );
    }
  } else if (isBlank(opts.subscriptionName)) {
    return err(
      new Error(
        "Google Chat credentials invalid: subscriptionName must not be empty (pubsub mode)",
      ),
    );
  }

  // Parse the service-account key. A parse failure is caught locally and turned
  // into an error that names the requirement — the raw string is never placed in
  // the message, so no key material can leak through the failure path.
  let parsed: unknown;
  try {
    parsed = JSON.parse(opts.serviceAccountKey as string);
  } catch {
    return err(
      new Error(
        "Google Chat credentials invalid: serviceAccountKey must be a service-account key JSON (parse failed)",
      ),
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    return err(
      new Error(
        "Google Chat credentials invalid: serviceAccountKey must be a service-account key JSON object",
      ),
    );
  }

  // Assert the two fields the outbound JWT mint requires. The error names the
  // missing field only — its value is never read into the message.
  const key = parsed as { private_key?: unknown; client_email?: unknown };
  const privateKey = typeof key.private_key === "string" ? key.private_key : undefined;
  const clientEmail = typeof key.client_email === "string" ? key.client_email : undefined;
  if (isBlank(privateKey)) {
    return err(
      new Error("Google Chat credentials invalid: serviceAccountKey is missing 'private_key'"),
    );
  }
  if (isBlank(clientEmail)) {
    return err(
      new Error("Google Chat credentials invalid: serviceAccountKey is missing 'client_email'"),
    );
  }

  // Advisory allowlist lint (does not fail validation): steer the operator away
  // from mutable, spoofable email display ids toward the immutable resource id.
  if (opts.logger && opts.allowFrom) {
    for (const entry of opts.allowFrom) {
      if (isEmailShaped(entry)) {
        opts.logger.warn(
          {
            channelType: "googlechat" as const,
            hint: "Prefer an immutable users/{id} in channels.googlechat.allowFrom — an email display id is mutable/spoofable",
            errorKind: "precondition" as const,
          },
          "Email-shaped allowFrom entry",
        );
      }
    }
  }

  return ok(undefined);
}
