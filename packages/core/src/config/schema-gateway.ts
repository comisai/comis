// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { SecretRefSchema } from "../domain/secret-ref.js";

/**
 * TLS configuration for the gateway HTTPS server.
 *
 * When provided, enables mTLS with client certificate verification.
 * All paths should be absolute or relative to the process working directory.
 */
export const GatewayTlsConfigSchema = z.strictObject({
    /** Path to the server TLS certificate (PEM format) */
    certPath: z.string().min(1),
    /** Path to the server TLS private key (PEM format) */
    keyPath: z.string().min(1),
    /** Path to the CA certificate for client cert verification (PEM format) */
    caPath: z.string().min(1),
    /** Require client certificates for mutual TLS (default: true) */
    requireClientCert: z.boolean().default(true),
  });

/**
 * Bearer token entry for API key authentication.
 *
 * The `secret` field requires a minimum of 32 characters when provided,
 * ensuring sufficient entropy for bearer tokens. The field
 * is optional — when omitted, the secret is resolved at runtime via
 * environment variable or auto-generation.
 *
 * Phase 69 SERVE-02 / WR-01: the `mcpClient` block is only meaningful when
 * `scopes` includes `"mcp-client"`. The `.refine` below enforces
 * ADMIN-EQUIVALENT-DISJOINTNESS — a single token MUST NOT co-issue
 * `"mcp-client"` with either `"admin"` OR `"*"` (the wildcard scope grants
 * all scopes via `checkScope`, including admin). Either co-issuance is the
 * privilege-escalation pathway threat T-69-02 prevents. The refine surfaces
 * at config-load with the literal token `[scope_disjointness]` and
 * `errorKind: "config"`.
 */
export const GatewayTokenSchema = z.strictObject({
    /** Unique identifier for this token */
    id: z.string().min(1),
    /** The secret value (min 32 chars; resolved at runtime if omitted; string or SecretRef) */
    secret: z.union([z.string().min(32), SecretRefSchema]).optional(),
    /** Allowed scopes for this token (e.g., ["rpc", "ws", "admin", "mcp-client"]) */
    scopes: z.array(z.string().min(1)).default([]),
    /** Per-MCP-client config block; only meaningful when `scopes` includes
     *  `"mcp-client"` (Phase 69 SERVE-02). Operators may omit it entirely when
     *  not provisioning an MCP client. */
    mcpClient: z.strictObject({
      /** Tool names this MCP client may invoke. Empty = only `"safe"`-classified
       *  tools are exposed (no `"permission-gated"` access). See SERVE-03/04. */
      allowlist: z.array(z.string()).default([]),
      /** Session keys this MCP client may read via `resources/*`. Empty = no
       *  sessions exposed (Phase 69 SERVE-06). */
      sessionAllowlist: z.array(z.string()).default([]),
      /** Per-tool rate-limit override (calls/min). Falls back to the
       *  30-calls/min/tool default in SERVE-07. */
      toolRateLimit: z.record(z.string(), z.number().int().positive()).default({}),
    }).optional(),
  })
  .refine(
    (t) => {
      // Phase 69 WR-01: reject mcp-client co-issued with either `"admin"`
      // OR `"*"` (the wildcard satisfies checkScope on every required
      // scope, so it is admin-equivalent). The refine surfaces at
      // config-load before the gateway boots.
      if (!t.scopes.includes("mcp-client")) return true;
      return !t.scopes.includes("admin") && !t.scopes.includes("*");
    },
    {
      message:
        "[scope_disjointness] mcp-client MUST NOT be co-issued with admin or wildcard '*' scopes on a token",
      path: ["scopes"],
    },
  );

/**
 * Rate limiting configuration for the gateway.
 */
export const GatewayRateLimitSchema = z.strictObject({
    /** Time window in milliseconds (default: 60000 = 1 minute) */
    windowMs: z.number().int().positive().default(60_000),
    /** Maximum requests per window (default: 100) */
    maxRequests: z.number().int().positive().default(100),
  });

/**
 * Web dashboard configuration. Controls whether the @comis/web SPA is mounted
 * at /app/* alongside the gateway, sharing the same host/port/auth. When
 * disabled, the daemon skips /app/*, /api, SSE, and the `/` -> `/app/` redirect.
 */
export const GatewayWebConfigSchema = z.strictObject({
    /** Enable the web dashboard SPA (default: true) */
    enabled: z.boolean().default(true),
  });

/**
 * Gateway server configuration schema.
 *
 * Controls the Hono HTTPS server, mTLS authentication, bearer tokens,
 * rate limiting, JSON-RPC batching, and WebSocket heartbeat settings.
 */
export const GatewayConfigSchema = z.strictObject({
    /** Enable the gateway server (default: true) */
    enabled: z.boolean().default(true),
    /** Host to bind the server to (default: "127.0.0.1" — secure-by-default, use "0.0.0.0" for external access) */
    host: z.string().default("127.0.0.1"),
    /** Port to listen on (default: 4766) */
    port: z.number().int().min(1).max(65535).default(4766),
    /** TLS / mTLS configuration (omit for dev-mode plain HTTP) */
    tls: GatewayTlsConfigSchema.optional(),
    /** Bearer tokens for API key authentication */
    tokens: z.array(GatewayTokenSchema).default([]),
    /** Rate limiting settings */
    rateLimit: GatewayRateLimitSchema.default(() => GatewayRateLimitSchema.parse({})),
    /** Web dashboard (mounted at /app/*, shares gateway host/port/auth) */
    web: GatewayWebConfigSchema.default(() => GatewayWebConfigSchema.parse({})),
    /** Maximum JSON-RPC batch size (default: 50) */
    maxBatchSize: z.number().int().positive().default(50),
    /** WebSocket heartbeat interval in milliseconds (default: 30000) */
    wsHeartbeatMs: z.number().int().positive().default(30_000),
    /** CORS allowed origins. Empty array = same-origin only (restrictive default). */
    corsOrigins: z.array(z.string()).default([]),
    /** Suppress insecure-HTTP WARN log (for dev/test environments). Default: false. */
    allowInsecureHttp: z.boolean().default(false),
    /** Trusted proxy IPs. Only these IPs' X-Forwarded-For headers are trusted for rate limiting. Empty = trust none (default). */
    trustedProxies: z.array(z.union([z.ipv4(), z.ipv6()])).default([]),
    /** Maximum HTTP request body size in bytes for POST endpoints (default: 1MB). */
    httpBodyLimitBytes: z.number().int().positive().default(1_048_576),
    /** Maximum WebSocket message size in characters before JSON.parse (default: 1MB). */
    wsMaxMessageBytes: z.number().int().positive().default(1_048_576),
    /** Per-connection WebSocket message rate limiting. */
    wsMessageRateLimit: z.strictObject({
      /** Maximum messages per window (default: 60). */
      maxMessages: z.number().int().positive().default(60),
      /** Time window in milliseconds (default: 60000 = 1 minute). */
      windowMs: z.number().int().positive().default(60_000),
    }).default({ maxMessages: 60, windowMs: 60_000 }),
  });

export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;
export type GatewayTlsConfig = z.infer<typeof GatewayTlsConfigSchema>;
export type GatewayToken = z.infer<typeof GatewayTokenSchema>;
export type GatewayRateLimit = z.infer<typeof GatewayRateLimitSchema>;
export type GatewayWebConfig = z.infer<typeof GatewayWebConfigSchema>;
