// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  CredentialValidationError,
  classifyValidationError,
  classifiedValidationErr,
} from "./credential-validation-error.js";

describe("classifyValidationError", () => {
  it.each([
    "Network request for 'getMe' failed!",
    "connect ECONNREFUSED 127.0.0.1:3128",
    "connect ETIMEDOUT 1.2.3.4:443",
    "getaddrinfo ENOTFOUND api.telegram.org",
    "request to https://slack.com/api/auth.test failed, reason: socket hang up",
    "tunneling socket could not be established",
    "unable to verify the first certificate",
    "Connection refused",
  ])("classifies network/transport failure as 'network': %s", (msg) => {
    expect(classifyValidationError(new Error(msg))).toBe("network");
  });

  it.each([
    "Unauthorized",
    "401: invalid token",
    "An API error occurred: invalid_auth",
    "Not Found: bot was not found",
    "403 Forbidden",
  ])("classifies credential rejection as 'auth': %s", (msg) => {
    expect(classifyValidationError(new Error(msg))).toBe("auth");
  });

  it("returns 'unknown' for an unrecognized message", () => {
    expect(classifyValidationError(new Error("something weird happened"))).toBe("unknown");
  });

  it("walks the cause chain (undici/fetch nest the transport error under .cause)", () => {
    const root = new Error("connect ECONNREFUSED 127.0.0.1:3128");
    const wrapped = new Error("fetch failed", { cause: root });
    // even without the network word in the top message, the cause is inspected
    expect(classifyValidationError(wrapped)).toBe("network");
  });

  it("network is checked before auth (a transport failure mentioning a code stays network)", () => {
    expect(classifyValidationError(new Error("ETIMEDOUT while awaiting 401 page"))).toBe("network");
  });
});

describe("classifiedValidationErr", () => {
  it("uses the network prefix and kind for a network failure", () => {
    const r = classifiedValidationErr(
      new Error("connect ETIMEDOUT"),
      "Invalid token",
      "Unreachable (network/proxy)",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(CredentialValidationError);
      expect(r.error.kind).toBe("network");
      expect(r.error.message).toContain("Unreachable (network/proxy)");
      expect(r.error.message).toContain("connect ETIMEDOUT");
    }
  });

  it("uses the auth prefix and kind for a credential rejection", () => {
    const r = classifiedValidationErr(new Error("Unauthorized"), "Invalid token", "Unreachable");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("auth");
      expect(r.error.message).toContain("Invalid token");
    }
  });

  it("preserves the original error as cause", () => {
    const root = new Error("ECONNREFUSED");
    const r = classifiedValidationErr(root, "auth", "net");
    if (!r.ok) {
      expect(r.error.cause).toBe(root);
    }
  });
});
