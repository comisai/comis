// SPDX-License-Identifier: Apache-2.0
/**
 * proxy-agent.ts — Shared proxy-agent helper family.
 *
 * Three composition helpers over the net/ primitives:
 *   - resolveHttpsProxyAgent  → HttpsProxyAgent | undefined  (grammy, Slack, Baileys)
 *   - resolveUndiciProxyAgent → ProxyAgent | undefined       (discord.js REST)
 *   - resolveProxyUrl         → string | undefined           (imapflow, nodemailer)
 *
 * Each gates identically and returns undefined when ANY of these is true:
 *   (a) resolveEnvHttpProxyAgentOptions(env) is undefined → no proxy configured (zero-config)
 *   (b) matchesNoProxy(targetUrl, env) is true → host is in NO_PROXY
 *   (c) isSsrfBlocked(targetHost) is true → host is SSRF-blocked
 *
 * CA handling: callers may supply a PEM string via opts.ca — read from the global
 * proxy config at the caller's construction site. The function does NOT read caFile
 * from disk itself (no FS I/O at this layer).
 *
 * resolveProxyUrl returns the raw credential-bearing URL string — imapflow and
 * nodemailer need Proxy-Authorization and must receive the full URL.
 * sanitizeProxyUrl is used ONLY for any potential log line; the raw URL is never logged.
 */

import { HttpsProxyAgent } from "https-proxy-agent";
import { ProxyAgent } from "undici";
import {
  resolveEnvHttpProxyAgentOptions,
  matchesNoProxy,
  isSsrfBlocked,
} from "@comis/core";

// ---------------------------------------------------------------------------
// Options shared by HttpsProxyAgent and ProxyAgent helpers
// ---------------------------------------------------------------------------

/** Optional overrides for proxy-agent construction. */
export interface ProxyAgentOptions {
  /** PEM CA certificate string for TLS-intercepting proxies (from proxy.tls.caFile). */
  ca?: string | undefined;
}

// ---------------------------------------------------------------------------
// Internal gate: true when the target host should bypass the proxy
// ---------------------------------------------------------------------------

/**
 * Returns true when the target host must NOT be proxied:
 *   - no proxy is configured in env (zero-config)
 *   - the host matches an effective NO_PROXY entry
 *   - the host is SSRF-blocked
 */
function shouldBypass(
  targetHost: string,
  env: Record<string, string | undefined>,
): boolean {
  // (a) Zero-config gate — no proxy configured at all
  const options = resolveEnvHttpProxyAgentOptions(env);
  if (options === undefined) {
    return true;
  }

  // (b) NO_PROXY gate — build a synthetic target URL for matchesNoProxy
  // matchesNoProxy expects a URL string so it can parse the hostname
  const targetUrl = `https://${targetHost}`;
  if (matchesNoProxy(targetUrl, env)) {
    return true;
  }

  // (c) SSRF gate — block private/loopback/cloud-metadata hosts
  if (isSsrfBlocked(targetHost)) {
    return true;
  }

  return false;
}

/**
 * Resolve the proxy URL to use for a given env snapshot.
 * Prefers httpsProxy, falls back to httpProxy.
 * Returns undefined if neither is set (guarded by shouldBypass already).
 */
function resolveProxyUrlFromEnv(
  env: Record<string, string | undefined>,
): string | undefined {
  const options = resolveEnvHttpProxyAgentOptions(env);
  if (!options) {
    return undefined;
  }
  return options.httpsProxy ?? options.httpProxy;
}

// ---------------------------------------------------------------------------
// resolveHttpsProxyAgent — for node:http.Agent-based clients
// ---------------------------------------------------------------------------

/**
 * Returns an `HttpsProxyAgent` for use with node:http.Agent-compatible clients
 * (grammy, @slack/bolt, Baileys, ws), or `undefined` when:
 *   - no proxy is configured (zero-config)
 *   - the target host matches NO_PROXY
 *   - the target host is SSRF-blocked
 *
 * @param targetHost - Bare hostname (no scheme/port), e.g. "api.telegram.org"
 * @param env - Environment snapshot containing HTTP_PROXY / HTTPS_PROXY / NO_PROXY etc.
 *              Pass the daemon's `mergedEnv` snapshot — never `process.env` directly.
 * @param opts - Optional overrides (CA PEM for TLS-intercepting proxies).
 */
export function resolveHttpsProxyAgent(
  targetHost: string,
  env: Record<string, string | undefined>,
  opts: ProxyAgentOptions = {},
): HttpsProxyAgent<string> | undefined {
  if (shouldBypass(targetHost, env)) {
    return undefined;
  }

  const proxyUrl = resolveProxyUrlFromEnv(env);
  if (!proxyUrl) {
    return undefined;
  }

  return new HttpsProxyAgent(proxyUrl, opts.ca ? { ca: opts.ca } : undefined);
}

// ---------------------------------------------------------------------------
// resolveUndiciProxyAgent — for undici-based REST clients
// ---------------------------------------------------------------------------

/**
 * Returns an undici `ProxyAgent` for use with undici-based REST clients
 * (discord.js REST), or `undefined` under the same conditions as
 * `resolveHttpsProxyAgent`.
 *
 * @param targetHost - Bare hostname (no scheme/port), e.g. "discord.com"
 * @param env - Environment snapshot containing HTTP_PROXY / HTTPS_PROXY / NO_PROXY etc.
 * @param opts - Optional overrides (CA PEM for TLS-intercepting proxies).
 */
export function resolveUndiciProxyAgent(
  targetHost: string,
  env: Record<string, string | undefined>,
  opts: ProxyAgentOptions = {},
): ProxyAgent | undefined {
  if (shouldBypass(targetHost, env)) {
    return undefined;
  }

  const proxyUrl = resolveProxyUrlFromEnv(env);
  if (!proxyUrl) {
    return undefined;
  }

  return new ProxyAgent({
    uri: proxyUrl,
    ...(opts.ca ? { proxyTls: { ca: opts.ca } } : {}),
  });
}

// ---------------------------------------------------------------------------
// resolveProxyUrl — for native-proxy clients (imapflow, nodemailer)
// ---------------------------------------------------------------------------

/**
 * Returns the raw proxy URL string (credentials preserved — imapflow and nodemailer
 * need Proxy-Authorization), or `undefined` under the same conditions as
 * `resolveHttpsProxyAgent`.
 *
 * SECURITY: The returned URL may contain credentials. Do NOT log it raw — use
 * `sanitizeProxyUrl` for any log line. The credential is intentional: imapflow
 * and nodemailer rely on it for Proxy-Authorization.
 *
 * @param targetHost - Bare hostname (no scheme/port), e.g. "mail.example.com"
 * @param env - Environment snapshot containing HTTP_PROXY / HTTPS_PROXY / NO_PROXY etc.
 */
export function resolveProxyUrl(
  targetHost: string,
  env: Record<string, string | undefined>,
): string | undefined {
  if (shouldBypass(targetHost, env)) {
    return undefined;
  }

  return resolveProxyUrlFromEnv(env);
}
