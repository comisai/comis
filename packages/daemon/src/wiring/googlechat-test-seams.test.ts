// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the OFF-BY-DEFAULT Google Chat inbound-verify wiring seam.
 *
 * `resolveTestGoogleChatVerifier` builds the `validateInboundJwt` closure the
 * gateway ingress consumes. It is gated on `COMIS_GOOGLECHAT_TEST_JWKS`, which is
 * UNSET in production — with the env unset the daemon behaves byte-identically to
 * today (the live remote-JWKS verifier). When the env names a JWKS file the seam
 * swaps in a LOCAL-JWKS verifier that STILL fully verifies (signature + issuer +
 * audience, plus the app-url sender-binding email claim) — it only changes the
 * key source, never relaxes a control, so it is never an auth bypass. Env is read
 * through the injected getter (never the ambient process environment); the file
 * is read through an injected `readFileImpl`.
 *
 * @module
 */

import { generateKeyPairSync, createSign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ComisLogger } from "@comis/core";
import { resolveTestGoogleChatVerifier } from "./googlechat-test-seams.js";

/** The issuer of a project-number Chat-system event token. */
const CHAT_SYSTEM_ISSUER = "chat@system.gserviceaccount.com";
/** Google's OIDC issuer for an app-url ID token. */
const GOOGLE_OIDC_ISSUER = "https://accounts.google.com";
/** The sender-binding email an app-url token must carry to prove the Chat system. */
const CHAT_SYSTEM_EMAIL = "chat@system.gserviceaccount.com";

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

/** A ComisLogger whose warn spy records every argument for content-free asserts. */
function makeLoggerSpy(): {
  logger: ComisLogger;
  warn: ReturnType<typeof vi.fn>;
  serialized: () => string;
} {
  const warn = vi.fn();
  const noop = vi.fn();
  const logger = {
    level: "debug",
    trace: noop,
    debug: noop,
    info: noop,
    warn,
    error: noop,
    fatal: noop,
    audit: noop,
    child: vi.fn().mockReturnThis(),
  } as unknown as ComisLogger;
  const serialized = (): string => JSON.stringify(warn.mock.calls);
  return { logger, warn, serialized };
}

/**
 * Generate an RS256 keypair with node:crypto (no jose dep in the daemon package),
 * serialize its public JWKS, and return a minter that signs an arbitrary claim
 * set. The token is exactly what jose's jwtVerify (RS256) accepts, so the
 * @comis/channels local-JWKS verifier verifies it offline.
 */
function makeJwks(): {
  jwksJson: string;
  jwkModulus: string;
  mint: (claims: Record<string, unknown>) => string;
} {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  jwk.kid = "gc-seam-1";
  jwk.alg = "RS256";
  jwk.use = "sig";
  const jwksJson = JSON.stringify({ keys: [jwk] });
  const mint = (claims: Record<string, unknown>): string => {
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(
      JSON.stringify({ alg: "RS256", typ: "JWT", kid: "gc-seam-1" }),
    );
    const payload = b64url(
      JSON.stringify({ iat: now, exp: now + 300, ...claims }),
    );
    const signingInput = `${header}.${payload}`;
    const sig = createSign("RSA-SHA256").update(signingInput).sign(privateKey);
    return `${signingInput}.${b64url(sig)}`;
  };
  return { jwksJson, jwkModulus: String(jwk.n), mint };
}

describe("resolveTestGoogleChatVerifier — default (production remote-JWKS) path", () => {
  it("env unset ⇒ returns the production verifier; reads no file, logs no WARN (project-number)", async () => {
    const readFileImpl = vi.fn((_p: string): string => {
      throw new Error("readFileImpl must not be called on the default path");
    });
    const { logger, warn } = makeLoggerSpy();
    const getEnv = (_k: string): string | undefined => undefined;

    const verify = resolveTestGoogleChatVerifier(
      { audienceType: "project-number", audience: "1234567890" },
      getEnv,
      { readFileImpl, logger },
    );

    expect(typeof verify).toBe("function");
    // The default path forwards to the live remote-JWKS verifier — no seam work.
    expect(readFileImpl).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    // The production verifier's cheap pre-gate rejects a missing bearer with no
    // network — proof the default (not the local-JWKS) path is wired.
    expect((await verify(undefined)).ok).toBe(false);
  });

  it("env unset ⇒ works for the app-url audience type too (no file read, no WARN)", async () => {
    const readFileImpl = vi.fn((_p: string): string => {
      throw new Error("readFileImpl must not be called on the default path");
    });
    const { logger, warn } = makeLoggerSpy();
    const getEnv = (_k: string): string | undefined => undefined;

    const verify = resolveTestGoogleChatVerifier(
      { audienceType: "app-url", audience: "https://example.com/app/" },
      getEnv,
      { readFileImpl, logger },
    );

    expect(readFileImpl).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect((await verify(undefined)).ok).toBe(false);
  });

  it("env unset ⇒ resolves with no deps bag at all (logger + readFileImpl optional)", async () => {
    const getEnv = (_k: string): string | undefined => undefined;
    const verify = resolveTestGoogleChatVerifier(
      { audienceType: "project-number", audience: "1234567890" },
      getEnv,
    );
    expect((await verify(undefined)).ok).toBe(false);
  });
});

