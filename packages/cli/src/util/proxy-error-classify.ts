// SPDX-License-Identifier: Apache-2.0
/**
 * Proxy error classifier and uncovered-transports manifest.
 *
 * Extracted from packages/cli/src/wizard/steps/06-channels.ts
 * (validateTelegramLive inline classifier) so that the
 * `comis proxy validate` command can share the same mapping without
 * duplicating the logic.
 *
 * Exports:
 *   - ProxyErrorKind  — union of recognised error categories
 *   - classifyProxyError(err) — maps an unknown thrown value to { errorKind, hint }
 *   - UNCOVERED_TRANSPORTS  — const list of transports NOT covered by the
 *     global EnvHttpProxyAgent dispatcher (IRC raw TCP accepted gap, Discord WS
 *     accepted gap, signal-cli env-covered; WhatsApp/Baileys is covered).
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Recognised proxy failure categories surfaced by classifyProxyError. */
export type ProxyErrorKind =
  | "proxy_unreachable"
  | "proxy_timeout"
  | "proxy_tls_error"
  | "proxy_unknown";

/** Result returned by classifyProxyError. */
export interface ProxyErrorClassification {
  errorKind: ProxyErrorKind;
  /** Human-readable, actionable guidance naming the relevant config knob. */
  hint: string;
}

// ---------------------------------------------------------------------------
// classifyProxyError
// ---------------------------------------------------------------------------

/**
 * Classify an unknown thrown value into a { errorKind, hint } pair.
 *
 * Mirrors the inline classifier in 06-channels.ts validateTelegramLive — keep
 * the same mapping contract so both callers behave identically.
 *
 * Priority order (mirrors 06-channels.ts):
 *   1. AbortError (err.name === "AbortError") → proxy_timeout
 *   2. err.cause.code ECONNREFUSED | ENOTFOUND → proxy_unreachable
 *   3. err.cause.code ETIMEDOUT → proxy_timeout
 *   4. cause.code starts with CERT_ OR cause.message has certificate/SSL/TLS → proxy_tls_error
 *   5. Anything else → proxy_unknown
 */
export function classifyProxyError(err: unknown): ProxyErrorClassification {
  // Check AbortError FIRST — an abort can also set cause in some Node versions.
  if (err instanceof Error && err.name === "AbortError") {
    return {
      errorKind: "proxy_timeout",
      hint: "The proxy did not respond in time — check the network path between this host and the proxy.",
    };
  }

  const cause =
    err instanceof Error
      ? (err.cause as Record<string, unknown> | undefined)
      : undefined;
  const code = typeof cause?.code === "string" ? cause.code : undefined;
  const causeMsg =
    typeof cause?.message === "string" ? cause.message : "";

  if (code === "ECONNREFUSED" || code === "ENOTFOUND") {
    return {
      errorKind: "proxy_unreachable",
      hint:
        "The proxy server could not be reached — verify HTTPS_PROXY / HTTP_PROXY are correct and the proxy is running.",
    };
  }

  if (code === "ETIMEDOUT") {
    return {
      errorKind: "proxy_timeout",
      hint: "Connection timed out — check the network path between this host and the proxy.",
    };
  }

  // TLS errors: CERT_* codes OR "certificate" / "SSL" / "TLS" in cause message
  if (
    code?.startsWith("CERT_") ||
    causeMsg.includes("certificate") ||
    causeMsg.includes("SSL") ||
    causeMsg.includes("TLS")
  ) {
    return {
      errorKind: "proxy_tls_error",
      hint:
        "TLS verification failed — set proxy.tls.caFile in config.yaml to the proxy CA certificate path.",
    };
  }

  // Unknown — no actionable knob identified
  return {
    errorKind: "proxy_unknown",
    hint:
      "An unexpected error occurred reaching the proxy — check proxy logs and HTTPS_PROXY / HTTP_PROXY.",
  };
}

// ---------------------------------------------------------------------------
// UNCOVERED_TRANSPORTS
// ---------------------------------------------------------------------------

/** Describes a transport that is NOT covered by the global EnvHttpProxyAgent dispatcher. */
export interface UncoveredTransport {
  /** Short display name, e.g. "IRC". */
  name: string;
  /** Why it is not covered by the global dispatcher. */
  reason: string;
  /** How coverage is addressed, e.g. "accepted-gap" or "env-covered" for already-env-proxied transports. */
  coveredInPhase: string;
}

/**
 * Transports whose outbound connections are NOT routed through the global
 * EnvHttpProxyAgent dispatcher.
 *
 * Used by `comis proxy validate --json` to surface coverage gaps to operators.
 *
 * Coverage reconciliation:
 *   - WhatsApp (Baileys): covered (undici ws-agent + socks5 wiring) — not listed here
 *   - IRC: accepted gap (SOCKS-only, no HTTP CONNECT, disproportionate complexity)
 *   - Discord WS: accepted gap (ws-agent wiring deferred; operator-controllable)
 *   - signal-cli: env-covered (JVM process inherits proxy env; scrub verified)
 */
export const UNCOVERED_TRANSPORTS: readonly UncoveredTransport[] = [
  {
    name: "IRC",
    reason:
      "IRC clients use raw TCP sockets — not an HTTP/HTTPS fetch path — so EnvHttpProxyAgent has no effect. irc-framework is SOCKS-only; HTTP CONNECT is not supported. Accepted gap: low-volume, operator-controllable channel. See docs/security/network-proxy.md (XPORT-06).",
    coveredInPhase: "accepted-gap",
  },
  {
    name: "Discord WS",
    reason:
      "The Discord gateway connection is a WebSocket upgrade initiated by the discord.js library, which does not use the undici global dispatcher. ws-agent wiring is a disproportionate change for the current phase. Accepted gap: operator-controllable. See docs/security/network-proxy.md (XPORT-02).",
    coveredInPhase: "accepted-gap",
  },
  {
    name: "signal-cli",
    reason:
      "signal-cli is a separate JVM process that inherits process.env (https_proxy / http_proxy / HTTP_PROXY / HTTPS_PROXY / ALL_PROXY / NO_PROXY). It is env-covered — the global dispatcher does not apply to it, but env var injection is sufficient. The daemon Stage-1 scrub deliberately excludes these keys (verified by daemon.test.ts XPORT-07). signal-client.ts itself uses fetch → global dispatcher for the HTTP/SSE API channel.",
    coveredInPhase: "env-covered",
  },
] as const;
