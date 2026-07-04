// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the OFF-BY-DEFAULT Microsoft Teams live-test wiring seams.
 *
 * These two helpers exist ONLY so a live-test emulator can round-trip a full
 * booted daemon over loopback. Both are gated on a `COMIS_MSTEAMS_TEST_*` env var
 * that is UNSET in production — with the env unset the daemon's behavior is
 * byte-identical to today (the default remote-JWKS validator + the global fetch).
 * Critically, neither relaxes a security control: the inbound seam swaps in a
 * LOCAL-JWKS validator (a full signature/issuer/audience verify against a key the
 * operator opted into), and the outbound seam only REDIRECTS the network egress
 * of the already-allowlisted Connector host — the `isSafeServiceUrl` gate is
 * untouched and still runs on the real host in the adapter.
 *
 * @module
 */

import { generateKeyPairSync, createSign } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  resolveTestActivityValidator,
  resolveTestConnectorFetch,
} from "./msteams-test-seams.js";

const BF_ISSUER = "https://api.botframework.com";

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * Generate an RS256 keypair, write its public JWKS to a temp file, and return a
 * minter that signs a Bot Framework activity token — all with node:crypto (no
 * jose dep in the daemon package). The token is exactly what jose's jwtVerify
 * (RS256 = RSASSA-PKCS1-v1_5 + SHA-256) accepts.
 */
function makeJwksFileAndMinter(): {
  jwksPath: string;
  mint: (aud: string, iss?: string) => string;
} {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  jwk.kid = "seam-key-1";
  jwk.alg = "RS256";
  jwk.use = "sig";
  const dir = mkdtempSync(join(tmpdir(), "msteams-seam-"));
  const jwksPath = join(dir, "jwks.json");
  writeFileSync(jwksPath, JSON.stringify({ keys: [jwk] }), "utf8");

  const mint = (aud: string, iss = BF_ISSUER): string => {
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "seam-key-1" }));
    const payload = b64url(JSON.stringify({ iss, aud, iat: now, exp: now + 300 }));
    const signingInput = `${header}.${payload}`;
    const sig = createSign("RSA-SHA256").update(signingInput).sign(privateKey);
    return `${signingInput}.${b64url(sig)}`;
  };
  return { jwksPath, mint };
}

describe("resolveTestActivityValidator — inbound JWT seam", () => {
  it("returns the DEFAULT validator when COMIS_MSTEAMS_TEST_JWKS is unset (rejects missing bearer, no network)", async () => {
    const getEnv = (_k: string): string | undefined => undefined;
    const validate = resolveTestActivityValidator("app-id", getEnv);
    // The default validator's cheap pre-gate rejects a missing bearer with no
    // network — proving the production path is wired (not the local-JWKS path).
    const verdict = await validate(undefined);
    expect(verdict.ok).toBe(false);
  });

  it("uses a LOCAL-JWKS validator when COMIS_MSTEAMS_TEST_JWKS points at a JWKS file", async () => {
    const { jwksPath, mint } = makeJwksFileAndMinter();
    const getEnv = (k: string): string | undefined =>
      k === "COMIS_MSTEAMS_TEST_JWKS" ? jwksPath : undefined;
    const validate = resolveTestActivityValidator("the-app-id", getEnv);

    // A token signed by that JWKS' key, for the bound appId → accepted.
    expect((await validate(`Bearer ${mint("the-app-id")}`)).ok).toBe(true);
    // A token for a DIFFERENT audience → rejected (appId is bound, not trusted from the token).
    expect((await validate(`Bearer ${mint("someone-else")}`)).ok).toBe(false);
    // A missing bearer → rejected (the pre-gate still applies).
    expect((await validate(undefined)).ok).toBe(false);
  });
});

describe("resolveTestConnectorFetch — outbound Connector redirect seam", () => {
  it("returns undefined when COMIS_MSTEAMS_TEST_CONNECTOR is unset (adapter keeps global fetch)", () => {
    const getEnv = (_k: string): string | undefined => undefined;
    expect(resolveTestConnectorFetch(getEnv)).toBeUndefined();
  });

  it("redirects the Connector + AAD hosts to the loopback base, keeping path + query", async () => {
    const baseFetch = vi.fn(async () => new Response("{}", { status: 200 }));
    const getEnv = (k: string): string | undefined =>
      k === "COMIS_MSTEAMS_TEST_CONNECTOR" ? "http://127.0.0.1:59999" : undefined;
    const redirect = resolveTestConnectorFetch(getEnv, baseFetch as unknown as typeof fetch);
    expect(redirect).toBeDefined();

    await redirect!(
      "https://smba.trafficmanager.net/v3/conversations/a%3Aconv/activities?x=1",
      { method: "POST" },
    );
    // The Connector host is rewritten to loopback; path + query are preserved.
    expect(String(baseFetch.mock.calls[0]?.[0])).toBe(
      "http://127.0.0.1:59999/v3/conversations/a%3Aconv/activities?x=1",
    );

    await redirect!("https://login.microsoftonline.com/tenant/oauth2/v2.0/token", {
      method: "POST",
    });
    expect(String(baseFetch.mock.calls[1]?.[0])).toBe(
      "http://127.0.0.1:59999/tenant/oauth2/v2.0/token",
    );
  });

  it("passes a non-Connector host through UNCHANGED (never a blanket redirect)", async () => {
    const baseFetch = vi.fn(async () => new Response("{}", { status: 200 }));
    const getEnv = (k: string): string | undefined =>
      k === "COMIS_MSTEAMS_TEST_CONNECTOR" ? "http://127.0.0.1:59999" : undefined;
    const redirect = resolveTestConnectorFetch(getEnv, baseFetch as unknown as typeof fetch);
    await redirect!("https://example.com/some/path", { method: "GET" });
    // Untouched — the seam only redirects the exact Connector/AAD hosts.
    expect(String(baseFetch.mock.calls[0]?.[0])).toBe("https://example.com/some/path");
  });
});
