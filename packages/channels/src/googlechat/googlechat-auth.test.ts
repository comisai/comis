// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import type { ComisLogger } from "@comis/core";
import {
  generateKeyPair,
  exportPKCS8,
  exportJWK,
  createLocalJWKSet,
  jwtVerify,
  decodeJwt,
  decodeProtectedHeader,
  SignJWT,
} from "jose";
import {
  createGoogleChatTokenProvider,
  CHAT_SCOPE,
  PUBSUB_SCOPE,
  type GoogleChatTokenDeps,
} from "./googlechat-auth.js";
// Namespace import for the INBOUND verify half so a not-yet-exported symbol reads
// as `undefined` (a clean, isolated per-test failure) rather than breaking the
// whole module load — mirrors the barrel index.test.ts technique.
import * as gcAuth from "./googlechat-auth.js";

const SA_EMAIL = "comis-bot@my-project.iam.gserviceaccount.com";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const MINTED_TOKEN = "ya29.minted-access-token-xyz";

/** A logger whose spies record every argument to every level for redaction asserts. */
function makeLoggerSpy() {
  const info = vi.fn();
  const warn = vi.fn();
  const debug = vi.fn();
  const error = vi.fn();
  const noop = vi.fn();
  const logger = {
    level: "debug",
    trace: noop,
    debug,
    info,
    warn,
    error,
    fatal: noop,
    audit: noop,
    child: vi.fn().mockReturnThis(),
  } as unknown as ComisLogger;
  const serialized = () =>
    JSON.stringify([
      ...info.mock.calls,
      ...warn.mock.calls,
      ...debug.mock.calls,
      ...error.mock.calls,
    ]);
  return { logger, serialized, info, warn };
}

/**
 * Build a real RS256 service-account keypair and the SA-key JSON an operator
 * would supply (`private_key` is a PKCS#8 PEM, exactly the Google keyfile shape).
 * The public key is returned so a test can verify the minted assertion's
 * signature; the PEM is returned so a test can assert it never reaches a log.
 */
async function makeServiceAccountKey(clientEmail = SA_EMAIL) {
  const { publicKey, privateKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const privateKeyPem = await exportPKCS8(privateKey);
  const serviceAccountKey = JSON.stringify({
    type: "service_account",
    client_email: clientEmail,
    private_key: privateKeyPem,
    token_uri: TOKEN_URL,
  });
  return { serviceAccountKey, publicKey, privateKeyPem };
}

/** A fetch stub returning a successful token exchange; captures its calls. */
function makeTokenFetch(token = MINTED_TOKEN, expiresIn = 3600) {
  const spy = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      access_token: token,
      expires_in: expiresIn,
      token_type: "Bearer",
    }),
  }));
  return { fetchImpl: spy as unknown as typeof fetch, spy };
}

async function makeDeps(overrides: Partial<GoogleChatTokenDeps> = {}) {
  const loggerSpy = makeLoggerSpy();
  const { fetchImpl, spy } = makeTokenFetch();
  const sa = await makeServiceAccountKey();
  const deps: GoogleChatTokenDeps = {
    serviceAccountKey: sa.serviceAccountKey,
    logger: loggerSpy.logger,
    fetchImpl,
    now: () => 1_000_000,
    ...overrides,
  };
  return { deps, spy, loggerSpy, sa };
}

/** A stable, armor-and-whitespace-stripped needle from the private-key body. */
function keyNeedle(pem: string): string {
  return pem
    .replace(/-----[^-]+-----/g, "")
    .replace(/\s+/g, "")
    .slice(0, 40);
}

/**
 * Assert that no log field carries the SA private key body, the minted token, or
 * the signed assertion. The assertion is read off the fetch spy's captured call
 * args (vitest records call arguments even when the stub then throws).
 */