describe("resolveTestGoogleChatVerifier — local-JWKS seam path (COMIS_GOOGLECHAT_TEST_JWKS set)", () => {
  it("app-url: FULL offline verify — valid token ok, wrong-audience err (not a bypass) + content-free WARN", async () => {
    const { jwksJson, jwkModulus, mint } = makeJwks();
    const readFileImpl = vi.fn((_p: string): string => jwksJson);
    const { logger, warn, serialized } = makeLoggerSpy();
    const getEnv = (k: string): string | undefined =>
      k === "COMIS_GOOGLECHAT_TEST_JWKS" ? "/seam/app-url.jwks.json" : undefined;

    const verify = resolveTestGoogleChatVerifier(
      { audienceType: "app-url", audience: "https://example.com/app/" },
      getEnv,
      { readFileImpl, logger },
    );

    // Seam activation is synchronous at resolve time, before any verify — a
    // deterministic, network-free assertion. On the default path neither fires.
    expect(readFileImpl).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);

    // A correctly-bound token (right key, issuer, audience, sender email) is
    // ACCEPTED — the local key set verifies offline.
    const good = mint({
      iss: GOOGLE_OIDC_ISSUER,
      aud: "https://example.com/app/",
      email: CHAT_SYSTEM_EMAIL,
      email_verified: true,
    });
    expect((await verify(`Bearer ${good}`)).ok).toBe(true);

    // A wrong-audience token is REJECTED — a real verify, never accept-all.
    const wrongAudience = mint({
      iss: GOOGLE_OIDC_ISSUER,
      aud: "https://attacker.example/app/",
      email: CHAT_SYSTEM_EMAIL,
      email_verified: true,
    });
    expect((await verify(`Bearer ${wrongAudience}`)).ok).toBe(false);

    // The local verifier carries no logger, so the activation WARN is the only
    // one — rejections stay opaque at this layer.
    expect(warn).toHaveBeenCalledTimes(1);
    const warnArg = warn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(warnArg).toMatchObject({
      channelType: "googlechat",
      errorKind: "config",
    });
    expect(String(warnArg.hint)).toContain("COMIS_GOOGLECHAT_TEST_JWKS");
    // Content-free: neither a token nor any JWKS key material reaches the WARN.
    const dump = serialized();
    expect(dump).not.toContain(good);
    expect(dump).not.toContain(jwkModulus);
  });

  it("project-number: FULL offline verify — valid token ok, wrong-audience err", async () => {
    const { jwksJson, mint } = makeJwks();
    const readFileImpl = vi.fn((_p: string): string => jwksJson);
    const { logger, warn } = makeLoggerSpy();
    const getEnv = (k: string): string | undefined =>
      k === "COMIS_GOOGLECHAT_TEST_JWKS" ? "/seam/pn.jwks.json" : undefined;

    const verify = resolveTestGoogleChatVerifier(
      { audienceType: "project-number", audience: "1234567890" },
      getEnv,
      { readFileImpl, logger },
    );

    expect(readFileImpl).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);

    const good = mint({ iss: CHAT_SYSTEM_ISSUER, aud: "1234567890" });
    expect((await verify(`Bearer ${good}`)).ok).toBe(true);

    const wrongAudience = mint({ iss: CHAT_SYSTEM_ISSUER, aud: "9999999999" });
    expect((await verify(`Bearer ${wrongAudience}`)).ok).toBe(false);
  });

  it("threads COMIS_GOOGLECHAT_TEST_ISSUER into the local verifier (synthetic app-url issuer)", async () => {
    const { jwksJson, mint } = makeJwks();
    const readFileImpl = vi.fn((_p: string): string => jwksJson);
    const { logger } = makeLoggerSpy();
    const emulatorIssuer = "https://emulator.test/oidc";
    const getEnv = (k: string): string | undefined =>
      k === "COMIS_GOOGLECHAT_TEST_JWKS"
        ? "/seam/iss.jwks.json"
        : k === "COMIS_GOOGLECHAT_TEST_ISSUER"
          ? emulatorIssuer
          : undefined;

    const verify = resolveTestGoogleChatVerifier(
      { audienceType: "app-url", audience: "https://example.com/app/" },
      getEnv,
      { readFileImpl, logger },
    );

    expect(readFileImpl).toHaveBeenCalledTimes(1);

    // A token from the synthetic emulator issuer verifies under the override...
    const emulatorToken = mint({
      iss: emulatorIssuer,
      aud: "https://example.com/app/",
      email: CHAT_SYSTEM_EMAIL,
      email_verified: true,
    });
    expect((await verify(`Bearer ${emulatorToken}`)).ok).toBe(true);

    // ...while a token from the default Google issuer is now REJECTED — the
    // override replaced the expected issuer, proving it was threaded through.
    const googleToken = mint({
      iss: GOOGLE_OIDC_ISSUER,
      aud: "https://example.com/app/",
      email: CHAT_SYSTEM_EMAIL,
      email_verified: true,
    });
    expect((await verify(`Bearer ${googleToken}`)).ok).toBe(false);
  });
});

