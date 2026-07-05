// SPDX-License-Identifier: Apache-2.0
/**
 * Microsoft Teams live-test wiring seams — OFF BY DEFAULT.
 *
 * The Teams channel is architecturally impossible to point at a loopback emulator
 * with a single config key the way Telegram (`apiRoot`) / Signal (`baseUrl`) are:
 * inbound arrives as a Bot-Framework-JWT-signed webhook the daemon must VERIFY
 * against the remote Bot Framework JWKS, and outbound goes to the Connector host
 * `smba.trafficmanager.net`, which `isSafeServiceUrl` hard-allowlists. These two
 * helpers bridge that gap for a live-test rig WITHOUT weakening either control,
 * and they activate ONLY when their `COMIS_MSTEAMS_TEST_*` env var is set — with
 * the env unset the daemon behaves byte-identically to production (the default
 * remote-JWKS validator + the global fetch). They are NEVER a production knob:
 * the vars are documented test-only in `docs/channels/msteams.mdx` and the
 * self-drive runbook.
 *
 *   - `COMIS_MSTEAMS_TEST_JWKS` = a path to a public JWKS JSON. The emulator holds
 *     the matching private key and signs inbound activity tokens; this swaps the
 *     ingress validator for a LOCAL-JWKS one (a FULL signature + issuer + audience
 *     verify — not a bypass) so the emulator's tokens verify offline. Production
 *     keeps the live remote-JWKS `validateActivityJwt` untouched.
 *   - `COMIS_MSTEAMS_TEST_CONNECTOR` = a loopback base (`http://127.0.0.1:PORT`).
 *     This returns a `fetchImpl` that REDIRECTS the network egress of the exact
 *     Connector hosts (+ the AAD token host) to that loopback base, keeping the
 *     path + query verbatim — the programmatic equivalent of a hosts-override. The
 *     `isSafeServiceUrl` host allowlist is NOT relaxed: it still runs on the real
 *     `smba.trafficmanager.net` serviceUrl inside the adapter/connector BEFORE the
 *     token mint; only the transport is redirected AFTER the gate passes.
 *
 * @module
 */

import { readFileSync } from "node:fs";
import {
  createLocalActivityJwtValidator,
  validateActivityJwt,
} from "@comis/channels";
import type { ComisLogger } from "@comis/core";
import type { Result } from "@comis/shared";

/** Reads an environment variable (injected so the resolvers stay pure + testable). */
export type EnvGetter = (key: string) => string | undefined;

/** The env var that points the inbound validator at a local test JWKS (off by default). */
export const MSTEAMS_TEST_JWKS_ENV = "COMIS_MSTEAMS_TEST_JWKS";
/** The env var that redirects outbound Connector egress to a loopback emulator (off by default). */
export const MSTEAMS_TEST_CONNECTOR_ENV = "COMIS_MSTEAMS_TEST_CONNECTOR";

/**
 * The exact Bot Framework Connector hosts (+ the AAD login host) the outbound
 * redirect rewrites to loopback. Mirrors `CLOUD_CONNECTOR_HOSTS` in
 * msteams-connector.ts plus the client-credentials token host. Every other host
 * passes through untouched — this is never a blanket redirect.
 */
const REDIRECT_HOSTS = new Set([
  "smba.trafficmanager.net",
  "botframework.azure.cn",
  "login.microsoftonline.com",
]);

/**
 * Resolve the inbound activity-JWT validator for the ingress, bound to `appId`.
 *
 * Default (env unset): the production remote-JWKS `validateActivityJwt`. When
 * `COMIS_MSTEAMS_TEST_JWKS` names a readable JWKS file, a LOCAL-JWKS validator
 * verifying against that key set instead (still a full signature/issuer/audience
 * verify). The returned closure has the ingress's expected `(authHeader)` shape
 * with the audience already closed over.
 */
export function resolveTestActivityValidator(
  appId: string,
  getEnv: EnvGetter,
  deps?: {
    readonly readFileImpl?: (path: string) => string;
    readonly logger?: ComisLogger;
  },
): (authHeader: string | undefined) => Promise<Result<void, Error>> {
  const jwksPath = getEnv(MSTEAMS_TEST_JWKS_ENV);
  if (jwksPath === undefined || jwksPath.length === 0) {
    // Production/default path: verify against the live Bot Framework JWKS.
    return (authHeader) => validateActivityJwt(authHeader, appId);
  }
  // Test-only offline path: verify against a local JWKS the emulator wrote.
  const readFileImpl =
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- jwksPath is an operator-set test-only env var, not user input
    deps?.readFileImpl ?? ((path: string) => readFileSync(path, "utf8"));
  const jwks = JSON.parse(readFileImpl(jwksPath)) as Parameters<
    typeof createLocalActivityJwtValidator
  >[0];
  const issuer = getEnv("COMIS_MSTEAMS_TEST_ISSUER");
  const validate = createLocalActivityJwtValidator(
    jwks,
    issuer !== undefined && issuer.length > 0 ? { issuer } : undefined,
  );
  deps?.logger?.warn(
    {
      channelType: "msteams" as const,
      hint: "Unset COMIS_MSTEAMS_TEST_JWKS in production — the msteams ingress is verifying inbound tokens against a LOCAL test JWKS, not the Bot Framework signing keys",
      errorKind: "config" as const,
    },
    "Microsoft Teams ingress using a LOCAL test JWKS (test-only seam)",
  );
  return (authHeader) => validate(authHeader, appId);
}

/**
 * Resolve the outbound `fetchImpl` the Teams adapter uses for its Connector +
 * token calls.
 *
 * Default (env unset): `undefined` — the adapter falls back to the global fetch
 * (production, unchanged). When `COMIS_MSTEAMS_TEST_CONNECTOR` names a loopback
 * base, a fetch that rewrites the exact Connector/AAD hosts to that base (path +
 * query preserved) and passes every other host through untouched. `baseFetch` is
 * injected for testability; it defaults to the global fetch.
 */
export function resolveTestConnectorFetch(
  getEnv: EnvGetter,
  baseFetch: typeof fetch = fetch,
): typeof fetch | undefined {
  const loopback = getEnv(MSTEAMS_TEST_CONNECTOR_ENV);
  if (loopback === undefined || loopback.length === 0) return undefined;
  const base = new URL(loopback);
  const redirect = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const href =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const target = new URL(href);
    if (REDIRECT_HOSTS.has(target.hostname.toLowerCase())) {
      target.protocol = base.protocol;
      target.host = base.host;
      return baseFetch(target.toString(), init);
    }
    return baseFetch(input as string | URL, init);
  };
  return redirect as typeof fetch;
}
