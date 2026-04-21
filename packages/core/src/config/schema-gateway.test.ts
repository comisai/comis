// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  GatewayConfigSchema,
  GatewayTlsConfigSchema,
  GatewayTokenSchema,
  GatewayRateLimitSchema,
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
