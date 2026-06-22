// SPDX-License-Identifier: Apache-2.0
// Ported verbatim from ~/projects/openclaw/src/infra/net/proxy-env.ts
// with two adaptations: (1) env parameter changed from
// `NodeJS.ProcessEnv = process.env` to `Record<string, string | undefined>`
// (no default — callers must pass the daemon's mergedEnv snapshot, never
// process.env directly); (2) SPDX header.
// Proxy environment helpers mirror undici EnvHttpProxyAgent selection while
// adding OpenClaw NO_PROXY CIDR/wildcard bypass checks.
//
// PURE: zero runtime deps. Lives in @comis/core so both the runtime dispatcher
// (@comis/infra) and the offline `comis proxy validate` command (@comis/cli)
// share these primitives without a cli→infra edge.
import type { ProxyBootConfig } from "./proxy-config.js";

export const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;

/** Return whether any supported proxy environment variable is non-blank. */
export function hasProxyEnvConfigured(env: Record<string, string | undefined>): boolean {
  for (const key of PROXY_ENV_KEYS) {
    const value = env[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return true;
    }
  }
  return false;
}

function normalizeProxyEnvValue(value: string | undefined): string | null | undefined {
  // Empty lowercase env vars intentionally shadow uppercase values, matching
  // undici's EnvHttpProxyAgent precedence.
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Explicit proxy option shape accepted by undici EnvHttpProxyAgent. */
export type EnvHttpProxyAgentProxyOptions = {
  /** Proxy URL used for HTTP requests. */
  httpProxy?: string;
  /** Proxy URL used for HTTPS requests. */
  httpsProxy?: string;
};

/**
 * Match undici EnvHttpProxyAgent semantics for env-based HTTP/S proxy selection:
 * - lower-case vars take precedence over upper-case
 * - HTTPS requests prefer https_proxy/HTTPS_PROXY, then fall back to http_proxy/HTTP_PROXY
 * - ALL_PROXY is ignored by EnvHttpProxyAgent
 */
export function resolveEnvHttpProxyUrl(
  protocol: "http" | "https",
  env: Record<string, string | undefined>,
): string | undefined {
  const lowerHttpProxy = normalizeProxyEnvValue(env.http_proxy);
  const lowerHttpsProxy = normalizeProxyEnvValue(env.https_proxy);
  const httpProxy =
    lowerHttpProxy !== undefined ? lowerHttpProxy : normalizeProxyEnvValue(env.HTTP_PROXY);
  const httpsProxy =
    lowerHttpsProxy !== undefined ? lowerHttpsProxy : normalizeProxyEnvValue(env.HTTPS_PROXY);
  if (protocol === "https") {
    return httpsProxy ?? httpProxy ?? undefined;
  }
  return httpProxy ?? undefined;
}

/** Return whether EnvHttpProxyAgent-style HTTP/S proxy resolution finds a proxy URL. */
export function hasEnvHttpProxyConfigured(
  protocol: "http" | "https" = "https",
  env: Record<string, string | undefined>,
): boolean {
  return resolveEnvHttpProxyUrl(protocol, env) !== undefined;
}

function resolveEnvAllProxyUrl(env: Record<string, string | undefined>): string | undefined {
  const lowerAllProxy = normalizeProxyEnvValue(env.all_proxy);
  const allProxy =
    lowerAllProxy !== undefined ? lowerAllProxy : normalizeProxyEnvValue(env.ALL_PROXY);
  return allProxy ?? undefined;
}

/**
 * Build explicit options for undici's EnvHttpProxyAgent.
 *
 * EnvHttpProxyAgent does not read ALL_PROXY itself, but it accepts explicit
 * HTTP/HTTPS proxy overrides. Keep this helper separate from the
 * HTTP(S)-only URL helpers so SSRF trusted-env proxy gates do not widen.
 */
export function resolveEnvHttpProxyAgentOptions(
  env: Record<string, string | undefined>,
): EnvHttpProxyAgentProxyOptions | undefined {
  const allProxy = resolveEnvAllProxyUrl(env);
  const httpProxy = resolveEnvHttpProxyUrl("http", env) ?? allProxy;
  const httpsProxy = resolveEnvHttpProxyUrl("https", env) ?? httpProxy;
  const options: EnvHttpProxyAgentProxyOptions = {
    ...(httpProxy ? { httpProxy } : {}),
    ...(httpsProxy ? { httpsProxy } : {}),
  };
  return options.httpProxy || options.httpsProxy ? options : undefined;
}

/** Return whether explicit EnvHttpProxyAgent options can be built from the environment. */
export function hasEnvHttpProxyAgentConfigured(env: Record<string, string | undefined>): boolean {
  return resolveEnvHttpProxyAgentOptions(env) !== undefined;
}

/** Return whether a target URL should use configured HTTP/S env proxy variables. */
export function shouldUseEnvHttpProxyForUrl(
  targetUrl: string,
  env: Record<string, string | undefined>,
): boolean {
  let protocol: "http" | "https";
  try {
    const parsed = new URL(targetUrl);
    if (parsed.protocol === "http:") {
      protocol = "http";
    } else if (parsed.protocol === "https:") {
      protocol = "https";
    } else {
      return false;
    }
  } catch {
    return false;
  }

  return hasEnvHttpProxyConfigured(protocol, env) && !matchesNoProxy(targetUrl, env);
}

/**
 * Check whether a target URL should bypass the HTTP proxy per NO_PROXY env var.
 *
 * Mirrors undici EnvHttpProxyAgent semantics
 * (`undici/lib/dispatcher/env-http-proxy-agent.js`):
 * - Entries separated by commas OR whitespace (undici splits on `/[,\s]/`)
 * - Case-insensitive
 * - Empty or missing → no bypass
 * - Bare `*` value → bypass everything
 * - Exact hostname match
 * - Leading-dot match (`.example.com` matches `foo.example.com`)
 * - Leading `*.` wildcard match (`*.example.com` matches `foo.example.com`);
 *   undici normalizes via `.replace(/^\*?\./, '')`, so the bare domain also
 *   matches (kept in sync with that behavior)
 * - Subdomain suffix match (`openai.com` matches `api.openai.com`)
 * - Optional `:port` suffix; when present, must match target port
 * - IPv6 literals in bracketed (`[::1]`) or bare (`::1`) form
 * - OpenClaw extension: IPv4 CIDR and octet-wildcard entries
 *   (`100.64.0.0/10`, `100.64.*`) bypass the trusted env proxy mode before
 *   undici's EnvHttpProxyAgent is selected.
 *
 * Undici does not export its matcher, so this is a targeted reimplementation
 * kept in sync with the upstream file above. Paired with
 * `hasEnvHttpProxyConfigured` this gates the trusted-env-proxy auto-upgrade
 * in provider HTTP helpers; see openclaw#64974 review thread on NO_PROXY
 * SSRF bypass.
 */
export function matchesNoProxy(targetUrl: string, env: Record<string, string | undefined>): boolean {
  const raw = normalizeProxyEnvValue(env.no_proxy) ?? normalizeProxyEnvValue(env.NO_PROXY);
  if (!raw) {
    return false;
  }

  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return false;
  }

  const targetHost = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!targetHost) {
    return false;
  }

  if (raw === "*") {
    return true;
  }

  const targetPort =
    parsed.port !== ""
      ? parsed.port
      : parsed.protocol === "https:"
        ? "443"
        : parsed.protocol === "http:"
          ? "80"
          : "";

  // Undici tokenizes NO_PROXY on BOTH commas and whitespace (single-char
  // class, empty entries filtered below). Values like `"localhost *.corp"`
  // or `"a, b\tc"` must all parse correctly.
  for (const rawEntry of raw.split(/[,\s]/)) {
    const entry = rawEntry.trim().toLowerCase();
    if (!entry) {
      continue;
    }
    let entryHost: string;
    let entryPort: string | undefined;
    if (entry.startsWith("[")) {
      const m = entry.match(/^\[([^\]]+)\](?::(\d+))?$/);
      if (!m) {
        continue;
      }
      entryHost = m[1];
      entryPort = m[2];
    } else {
      const firstColonIdx = entry.indexOf(":");
      const lastColonIdx = entry.lastIndexOf(":");
      if (
        firstColonIdx > -1 &&
        firstColonIdx === lastColonIdx &&
        /^\d+$/.test(entry.slice(lastColonIdx + 1))
      ) {
        entryHost = entry.slice(0, lastColonIdx);
        entryPort = entry.slice(lastColonIdx + 1);
      } else {
        entryHost = entry;
      }
    }

    if (entryPort && entryPort !== targetPort) {
      continue;
    }

    // Mirror undici: strip optional leading `*` followed by `.` so both
    // `.example.com` and `*.example.com` normalize to `example.com`. That also
    // means apex hosts still match those entries after normalization.
    const normalizedEntry = entryHost.replace(/^\*\./, "").replace(/^\./, "");
    if (!normalizedEntry || normalizedEntry === "*") {
      continue;
    }

    if (matchesIpv4NoProxyPattern(targetHost, normalizedEntry)) {
      return true;
    }

    if (targetHost === normalizedEntry) {
      return true;
    }
    if (targetHost.endsWith("." + normalizedEntry)) {
      return true;
    }
  }
  return false;
}

