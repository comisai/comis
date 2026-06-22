// SPDX-License-Identifier: Apache-2.0
/**
 * proxy-dispatcher.ts — Global undici dispatcher installer.
 *
 * `installGlobalProxyDispatcher(config)` is the integration seam the daemon + CLI
 * call at boot. It wires three primitives into one idempotent,
 * zero-config-safe, SSRF-guarded global dispatcher:
 *
 *   1. proxy-env.ts   — resolveEnvHttpProxyAgentOptions (ALL_PROXY, lowercase-wins)
 *   2. ssrf-blocklist.ts — ssrfBlockInterceptor (compose-compatible interceptor)
 *   3. sanitize.ts    — sanitizeProxyUrl (credential-safe error messages)
 *
 * Design invariants:
 *   - env-first: env proxy vars → EnvHttpProxyAgent; explicit proxyUrl → ProxyAgent
 *   - SHA-256 fingerprint idempotency: same config → no-op, reference-equal
 *   - loopback forcing: gateway(4766) + Ollama(11434) + loopback set always
 *     forced into effective NO_PROXY unless loopbackMode="proxy"
 *   - TLS CA: caFile → readFileSync → proxyTls.ca on the agent
 *   - fail-fast: ProxyConfigError naming the exact key on misconfigured inputs
 *   - no @comis/core import (standalone structural type)
 *   - reads ONLY config.env, never process.env
 *   - installation is NOT a module side effect — only inside the exported fn
 *   - noProxy ALWAYS passed explicitly (EnvHttpProxyAgent re-reads process.env
 *     at dispatch time unless the explicit option is set)
 *
 * @allow-throw: fail-fast config validation. A self-contradictory proxy config
 * (enabled without proxyUrl, unreadable caFile) throws ProxyConfigError naming
 * the exact dotted key so the daemon aborts boot rather than installing a
 * half-configured dispatcher — the throw is the documented boundary contract.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  EnvHttpProxyAgent,
  setGlobalDispatcher,
} from "undici";
import {
  resolveEnvHttpProxyAgentOptions,
  resolveEffectiveNoProxy,
  resolveLoopbackExemptHosts,
  sanitizeProxyUrl,
  type ProxyBootConfig,
  ProxyConfigError,
} from "@comis/core";
import { createSsrfBlockInterceptor } from "./ssrf-blocklist.js";

// ---------------------------------------------------------------------------
// Module-level idempotency state
// DO NOT install at module load
// ---------------------------------------------------------------------------

let lastInstalledKey: string | null = null;
let lastInstalledDispatcher: ReturnType<typeof EnvHttpProxyAgent.prototype.compose> | null = null;

// ---------------------------------------------------------------------------
// fingerprintConfig — SHA-256 of stable sorted resolved options
// ---------------------------------------------------------------------------

function fingerprintConfig(config: ProxyBootConfig): string {
  const entries = Object.entries({
    httpProxy: config.env.HTTP_PROXY ?? config.env.http_proxy ?? "",
    httpsProxy: config.env.HTTPS_PROXY ?? config.env.https_proxy ?? "",
    allProxy: config.env.ALL_PROXY ?? config.env.all_proxy ?? "",
    noProxy: config.env.NO_PROXY ?? config.env.no_proxy ?? "",
    proxyUrl: config.proxyUrl ?? "",
    caFile: config.caFile ?? "",
    loopbackMode: config.loopbackMode ?? "gateway-only",
    gatewayHostPort: config.gatewayHostPort ?? "127.0.0.1:4766",
    enabled: String(config.enabled ?? false),
  }).sort(([a], [b]) => a.localeCompare(b));

  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

// ---------------------------------------------------------------------------
// hasProxyConfigured — zero-config no-op guard
// ---------------------------------------------------------------------------

function hasProxyConfigured(config: ProxyBootConfig): boolean {
  // env-based proxy
  if (resolveEnvHttpProxyAgentOptions(config.env) !== undefined) {
    return true;
  }
  // explicit proxyUrl (with enabled flag)
  if (config.enabled && config.proxyUrl) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// installGlobalProxyDispatcher — the integration seam the daemon + CLI call
// ---------------------------------------------------------------------------

/**
 * Install a SSRF-guarded undici global dispatcher based on `config`.
 *
 * Behaviour:
 * - `enabled === true` + no `proxyUrl` → throw `ProxyConfigError("proxy.proxyUrl")`
 * - `caFile` set + unreadable → throw `ProxyConfigError("proxy.tls.caFile")`
 * - same config (SHA-256) already installed → no-op (idempotent)
 * - no proxy configured in env + no explicit proxyUrl → no-op, leaves global
 *   dispatcher unchanged (zero-config preservation)
 * - env proxy configured → install `EnvHttpProxyAgent` with effective NO_PROXY
 *   (loopback forced in), SSRF interceptor composed, `setGlobalDispatcher`
 * - explicit `proxyUrl` (enabled, no env) → install `ProxyAgent`
 *
 * The installer reads ONLY `config.env` — never `process.env`.
 * Installation is NOT a module side effect.
 * `noProxy` is ALWAYS passed explicitly to undici.
 */