describe("resolveTestGoogleChatVerifier — unreadable/malformed JWKS file (fail-closed to production, never crash boot)", () => {
  it("does not throw when the JWKS file is unreadable; falls back to the production verifier + a config WARN naming the env var", async () => {
    // readFileImpl throwing simulates ENOENT/EACCES — the seam must not let that
    // propagate out of bootstrapAdapters and fail daemon boot.
    const readFileImpl = vi.fn((_p: string): string => {
      throw new Error("ENOENT: no such file or directory");
    });
    const { logger, warn, serialized } = makeLoggerSpy();
    const getEnv = (k: string): string | undefined =>
      k === "COMIS_GOOGLECHAT_TEST_JWKS" ? "/seam/missing.jwks.json" : undefined;

    let verify: ReturnType<typeof resolveTestGoogleChatVerifier> | undefined;
    expect(() => {
      verify = resolveTestGoogleChatVerifier(
        { audienceType: "project-number", audience: "1234567890" },
        getEnv,
        { readFileImpl, logger },
      );
    }).not.toThrow();

    // A usable verifier is still returned — the production remote-JWKS one.
    expect(typeof verify).toBe("function");
    expect((await verify!(undefined)).ok).toBe(false);

    // A single config-errorKind WARN names the env var and the fallback.
    expect(warn).toHaveBeenCalledTimes(1);
    const warnArg = warn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(warnArg).toMatchObject({ channelType: "googlechat", errorKind: "config" });
    expect(String(warnArg.hint)).toContain("COMIS_GOOGLECHAT_TEST_JWKS");
    // Content-free: the read path is not echoed into the WARN structured fields.
    expect(serialized()).not.toContain("/seam/missing.jwks.json");
  });

  it("does not throw when the JWKS file is not valid JSON; falls back to the production verifier + a config WARN", async () => {
    const readFileImpl = vi.fn((_p: string): string => "not-json{{{");
    const { logger, warn } = makeLoggerSpy();
    const getEnv = (k: string): string | undefined =>
      k === "COMIS_GOOGLECHAT_TEST_JWKS" ? "/seam/garbage.jwks.json" : undefined;

    let verify: ReturnType<typeof resolveTestGoogleChatVerifier> | undefined;
    expect(() => {
      verify = resolveTestGoogleChatVerifier(
        { audienceType: "app-url", audience: "https://example.com/app/" },
        getEnv,
        { readFileImpl, logger },
      );
    }).not.toThrow();

    expect(typeof verify).toBe("function");
    expect((await verify!(undefined)).ok).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    const warnArg = warn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(warnArg).toMatchObject({ channelType: "googlechat", errorKind: "config" });
    expect(String(warnArg.hint)).toContain("COMIS_GOOGLECHAT_TEST_JWKS");
  });
});
