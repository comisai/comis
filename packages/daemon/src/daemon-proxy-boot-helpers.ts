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
 * @module
 */

import { installGlobalProxyDispatcher } from "@comis/infra";
import { sanitizeProxyUrl, ProxyConfigError } from "@comis/core";

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
    proxy: {
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
  const proxyCfg = container.config.proxy;
  const gw = container.config.gateway;

  const proxyUrl =
    typeof proxyCfg.proxyUrl === "string" ? proxyCfg.proxyUrl : undefined;

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
