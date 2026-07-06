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
 * It also carries three advisory config lints that never fail validation: an
 * email-shaped `allowFrom` entry surfaces a WARN steering the operator toward the
 * immutable resource id (an email display id is mutable and spoofable); an
 * `"always"` group-activation mode surfaces a WARN naming that Google Chat never
 * delivers unmentioned space messages, so `"always"` is inert on this channel;
 * and, in webhook mode, an `audience` whose SHAPE contradicts `audienceType` (a
 * URL audience declared `project-number`, or a non-URL audience declared
 * `app-url`) surfaces a WARN — that mismatch makes the inbound verifier select
 * the wrong key set and silently reject every request.
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
  /**
   * Which audience shape the webhook verifier expects: `project-number` (a
   * self-signed Chat-system token whose `aud` is the Cloud project number) or
   * `app-url` (a Google OIDC token whose `aud` is the endpoint URL). Linted
   * against the shape of {@link audience}: a contradiction selects the wrong key
   * set and silently rejects every inbound request. Advisory only, webhook mode.
   */
  audienceType?: "project-number" | "app-url";
  /** The configured sender allowlist, linted for mutable email-shaped ids. */
  allowFrom?: string[];
  /**
   * The global group-activation mode. `"always"` is inert on Google Chat — the
   * platform delivers a space message only when the app is mentioned or
   * slash-commanded, so there is no unmentioned traffic for `"always"` to answer.
   * When it is `"always"` an advisory WARN steers the operator to that reality.
   */
  groupActivation?: string;
  /**
   * Optional logger. When present, an email-shaped `allowFrom` entry and an inert
   * `groupActivation` emit advisory WARNs; without it the lints are silent
   * (validation is unaffected either way).
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
 * True when an audience value looks like an endpoint URL (an `app-url` audience)
 * rather than a numeric project number (a `project-number` audience). The two
 * shapes are what the inbound verifier keys its key-set/claim selection on.
 */
function isUrlShapedAudience(audience: string): boolean {
  return /^https?:\/\//i.test(audience.trim());
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
 * @param opts.groupActivation - The global group-activation mode; `"always"` is
 *   linted as inert on Google Chat (advisory, never gated here)
 * @param opts.logger - Optional logger for the advisory allowlist + activation lints
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

  // Advisory audience-shape lint (does not fail validation): in webhook mode the
  // inbound verifier binds to a DIFFERENT key set + claim shape per audienceType —
  // a self-signed Chat-system token whose `aud` is the project number, or a Google
  // OIDC token whose `aud` is the endpoint URL. If the configured audience SHAPE
  // contradicts audienceType the verifier selects the wrong path and silently
  // rejects EVERY inbound request, so surface the mismatch here. Webhook-only:
  // audienceType is inert in pubsub mode. Content-free — the WARN names only the
  // two config keys and the fix, never the audience value. (A blank audience has
  // already failed validation above in webhook mode, so audience is non-blank here.)
  if (
    opts.logger &&
    opts.mode === "webhook" &&
    opts.audienceType &&
    !isBlank(opts.audience)
  ) {
    const urlShaped = isUrlShapedAudience(opts.audience as string);
    if (opts.audienceType === "app-url" && !urlShaped) {
      opts.logger.warn(
        {
          channelType: "googlechat" as const,
          hint: 'channels.googlechat.audienceType is "app-url" but channels.googlechat.audience is not an endpoint URL — set audience to your https:// endpoint URL, or set audienceType to "project-number" if audience is your numeric Cloud project number',
          errorKind: "config" as const,
        },
        "Google Chat audience shape contradicts audienceType",
      );
    } else if (opts.audienceType === "project-number" && urlShaped) {
      opts.logger.warn(
        {
          channelType: "googlechat" as const,
          hint: 'channels.googlechat.audienceType is "project-number" but channels.googlechat.audience looks like an endpoint URL — set audienceType to "app-url" for a URL audience, or set audience to your numeric Cloud project number',
          errorKind: "config" as const,
        },
        "Google Chat audience shape contradicts audienceType",
      );
    }
  }

  // Advisory activation lint (does not fail validation): Google Chat delivers a
  // space MESSAGE event only when the app is mentioned or slash-commanded, so an
  // "always" activation mode never sees the unmentioned traffic it is meant to
  // answer — it is inert here. Content-free: the WARN names only the mode literal.
  if (opts.logger && opts.groupActivation === "always") {
    opts.logger.warn(
      {
        channelType: "googlechat" as const,
        hint: 'Google Chat never delivers unmentioned space messages, so groupActivation "always" is inert here — mentions still activate',
        errorKind: "precondition" as const,
      },
      "Inert groupActivation for Google Chat",
    );
  }

  return ok(undefined);
}
