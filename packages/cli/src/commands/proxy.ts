// SPDX-License-Identifier: Apache-2.0
/**
 * `comis proxy validate` — offline proxy diagnostic command.
 *
 * Confirms that the configured egress proxy is reachable, that the loopback
 * gateway address (localhost:4766) is correctly bypassed, and lists transports
 * NOT covered by the global EnvHttpProxyAgent dispatcher.
 *
 * OFFLINE — does not require a running daemon. Reads proxy settings from
 * config.yaml and from the environment (HTTPS_PROXY / HTTP_PROXY / NO_PROXY).
 *
 * Design:
 *   - Uses a ONE-OFF undici dispatcher (NOT installGlobalProxyDispatcher, NOT
 *     globalThis.fetch) so this command never mutates CLI-wide state.
 *   - SSRF pre-check (isSsrfBlocked) runs BEFORE any dispatcher is constructed
 *     — a private/loopback/metadata --target is rejected with ZERO network connects.
 *   - Loopback canary via resolveEffectiveNoProxy + matchesNoProxy asserts that
 *     localhost:4766 is NOT routed through the proxy.
 *   - Every displayed proxy URL is run through sanitizeProxyUrl so
 *     credentials never appear in output.
 *   - classifyProxyError maps connection failures into errorKind + hint.
 *   - UNCOVERED_TRANSPORTS surfaced in --json output.
 *
 * @module
 */

import * as dnsPromises from "node:dns/promises";
import * as os from "node:os";
import type { Command } from "commander";
import { fetch as undiciFetch, EnvHttpProxyAgent, ProxyAgent } from "undici";
import {
  isSsrfBlocked,
  resolveEnvHttpProxyAgentOptions,
  resolveEffectiveNoProxy,
  matchesNoProxy,
  sanitizeProxyUrl,
  loadConfigFile,
} from "@comis/core";
import { info, error, json as jsonOutput } from "../output/format.js";
import {
  classifyProxyError,
  UNCOVERED_TRANSPORTS,
} from "../util/proxy-error-classify.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options accepted by the validate subcommand. */
export interface ProxyValidateOptions {
  target: string;
  timeoutMs: number;
  json: boolean;
}

/** Structured result returned by runProxyValidate (testable, no process.exit). */
export interface ProxyValidateResult {
  probeOk: boolean;
  /** HTTP status from the probe, if the connection succeeded. */
  status?: number;
  /** Classified failure kind, if the probe failed. */
  errorKind?: string;
  /** Actionable guidance for the error kind. */
  hint?: string;
  /** The --target URL that was probed. */
  target: string;
  /** Proxy URL with credentials masked (undefined = no proxy configured). */
  proxyUrlMasked?: string;
  /**
   * True when matchesNoProxy("http://localhost:4766", env) confirms that the
   * gateway loopback address is excluded from the proxy.
   */
  loopbackCanaryBypassed: boolean;
  /**
   * Names of transports NOT covered by the global EnvHttpProxyAgent dispatcher.
   * Populated in --json mode and always included in the result object.
   */
  uncoveredTransports: string[];
  /** Human-readable status message. */
  message?: string;
}

// ---------------------------------------------------------------------------
// registerProxyCommand
// ---------------------------------------------------------------------------

/**
 * Register the `proxy` command group and the `proxy validate` subcommand.
 *
 * Wire after registerFleetCommand in cli.ts. The parent `proxy` command has
 * NO .action() (a parent .action() swallows subcommand routing).
 */
export function registerProxyCommand(program: Command): void {
  // Parent: no .action() — subcommand routing only
  const proxyCmd = program
    .command("proxy")
    .description("Proxy diagnostics");

  proxyCmd
    .command("validate")
    .description(
      "Validate proxy reachability, loopback bypass, and transport coverage (offline — no daemon needed)",
    )
    .option(
      "--target <url>",
      "Target URL to probe through the proxy",
      "https://api.telegram.org",
    )
    .option(
      "--timeout-ms <ms>",
      "Probe timeout in milliseconds",
      (v) => parseInt(v, 10),
      5000,
    )
    .option("--json", "Output machine-readable JSON", false)
    .action(
      async (options: { target: string; timeoutMs: number; json: boolean }) => {
        const result = await runProxyValidate(options);
        if (options.json) {
          jsonOutput(result);
        } else {
          printTable(result);
        }
        process.exit(result.probeOk && result.loopbackCanaryBypassed ? 0 : 1);
      },
    );
}

