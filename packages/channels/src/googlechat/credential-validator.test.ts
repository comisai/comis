// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import type { ComisLogger } from "@comis/core";
import { validateGoogleChatCredentials } from "./credential-validator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A vi.fn()-backed logger so a WARN can be asserted without a real Pino impl. */
function makeLogger(): ComisLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    audit: vi.fn(),
    child: vi.fn(),
  } as unknown as ComisLogger;
}

/** A recognizable secret sentinel that must never surface in an error message. */
const PRIVATE_KEY_SENTINEL =
  "-----BEGIN PRIVATE KEY-----\nMIIBVAIBADANBgkqhki-DO-NOT-LEAK-THIS\n-----END PRIVATE KEY-----\n";

/** A well-formed service-account key JSON with both required fields present. */
const VALID_SA_KEY = JSON.stringify({
  client_email: "sa@p.iam.gserviceaccount.com",
  private_key: PRIVATE_KEY_SENTINEL,
});

const VALID_SUBSCRIPTION = "projects/p/subscriptions/s";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("validateGoogleChatCredentials", () => {
  it("returns ok for a well-formed SA key JSON and a non-blank subscriptionName", () => {
    const result = validateGoogleChatCredentials({
      serviceAccountKey: VALID_SA_KEY,
      subscriptionName: VALID_SUBSCRIPTION,
    });
    expect(result.ok).toBe(true);
  });

  it("returns err naming serviceAccountKey when the key is blank", () => {
    const result = validateGoogleChatCredentials({
      serviceAccountKey: "",
      subscriptionName: VALID_SUBSCRIPTION,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("serviceAccountKey");
  });

  it("treats a whitespace-only serviceAccountKey as blank", () => {
    const result = validateGoogleChatCredentials({
      serviceAccountKey: "   ",
      subscriptionName: VALID_SUBSCRIPTION,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("serviceAccountKey");
  });

  it("returns err naming subscriptionName when the subscription is blank (pubsub mode)", () => {
    const result = validateGoogleChatCredentials({
      serviceAccountKey: VALID_SA_KEY,
      subscriptionName: "",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("subscriptionName");
  });

  it("returns err for a serviceAccountKey that is not valid JSON, without echoing the raw value", () => {
    const malformed = `not-json ${PRIVATE_KEY_SENTINEL}`;
    const result = validateGoogleChatCredentials({
      serviceAccountKey: malformed,
      subscriptionName: VALID_SUBSCRIPTION,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The message states a JSON SA key is required (parse failed)...
      expect(result.error.message.toLowerCase()).toContain("json");
      // ...but never echoes the raw string it failed to parse.
      expect(result.error.message).not.toContain(PRIVATE_KEY_SENTINEL);
      expect(result.error.message).not.toContain(malformed);
    }
  });

  it("returns err naming private_key when the SA key JSON is missing private_key", () => {
    // The key carries other sensitive-looking material but omits private_key.
    const keyMissingPrivateKey = JSON.stringify({
      client_email: "sa@p.iam.gserviceaccount.com",
      private_key_id: "SENSITIVE_KEY_ID_MUST_NOT_LEAK",
      project_id: "p",
    });
    const result = validateGoogleChatCredentials({
      serviceAccountKey: keyMissingPrivateKey,
      subscriptionName: VALID_SUBSCRIPTION,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("private_key");
      // CRITICAL secret-safety: the missing-field error must not echo the
      // passed key material (neither the raw blob nor its sensitive fields).
      expect(result.error.message).not.toContain("SENSITIVE_KEY_ID_MUST_NOT_LEAK");
      expect(result.error.message).not.toContain(keyMissingPrivateKey);
    }
  });

  it("returns err naming client_email when the SA key JSON is missing client_email, never echoing the private key", () => {
    // A real private_key is present; only client_email is missing.
    const keyMissingClientEmail = JSON.stringify({ private_key: PRIVATE_KEY_SENTINEL });
    const result = validateGoogleChatCredentials({
      serviceAccountKey: keyMissingClientEmail,
      subscriptionName: VALID_SUBSCRIPTION,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("client_email");
      // The private-key material present in the key never crosses into the error.
      expect(result.error.message).not.toContain(PRIVATE_KEY_SENTINEL);
    }
  });

  it("returns err for a JSON SA key that is not an object (e.g. a bare number)", () => {
    const result = validateGoogleChatCredentials({
      serviceAccountKey: "42",
      subscriptionName: VALID_SUBSCRIPTION,
    });
    expect(result.ok).toBe(false);
  });

  it("emits an advisory WARN naming users/{id} for an email-shaped allowFrom entry, without failing validation", () => {
    const logger = makeLogger();
    const result = validateGoogleChatCredentials({
      serviceAccountKey: VALID_SA_KEY,
      subscriptionName: VALID_SUBSCRIPTION,
      allowFrom: ["someone@example.com"],
      logger,
    });
    // The lint is advisory: an email-shaped id does NOT fail validation.
    expect(result.ok).toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        channelType: "googlechat",
        errorKind: "precondition",
        hint: expect.stringContaining("users/{id}"),
      }),
      expect.any(String),
    );
  });

  it("does NOT WARN for an immutable users/{id} allowFrom entry", () => {
    const logger = makeLogger();
    const result = validateGoogleChatCredentials({
      serviceAccountKey: VALID_SA_KEY,
      subscriptionName: VALID_SUBSCRIPTION,
      allowFrom: ["users/123"],
      logger,
    });
    expect(result.ok).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("does NOT WARN for a spaces/{id} allowFrom entry", () => {
    const logger = makeLogger();
    validateGoogleChatCredentials({
      serviceAccountKey: VALID_SA_KEY,
      subscriptionName: VALID_SUBSCRIPTION,
      allowFrom: ["spaces/AAAAAAAA"],
      logger,
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("does not throw when an email-shaped allowFrom entry is present but no logger is injected", () => {
    const result = validateGoogleChatCredentials({
      serviceAccountKey: VALID_SA_KEY,
      subscriptionName: VALID_SUBSCRIPTION,
      allowFrom: ["someone@example.com"],
    });
    expect(result.ok).toBe(true);
  });
});
