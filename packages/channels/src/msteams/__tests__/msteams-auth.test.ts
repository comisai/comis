// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from "jose";
import {
  createActivityJwtValidator,
  type ActivityJwtValidatorOpts,
} from "../msteams-auth.js";

// Bot Framework issuer + a stand-in bot app id used as the audience claim.
const BF_ISSUER = "https://api.botframework.com";
const APP_ID = "bot-app-client-id";

/**
 * A local RS256 keypair + local JWKS stands in for the Bot Framework signing
 * keys, so the validator runs fully offline — no network to real metadata.
 */
async function makeKeyContext(): Promise<{
  privateKey: CryptoKey;
  jwks: ActivityJwtValidatorOpts["jwks"];
}> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.alg = "RS256";
  const jwks = createLocalJWKSet({ keys: [jwk] });
  return { privateKey: privateKey as CryptoKey, jwks };
}

function mintToken(
  privateKey: CryptoKey,
  opts: { iss?: string; aud?: string; exp?: number | string } = {},
): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(opts.iss ?? BF_ISSUER)
    .setAudience(opts.aud ?? APP_ID)
    .setExpirationTime(opts.exp ?? "5m")
    .sign(privateKey);
}

describe("createActivityJwtValidator — Bearer pre-gate (no network on reject)", () => {
  it("rejects an undefined Authorization header without touching the key set", async () => {
    const jwksSpy = vi.fn();
    const validate = createActivityJwtValidator({
      jwks: jwksSpy as unknown as ActivityJwtValidatorOpts["jwks"],
      issuer: BF_ISSUER,
    });
    const result = await validate(undefined, APP_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("missing bearer token");
    expect(jwksSpy).not.toHaveBeenCalled();
  });

  it("rejects a non-Bearer authorization scheme without touching the key set", async () => {
    const jwksSpy = vi.fn();
    const validate = createActivityJwtValidator({
      jwks: jwksSpy as unknown as ActivityJwtValidatorOpts["jwks"],
      issuer: BF_ISSUER,
    });
    const result = await validate("Basic dXNlcjpwYXNz", APP_ID);
    expect(result.ok).toBe(false);
    expect(jwksSpy).not.toHaveBeenCalled();
  });

  it("rejects a bare Bearer scheme carrying no token without touching the key set", async () => {
    const jwksSpy = vi.fn();
    const validate = createActivityJwtValidator({
      jwks: jwksSpy as unknown as ActivityJwtValidatorOpts["jwks"],
      issuer: BF_ISSUER,
    });
    const result = await validate("Bearer", APP_ID);
    expect(result.ok).toBe(false);
    expect(jwksSpy).not.toHaveBeenCalled();
  });
});

describe("createActivityJwtValidator — jose signature + claim verification", () => {
  it("accepts a correctly-signed token with the expected issuer and audience", async () => {
    const { privateKey, jwks } = await makeKeyContext();
    const token = await mintToken(privateKey);
    const validate = createActivityJwtValidator({ jwks, issuer: BF_ISSUER });
    const result = await validate(`Bearer ${token}`, APP_ID);
    expect(result.ok).toBe(true);
  });

  it("rejects a token whose audience is not the bot app id", async () => {
    const { privateKey, jwks } = await makeKeyContext();
    const token = await mintToken(privateKey, { aud: "some-other-app-id" });
    const validate = createActivityJwtValidator({ jwks, issuer: BF_ISSUER });
    const result = await validate(`Bearer ${token}`, APP_ID);
    expect(result.ok).toBe(false);
  });

  it("rejects a token whose issuer is not the expected issuer", async () => {
    const { privateKey, jwks } = await makeKeyContext();
    const token = await mintToken(privateKey, { iss: "https://spoofed.example.com" });
    const validate = createActivityJwtValidator({ jwks, issuer: BF_ISSUER });
    const result = await validate(`Bearer ${token}`, APP_ID);
    expect(result.ok).toBe(false);
  });

  it("rejects a token whose expiry is in the past", async () => {
    const { privateKey, jwks } = await makeKeyContext();
    // Absolute epoch second 2 (1970) — unambiguously expired, no wall-clock read.
    const token = await mintToken(privateKey, { exp: 2 });
    const validate = createActivityJwtValidator({ jwks, issuer: BF_ISSUER });
    const result = await validate(`Bearer ${token}`, APP_ID);
    expect(result.ok).toBe(false);
  });

  it("rejects a token signed by a key absent from the trusted key set", async () => {
    const { jwks } = await makeKeyContext(); // trusted key set
    const foreign = await generateKeyPair("RS256"); // a DIFFERENT, untrusted signer
    const token = await mintToken(foreign.privateKey as CryptoKey);
    const validate = createActivityJwtValidator({ jwks, issuer: BF_ISSUER });
    const result = await validate(`Bearer ${token}`, APP_ID);
    expect(result.ok).toBe(false);
  });
});