function assertNoSecretsLogged(
  loggerSpy: ReturnType<typeof makeLoggerSpy>,
  sa: { privateKeyPem: string },
  fetchSpy?: ReturnType<typeof vi.fn>,
) {
  const blob = loggerSpy.serialized();
  expect(blob).not.toContain(MINTED_TOKEN);
  const needle = keyNeedle(sa.privateKeyPem);
  expect(needle.length).toBeGreaterThan(0);
  expect(blob).not.toContain(needle);
  const calls = fetchSpy?.mock.calls ?? [];
  if (calls.length > 0) {
    const init = calls[0][1] as RequestInit | undefined;
    const assertion =
      new URLSearchParams(String(init?.body)).get("assertion") ?? "";
    if (assertion) expect(blob).not.toContain(assertion);
  }
}

describe("createGoogleChatTokenProvider — credentialError (single-parse reuse)", () => {
  it("returns undefined for a well-formed service-account key", async () => {
    const { deps } = await makeDeps();
    const provider = createGoogleChatTokenProvider(deps);
    expect(provider.credentialError()).toBeUndefined();
  });

  it("surfaces a secret-free hint for a malformed key, cached across calls (no re-parse)", async () => {
    const { deps } = await makeDeps({ serviceAccountKey: "{not json" });
    const provider = createGoogleChatTokenProvider(deps);
    const first = provider.credentialError();
    const second = provider.credentialError();
    expect(first?.hint).toBeTruthy();
    expect(first).toEqual(second); // same cached parse result, not re-parsed
    expect(first?.hint.toLowerCase()).toContain("service-account key");
  });

  it("surfaces a missing-field hint naming the absent field", async () => {
    const noEmail = JSON.stringify({
      private_key: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----",
    });
    const { deps } = await makeDeps({ serviceAccountKey: noEmail });
    const provider = createGoogleChatTokenProvider(deps);
    expect(provider.credentialError()?.hint).toContain("client_email");
  });
});