function parseIpv4Address(host: string): number | undefined {
  const parts = host.split(".");
  if (parts.length !== 4) {
    return undefined;
  }
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return undefined;
    }
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
      return undefined;
    }
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

function matchesIpv4NoProxyPattern(targetHost: string, entryHost: string): boolean {
  const target = parseIpv4Address(targetHost);
  if (target === undefined) {
    return false;
  }

  const cidrMatch = entryHost.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/);
  if (cidrMatch) {
    const network = parseIpv4Address(cidrMatch[1]);
    const prefixLength = Number(cidrMatch[2]);
    if (network === undefined || prefixLength < 0 || prefixLength > 32) {
      return false;
    }
    const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
    return (target & mask) === (network & mask);
  }

  if (!entryHost.includes("*")) {
    return false;
  }
  const targetParts = targetHost.split(".");
  const patternParts = entryHost.split(".");
  if (patternParts.length > 4 || patternParts.length === 0) {
    return false;
  }
  for (let index = 0; index < patternParts.length; index += 1) {
    const part = patternParts[index];
    if (part === "*") {
      if (index === patternParts.length - 1) {
        return true;
      }
      continue;
    }
    if (!/^\d{1,3}$/.test(part) || Number(part) !== Number(targetParts[index])) {
      return false;
    }
  }
  return patternParts.length === targetParts.length;
}

