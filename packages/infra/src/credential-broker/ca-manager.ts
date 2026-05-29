// SPDX-License-Identifier: Apache-2.0
/**
 * NodeCaManager — TLS CA management adapter for MITM broker (Phase 3).
 * Implements CaManagerPort: mints a self-signed ECDSA P-256 root CA, persists
 * key/cert under dataDir (key at 0o600), and issues per-host leaf certs
 * (SAN=dnsName, short validity) cached in a bounded FIFO Map.
 * @module
 */
import "reflect-metadata"; // MUST be first import — tsyringe (transitive of @peculiar/x509) requires Reflect.metadata
import * as x509 from "@peculiar/x509";
import * as tls from "node:tls";
import {
  existsSync,
  mkdirSync,
  openSync,
  writeSync,
  closeSync,
  chmodSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { safePath, systemDateFrom } from "@comis/core";
import type { ClockPort, CaManagerPort } from "@comis/core";

// ── Constants ──────────────────────────────────────────────────────────────
const CA_DN = "CN=Comis Broker CA";
const CA_VALIDITY_MS = 10 * 365 * 24 * 60 * 60 * 1000; // 10 years
export const LEAF_VALIDITY_MS = 24 * 60 * 60 * 1000; // 24 hours
export const REFRESH_BUFFER_MS = 60 * 60 * 1000; // 1 hour

// ── Internal types ─────────────────────────────────────────────────────────
interface CaState {
  caKeys: CryptoKeyPair;
  caCert: x509.X509Certificate;
  caCertPem: string;
}

interface LeafCacheEntry {
  ctx: tls.SecureContext;
  notAfterMs: number; // clock.now() + LEAF_VALIDITY_MS at mint time
}

// ── Exported types ─────────────────────────────────────────────────────────
export interface NodeCaManagerDeps {
  clock: ClockPort; // required — no Date.now() anywhere
  dataDir: string; // injected — never read process.env directly
  leafCacheCap?: number; // default: 256
}

// ── Helper: convert DER ArrayBuffer to PEM string ──────────────────────────
function derToPem(der: ArrayBuffer, label: string): string {
  const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

// ── Helper: random 16-byte serial number as hex ────────────────────────────
function randomHex16(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── CA initialisation (idempotent) ─────────────────────────────────────────
async function initCa(dataDir: string, clock: ClockPort): Promise<CaState> {
  const keyPath = safePath(dataDir, "broker-ca.key");
  const certPath = safePath(dataDir, "broker-ca.pem");

  if (existsSync(keyPath) && existsSync(certPath)) {
    // Reload existing CA (same issuer DN across restarts — CA-01b)
    const keyPem = readFileSync(keyPath, "utf8");
    const certPem = readFileSync(certPath, "utf8");

    // Strip PEM headers/footers and decode
    const b64 = keyPem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
    const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const privateKey = await crypto.subtle.importKey(
      "pkcs8",
      der.buffer as ArrayBuffer,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign"],
    );
    const caCert = new x509.X509Certificate(certPem);
    // Reload public key from cert SPKI
    const publicKey = await crypto.subtle.importKey(
      "spki",
      caCert.publicKey.rawData,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["verify"],
    );
    return { caKeys: { privateKey, publicKey }, caCert, caCertPem: certPem };
  }

  // Mint a new CA
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  const alg: EcKeyGenParams = { name: "ECDSA", namedCurve: "P-256" };
  const caKeys = await crypto.subtle.generateKey(alg, true, ["sign", "verify"]);

  const nowMs = clock.now();
  const caCert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: CA_DN,
    notBefore: clock.nowDate(),
    notAfter: systemDateFrom(nowMs + CA_VALIDITY_MS),
    signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    keys: caKeys,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true), // cA=true, pathLen=0, critical
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
        true,
      ),
      await x509.SubjectKeyIdentifierExtension.create(caKeys.publicKey),
    ],
  });

  const caCertPem = caCert.toString("pem");
  const keyDer = await crypto.subtle.exportKey("pkcs8", caKeys.privateKey);
  const caKeyPem = derToPem(keyDer, "PRIVATE KEY");

  // Atomic write at 0o600 — exact pattern from master-key.ts:72-88
  // openSync("a", 0o600) sets the mode on file CREATION (O_CREAT path);
  // subsequent chmodSync is defensive for any pre-existing file.
  const fd = openSync(keyPath, "a", 0o600);
  try {
    writeSync(fd, caKeyPem);
  } finally {
    closeSync(fd);
  }
  chmodSync(keyPath, 0o600); // defensive

  writeFileSync(certPath, caCertPem); // cert is public — no mode restriction needed

  return { caKeys, caCert, caCertPem };
}