// ---------------------------------------------------------------------------
// printTable — human-readable output
// ---------------------------------------------------------------------------

function printTable(result: ProxyValidateResult): void {
  info(`Target: ${result.target}`);
  if (result.proxyUrlMasked) {
    info(`Proxy:  ${result.proxyUrlMasked}`);
  } else {
    info("Proxy:  (none configured)");
  }
  info(`Probe:  ${result.probeOk ? "OK" : "FAILED"}`);
  if (result.status !== undefined) {
    info(`Status: HTTP ${result.status}`);
  }
  if (result.errorKind) {
    error(`Error kind: ${result.errorKind}`);
  }
  if (result.hint) {
    info(`Hint:   ${result.hint}`);
  }
  info(
    `Loopback canary (localhost:4766 bypasses proxy): ${result.loopbackCanaryBypassed ? "PASS" : "FAIL"}`,
  );
  if (result.uncoveredTransports.length > 0) {
    info(
      `Uncovered transports (not routed via EnvHttpProxyAgent): ${result.uncoveredTransports.join(", ")}`,
    );
  }
}

// ---------------------------------------------------------------------------
// ssrfCheckTarget — SSRF guard
// ---------------------------------------------------------------------------

/**
 * Check whether --target is SSRF-blocked BEFORE any dispatcher is constructed.
 *
 * Fast-path: if the hostname is already a blocked IP literal, reject immediately.
 * DNS-path: for non-IP hostnames, resolve each address and check isSsrfBlocked.
 *
 * Returns undefined on success (safe to proceed); returns an error string when
 * the target must be rejected.
 */
