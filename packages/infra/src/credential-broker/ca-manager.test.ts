// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for NodeCaManager — CA-01, CA-02.
 * RED-first TDD: all tests must fail before implementation lands.
 * @module
 */
import "reflect-metadata"; // MUST be first import — before @peculiar/x509 loads via ca-manager.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, connect } from "node:tls";
import type { AddressInfo } from "node:net";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { createNodeCaManager } from "./ca-manager.js";

// Mirror constants from ca-manager.ts for clock.advance() calculations
const LEAF_VALIDITY_MS = 24 * 60 * 60 * 1000; // 24 hours
const REFRESH_BUFFER_MS = 60 * 60 * 1000; // 1 hour

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "comis-ca-test-"));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeDeps(overrides?: { leafCacheCap?: number }) {
  const clock = createFakeClock(Date.now());
  return {
    clock,
    dataDir: tmpDir,
    ...(overrides?.leafCacheCap !== undefined ? { leafCacheCap: overrides.leafCacheCap } : {}),
  };
}

describe("NodeCaManager — CA-01a: CA key file 0o600", () => {
  it("CA private key file is created with mode 0o600", async () => {
    const deps = makeDeps();
    const manager = createNodeCaManager(deps);
    await manager.serverContextForHost("test.example.com");
    const stat = statSync(join(tmpDir, "broker-ca.key"));
    expect(stat.mode & 0o777).toBe(0o600);
  });
});

describe("NodeCaManager — CA-01b: Idempotent CA reuse", () => {
  it("two manager instances over the same dataDir produce identical broker-ca.pem", async () => {
    const clock = createFakeClock(Date.now());

    const m1 = createNodeCaManager({ clock, dataDir: tmpDir });
    await m1.serverContextForHost("a.example.com");
    const caFile1 = readFileSync(join(tmpDir, "broker-ca.pem"), "utf8");

    const m2 = createNodeCaManager({ clock, dataDir: tmpDir });
    await m2.serverContextForHost("b.example.com");
    const caFile2 = readFileSync(join(tmpDir, "broker-ca.pem"), "utf8");

    expect(caFile1).toBe(caFile2);
  });
});

describe("NodeCaManager — CA-01c: Leaf cache hit (reference equality)", () => {
  it("second serverContextForHost for same host returns reference-equal SecureContext", async () => {
    const deps = makeDeps();
    const manager = createNodeCaManager(deps);

    const ctx1 = await manager.serverContextForHost("api.example.com");
    const ctx2 = await manager.serverContextForHost("api.example.com");

    expect(ctx1).not.toBeUndefined();
    expect(ctx1).toBe(ctx2);
  });
});

describe("NodeCaManager — CA-01d: Refresh buffer re-mint", () => {
  it("leaf within refresh buffer (clock near notAfter) is re-minted (new ctx object)", async () => {
    const deps = makeDeps();
    const manager = createNodeCaManager(deps);

    const ctx1 = await manager.serverContextForHost("host.example.com");
    // Advance clock to within refresh buffer of notAfter (LEAF_VALIDITY_MS - REFRESH_BUFFER_MS + 1ms)
    deps.clock.advance(LEAF_VALIDITY_MS - REFRESH_BUFFER_MS + 1);
    const ctx2 = await manager.serverContextForHost("host.example.com");

    expect(ctx1).not.toBeUndefined();
    expect(ctx2).not.toBeUndefined();
    expect(ctx2).not.toBe(ctx1);
  });
});

describe("NodeCaManager — CA-01e: Bounded cache FIFO eviction", () => {
  it("cap+1 entries evicts the first host (re-minted on re-request)", async () => {
    const deps = makeDeps({ leafCacheCap: 3 });
    const manager = createNodeCaManager(deps);

    const ctx1 = await manager.serverContextForHost("a.example.com");
    await manager.serverContextForHost("b.example.com");
    await manager.serverContextForHost("c.example.com");
    // Cache is now at cap=3; adding a 4th host should evict "a"
    await manager.serverContextForHost("d.example.com");
    // Re-request "a" — it was evicted, so it must be re-minted (new object)
    const ctx1_again = await manager.serverContextForHost("a.example.com");

    expect(ctx1_again).not.toBe(ctx1);
  });
});

describe("NodeCaManager — CA-02a: Leaf SAN contains dnsName(host)", () => {
  it("leaf cert subjectaltname contains DNS:<host> for requested hostname", async () => {
    const deps = makeDeps();
    const manager = createNodeCaManager(deps);
    const ctx = await manager.serverContextForHost("api.anthropic.com");
    expect(ctx).not.toBeUndefined();

    const caCertPem = readFileSync(join(tmpDir, "broker-ca.pem"), "utf8");

    const server = createServer({
      ALPNProtocols: ["http/1.1"],
      SNICallback: (_servername, cb) => cb(null, ctx!),
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;

    const client = connect({
      host: "127.0.0.1",
      port,
      servername: "api.anthropic.com",
      ca: caCertPem,
      rejectUnauthorized: true,
    });

    try {
      await new Promise<void>((resolve, reject) => {
        client.on("secureConnect", () => {
          const cert = client.getPeerCertificate();
          expect(cert.subjectaltname).toContain("DNS:api.anthropic.com");
          resolve();
        });
        client.on("error", reject);
      });
    } finally {
      client.destroy();
      await new Promise<void>((r) => server.close(r));
    }
  });
});

describe("NodeCaManager — CA-02b+CA-02c: In-process TLS handshake", () => {
  it("client trusting broker CA completes TLS handshake with alpnProtocol==='http/1.1' and correct SAN", async () => {
    const deps = makeDeps();
    const manager = createNodeCaManager(deps);
    const ctx = await manager.serverContextForHost("api.anthropic.com");
    expect(ctx).not.toBeUndefined();

    const caCertPem = readFileSync(join(tmpDir, "broker-ca.pem"), "utf8");

    const server = createServer({
      ALPNProtocols: ["http/1.1"],
      SNICallback: (_servername, cb) => cb(null, ctx!),
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;

    const client = connect({
      host: "127.0.0.1",
      port,
      servername: "api.anthropic.com",
      ca: caCertPem,
      rejectUnauthorized: true,
    });

    try {
      await new Promise<void>((resolve, reject) => {
        client.on("secureConnect", () => {
          expect(client.alpnProtocol).toBe("http/1.1");
          const cert = client.getPeerCertificate();
          expect(cert.subjectaltname).toContain("DNS:api.anthropic.com");
          resolve();
        });
        client.on("error", reject);
      });
    } finally {
      client.destroy();
      await new Promise<void>((r) => server.close(r));
    }
  });
});
