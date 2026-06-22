// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { SecretRefSchema } from "../domain/secret-ref.js";

/**
 * Helper: returns true only for http: and https: protocol URLs.
 *
 * Uses the WHATWG URL parser (security requirement) — do not hand-roll
 * a regex over the raw string. Rejects socks5://, file://, malformed values.
 */
function isHttpOrHttpsProxyUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Loopback handling mode for the proxy.
 *
 * - gateway-only (default): local gateway (127.0.0.1:4766) and loopback
 *   addresses are never proxied — security-conservative; local Ollama etc.
 *   are unreachable through the proxy.
 * - proxy: all traffic including loopback goes through the proxy.
 * - block: loopback traffic is completely blocked.
 */
export const ProxyLoopbackModeSchema = z.enum(["gateway-only", "proxy", "block"]);

/**
 * Reusable proxy endpoint sub-schema (the per-endpoint seam).
 *
 * Extracts the connection-target shape { proxyUrl, tls } so future per-channel
 * proxy overrides (e.g. telegram_proxy) can compose this without rework.
 *
 * EXTENSION POINT: to add per-channel proxy overrides, introduce a field on
 * the relevant channel schema typed as ProxyEndpointSchema.optional(), referencing
 * this schema. Do NOT add a live overrides/perChannel field here in v1.
 *
 * NOTE: proxyUrl credentials (http://user:pass@host) are permitted by this
 * schema because real enterprise proxies require them. They are
 * security-sensitive and MUST be masked (redacted) in all downstream logging
 * and error output (via sanitizeProxyUrl).
 */
export const ProxyEndpointSchema = z.strictObject({
  /**
   * HTTP(S) proxy URL. Accepts a literal http:// or https:// URL, or a
   * SecretRef resolved at boot by resolveConfigSecretRefs.
   *
   * socks5:// and other schemes are rejected at parse time.
   * Embedded credentials are allowed but MUST be masked downstream.
   */
  proxyUrl: z
    .union([
      z.string().url().refine(isHttpOrHttpsProxyUrl, {
        message: "proxyUrl must use http:// or https://",
      }),
      SecretRefSchema,
    ])
    .optional(),
  /**
   * TLS configuration for connecting to the proxy itself.
   * Schema validates the caFile path as a non-empty string only — filesystem
   * readability is fail-fast checked elsewhere.
   */
  tls: z
    .strictObject({
      /** Path to a custom CA bundle for verifying the proxy's TLS certificate. */
      caFile: z.string().min(1).optional(),
    })
    .optional(),
});

/**
 * Global outbound HTTP proxy configuration (env-first, zero-config default path).
 *
 * Composes ProxyEndpointSchema with enabled and loopbackMode. Attaches to
 * AppConfigSchema as `proxy:` with a full default so a config.yaml
 * without a proxy: key yields { enabled: false, loopbackMode: "gateway-only" }
 * — the zero-config posture is unchanged.
 *
 * Security: all proxy.* paths are in IMMUTABLE_CONFIG_PREFIXES — agents cannot
 * self-configure egress routing via config.write/config.patch.
 */
export const ProxyConfigSchema = z
  .strictObject({
    ...ProxyEndpointSchema.shape,
    /** Whether the explicitly-configured proxyUrl is active.
     *  Does NOT gate env-var-driven dispatcher (HTTPS_PROXY / HTTP_PROXY) —
     *  env-var routing is handled separately. */
    enabled: z.boolean().default(false),
    /** Loopback address handling mode. Default: gateway-only (security-conservative). */
    loopbackMode: ProxyLoopbackModeSchema.default("gateway-only"),
  })
  .superRefine((val, ctx) => {
    // When the proxy is explicitly enabled, proxyUrl is required.
    // A misconfigured enabled=true with no proxyUrl is a silent no-op proxy
    // posture — reject it with a descriptive Zod issue.
    if (val.enabled && val.proxyUrl === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["proxyUrl"],
        message: "proxyUrl is required when proxy.enabled is true",
      });
    }
  });

/** Inferred type for the global proxy config block. */
export type ProxyConfig = z.infer<typeof ProxyConfigSchema>;

/** Inferred type for the reusable per-endpoint proxy seam. */
export type ProxyEndpoint = z.infer<typeof ProxyEndpointSchema>;