describe("createGoogleChatTokenProvider — SA-JWT-bearer mint", () => {
  it("mints an RS256 SA-JWT assertion and POSTs the jwt-bearer grant to the token endpoint", async () => {
    const { deps, spy, sa } = await makeDeps();
    const provider = createGoogleChatTokenProvider(deps);
    const result = await provider.getToken(CHAT_SCOPE);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(MINTED_TOKEN);
    expect(spy).toHaveBeenCalledTimes(1);

    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(TOKEN_URL);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["content-type"]).toBe(
      "application/x-www-form-urlencoded",
    );

    const body = new URLSearchParams(String(init.body));
    expect(body.get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:jwt-bearer",
    );
    const assertion = body.get("assertion") ?? "";
    expect(assertion.split(".")).toHaveLength(3); // a compact JWS

    const header = decodeProtectedHeader(assertion);
    expect(header.alg).toBe("RS256");
    expect(header.typ).toBe("JWT");

    const claims = decodeJwt(assertion) as {
      iss?: string;
      sub?: string;
      aud?: string;
      scope?: string;
      iat?: number;
      exp?: number;
    };
    expect(claims.iss).toBe(SA_EMAIL);
    expect(claims.sub).toBe(SA_EMAIL);
    expect(claims.aud).toBe(TOKEN_URL);
    expect(claims.scope).toBe(CHAT_SCOPE);
    expect(typeof claims.iat).toBe("number");
    expect(typeof claims.exp).toBe("number");
    expect((claims.exp as number) - (claims.iat as number)).toBeLessThanOrEqual(
      3600,
    );
  });

  it("signs the assertion with the SA private key — jwtVerify against the matching public key succeeds", async () => {
    const { deps, spy, sa } = await makeDeps();
    const provider = createGoogleChatTokenProvider(deps);
    await provider.getToken(CHAT_SCOPE);
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    const assertion =
      new URLSearchParams(String(init.body)).get("assertion") ?? "";
    // The assertion is signed off the injected clock (now() = 1_000_000 ms =
    // epoch second 1000), so verify its time-based claims against that instant.
    const verified = await jwtVerify(assertion, sa.publicKey, {
      issuer: SA_EMAIL,
      audience: TOKEN_URL,
      currentDate: new Date(1_000_000),
    });
    expect((verified.payload as { scope?: string }).scope).toBe(CHAT_SCOPE);
  });

  it("reuses the cached token on a second same-scope call inside the skew window", async () => {
    const { deps, spy } = await makeDeps();
    const provider = createGoogleChatTokenProvider(deps);
    const first = await provider.getToken(CHAT_SCOPE);
    const second = await provider.getToken(CHAT_SCOPE);
    expect(first.ok && second.ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("refreshes the token once the clock passes expiry-minus-skew", async () => {
    let clock = 1_000_000;
    const { deps, spy } = await makeDeps({ now: () => clock, skewMs: 60_000 });
    const provider = createGoogleChatTokenProvider(deps);
    await provider.getToken(CHAT_SCOPE);
    expect(spy).toHaveBeenCalledTimes(1);
    // expiresAt = 1_000_000 + 3_600_000; refresh boundary = expiresAt - 60_000.
    clock = 1_000_000 + 3_600_000 - 60_000 + 1;
    await provider.getToken(CHAT_SCOPE);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("caches chat.bot and pubsub scopes independently — two scopes mint twice, each reuses its own slot", async () => {
    const { deps, spy } = await makeDeps();
    const provider = createGoogleChatTokenProvider(deps);
    await provider.getToken(CHAT_SCOPE);
    await provider.getToken(PUBSUB_SCOPE);
    expect(spy).toHaveBeenCalledTimes(2);
    // A second call on each scope is served from that scope's own cache slot.
    await provider.getToken(CHAT_SCOPE);
    await provider.getToken(PUBSUB_SCOPE);
    expect(spy).toHaveBeenCalledTimes(2);
    // The two mints carried the two distinct scopes in their assertions.
    const scopes = spy.mock.calls.map(([, init]) => {
      const assertion =
        new URLSearchParams(String((init as RequestInit).body)).get(
          "assertion",
        ) ?? "";
      return (decodeJwt(assertion) as { scope?: string }).scope;
    });
    expect(new Set(scopes)).toEqual(new Set([CHAT_SCOPE, PUBSUB_SCOPE]));
  });

  it("logs a durationMs mint completion but never the SA key, the assertion, or the minted token", async () => {
    const { deps, spy, loggerSpy, sa } = await makeDeps();
    const provider = createGoogleChatTokenProvider(deps);
    const result = await provider.getToken(CHAT_SCOPE);
    expect(result.ok).toBe(true);
    const mintLine = loggerSpy.info.mock.calls
      .map((c) => c[0])
      .find(
        (p) =>
          p !== null &&
          typeof p === "object" &&
          (p as { step?: string }).step === "googlechat-token-mint",
      );
    expect(mintLine).toBeDefined();
    expect(typeof (mintLine as { durationMs?: unknown }).durationMs).toBe(
      "number",
    );
    assertNoSecretsLogged(loggerSpy, sa, spy);
  });

  it("returns err and warns (auth) on a non-ok token-endpoint status, leaking no secret", async () => {
    const loggerSpy = makeLoggerSpy();
    const spy = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
    }));
    const sa = await makeServiceAccountKey();
    const provider = createGoogleChatTokenProvider({
      serviceAccountKey: sa.serviceAccountKey,
      logger: loggerSpy.logger,
      fetchImpl: spy as unknown as typeof fetch,
      now: () => 1_000_000,
    });
    const result = await provider.getToken(CHAT_SCOPE);
    expect(result.ok).toBe(false);
    const authWarn = loggerSpy.warn.mock.calls
      .map((c) => c[0])
      .find(
        (p) =>
          p !== null &&
          typeof p === "object" &&
          (p as { errorKind?: string }).errorKind === "auth",
      );
    expect(authWarn).toBeDefined();
    assertNoSecretsLogged(loggerSpy, sa, spy);
  });

  it("returns err and warns (network) when the token fetch rejects at the transport level, leaking no secret", async () => {
    const loggerSpy = makeLoggerSpy();
    const spy = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    const sa = await makeServiceAccountKey();
    const provider = createGoogleChatTokenProvider({
      serviceAccountKey: sa.serviceAccountKey,
      logger: loggerSpy.logger,
      fetchImpl: spy as unknown as typeof fetch,
      now: () => 1_000_000,
    });
    const result = await provider.getToken(PUBSUB_SCOPE);
    expect(result.ok).toBe(false);
    const networkWarn = loggerSpy.warn.mock.calls
      .map((c) => c[0])
      .find(
        (p) =>
          p !== null &&
          typeof p === "object" &&
          (p as { errorKind?: string }).errorKind === "network",
      );
    expect(networkWarn).toBeDefined();
    assertNoSecretsLogged(loggerSpy, sa, spy);
  });

  it("returns a precondition err naming PKCS#8 PEM (never the key bytes) when the private_key is not valid PKCS#8", async () => {
    const loggerSpy = makeLoggerSpy();
    const badKeyBody = "NOT-A-VALID-PKCS8-KEY-BODY-000111222333444";
    const serviceAccountKey = JSON.stringify({
      client_email: SA_EMAIL,
      private_key: `-----BEGIN PRIVATE KEY-----\n${badKeyBody}\n-----END PRIVATE KEY-----\n`,
    });
    const spy = vi.fn();
    const provider = createGoogleChatTokenProvider({
      serviceAccountKey,
      logger: loggerSpy.logger,
      fetchImpl: spy as unknown as typeof fetch,
      now: () => 1_000_000,
    });
    const result = await provider.getToken(CHAT_SCOPE);
    expect(result.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled(); // never reached the token endpoint
    const preconditionWarn = loggerSpy.warn.mock.calls
      .map((c) => c[0])
      .find(
        (p) =>
          p !== null &&
          typeof p === "object" &&
          (p as { errorKind?: string }).errorKind === "precondition",
      );
    expect(preconditionWarn).toBeDefined();
    const blob = loggerSpy.serialized();
    expect(blob).toContain("PKCS#8 PEM"); // names the requirement
    expect(blob).not.toContain(badKeyBody); // never the key bytes
  });

  it("returns a precondition err (never the key bytes) when the SA key JSON does not parse", async () => {
    const loggerSpy = makeLoggerSpy();
    const spy = vi.fn();
    const provider = createGoogleChatTokenProvider({
      serviceAccountKey: "not-json {{{",
      logger: loggerSpy.logger,
      fetchImpl: spy as unknown as typeof fetch,
      now: () => 1_000_000,
    });
    const result = await provider.getToken(CHAT_SCOPE);
    expect(result.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    const preconditionWarn = loggerSpy.warn.mock.calls
      .map((c) => c[0])
      .find(
        (p) =>
          p !== null &&
          typeof p === "object" &&
          (p as { errorKind?: string }).errorKind === "precondition",
      );
    expect(preconditionWarn).toBeDefined();
  });

  it("returns a precondition err when the SA key JSON is missing client_email", async () => {
    const loggerSpy = makeLoggerSpy();
    const { publicKey: _pub, privateKey } = await generateKeyPair("RS256", {
      extractable: true,
    });
    void _pub;
    const serviceAccountKey = JSON.stringify({
      private_key: await exportPKCS8(privateKey),
    });
    const spy = vi.fn();
    const provider = createGoogleChatTokenProvider({
      serviceAccountKey,
      logger: loggerSpy.logger,
      fetchImpl: spy as unknown as typeof fetch,
      now: () => 1_000_000,
    });
    const result = await provider.getToken(CHAT_SCOPE);
    expect(result.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns err (platform) when the token response body is not valid JSON", async () => {
    const loggerSpy = makeLoggerSpy();
    const spy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("invalid json");
      },
    }));
    const sa = await makeServiceAccountKey();
    const provider = createGoogleChatTokenProvider({
      serviceAccountKey: sa.serviceAccountKey,
      logger: loggerSpy.logger,
      fetchImpl: spy as unknown as typeof fetch,
      now: () => 1_000_000,
    });
    const result = await provider.getToken(CHAT_SCOPE);
    expect(result.ok).toBe(false);
    const platformWarn = loggerSpy.warn.mock.calls
      .map((c) => c[0])
      .find(
        (p) =>
          p !== null &&
          typeof p === "object" &&
          (p as { errorKind?: string }).errorKind === "platform",
      );
    expect(platformWarn).toBeDefined();
  });

  it("treats a response missing access_token as an incomplete token response", async () => {
    const loggerSpy = makeLoggerSpy();
    const spy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ expires_in: 3600 }),
    }));
    const sa = await makeServiceAccountKey();
    const provider = createGoogleChatTokenProvider({
      serviceAccountKey: sa.serviceAccountKey,
      logger: loggerSpy.logger,
      fetchImpl: spy as unknown as typeof fetch,
      now: () => 1_000_000,
    });
    const result = await provider.getToken(CHAT_SCOPE);
    expect(result.ok).toBe(false);
  });

  it("treats a non-finite expires_in as incomplete and never caches it", async () => {
    // typeof NaN === "number", so a bare typeof guard would poison the cache
    // (expiresAtMs = NaN) and force a re-mint on every call.
    const loggerSpy = makeLoggerSpy();
    let call = 0;
    const spy = vi.fn(async () => {
      call += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "tok",
          expires_in: call === 1 ? Number.NaN : 3600,
        }),
      };
    });
    const sa = await makeServiceAccountKey();
    const provider = createGoogleChatTokenProvider({
      serviceAccountKey: sa.serviceAccountKey,
      logger: loggerSpy.logger,
      fetchImpl: spy as unknown as typeof fetch,
      now: () => 1_000_000,
    });
    expect((await provider.getToken(CHAT_SCOPE)).ok).toBe(false); // NaN → not cached
    expect((await provider.getToken(CHAT_SCOPE)).ok).toBe(true); // valid → cached
    expect((await provider.getToken(CHAT_SCOPE)).ok).toBe(true); // served from cache
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

