/**
 * daemon-proxy-boot-helpers.ts
 *
 * Pure helper functions extracted from the bootFoundation composition root
 * so the proxy-install + posture logic is unit-testable without booting the
 * whole daemon.
 *
 * Used by:
 *   - daemon.ts  (production — composition root calls installProxyAtBoot +
 *                 logProxyPosture after setupLogging)
 *   - daemon-proxy-boot.test.ts  (unit tests — mock installGlobalProxyDispatcher)
 *
 * @allow-throw: composition-root fail-fast. A misconfigured proxy must abort
 * bootstrap (FATAL) rather than degrade to silent direct egress — there is no
 * Result channel above the boot foundation, so the throw IS the boundary
 * contract (mirrors the installGlobalProxyDispatcher fail-fast in @comis/infra).
 *
 * @module
 */

import { readFileSync } from "node:fs";
import { installGlobalProxyDispatcher } from "@comis/infra";
import {
  sanitizeProxyUrl,
  ProxyConfigError,
  resolveEnvHttpProxyAgentOptions,
  resolveEffectiveNoProxy,
} from "@comis/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Posture snapshot captured at the install site (before the daemon logger
 *  is available). Threaded onto the boot struct and emitted as a single
 *  INFO line after setupLogging(). */
export interface ProxyBootPosture {
  /** True when any proxy routing is active (env vars or config). */
  configured: boolean;
  /** sanitizeProxyUrl() output — credentials masked. Only set when configured. */
  maskedUrl?: string;
  /** Effective loopback-mode value passed to the installer. */
  loopbackMode?: "gateway-only" | "proxy" | "block";
  /** Where the proxy URL came from: config.yaml or env. */
  source?: "env" | "config" | "none";
  /** False only when the installer threw a non-ProxyConfigError (unexpected error). */
  installerOk: boolean;
  /** configKey string from ProxyConfigError (fail-closed path). */
  installerError?: string;
}

// ---------------------------------------------------------------------------
// Minimal container shape consumed by installProxyAtBoot
// ---------------------------------------------------------------------------

interface ProxyContainerSlice {
  config: {
    // Optional: production config always carries `proxy` (schema-proxy.ts applies
    // a full default), but partial/hand-built configs may omit it — absent is
    // treated as zero-config no-proxy, never a crash.
    proxy?: {
      enabled?: boolean;
      proxyUrl?: string | { $secret: string } | unknown;
      loopbackMode?: "gateway-only" | "proxy" | "block";
      tls?: { caFile?: string };
    };
    gateway: {
      host?: string;
      port?: number;
    };
  };
}

// ---------------------------------------------------------------------------
// installProxyAtBoot
// ---------------------------------------------------------------------------

/**
 * installProxyAtBoot — call at the daemon composition root between the
 * resolved container (line ~1336) and the Stage-2 env scrub (~line 1338).
 *
 * Builds a ProxyBootConfig from `container.config` + `mergedEnv`, calls
 * `installGlobalProxyDispatcher`, captures and returns a ProxyBootPosture.
 *
 * On ProxyConfigError: re-throws with a "Bootstrap failed" message naming
 * the configKey (D-03 fail-closed). On other errors: re-throws unchanged.
 *
 * DOES NOT log — the daemon logger is not yet available at this point.
 * Call logProxyPosture() after setupLogging() to emit the deferred INFO line.
 *
 * Pitfall 1: always pass mergedEnv (store-wins snapshot), never process.env.
 * Pitfall 6: typeof guard on proxyUrl handles unresolved SecretRef objects.
 */
