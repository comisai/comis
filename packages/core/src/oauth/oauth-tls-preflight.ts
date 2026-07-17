// SPDX-License-Identifier: Apache-2.0
/**
 * OAuth TLS preflight for OpenAI Codex `auth.openai.com`.
 *
 * Issues a single 5-second `fetch` GET against the OAuth authorize endpoint
 * and classifies failures as `tls-cert` (system CA bundle missing/broken;
 * fixable via `apt install ca-certificates` etc.) or `network` (DNS,
 * firewall, proxy — operator action required).
 *
 * This module is pure and renders no UI — the caller decides how to
 * surface the result. Derived from third-party code; see NOTICE.
 *
 * The probe URL uses the public OpenAI Codex client_id
 * `app_EMoamEEZ73f0CkXaXp7hrann` (NOT a Comis-distinct value) to avoid
 * fingerprinting in OpenAI logs.
 *
 * This module never logs — the caller is responsible for surfacing
 * the result via Pino (daemon) or DoctorFinding (CLI). No `@comis/infra`
 * import.
 *
 * @module
 */

const TLS_CERT_ERROR_CODES = [
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "ERR_TLS_CERT_ALTNAME_INVALID",
] as const;

/** Content-free OpenSSL certificate codes safe to expose to operators. */
export type TlsCertificateErrorCode = (typeof TLS_CERT_ERROR_CODES)[number];

/** Content-free network classification safe to expose to operators. */
export type TlsPreflightNetworkReason =
  | "timeout"
  | "dns"
  | "connection"
  | "proxy"
  | "other";

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
 * NOTE on Result<T,E> deviation: callers pattern-match on `.kind` for
 * actionable routing, which is more ergonomic here than `.error.kind`.
 */
export type TlsPreflightResult =
  | { ok: true }
  | {
      ok: false;
      kind: "tls-cert";
      /** Recognized OpenSSL error code; arbitrary dependency codes are discarded. */
      code?: TlsCertificateErrorCode;
    }
  | {
      ok: false;
      kind: "network";
      /** Bounded failure class; raw dependency errors never cross this boundary. */
      reason: TlsPreflightNetworkReason;
    };

/** Options for the preflight probe. */
export interface RunOAuthTlsPreflightOptions {
  /** Defaults to 5000 ms; the daemon-boot caller passes 4000. */
  timeoutMs?: number;
  /** Dependency-injected fetch — used by tests; defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Issue a single TLS preflight GET against auth.openai.com/oauth/authorize.
 *
 * Resolves to {ok:true} on any HTTP response (302 included — that's the
 * expected success path with redirect:"manual"). Failures expose only a
 * closed classification and a recognized certificate code when available.
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
  // Inline narrowing — duplicating ~3 lines of object-record coercion is
  // preferred over adding a shared util (rule of three not yet met).
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
  const knownTlsCode = TLS_CERT_ERROR_CODES.find((candidate) => candidate === code);
  const isTlsCert =
    knownTlsCode !== undefined ||
    TLS_CERT_ERROR_PATTERNS.some((re) => re.test(message));
  if (isTlsCert) {
    return knownTlsCode === undefined
      ? { ok: false, kind: "tls-cert" }
      : { ok: false, kind: "tls-cert", code: knownTlsCode };
  }
  return { ok: false, kind: "network", reason: classifyNetworkReason(code, message) };
}

function classifyNetworkReason(
  code: string | undefined,
  message: string,
): TlsPreflightNetworkReason {
  const evidence = `${code ?? ""} ${message}`;
  if (/timeout|timed out|abort|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/i.test(evidence)) {
    return "timeout";
  }
  if (/ENOTFOUND|EAI_AGAIN|EAI_FAIL|dns|name resolution/i.test(evidence)) {
    return "dns";
  }
  if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|socket hang up/i.test(evidence)) {
    return "connection";
  }
  if (/proxy|HTTP 407|tunnel/i.test(evidence)) {
    return "proxy";
  }
  return "other";
}
