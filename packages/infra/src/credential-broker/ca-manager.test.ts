// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for NodeCaManager.
 * @module
 */
import "reflect-metadata"; // MUST be first import — before @peculiar/x509 loads via ca-manager.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, connect } from "node:tls";
import type { AddressInfo } from "node:net";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { createNodeCaManager, LEAF_VALIDITY_MS, REFRESH_BUFFER_MS } from "./ca-manager.js";

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

describe("NodeCaManager — CA key file 0o600", () => {
  it("CA private key file is created with mode 0o600", async () => {
    const deps = makeDeps();
    const manager = createNodeCaManager(deps);
    await manager.serverContextForHost("test.example.com");
    const stat = statSync(join(tmpDir, "broker-ca.key"));
    expect(stat.mode & 0o777).toBe(0o600);
  });
});

describe("NodeCaManager — Idempotent CA reuse", () => {
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

describe("NodeCaManager — Leaf cache hit (reference equality)", () => {
  it("second serverContextForHost for same host returns reference-equal SecureContext", async () => {
    const deps = makeDeps();
    const manager = createNodeCaManager(deps);

    const ctx1 = await manager.serverContextForHost("api.example.com");
    const ctx2 = await manager.serverContextForHost("api.example.com");

    expect(ctx1).not.toBeUndefined();
    expect(ctx1).toBe(ctx2);
  });
});

describe("NodeCaManager — Refresh buffer re-mint", () => {
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

describe("NodeCaManager — Bounded cache FIFO eviction", () => {
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

describe("NodeCaManager — Leaf SAN contains dnsName(host)", () => {
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
      ALPNProtocols: ["http/1.1"],
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

describe("NodeCaManager — In-process TLS handshake", () => {
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
      ALPNProtocols: ["http/1.1"], // client must advertise the protocol for negotiation to succeed
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

// ── Regression tests: partial-write recovery and concurrent init ─────────────

describe("partial-write recovery: key file must not be corrupted by append", () => {
  it("key-exists-but-cert-missing state: next init regenerates a single valid key (no double-PEM append)", async () => {
    // Simulate the partial-write scenario: key written but cert not.
    // First: create a real CA so we have a valid key PEM on disk.
    const clock = createFakeClock(Date.now());
    const m1 = createNodeCaManager({ clock, dataDir: tmpDir });
    await m1.serverContextForHost("a.example.com");

    // Delete just the cert — simulates a crash after key write but before cert write.
    const certPath = join(tmpDir, "broker-ca.pem");
    const keyPath = join(tmpDir, "broker-ca.key");
    rmSync(certPath);

    // Create a new manager — it should regenerate cleanly (not append a second PEM block).
    const m2 = createNodeCaManager({ clock, dataDir: tmpDir });
    // This must succeed (importKey crash would mean double-PEM was appended)
    await expect(m2.serverContextForHost("b.example.com")).resolves.toBeDefined();

    // The key file must contain exactly ONE PEM block — not two appended ones
    const keyContent = readFileSync(keyPath, "utf8");
    const pemBlockCount = (keyContent.match(/-----BEGIN PRIVATE KEY-----/g) ?? []).length;
    expect(pemBlockCount).toBe(1);

    // Both key and cert must now exist and be consistent
    expect(existsSync(certPath)).toBe(true);
  });
});

describe("concurrent ensureCa() calls: promise singleton prevents double initCa", () => {
  it("two concurrent serverContextForHost calls on a fresh dir: initCa runs once, key file has single PEM block", async () => {
    const clock = createFakeClock(Date.now());
    const manager = createNodeCaManager({ clock, dataDir: tmpDir });
    const keyPath = join(tmpDir, "broker-ca.key");

    // Fire two concurrent calls — without the fix, both see caState===null and race
    const [ctx1, ctx2] = await Promise.all([
      manager.serverContextForHost("host1.example.com"),
      manager.serverContextForHost("host2.example.com"),
    ]);

    expect(ctx1).toBeDefined();
    expect(ctx2).toBeDefined();

    // Key file must have exactly ONE PEM block — not two from double-initCa
    const keyContent = readFileSync(keyPath, "utf8");
    const pemBlockCount = (keyContent.match(/-----BEGIN PRIVATE KEY-----/g) ?? []).length;
    expect(pemBlockCount).toBe(1);
  });
});
