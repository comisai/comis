// SPDX-License-Identifier: Apache-2.0
/**
 * proxy-config.ts — Standalone structural types for the proxy dispatcher installer.
 *
 * `ProxyBootConfig` is intentionally decoupled from `@comis/core`'s `ProxyConfig`.
 * The daemon/CLI call site maps @comis/core's ProxyConfig → this shape.
 *
 * Pure: zero runtime deps. Lives in @comis/core so both the runtime dispatcher
 * (@comis/infra) and the offline `comis proxy validate` command (@comis/cli)
 * can depend on the same contract without a cli→infra edge.
 */

// ---------------------------------------------------------------------------
// ProxyBootConfig — the installer's input contract
// ---------------------------------------------------------------------------

/**
 * Structural input type for `installGlobalProxyDispatcher`.
 *
 * Fields:
 * - `env` — a post-scrub env snapshot (e.g. daemon's `mergedEnv`). MUST be a
 *   snapshot, never `process.env` directly (after `scrubProcessEnv()` the live
 *   env is cleared). The installer reads only this field, never `process.env`.
 * - `proxyUrl` — explicit operator-provided proxy URL (plain string or
 *   resolved from a SecretRef at the call site).
 * - `enabled` — when `true` + `proxyUrl` is absent → fail-fast `ProxyConfigError`.
 * - `caFile` — path to a PEM CA certificate for TLS-intercepting proxy support.
 *   Read with `readFileSync` at install time; fail-fast if unreadable.
 * - `loopbackMode` — controls how loopback/gateway addresses are handled:
 *     - `"gateway-only"` (default): localhost + 127.0.0.0/8 + ::1 + gateway(4766)
 *       + Ollama(11434) are always forced into effective NO_PROXY.
 *     - `"proxy"`: loopback traffic is allowed through the proxy (operator opt-in).
 *     - `"block"`: loopback connections are blocked (SSRF interceptor handles this).
 * - `gatewayHostPort` — override for the gateway host:port added to effective
 *   NO_PROXY in `gateway-only` mode. Defaults to `"127.0.0.1:4766"`.
 */
export interface ProxyBootConfig {
  /**
   * Post-scrub environment snapshot containing HTTP_PROXY / HTTPS_PROXY /
   * NO_PROXY / ALL_PROXY etc. Never pass `process.env` directly — use the
   * daemon's `mergedEnv` snapshot or an explicit stub in tests.
   */
  env: Record<string, string | undefined>;

  /**
   * Explicit proxy URL (operator override). When `enabled === true` and this
   * is absent, `installGlobalProxyDispatcher` throws `ProxyConfigError`.
   */
  proxyUrl?: string | undefined;

  /**
   * Whether the explicit-proxyUrl path is required.
   * `true` + absent `proxyUrl` → fail-fast `ProxyConfigError("proxy.proxyUrl")`.
   */
  enabled?: boolean | undefined;

  /**
   * Path to a PEM CA certificate for the TLS-intercepting proxy endpoint.
   * Read at install time; fail-fast with `ProxyConfigError("proxy.tls.caFile")`
   * if the path is set but unreadable.
   */
  caFile?: string | undefined;

  /**
   * Loopback routing policy.
   * - `"gateway-only"` (default) — force loopback + gateway + Ollama into effective NO_PROXY.
   * - `"proxy"` — route loopback through the proxy (operator opt-in).
   * - `"block"` — block loopback connections via the SSRF interceptor.
   */
  loopbackMode?: "gateway-only" | "proxy" | "block" | undefined;

  /**
   * Gateway host:port added to effective NO_PROXY in `gateway-only` mode.
   * Default: `"127.0.0.1:4766"`.
   */
  gatewayHostPort?: string | undefined;
}

// ---------------------------------------------------------------------------
// ProxyConfigError — fail-fast error class
// ---------------------------------------------------------------------------

/**
 * Thrown by `installGlobalProxyDispatcher` when the proxy configuration is
 * self-contradictory or referencing a missing resource:
 *   - `enabled === true` but `proxyUrl` is absent → configKey = `"proxy.proxyUrl"`
 *   - `caFile` is set but unreadable → configKey = `"proxy.tls.caFile"`
 *
 * `configKey` names the exact dotted YAML/config key that is misconfigured so
 * operators can fix it without reading source. The error message MUST NOT
 * contain raw proxy credentials — use `sanitizeProxyUrl` before interpolation.
 */
export class ProxyConfigError extends Error {
  /** Dotted config key that is misconfigured, e.g. `"proxy.proxyUrl"`. */
  readonly configKey: string;

  constructor(message: string, configKey: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProxyConfigError";
    this.configKey = configKey;
  }
}