export function installGlobalProxyDispatcher(config: ProxyBootConfig): void {
  // -------------------------------------------------------------------------
  // Step 1: Fail-fast checks BEFORE any install
  // -------------------------------------------------------------------------

  // enabled=true without proxyUrl → naming the exact key
  if (config.enabled === true && !config.proxyUrl) {
    throw new ProxyConfigError(
      "proxy.proxyUrl is required when proxy.enabled is true",
      "proxy.proxyUrl",
    );
  }

  // caFile set → read now (fail-fast; never fallback-silent)
  let ca: string | undefined;
  if (config.caFile) {
    try {
      ca = readFileSync(config.caFile, "utf8");
    } catch (cause) {
      throw new ProxyConfigError(
        `proxy.tls.caFile is configured but unreadable: ${sanitizeProxyUrl(config.caFile)}`,
        "proxy.tls.caFile",
        { cause: cause as Error },
      );
    }
  }

  // -------------------------------------------------------------------------
  // Step 2: Fingerprint check — idempotency
  // -------------------------------------------------------------------------

  const key = fingerprintConfig(config);
  if (lastInstalledKey === key && lastInstalledDispatcher !== null) {
    return; // no-op: reference-equal dispatcher already installed
  }

  // -------------------------------------------------------------------------
  // Step 3: Zero-config no-op
  // -------------------------------------------------------------------------

  if (!hasProxyConfigured(config)) {
    return; // no proxy → leave global dispatcher unchanged
  }

  // -------------------------------------------------------------------------
  // Step 4: Compute effective NO_PROXY
  // -------------------------------------------------------------------------

  const effectiveNoProxy = resolveEffectiveNoProxy(config);

  // -------------------------------------------------------------------------
  // Step 5: Build the undici agent
  // -------------------------------------------------------------------------

  const proxyTls = ca ? { ca } : undefined;
  const envOptions = resolveEnvHttpProxyAgentOptions(config.env);

  // Both paths use EnvHttpProxyAgent so `noProxy` (and therefore loopbackMode)
  // is honored uniformly. undici's plain ProxyAgent has NO noProxy option, so
  // the explicit-proxyUrl (config.yaml) path used to force loopback through the
  // proxy and ignore loopbackMode entirely — EnvHttpProxyAgent with explicit
  // http/https proxy options fixes that. noProxy MUST be explicit: EnvHttpProxyAgent
  // re-reads process.env.NO_PROXY at dispatch time unless the option overrides it.
  const proxyOptions = envOptions ?? {
    httpProxy: config.proxyUrl!,
    httpsProxy: config.proxyUrl!,
  };

  const agent: EnvHttpProxyAgent = new EnvHttpProxyAgent({
    ...proxyOptions,
    noProxy: effectiveNoProxy,
    ...(proxyTls ? { proxyTls } : {}),
    allowH2: false,
  });

  // -------------------------------------------------------------------------
  // Step 6: Compose SSRF interceptor (blocks BEFORE connect)
  // -------------------------------------------------------------------------

  // The interceptor runs ABOVE the NO_PROXY routing decision and blocks ALL
  // loopback/private ranges via isSsrfBlocked. In gateway-only / proxy modes the
  // trusted loopback + gateway hosts must stay reachable, so they are passed as
  // an exempt allowlist. In block mode the allowlist is empty → loopback stays
  // blocked, which is exactly what block mode means.
  const exemptHosts = new Set(resolveLoopbackExemptHosts(config));
  const guarded = agent.compose(createSsrfBlockInterceptor(exemptHosts));

  // -------------------------------------------------------------------------
  // Step 7: Install globally + record fingerprint
  // -------------------------------------------------------------------------

  setGlobalDispatcher(guarded);
  lastInstalledKey = key;
  lastInstalledDispatcher = guarded;
}

// ---------------------------------------------------------------------------
// resetProxyDispatcherForTests — test isolation hook
// ---------------------------------------------------------------------------

/**
 * Reset module-level idempotency state so tests can reinstall with any config.
 * Call in `afterEach` alongside restoring the original global dispatcher via
 * `setGlobalDispatcher(originalDispatcher)`.
 *
 * NEVER call in production code.
 */
export function resetProxyDispatcherForTests(): void {
  lastInstalledKey = null;
  lastInstalledDispatcher = null;
}
