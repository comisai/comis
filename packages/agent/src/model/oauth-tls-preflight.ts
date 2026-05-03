// SPDX-License-Identifier: Apache-2.0
/**
 * OAuth TLS preflight for OpenAI Codex `auth.openai.com`.
 *
 * Issues a single 5-second `fetch` GET against the OAuth authorize endpoint
 * and classifies failures as `tls-cert` (system CA bundle missing/broken;
 * fixable via `apt install ca-certificates` etc.) or `network` (DNS,
 * firewall, proxy — operator action required).
 *
 * Verbatim port of OpenClaw's provider-openai-codex-oauth-tls.ts (RESEARCH §Q1)
 * minus the Homebrew prefix-resolution branch and minus the `note()` UI
 * (caller decides how to surface the result; this module is pure).
 *
 * The probe URL uses the public OpenAI Codex client_id
 * `app_EMoamEEZ73f0CkXaXp7hrann` (NOT a Comis-distinct value) per
 * RESEARCH §Q6 T-10-01 to avoid fingerprinting in OpenAI logs.
 *
 * This module never logs — the caller is responsible for surfacing
 * the result via Pino (daemon) or DoctorFinding (CLI). Per AGENTS.md §2.4
 * no `@comis/infra` import.
 *
 * @module
 */

const TLS_CERT_ERROR_CODES = new Set([
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

const TLS_CERT_ERROR_PATTERNS = [
  /unable to get local issuer certificate/i,
  /unable to verify the first certificate/i,
  /self[- ]signed certificate/i,
  /certificate has expired/i,
];

const OPENAI_AUTH_PROBE_URL =
  "https://auth.openai.com/oauth/authorize?response_type=code" +
  "&client_id=app_EMoamEEZ73f0CkXaXp7hrann" +
  "&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback" +
  "&scope=openid+profile+email";

const DEFAULT_TIMEOUT_MS = 5000;

/** Discriminator for non-OK preflight outcomes. */
export type TlsPreflightFailureKind = "tls-cert" | "network";

/**
 * Discriminated union returned by runOAuthTlsPreflight.
 *
 * NOTE on Result<T,E> deviation: this shape predates AGENTS.md §2.1 in
 * the OpenClaw port. Callers pattern-match on `.kind` for actionable
 * routing, which is more ergonomic than `.error.kind`. RESEARCH §Q1
 * sanctions this as the one acceptable deviation in Phase 10.
 */
export type TlsPreflightResult =
  | { ok: true }
  | {
      ok: false;
      kind: TlsPreflightFailureKind;
      /** OpenSSL error code when available (e.g. UNABLE_TO_GET_ISSUER_CERT_LOCALLY). */
      code?: string;
      /** Raw error string for log `err` field — safe to surface to operators. */
      message: string;
    };

/** Options for the preflight probe. */
export interface RunOAuthTlsPreflightOptions {
  /** Defaults to 5000 ms (matches OpenClaw doctor variant; daemon-boot caller passes 4000). */
  timeoutMs?: number;
  /** Dependency-injected fetch — used by tests; defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Issue a single TLS preflight GET against auth.openai.com/oauth/authorize.
 *
 * Resolves to {ok:true} on any HTTP response (302 included — that's the
 * expected success path with redirect:"manual"). Resolves to {ok:false,
 * kind, code?, message} on fetch error.
 *
 * Never throws.
 */
export async function runOAuthTlsPreflight(
  opts?: RunOAuthTlsPreflightOptions,
): Promise<TlsPreflightResult> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts?.fetchImpl ?? fetch;
  try {
    await fetchImpl(OPENAI_AUTH_PROBE_URL, {
      method: "GET",
      redirect: "manual", // a 302 IS the success signal; do not follow
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: true };
  } catch (error) {
    return classifyTlsPreflightError(error);
  }
}

function classifyTlsPreflightError(error: unknown): TlsPreflightResult {
  // Inline narrowing — OpenClaw's asNullableObjectRecord helper is not
  // exported by Comis; duplicating ~3 lines is preferred over adding a
  // shared util (AGENTS.md §2.3 rule of three not yet met).
  const root = (error && typeof error === "object" ? error : {}) as Record<string, unknown>;
  const cause = (root.cause && typeof root.cause === "object" ? root.cause : {}) as Record<
    string,
    unknown
  >;
  const code = typeof cause.code === "string" ? cause.code : undefined;
  const message =
    typeof cause.message === "string"
      ? cause.message
      : typeof root.message === "string"
        ? root.message
        : String(error);
  const isTlsCert =
    (code ? TLS_CERT_ERROR_CODES.has(code) : false) ||
    TLS_CERT_ERROR_PATTERNS.some((re) => re.test(message));
  return { ok: false, kind: isTlsCert ? "tls-cert" : "network", code, message };
}
