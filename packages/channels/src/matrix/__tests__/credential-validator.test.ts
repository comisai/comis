// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ok, err } from "@comis/shared";
import type { ComisLogger, ValidatedUrl } from "@comis/core";

// Mock only `validateUrl` so the default-path delegation is deterministic (no
// real DNS lookup of a public host). `CLOUD_METADATA_IPS` is kept REAL via
// importOriginal so the opt-in metadata block is proven against the actual
// exported blocklist, not a stub.
vi.mock("@comis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/core")>();
  return { ...actual, validateUrl: vi.fn() };
});

import { validateUrl } from "@comis/core";
import {
  validateHomeserverUrl,
  validateMatrixCredentials,
} from "../credential-validator.js";

const mockValidateUrl = vi.mocked(validateUrl);

/** A ValidatedUrl stand-in for the mocked default-path success. */
function makeValidatedUrl(urlString: string): ValidatedUrl {
  const url = new URL(urlString);
  return { hostname: url.hostname, ip: "203.0.113.10", url };
}

/** Minimal logger exposing the single method the SUT calls (`warn`). */
function makeLogger(): ComisLogger {
  return { warn: vi.fn() } as unknown as ComisLogger;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("validateHomeserverUrl", () => {
  it("delegates a public https homeserver to the core guard and returns ok without warning", async () => {
    mockValidateUrl.mockResolvedValue(ok(makeValidatedUrl("https://matrix.org")));
    const logger = makeLogger();

    const result = await validateHomeserverUrl("https://matrix.org", false, logger);

    expect(result.ok).toBe(true);
    expect(mockValidateUrl).toHaveBeenCalledWith("https://matrix.org");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("blocks a loopback homeserver by default (allowPrivateHomeserver false) via the core guard", async () => {
    mockValidateUrl.mockResolvedValue(
      err(new Error("Blocked: resolved IP 127.0.0.1 is in loopback range")),
    );
    const logger = makeLogger();

    const result = await validateHomeserverUrl("http://127.0.0.1:8008", false, logger);

    expect(result.ok).toBe(false);
    expect(mockValidateUrl).toHaveBeenCalledWith("http://127.0.0.1:8008");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("blocks a private-range homeserver by default (allowPrivateHomeserver false) via the core guard", async () => {
    mockValidateUrl.mockResolvedValue(
      err(new Error("Blocked: resolved IP 10.0.0.5 is in private range")),
    );
    const logger = makeLogger();

    const result = await validateHomeserverUrl("http://10.0.0.5", false, logger);

    expect(result.ok).toBe(false);
    expect(mockValidateUrl).toHaveBeenCalledWith("http://10.0.0.5");
  });

  it("permits a loopback homeserver when allowPrivateHomeserver is enabled and logs a loud config-posture warning", async () => {
    const logger = makeLogger();

    const result = await validateHomeserverUrl("http://127.0.0.1:8008", true, logger);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ip).toBe("127.0.0.1");
    }
    // The opt-in path does NOT delegate to the strict guard — it does its own
    // structured checks and reuses the exported metadata blocklist.
    expect(mockValidateUrl).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [fields] = vi.mocked(logger.warn).mock.calls[0];
    expect(fields).toMatchObject({ channelType: "matrix", errorKind: "config" });
    expect(typeof (fields as { hint?: unknown }).hint).toBe("string");
    // The loud warning names the exact config knob that relaxed the check.
    expect((fields as { hint: string }).hint).toContain("allowPrivateHomeserver");
  });

  it("ALWAYS blocks a cloud-metadata homeserver even when allowPrivateHomeserver is enabled", async () => {
    // allowPrivateHomeserver relaxes ONLY the private/loopback range —
    // 169.254.169.254 (cloud metadata) must stay blocked, or a self-hosted
    // opt-in becomes an SSRF hole into the instance metadata service.
    const logger = makeLogger();

    const result = await validateHomeserverUrl(
      "http://169.254.169.254/latest/meta-data",
      true,
      logger,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("metadata");
    }
    // A metadata block is not a permitted relaxation, so no opt-in warning fires.
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("rejects a non-http(s) scheme even on the allowPrivateHomeserver opt-in path", async () => {
    const logger = makeLogger();

    const result = await validateHomeserverUrl("ftp://matrix.org", true, logger);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("protocol");
    }
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("validateMatrixCredentials", () => {
  const HS = "https://matrix.org";

  it("returns ok for a valid homeserverUrl + accessToken combination", () => {
    const result = validateMatrixCredentials({ homeserverUrl: HS, accessToken: "syt_valid_token" });
    expect(result.ok).toBe(true);
  });

  it("returns ok for a valid homeserverUrl + password + userId combination", () => {
    const result = validateMatrixCredentials({
      homeserverUrl: HS,
      password: "a-password",
      userId: "@bot:matrix.org",
    });
    expect(result.ok).toBe(true);
  });

  it("returns err naming homeserverUrl when the homeserver URL is missing", () => {
    const result = validateMatrixCredentials({ accessToken: "syt_valid_token" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("homeserverUrl");
  });

  it("returns err naming both credential fields when neither accessToken nor password is present", () => {
    const result = validateMatrixCredentials({ homeserverUrl: HS });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("accessToken");
      expect(result.error.message).toContain("password");
    }
  });

  it("returns err naming userId when a password is given without a userId", () => {
    const result = validateMatrixCredentials({ homeserverUrl: HS, password: "a-password" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("userId");
  });

  it("treats a whitespace-only homeserverUrl as empty and errs", () => {
    const result = validateMatrixCredentials({ homeserverUrl: "   ", accessToken: "syt_valid_token" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("homeserverUrl");
  });

  it("never echoes the supplied access-token value into any error message", () => {
    const secret = "syt_super_secret_access_token_value";
    // A token is present, but an unrelated field (homeserverUrl) is missing.
    const result = validateMatrixCredentials({ homeserverUrl: "", accessToken: secret });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).not.toContain(secret);
  });

  it("never echoes the supplied password value into any error message", () => {
    const secret = "correct-horse-battery-staple";
    // Password present, userId missing → the error names userId, not the secret.
    const result = validateMatrixCredentials({ homeserverUrl: HS, password: secret });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).not.toContain(secret);
  });
});