export async function installProxyAtBoot(
  container: ProxyContainerSlice,
  mergedEnv: Record<string, string | undefined>,
): Promise<ProxyBootPosture> {
  const proxyCfg = container.config.proxy ?? {};
  const gw = container.config.gateway;

  const proxyUrl =
    typeof proxyCfg.proxyUrl === "string" ? proxyCfg.proxyUrl : undefined;

  // Distinguish an UNRESOLVED SecretRef from an absent value. If proxyUrl was
  // provided as a non-string (e.g. a `{$secret: ...}` object that secret
  // resolution left in place), the installer would otherwise fail-fast with the
  // misleading "proxy.proxyUrl is required" — pointing the operator at a key
  // they already set. Name the real cause instead.
  if (proxyCfg.enabled === true && proxyUrl === undefined && proxyCfg.proxyUrl != null) {
    throw new Error(
      "Bootstrap failed: proxy misconfigured — `proxy.proxyUrl` is set but did not " +
        "resolve to a string; verify its `{$secret: ...}` reference (the secret must " +
        "exist and be readable).",
    );
  }

  const gatewayHostPort = `${gw.host ?? "127.0.0.1"}:${gw.port ?? 4766}`;

  // Determine whether any proxy source is active BEFORE calling the installer.
  // Mirrors the Phase-2 hasProxyConfigured() logic (not exported):
  //   env: any of HTTPS_PROXY / HTTP_PROXY / ALL_PROXY set
  //   config: enabled===true AND proxyUrl is a string
  const envKeys = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];
  const envProxy = envKeys.find((k) => typeof mergedEnv[k] === "string" && mergedEnv[k] !== "");
  const configProxy = proxyCfg.enabled === true && typeof proxyUrl === "string" ? proxyUrl : undefined;
  // Note: the Phase-2 installer has its own hasProxyConfigured() gate; we compute
  // this independently so the posture can be captured accurately (inc. zero-config).
  // When neither env nor config proxy is active, the installer returns immediately
  // without calling setGlobalDispatcher (D-10 zero-config no-op).
  const configured = Boolean(envProxy ?? configProxy);

  try {
    installGlobalProxyDispatcher({
      env: mergedEnv,
      proxyUrl,
      enabled: proxyCfg.enabled,
      caFile: proxyCfg.tls?.caFile,
      loopbackMode: proxyCfg.loopbackMode,
      gatewayHostPort,
    });
  } catch (err) {
    if (err instanceof ProxyConfigError) {
      throw new Error(
        `Bootstrap failed: proxy misconfigured — set \`${err.configKey}\` in config.yaml: ${err.message}`,
        { cause: err },
      );
    }
    throw err;
  }

  if (!configured) {
    return { configured: false, installerOk: true };
  }

  // Determine the effective URL for masking (config beats env).
  const effectiveUrl = configProxy ?? (envProxy ? mergedEnv[envProxy]! : "");
  const maskedUrl = effectiveUrl ? sanitizeProxyUrl(effectiveUrl) : undefined;
  const source: ProxyBootPosture["source"] = configProxy
    ? "config"
    : envProxy
      ? "env"
      : "none";

  return {
    configured: true,
    maskedUrl,
    loopbackMode: (proxyCfg.loopbackMode as "gateway-only" | "proxy" | "block" | undefined) ?? "gateway-only",
    source,
    installerOk: true,
  };
}

// ---------------------------------------------------------------------------
// Channel-adapter proxy plumbing
//
// The global undici dispatcher (installGlobalProxyDispatcher) covers fetch/undici
// egress, but the HTTP-client channels (Telegram/Slack/WhatsApp/Discord-REST/Email)
// build their own proxy agents from an ENV snapshot via @comis/infra's
// resolve*ProxyAgent helpers — which read ONLY HTTP(S)_PROXY/ALL_PROXY, never the
// config.yaml `proxy.proxyUrl`. These helpers bridge that gap so a config-file
// proxy reaches the channel adapters too (and threads the TLS CA through).
// ---------------------------------------------------------------------------

/** Proxy slice consumed by the channel-env derivation (config.yaml `proxy:`). */
interface ProxyConfigSlice {
  enabled?: boolean;
  proxyUrl?: string | { $secret: string } | unknown;
  loopbackMode?: "gateway-only" | "proxy" | "block";
  tls?: { caFile?: string };
}

