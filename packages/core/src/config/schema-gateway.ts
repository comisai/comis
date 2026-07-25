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
 * The `mcpClient` block is only meaningful when `scopes` includes
 * `"mcp-client"`. The `.refine` below enforces SOLE-SCOPE-DISJOINTNESS —
 * when `"mcp-client"` is present on a token, it MUST be the ONLY scope.
 * This subsumes the `admin` rejection, the wildcard `*` rejection, and the
 * rpc/ws rejection (an mcp-client token is an EXTERNAL trust boundary; its
 * compromise must be containable to the MCP surface only -- it cannot also
 * speak RPC or open a WebSocket).
 *
 * The refine surfaces at config-load with the literal token
 * `[scope_disjointness]` and `errorKind: "config"`.
 */
export const GatewayTokenSchema = z.strictObject({
    /** Unique identifier for this token */
    id: z.string().min(1),
    /** The secret value (min 32 chars; resolved at runtime if omitted; string or SecretRef) */
    secret: z.union([z.string().min(32), SecretRefSchema]).optional(),
    /** Allowed scopes for this token. Each token expresses ONE trust posture:
     *  RPC/WS operator tokens (`["rpc"]`, `["rpc", "ws"]`, `["admin"]`,
     *  `["*"]`) OR an external MCP-server client (`["mcp-client"]` --
     *  must be the sole scope). The refine below rejects co-issuance of
     *  `mcp-client` with any other scope. */
    scopes: z.array(z.string().min(1)).default([]),
    /** Per-MCP-client config block; only meaningful when `scopes` includes
     *  `"mcp-client"`. Operators may omit it entirely when not provisioning
     *  an MCP client. */
    mcpClient: z.strictObject({
      /** Tool names this MCP client may invoke. Empty = only `"safe"`-classified
       *  tools are exposed (no `"permission-gated"` access). */
      allowlist: z.array(z.string()).default([]),
      /** Session keys this MCP client may read via `resources/*`. Empty = no
       *  sessions exposed. */
      sessionAllowlist: z.array(z.string()).default([]),
      /** Per-tool rate-limit override (calls/min). Falls back to the
       *  30-calls/min/tool default. */
      toolRateLimit: z.record(z.string(), z.number().int().positive()).default({}),
    }).optional(),
  })
  .refine(
    (t) => {
      // When `mcp-client` is present on a token, it MUST be the ONLY scope.
      // An mcp-client token is an EXTERNAL trust boundary. Allowing it to
      // be co-issued with `rpc`, `ws`, or future operator scopes turns one
      // compromised MCP credential into a full operator escalation.
      // Tokens without `mcp-client` are unaffected by this rule.
      if (!t.scopes.includes("mcp-client")) return true;
      // Must be the sole scope -- exactly one entry, and that entry is
      // `"mcp-client"`. (Duplicate entries in the array would mean
      // length > 1 too, which is also rejected: a hygiene win.)
      return t.scopes.length === 1;
    },
    {
      message:
        "[scope_disjointness] mcp-client MUST be the sole scope of a token (no co-issuance with rpc, ws, admin, *, or any other scope)",
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
 * A bind target is a hostname or an unbracketed IP literal, never a URL.
 * Rejecting URL/userinfo syntax also prevents credential-shaped values from
 * reaching endpoint diagnostics that render the host alongside its port.
 */
const GatewayBindHostSchema = z.union([z.ipv4(), z.ipv6(), z.hostname()]);

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
    host: GatewayBindHostSchema.default("127.0.0.1"),
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