async function ssrfCheckTarget(
  targetUrl: string,
): Promise<string | undefined> {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return "Invalid --target URL";
  }

  const hostname = parsed.hostname;

  // Fast-path: literal IP or known loopback hostname
  if (isSsrfBlocked(hostname)) {
    return `SSRF guard: target hostname "${hostname}" resolves to a blocked address (loopback/private/metadata)`;
  }

  // DNS-resolve non-IP hostnames and check each resolved address
  // Skip DNS resolution for IP-looking hostnames (already checked above)
  const isIpLiteral = /^[\d.]+$/.test(hostname) || hostname.includes(":");
  if (!isIpLiteral) {
    try {
      const [addrs4, addrs6] = await Promise.allSettled([
        dnsPromises.resolve4(hostname),
        dnsPromises.resolve6(hostname),
      ]);
      const allAddrs: string[] = [];
      if (addrs4.status === "fulfilled") allAddrs.push(...addrs4.value);
      if (addrs6.status === "fulfilled") allAddrs.push(...addrs6.value);

      for (const addr of allAddrs) {
        if (isSsrfBlocked(addr)) {
          return `SSRF guard: target "${hostname}" resolves to a blocked address (${addr})`;
        }
      }
    } catch {
      // DNS resolution failure is not a security issue — proceed
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// runProxyValidate — the testable core function (no process.exit)
// ---------------------------------------------------------------------------

/**
 * Run the proxy validation logic and return a structured result.
 *
 * @param options - CLI options (target, timeoutMs, json)
 * @param envOverride - Optional environment override for testing (replaces process.env)
 */
export async function runProxyValidate(
  options: ProxyValidateOptions,
  envOverride?: Record<string, string | undefined>,
): Promise<ProxyValidateResult> {
  const env = envOverride ?? (process.env as Record<string, string | undefined>);
  const target = options.target;
  const timeoutMs = options.timeoutMs;

  // Step 1: SSRF pre-check BEFORE any dispatcher construction
  const ssrfError = await ssrfCheckTarget(target);
  if (ssrfError) {
    return {
      probeOk: false,
      errorKind: "proxy_unknown",
      hint: ssrfError,
      target,
      loopbackCanaryBypassed: false,
      uncoveredTransports: UNCOVERED_TRANSPORTS.map((t) => t.name),
      message: ssrfError,
    };
  }

  // Step 2: Resolve proxy config offline (no daemon needed)
  // Try to load config file for the explicit proxy.proxyUrl path; fall back to
  // env-only if config is absent or fails to parse.
  // When envOverride is provided (test seam), skip disk config to avoid reading
  // the operator's real ~/.comis/config.yaml and contaminating test assertions.
  let configProxyUrl: string | undefined;
  let configEnabled = false;
  let loopbackMode: "gateway-only" | "proxy" | "block" = "gateway-only";

  if (!envOverride) {
    // Production path: read from disk
    try {
      const configPaths = env["COMIS_CONFIG_PATHS"] ?? `${os.homedir()}/.comis/config.yaml`;
      const configResult = loadConfigFile(configPaths, { getSecret: (key) => env[key] });
      if (configResult.ok && configResult.value) {
        const raw = configResult.value as Record<string, unknown>;
        const proxySection = raw["proxy"] as
          | { enabled?: boolean; proxyUrl?: string; loopbackMode?: string }
          | undefined;
        if (proxySection) {
          configEnabled = proxySection.enabled ?? false;
          configProxyUrl =
            typeof proxySection.proxyUrl === "string"
              ? proxySection.proxyUrl
              : undefined;
          loopbackMode =
            (proxySection.loopbackMode as "gateway-only" | "proxy" | "block") ??
            "gateway-only";
        }
      }
    } catch {
      // Config load failure is non-fatal — fall through to env-only
    }
  }

  // Step 3: Loopback canary
  // Build a synthetic ProxyBootConfig shape for resolveEffectiveNoProxy
  const proxyBootConfig = {
    env: env as Record<string, string | undefined>,
    loopbackMode,
    gatewayHostPort: "localhost:4766",
    enabled: configEnabled,
    proxyUrl: configProxyUrl,
  };
  const effectiveNoProxy = resolveEffectiveNoProxy(proxyBootConfig as Parameters<typeof resolveEffectiveNoProxy>[0]);
  const loopbackCanaryBypassed = matchesNoProxy("http://localhost:4766", {
    ...env,
    NO_PROXY: effectiveNoProxy,
  });

  // Step 4: Resolve proxy URL for display (masked) and for dispatcher
  const envProxyOpts = resolveEnvHttpProxyAgentOptions(env);
  // resolveEnvHttpProxyAgentOptions returns {httpProxy?, httpsProxy?} (not {uri})
  const envProxyUrl: string | undefined =
    envProxyOpts?.httpsProxy ??
    envProxyOpts?.httpProxy ??
    env["HTTPS_PROXY"] ??
    env["https_proxy"] ??
    env["HTTP_PROXY"] ??
    env["http_proxy"];

  // Raw proxy URL (from env or config)
  const rawProxyUrl = envProxyUrl ?? (configEnabled ? configProxyUrl : undefined);
  const proxyUrlMasked = rawProxyUrl ? sanitizeProxyUrl(rawProxyUrl) : undefined;

  // Step 5: Build uncoveredTransports list (always populated)
  const uncoveredTransports = UNCOVERED_TRANSPORTS.map((t) => t.name);

  // Step 6: Probe
  if (!rawProxyUrl) {
    // No proxy configured — nothing to validate
    return {
      probeOk: false,
      errorKind: "proxy_unknown",
      hint: "No proxy configured — set HTTPS_PROXY or proxy.proxyUrl in config.yaml",
      target,
      proxyUrlMasked: undefined,
      loopbackCanaryBypassed,
      uncoveredTransports,
      message: "No proxy configured",
    };
  }

  try {
    // Build a one-off dispatcher (NOT installGlobalProxyDispatcher)
    let dispatcher: EnvHttpProxyAgent | ProxyAgent;

    if (envProxyUrl) {
      // Env-var path: EnvHttpProxyAgent with explicit noProxy to honour effectiveNoProxy
      dispatcher = new EnvHttpProxyAgent({
        httpProxy: env["HTTP_PROXY"] ?? env["http_proxy"],
        httpsProxy: env["HTTPS_PROXY"] ?? env["https_proxy"],
        noProxy: effectiveNoProxy,
        allowH2: false,
      });
    } else {
      // Explicit config path: ProxyAgent from config proxyUrl
      dispatcher = new ProxyAgent({
        uri: configProxyUrl!,
        allowH2: false,
      });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await undiciFetch(target, {
        method: "HEAD",
        signal: controller.signal,
        dispatcher,
      });
      clearTimeout(timer);

      return {
        probeOk: true,
        status: response.status,
        target,
        proxyUrlMasked,
        loopbackCanaryBypassed,
        uncoveredTransports,
        message: `Probe succeeded — HTTP ${response.status}`,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (err: unknown) {
    const { errorKind, hint } = classifyProxyError(err);
    return {
      probeOk: false,
      errorKind,
      hint,
      target,
      proxyUrlMasked,
      loopbackCanaryBypassed,
      uncoveredTransports,
      message: `Probe failed: ${errorKind}`,
    };
  }
}
