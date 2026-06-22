// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { ProxyConfigSchema, ProxyEndpointSchema } from "./schema-proxy.js";

// ---------------------------------------------------------------------------
// Omitted proxy block yields safe defaults
// ---------------------------------------------------------------------------

describe("ProxyConfigSchema — defaults (SC#3: zero-config preservation)", () => {
  it("produces valid defaults from empty object", () => {
    const result = ProxyConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(false);
      expect(result.data.loopbackMode).toBe("gateway-only");
      expect(result.data.proxyUrl).toBeUndefined();
      expect(result.data.tls).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Unknown keys rejected (z.strictObject enforcement)
// ---------------------------------------------------------------------------

describe("ProxyConfigSchema — unknown keys rejected (z.strictObject enforcement)", () => {
  it("rejects unknown top-level proxy key", () => {
    const result = ProxyConfigSchema.safeParse({ unknownField: "x" });
    expect(result.success).toBe(false);
  });

  it("rejects unknown tls subkey", () => {
    const result = ProxyConfigSchema.safeParse({
      tls: { caFile: "/ca.pem", unknownTlsKey: true },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scheme restriction (http/https only)
// ---------------------------------------------------------------------------

describe("ProxyConfigSchema — proxyUrl scheme restriction (D-02 security)", () => {
  it("accepts http:// proxyUrl", () => {
    const result = ProxyConfigSchema.safeParse({ proxyUrl: "http://proxy.corp:3128" });
    expect(result.success).toBe(true);
  });

  it("accepts https:// proxyUrl", () => {
    const result = ProxyConfigSchema.safeParse({ proxyUrl: "https://proxy.corp:3128" });
    expect(result.success).toBe(true);
  });

  it("rejects socks5:// proxyUrl (D-02 security — SOCKS out of scope)", () => {
    const result = ProxyConfigSchema.safeParse({ proxyUrl: "socks5://proxy.corp:1080" });
    expect(result.success).toBe(false);
  });

  it("rejects file:// proxyUrl (D-02 security — SSRF footgun)", () => {
    const result = ProxyConfigSchema.safeParse({ proxyUrl: "file:///etc/passwd" });
    expect(result.success).toBe(false);
  });

  it("rejects malformed non-URL proxyUrl", () => {
    const result = ProxyConfigSchema.safeParse({ proxyUrl: "not-a-url" });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SecretRef union for proxyUrl
// ---------------------------------------------------------------------------

describe("ProxyConfigSchema — SecretRef proxyUrl (CONFIG-02)", () => {
  it("accepts SecretRef object for proxyUrl and round-trips it", () => {
    const secretRef = { source: "env", provider: "secrets", id: "CORP_PROXY_URL" };
    const result = ProxyConfigSchema.safeParse({ proxyUrl: secretRef });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.proxyUrl).toEqual(secretRef);
    }
  });
});

// ---------------------------------------------------------------------------
// superRefine cross-field rule (enabled=true requires proxyUrl)
// ---------------------------------------------------------------------------

describe("ProxyConfigSchema — superRefine cross-field rule (D-06)", () => {
  it("rejects enabled=true without proxyUrl and reports path proxyUrl", () => {
    const result = ProxyConfigSchema.safeParse({ enabled: true });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("proxyUrl");
    }
  });

  it("accepts enabled=true with a valid http proxyUrl", () => {
    const result = ProxyConfigSchema.safeParse({
      enabled: true,
      proxyUrl: "http://proxy.corp:3128",
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// loopbackMode enum
// ---------------------------------------------------------------------------

describe("ProxyConfigSchema — loopbackMode (D-07)", () => {
  it("defaults to gateway-only", () => {
    const result = ProxyConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.loopbackMode).toBe("gateway-only");
    }
  });

  it("accepts proxy loopbackMode value", () => {
    expect(ProxyConfigSchema.safeParse({ loopbackMode: "proxy" }).success).toBe(true);
  });

  it("accepts block loopbackMode value", () => {
    expect(ProxyConfigSchema.safeParse({ loopbackMode: "block" }).success).toBe(true);
  });

  it("rejects unknown loopbackMode value", () => {
    expect(ProxyConfigSchema.safeParse({ loopbackMode: "bypass" }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// tls block
// ---------------------------------------------------------------------------

describe("ProxyConfigSchema — tls block (D-08)", () => {
  it("accepts tls with caFile path", () => {
    const result = ProxyConfigSchema.safeParse({ tls: { caFile: "/etc/ssl/corp-ca.crt" } });
    expect(result.success).toBe(true);
  });

  it("rejects tls with empty-string caFile (min-1 enforcement)", () => {
    const result = ProxyConfigSchema.safeParse({ tls: { caFile: "" } });
    expect(result.success).toBe(false);
  });

  it("accepts tls block with no caFile (caFile optional)", () => {
    const result = ProxyConfigSchema.safeParse({ tls: {} });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ProxyEndpointSchema reusable seam
// ---------------------------------------------------------------------------

describe("ProxyEndpointSchema — standalone seam (CONFIG-03, D-10)", () => {
  it("parses empty object (seam is fully optional)", () => {
    const result = ProxyEndpointSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("parses with proxyUrl set", () => {
    const result = ProxyEndpointSchema.safeParse({ proxyUrl: "http://proxy:3128" });
    expect(result.success).toBe(true);
  });
});