// ---------------------------------------------------------------------------
// Default loopback/gateway/Ollama entries
// MUST be hostname-form only — undici's noProxy has NO CIDR support.
// ---------------------------------------------------------------------------

const DEFAULT_LOOPBACK_HOSTS = [
  "localhost",
  "127.0.0.1",
  "::1",
  // Gateway host (default 127.0.0.1:4766 — overridable via gatewayHostPort)
  "127.0.0.1:4766",
  // Ollama (localhost:11434) — always a local service
  "localhost:11434",
] as const;

// ---------------------------------------------------------------------------
// resolveEffectiveNoProxy — exported for test seam (pure predicate)
// ---------------------------------------------------------------------------

/**
 * Build the effective NO_PROXY string to pass to `EnvHttpProxyAgent({ noProxy })`.
 *
 * When `loopbackMode !== "proxy"`, the loopback set (localhost, 127.0.0.1, ::1)
 * plus the gateway (default 127.0.0.1:4766) and Ollama (localhost:11434) are
 * always unioned into the effective bypass list — regardless of what is in
 * `config.env.NO_PROXY`. This prevents the local gateway and Ollama from being
 * accidentally routed through the proxy.
 *
 * IMPORTANT: Only hostname-form entries are passed to undici — the library's
 * internal `#parseNoProxy()` has NO CIDR support. CIDR matching for our own
 * pre-checks belongs to `matchesNoProxy` above.
 *
 * @returns Comma-joined string, or empty string when nothing is configured.
 */
export function resolveEffectiveNoProxy(config: ProxyBootConfig): string {
  // Start from the env-configured NO_PROXY (or empty)
  const envNoProxy =
    config.env.NO_PROXY ?? config.env.no_proxy ?? "";

  const parts: string[] = envNoProxy
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (config.loopbackMode !== "proxy") {
    // Union loopback/gateway/Ollama entries (hostname-form only)
    const gatewayHostPort = config.gatewayHostPort ?? "127.0.0.1:4766";
    const loopbackEntries = new Set([
      ...DEFAULT_LOOPBACK_HOSTS,
      gatewayHostPort,
    ]);
    for (const entry of loopbackEntries) {
      if (!parts.includes(entry)) {
        parts.push(entry);
      }
    }
  }

  return parts.join(",");
}