/**
 * deriveChannelProxyEnv — overlay a config.yaml proxy onto the env snapshot the
 * per-channel proxy resolvers read.
 *
 * The channel resolvers gate on `resolveEnvHttpProxyAgentOptions(env)` (env vars
 * only). When the operator configured the proxy via `proxy.enabled` +
 * `proxy.proxyUrl` (no env vars), those channels would otherwise bypass it. This
 * synthesizes HTTP(S)_PROXY + the effective NO_PROXY from config so the channels
 * route through the same proxy as the global dispatcher.
 *
 * Precedence: an env-var proxy already present → returned unchanged (env wins,
 * exactly as the global dispatcher resolves it). No config proxy → unchanged.
 */
export function deriveChannelProxyEnv(
  mergedEnv: Record<string, string | undefined>,
  proxyConfig: ProxyConfigSlice,
  gatewayConfig: { host?: string; port?: number },
): Record<string, string | undefined> {
  // Env-var proxy already configured → channels already see it.
  if (resolveEnvHttpProxyAgentOptions(mergedEnv) !== undefined) {
    return mergedEnv;
  }
  const proxyUrl =
    typeof proxyConfig.proxyUrl === "string" ? proxyConfig.proxyUrl : undefined;
  if (proxyConfig.enabled !== true || !proxyUrl) {
    return mergedEnv; // no config-file proxy → unchanged
  }

  const effectiveNoProxy = resolveEffectiveNoProxy({
    env: mergedEnv,
    proxyUrl,
    enabled: true,
    loopbackMode: proxyConfig.loopbackMode,
    gatewayHostPort: `${gatewayConfig.host ?? "127.0.0.1"}:${gatewayConfig.port ?? 4766}`,
  });

  // Set both NO_PROXY casings so matchesNoProxy (lowercase-wins) and any
  // uppercase-first reader see the same effective bypass list.
  return {
    ...mergedEnv,
    HTTPS_PROXY: proxyUrl,
    HTTP_PROXY: proxyUrl,
    NO_PROXY: effectiveNoProxy,
    no_proxy: effectiveNoProxy,
  };
}

/**
 * resolveProxyCaPem — read the PEM CA bundle for a TLS-intercepting proxy so the
 * per-channel proxy agents can trust it (parity with the global dispatcher,
 * which reads the same file). Returns undefined when no caFile is configured.
 *
 * Readability was already validated by installGlobalProxyDispatcher at boot
 * (which fail-fasts on an unreadable caFile BEFORE channels are wired), so a
 * read error here is treated as "no CA" rather than re-throwing.
 */
export function resolveProxyCaPem(caFile?: string): string | undefined {
  if (!caFile) {
    return undefined;
  }
  try {
    return readFileSync(caFile, "utf8");
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// logProxyPosture — deferred INFO emission (Pitfall 2: logger not ready at install)
// ---------------------------------------------------------------------------

/** Minimal Pino-compatible logger slice. */
interface LoggerSlice {
  info: (data: Record<string, unknown>, msg: string) => void;
}

/**
 * logProxyPosture — emit exactly one module:"proxy" INFO line when the proxy
 * dispatcher is active (D-07 / SC#1). Call AFTER setupLogging() (~line 1375).
 *
 * Emits nothing when posture.configured is false (D-10 zero-config gate).
 * Only maskedUrl is logged — the raw proxy URL is never interpolated (T-3-03).
 */
export function logProxyPosture(logger: LoggerSlice, posture: ProxyBootPosture): void {
  if (!posture.configured) {
    return;
  }
  logger.info(
    {
      submodule: "proxy",
      maskedUrl: posture.maskedUrl,
      loopbackMode: posture.loopbackMode,
      source: posture.source,
    },
    "Proxy dispatcher installed",
  );
}
