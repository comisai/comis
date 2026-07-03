// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  GatewayConfigSchema,
  GatewayTlsConfigSchema,
  GatewayTokenSchema,
  GatewayRateLimitSchema,
  GatewayWebConfigSchema,
} from "./schema-gateway.js";

// ---------------------------------------------------------------------------
// GatewayConfigSchema
// ---------------------------------------------------------------------------

describe("GatewayConfigSchema", () => {
  it("produces valid defaults from empty object", () => {
    const result = GatewayConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
      expect(result.data.host).toBe("127.0.0.1");
      expect(result.data.port).toBe(4766);
      expect(result.data.tokens).toEqual([]);
      expect(result.data.maxBatchSize).toBe(50);
      expect(result.data.wsHeartbeatMs).toBe(30_000);
      expect(result.data.corsOrigins).toEqual([]);
      expect(result.data.allowInsecureHttp).toBe(false);
      expect(result.data.trustedProxies).toEqual([]);
      expect(result.data.httpBodyLimitBytes).toBe(1_048_576);
      expect(result.data.wsMaxMessageBytes).toBe(1_048_576);
    }
  });

  it("includes rateLimit defaults", () => {
    const result = GatewayConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rateLimit.windowMs).toBe(60_000);
      expect(result.data.rateLimit.maxRequests).toBe(100);
    }
  });

  it("includes wsMessageRateLimit defaults", () => {
    const result = GatewayConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.wsMessageRateLimit.maxMessages).toBe(60);
      expect(result.data.wsMessageRateLimit.windowMs).toBe(60_000);
    }
  });

  it("tls is optional (undefined when omitted)", () => {
    const result = GatewayConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tls).toBeUndefined();
    }
  });

  it("rejects port below 1", () => {
    const result = GatewayConfigSchema.safeParse({ port: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects port above 65535", () => {
    const result = GatewayConfigSchema.safeParse({ port: 65536 });
    expect(result.success).toBe(false);
  });

  it("accepts valid port at boundaries", () => {
    const r1 = GatewayConfigSchema.safeParse({ port: 1 });
    expect(r1.success).toBe(true);
    const rMax = GatewayConfigSchema.safeParse({ port: 65535 });
    expect(rMax.success).toBe(true);
  });

  it("rejects unknown fields (strictObject enforcement)", () => {
    const result = GatewayConfigSchema.safeParse({ unknownField: "test" });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GatewayTlsConfigSchema
// ---------------------------------------------------------------------------

describe("GatewayTlsConfigSchema", () => {
  it("requires certPath, keyPath, caPath", () => {
    const result = GatewayTlsConfigSchema.safeParse({
      certPath: "/etc/tls/cert.pem",
      keyPath: "/etc/tls/key.pem",
      caPath: "/etc/tls/ca.pem",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.certPath).toBe("/etc/tls/cert.pem");
      expect(result.data.keyPath).toBe("/etc/tls/key.pem");
      expect(result.data.caPath).toBe("/etc/tls/ca.pem");
    }
  });

  it("defaults requireClientCert to true", () => {
    const result = GatewayTlsConfigSchema.safeParse({
      certPath: "/cert.pem",
      keyPath: "/key.pem",
      caPath: "/ca.pem",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.requireClientCert).toBe(true);
    }
  });

  it("rejects empty certPath", () => {
    const result = GatewayTlsConfigSchema.safeParse({
      certPath: "",
      keyPath: "/key.pem",
      caPath: "/ca.pem",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing required fields", () => {
    const result = GatewayTlsConfigSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GatewayTokenSchema
// ---------------------------------------------------------------------------

describe("GatewayTokenSchema", () => {
  it("accepts token with id and scopes (no secret)", () => {
    const result = GatewayTokenSchema.safeParse({
      id: "token-1",
      scopes: ["rpc", "ws"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe("token-1");
      expect(result.data.secret).toBeUndefined();
      expect(result.data.scopes).toEqual(["rpc", "ws"]);
    }
  });

  it("scopes defaults to empty array", () => {
    const result = GatewayTokenSchema.safeParse({ id: "token-2" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scopes).toEqual([]);
    }
  });

  it("accepts secret string with min 32 chars", () => {
    const secret = "a".repeat(32);
    const result = GatewayTokenSchema.safeParse({ id: "token-3", secret });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.secret).toBe(secret);
    }
  });

  it("rejects short secret string (< 32 chars)", () => {
    const result = GatewayTokenSchema.safeParse({
      id: "token-4",
      secret: "too-short",
    });
    expect(result.success).toBe(false);
  });

  it("accepts SecretRef object for secret field", () => {
    const result = GatewayTokenSchema.safeParse({
      id: "token-5",
      secret: { source: "env", provider: "gateway", id: "GW_TOKEN_SECRET" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.secret).toEqual({
        source: "env",
        provider: "gateway",
        id: "GW_TOKEN_SECRET",
      });
    }
  });

  it("rejects empty id", () => {
    const result = GatewayTokenSchema.safeParse({ id: "" });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GatewayTokenSchema -- mcp-client scope disjointness + mcpClient block
// ---------------------------------------------------------------------------

describe("GatewayTokenSchema -- mcp-client disjointness", () => {
  it("GatewayTokenSchema accepts a token with only the rpc scope", () => {
    const result = GatewayTokenSchema.safeParse({ id: "t1", scopes: ["rpc"] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scopes).toEqual(["rpc"]);
    }
  });

  it("GatewayTokenSchema accepts a token with only the mcp-client scope and an mcpClient block", () => {
    const result = GatewayTokenSchema.safeParse({
      id: "t2",
      scopes: ["mcp-client"],
      mcpClient: { allowlist: ["memory_search"] },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scopes).toEqual(["mcp-client"]);
      expect(result.data.mcpClient).toBeDefined();
      expect(result.data.mcpClient!.allowlist).toEqual(["memory_search"]);
      // Defaults applied via the inner .default([]) / .default({}):
      expect(result.data.mcpClient!.sessionAllowlist).toEqual([]);
      expect(result.data.mcpClient!.toolRateLimit).toEqual({});
    }
  });

  it("GatewayTokenSchema rejects a token co-issuing admin and mcp-client scopes", () => {
    const result = GatewayTokenSchema.safeParse({
      id: "t3",
      scopes: ["admin", "mcp-client"],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues[0];
      expect(issue.message).toContain("[scope_disjointness]");
      expect(issue.path).toEqual(["scopes"]);
    }
  });

  it("GatewayTokenSchema accepts a token with admin scope but no mcp-client", () => {
    const result = GatewayTokenSchema.safeParse({ id: "t4", scopes: ["admin"] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scopes).toEqual(["admin"]);
    }
  });

  // -------------------------------------------------------------------------
  // Wildcard scope co-issuance defense
  //
  // The wildcard scope "*" grants ALL scopes via checkScope(), including
  // "admin". A token with `scopes: ["*", "mcp-client"]` has admin-equivalent
  // access AND mcp-client access -- the same privilege-escalation pathway
  // blocked for literal "admin + mcp-client".
  //
  // The refine must reject `*` alongside `mcp-client` for the same reason
  // it rejects `admin` alongside `mcp-client`.
  // -------------------------------------------------------------------------

  it("GatewayTokenSchema rejects a token co-issuing the wildcard star and mcp-client", () => {
    const result = GatewayTokenSchema.safeParse({
      id: "t5",
      scopes: ["*", "mcp-client"],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues[0];
      expect(issue.message).toContain("[scope_disjointness]");
      expect(issue.path).toEqual(["scopes"]);
    }
  });

  it("GatewayTokenSchema rejects a token co-issuing mcp-client and wildcard star in either order", () => {
    const result = GatewayTokenSchema.safeParse({
      id: "t6",
      scopes: ["mcp-client", "*"],
    });
    expect(result.success).toBe(false);
  });

  // -------------------------------------------------------------------------
  // mcp-client must be the SOLE scope
  //
  // Blocking only `admin + mcp-client` (and `* + mcp-client`) is not enough:
  // a token with `["rpc", "mcp-client"]` would otherwise
  //   1. satisfy the `/mcp/v1` gates (has mcp-client; no admin/*), and
  //   2. also authenticate to /ws and satisfy checkScope(scopes, "rpc")
  //      on every rpc-scoped RPC method.
  //
  // Operationally, an mcp-client token is supposed to be an EXTERNAL trust
  // boundary -- its compromise should be containable to the MCP surface
  // only. Allowing co-issuance with rpc/ws turns one compromised credential
  // into a full RPC + WS escalation.
  //
  // The refine must therefore enforce: when `mcp-client` is in scopes, it
  // is the ONLY scope.
  // -------------------------------------------------------------------------

  it("GatewayTokenSchema rejects a token co-issuing rpc and mcp-client -- mcp-client must be sole scope", () => {
    const result = GatewayTokenSchema.safeParse({
      id: "t7",
      scopes: ["rpc", "mcp-client"],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues[0];
      expect(issue.message).toContain("[scope_disjointness]");
      expect(issue.path).toEqual(["scopes"]);
    }
  });

  it("GatewayTokenSchema rejects a token co-issuing ws and mcp-client", () => {
    const result = GatewayTokenSchema.safeParse({
      id: "t8",
      scopes: ["ws", "mcp-client"],
    });
    expect(result.success).toBe(false);
  });

  it("GatewayTokenSchema rejects a token co-issuing rpc ws and mcp-client", () => {
    const result = GatewayTokenSchema.safeParse({
      id: "t9",
      scopes: ["rpc", "ws", "mcp-client"],
    });
    expect(result.success).toBe(false);
  });

  it("GatewayTokenSchema accepts a token with only mcp-client scope -- happy path", () => {
    const result = GatewayTokenSchema.safeParse({
      id: "t10",
      scopes: ["mcp-client"],
      mcpClient: { allowlist: [] },
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GatewayRateLimitSchema
// ---------------------------------------------------------------------------

describe("GatewayRateLimitSchema", () => {
  it("produces valid defaults", () => {
    const result = GatewayRateLimitSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.windowMs).toBe(60_000);
      expect(result.data.maxRequests).toBe(100);
    }
  });

  it("rejects non-positive windowMs", () => {
    const result = GatewayRateLimitSchema.safeParse({ windowMs: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects non-positive maxRequests", () => {
    const result = GatewayRateLimitSchema.safeParse({ maxRequests: 0 });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Trusted proxies IP validation
// ---------------------------------------------------------------------------

describe("Trusted proxies validation", () => {
  it("accepts valid IPv4 addresses", () => {
    const result = GatewayConfigSchema.safeParse({
      trustedProxies: ["10.0.0.1", "192.168.1.100"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.trustedProxies).toEqual(["10.0.0.1", "192.168.1.100"]);
    }
  });

  it("accepts valid IPv6 addresses", () => {
    const result = GatewayConfigSchema.safeParse({
      trustedProxies: ["::1", "2001:db8::1"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.trustedProxies).toHaveLength(2);
    }
  });

  it("rejects invalid IP strings", () => {
    const result = GatewayConfigSchema.safeParse({
      trustedProxies: ["not-an-ip"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects mixed valid/invalid IPs", () => {
    const result = GatewayConfigSchema.safeParse({
      trustedProxies: ["10.0.0.1", "invalid"],
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GatewayWebConfigSchema / gateway.web field
// ---------------------------------------------------------------------------

describe("GatewayWebConfigSchema / gateway.web field", () => {
  it("gateway.web defaults to { enabled: true } when omitted", () => {
    const result = GatewayConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.web.enabled).toBe(true);
    }
  });

  it("accepts explicit gateway.web.enabled=false", () => {
    const result = GatewayConfigSchema.safeParse({ web: { enabled: false } });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.web.enabled).toBe(false);
    }
  });

  it("rejects non-boolean gateway.web.enabled (strict boolean)", () => {
    const result = GatewayConfigSchema.safeParse({ web: { enabled: "yes" } });
    expect(result.success).toBe(false);
  });

  it("standalone GatewayWebConfigSchema defaults to { enabled: true }", () => {
    const result = GatewayWebConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
    }
  });
});