// ── Factory ────────────────────────────────────────────────────────────────
export function createNodeCaManager(deps: NodeCaManagerDeps): CaManagerPort {
  const { clock, dataDir, leafCacheCap = 256 } = deps;

  let caState: CaState | null = null;
  const leafCache = new Map<string, LeafCacheEntry>();

  async function ensureCa(): Promise<CaState> {
    if (caState === null) {
      caState = await initCa(dataDir, clock);
    }
    return caState;
  }

  function evictIfNeeded(): void {
    if (leafCache.size >= leafCacheCap) {
      const firstKey = leafCache.keys().next().value;
      if (firstKey !== undefined) leafCache.delete(firstKey);
    }
  }

  async function mintLeafContext(
    host: string,
    ca: CaState,
  ): Promise<{ ctx: tls.SecureContext; notAfterMs: number }> {
    const leafAlg: EcKeyGenParams = { name: "ECDSA", namedCurve: "P-256" };
    const leafKeys = await crypto.subtle.generateKey(leafAlg, true, [
      "sign",
      "verify",
    ]);

    const notAfterMs = clock.now() + LEAF_VALIDITY_MS;

    const leafCert = await x509.X509CertificateGenerator.create({
      serialNumber: randomHex16(),
      subject: `CN=${host}`,
      issuer: ca.caCert.subject, // CA's subject DN
      notBefore: clock.nowDate(),
      notAfter: systemDateFrom(notAfterMs),
      signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
      publicKey: leafKeys.publicKey,
      signingKey: ca.caKeys.privateKey, // CA key signs the leaf
      extensions: [
        new x509.SubjectAlternativeNameExtension(
          [{ type: "dns", value: host }],
          false,
        ),
        new x509.BasicConstraintsExtension(false), // cA=false
        new x509.KeyUsagesExtension(
          x509.KeyUsageFlags.digitalSignature |
            x509.KeyUsageFlags.keyEncipherment,
          false,
        ),
        await x509.SubjectKeyIdentifierExtension.create(leafKeys.publicKey),
      ],
    });

    const leafKeyDer = await crypto.subtle.exportKey(
      "pkcs8",
      leafKeys.privateKey,
    );
    const leafKeyPem = derToPem(leafKeyDer, "PRIVATE KEY");
    const leafCertPem = leafCert.toString("pem");

    const ctx = tls.createSecureContext({
      key: leafKeyPem,
      cert: leafCertPem,
      ca: ca.caCertPem,
    });

    return { ctx, notAfterMs };
  }

  return {
    async serverContextForHost(
      host: string,
    ): Promise<tls.SecureContext | undefined> {
      const ca = await ensureCa();

      const cached = leafCache.get(host);
      if (cached !== undefined && clock.now() < cached.notAfterMs - REFRESH_BUFFER_MS) {
        return cached.ctx; // cache HIT
      }

      // MISS or within refresh buffer — delete stale entry and re-mint
      leafCache.delete(host);
      evictIfNeeded();

      const { ctx, notAfterMs } = await mintLeafContext(host, ca);
      leafCache.set(host, { ctx, notAfterMs });
      return ctx;
    },
  };
}