// --- Inbound dual-audience Bearer-JWT verify (the webhook-mode trust anchor) ---

const PROJECT_NUMBER = "1234567890";
const CHAT_SYSTEM_ISS = "chat@system.gserviceaccount.com";

/**
 * A locally-generated RS256 keypair + local JWK set stands in for Google's
 * signing keys, so the verifier runs fully offline — no network to real Google
 * endpoints. `jwk` is the raw public JWK (for the raw-JWKS seam entry point);
 * `jwks` is the constructed local key set (for the `jwks` option).
 */
async function makeInboundKeyContext() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.alg = "RS256";
  jwk.kid = "k1";
  const jwks = createLocalJWKSet({ keys: [jwk] });
  return { privateKey: privateKey as CryptoKey, jwk, jwks };
}

/** Mint a project-number-audience token (a self-signed Chat-system JWT shape). */
function mintProjectToken(
  privateKey: CryptoKey,
  opts: { iss?: string; aud?: string; exp?: number | string } = {},
): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(opts.iss ?? CHAT_SYSTEM_ISS)
    .setAudience(opts.aud ?? PROJECT_NUMBER)
    .setExpirationTime(opts.exp ?? "5m")
    .sign(privateKey);
}

/** A hand-built alg:none unsecured JWT — jose must reject it by contract. */
function makeUnsignedToken(payload: Record<string, unknown>): string {
  const seg = (o: unknown): string =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${seg({ alg: "none", typ: "JWT" })}.${seg(payload)}.`;
}

describe("createGoogleChatInboundVerifier — project-number audience", () => {
  it("verifies a Chat-system token (iss/aud/RS256) signed by the trusted key", async () => {
    const { privateKey, jwks } = await makeInboundKeyContext();
    const verify = gcAuth.createGoogleChatInboundVerifier({
      audienceType: "project-number",
      audience: PROJECT_NUMBER,
      jwks,
    });
    const token = await mintProjectToken(privateKey);
    expect((await verify(`Bearer ${token}`)).ok).toBe(true);
  });

  it("fails closed on a blank expected audience BEFORE any key-set access", async () => {
    const { privateKey } = await makeInboundKeyContext();
    // A key set whose access is observable: it must never be consulted.
    const jwksSpy = vi.fn();
    const verify = gcAuth.createGoogleChatInboundVerifier({
      audienceType: "project-number",
      audience: "",
      jwks: jwksSpy as unknown as Parameters<typeof jwtVerify>[1],
    });
    const token = await mintProjectToken(privateKey);
    const result = await verify(`Bearer ${token}`);
    expect(result.ok).toBe(false);
    expect(jwksSpy).not.toHaveBeenCalled();
  });

  it("rejects missing / non-Bearer / bare-Bearer headers via the pre-gate (no key-set access)", async () => {
    const jwksSpy = vi.fn();
    const verify = gcAuth.createGoogleChatInboundVerifier({
      audienceType: "project-number",
      audience: PROJECT_NUMBER,
      jwks: jwksSpy as unknown as Parameters<typeof jwtVerify>[1],
    });
    expect((await verify(undefined)).ok).toBe(false);
    expect((await verify("Basic dXNlcjpwYXNz")).ok).toBe(false);
    expect((await verify("")).ok).toBe(false);
    expect((await verify("Bearer")).ok).toBe(false);
    expect(jwksSpy).not.toHaveBeenCalled();
  });

  it("rejects a wrong audience", async () => {
    const { privateKey, jwks } = await makeInboundKeyContext();
    const verify = gcAuth.createGoogleChatInboundVerifier({
      audienceType: "project-number",
      audience: PROJECT_NUMBER,
      jwks,
    });
    const token = await mintProjectToken(privateKey, { aud: "9999999999" });
    expect((await verify(`Bearer ${token}`)).ok).toBe(false);
  });

  it("rejects a wrong issuer", async () => {
    const { privateKey, jwks } = await makeInboundKeyContext();
    const verify = gcAuth.createGoogleChatInboundVerifier({
      audienceType: "project-number",
      audience: PROJECT_NUMBER,
      jwks,
    });
    const token = await mintProjectToken(privateKey, { iss: "https://evil.example" });
    expect((await verify(`Bearer ${token}`)).ok).toBe(false);
  });

  it("rejects a token signed by a key absent from the trusted key set", async () => {
    const { jwks } = await makeInboundKeyContext(); // trusted set
    const foreign = await generateKeyPair("RS256"); // a DIFFERENT, untrusted signer
    const verify = gcAuth.createGoogleChatInboundVerifier({
      audienceType: "project-number",
      audience: PROJECT_NUMBER,
      jwks,
    });
    const token = await mintProjectToken(foreign.privateKey as CryptoKey);
    expect((await verify(`Bearer ${token}`)).ok).toBe(false);
  });

  it("rejects an alg:none / unsigned token", async () => {
    const { jwks } = await makeInboundKeyContext();
    const verify = gcAuth.createGoogleChatInboundVerifier({
      audienceType: "project-number",
      audience: PROJECT_NUMBER,
      jwks,
    });
    const token = makeUnsignedToken({
      iss: CHAT_SYSTEM_ISS,
      aud: PROJECT_NUMBER,
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    expect((await verify(`Bearer ${token}`)).ok).toBe(false);
  });

  it("rejects an expired token", async () => {
    const { privateKey, jwks } = await makeInboundKeyContext();
    const verify = gcAuth.createGoogleChatInboundVerifier({
      audienceType: "project-number",
      audience: PROJECT_NUMBER,
      jwks,
    });
    // Absolute epoch second 2 (1970) — unambiguously expired, no wall-clock read.
    const token = await mintProjectToken(privateKey, { exp: 2 });
    expect((await verify(`Bearer ${token}`)).ok).toBe(false);
  });

  it("warns on rejection but never records the token bytes in a log field", async () => {
    const { privateKey, jwks } = await makeInboundKeyContext();
    const loggerSpy = makeLoggerSpy();
    const verify = gcAuth.createGoogleChatInboundVerifier({
      audienceType: "project-number",
      audience: PROJECT_NUMBER,
      jwks,
      logger: loggerSpy.logger,
    });
    const token = await mintProjectToken(privateKey, { aud: "9999999999" });
    const result = await verify(`Bearer ${token}`);
    expect(result.ok).toBe(false);
    const authWarn = loggerSpy.warn.mock.calls
      .map((c) => c[0])
      .find(
        (p) =>
          p !== null &&
          typeof p === "object" &&
          (p as { errorKind?: string }).errorKind === "auth",
      );
    expect(authWarn).toBeDefined();
    expect(loggerSpy.serialized()).not.toContain(token);
  });
});
