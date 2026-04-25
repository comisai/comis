// SPDX-License-Identifier: Apache-2.0
/**
 * mTLS handshake integration test.
 *
 * Generates a throwaway CA + server cert + 2 client certs (one signed by
 * the CA, one self-signed under a different "rogue" CA), spins up a real
 * node:https server with `requestCert: true, rejectUnauthorized: true`,
 * and exercises the 4 client-cert states the gateway must distinguish:
 *
 *   1. No client cert  -> handshake terminates, request never lands
 *   2. Cert from the wrong CA  -> handshake terminates, request never lands
 *   3. Valid CA-signed cert with CN="user_a"  -> handshake succeeds and
 *      extractClientCN() reads "user_a"
 *   4. Valid CA-signed cert with CN="user_b"  -> handshake succeeds and
 *      extractClientCN() reads "user_b"
 *
 * Skips cleanly if openssl is not available on PATH (CI matrix without it).
 *
 * @module
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { request as httpsRequest } from "node:https";
import type { TLSSocket } from "node:tls";

// Inlined gateway CN extractor (mtls-verifier#extractClientCN is not exported
// from @comis/gateway; we replicate its 4-line contract here so the test
// stays a black-box exercise of the TLS layer).
function extractClientCN(socket: TLSSocket): string | null {
  if (!socket.authorized) return null;
  const cert = socket.getPeerCertificate();
  if (!cert || !cert.subject) return null;
  const cn = cert.subject.CN ?? null;
  return Array.isArray(cn) ? (cn[0] ?? null) : cn;
}

// ---------------------------------------------------------------------------
// Skip-if-no-openssl helper
// ---------------------------------------------------------------------------

function opensslAvailable(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const HAS_OPENSSL = opensslAvailable();
const skipIfNoOpenssl = !HAS_OPENSSL;

// ---------------------------------------------------------------------------
// Cert factory
// ---------------------------------------------------------------------------

interface CertSet {
  caKey: string;
  caCert: string;
  serverKey: string;
  serverCert: string;
  clientAKey: string;
  clientACert: string;
  clientBKey: string;
  clientBCert: string;
  rogueClientKey: string;
  rogueClientCert: string;
}

function genCerts(dir: string): CertSet {
  const out = (name: string): string => join(dir, name);

  // ── Trusted CA ────────────────────────────────────────────────────
  execFileSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-keyout",
    out("ca.key"),
    "-out",
    out("ca.crt"),
    "-days",
    "1",
    "-nodes",
    "-subj",
    "/CN=ComisTestCA",
  ]);

  // ── Server cert (CN=localhost), signed by trusted CA ──────────────
  execFileSync("openssl", [
    "req",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-keyout",
    out("server.key"),
    "-out",
    out("server.csr"),
    "-nodes",
    "-subj",
    "/CN=localhost",
  ]);
  execFileSync("openssl", [
    "x509",
    "-req",
    "-in",
    out("server.csr"),
    "-CA",
    out("ca.crt"),
    "-CAkey",
    out("ca.key"),
    "-CAcreateserial",
    "-out",
    out("server.crt"),
    "-days",
    "1",
  ]);

  // ── Client A (CN=user_a), signed by trusted CA ────────────────────
  execFileSync("openssl", [
    "req",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-keyout",
    out("clientA.key"),
    "-out",
    out("clientA.csr"),
    "-nodes",
    "-subj",
    "/CN=user_a",
  ]);
  execFileSync("openssl", [
    "x509",
    "-req",
    "-in",
    out("clientA.csr"),
    "-CA",
    out("ca.crt"),
    "-CAkey",
    out("ca.key"),
    "-CAcreateserial",
    "-out",
    out("clientA.crt"),
    "-days",
    "1",
  ]);

  // ── Client B (CN=user_b), signed by trusted CA ────────────────────
  execFileSync("openssl", [
    "req",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-keyout",
    out("clientB.key"),
    "-out",
    out("clientB.csr"),
    "-nodes",
    "-subj",
    "/CN=user_b",
  ]);
  execFileSync("openssl", [
    "x509",
    "-req",
    "-in",
    out("clientB.csr"),
    "-CA",
    out("ca.crt"),
    "-CAkey",
    out("ca.key"),
    "-CAcreateserial",
    "-out",
    out("clientB.crt"),
    "-days",
    "1",
  ]);

  // ── Rogue self-signed client (different CA) ──────────────────────
  execFileSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-keyout",
    out("rogue.key"),
    "-out",
    out("rogue.crt"),
    "-days",
    "1",
    "-nodes",
    "-subj",
    "/CN=rogue_user",
  ]);

  return {
    caKey: out("ca.key"),
    caCert: out("ca.crt"),
    serverKey: out("server.key"),
    serverCert: out("server.crt"),
    clientAKey: out("clientA.key"),
    clientACert: out("clientA.crt"),
    clientBKey: out("clientB.key"),
    clientBCert: out("clientB.crt"),
    rogueClientKey: out("rogue.key"),
    rogueClientCert: out("rogue.crt"),
  };
}

// ---------------------------------------------------------------------------
// Tiny TLS server: records the CN of any successful handshake
// ---------------------------------------------------------------------------

interface TestServer {
  port: number;
  observedCNs: string[];
  close: () => Promise<void>;
}

async function startMtlsServer(certs: CertSet): Promise<TestServer> {
  const observedCNs: string[] = [];

  const server: HttpsServer = createHttpsServer(
    {
      cert: readFileSync(certs.serverCert),
      key: readFileSync(certs.serverKey),
      ca: readFileSync(certs.caCert),
      requestCert: true,
      rejectUnauthorized: true,
    },
    (req, res) => {
      // Use the same code path the gateway uses to read CN.
      const cn = extractClientCN(req.socket as TLSSocket);
      if (cn) observedCNs.push(cn);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, cn }));
    },
  );

  // Bind to an ephemeral port on loopback only.
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("TLS server failed to bind");
  }

  return {
    port: address.port,
    observedCNs,
    close: () =>
      new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface ClientResult {
  status?: number;
  body?: string;
  error?: string;
}

function tlsRequest(
  port: number,
  options: {
    cert?: Buffer;
    key?: Buffer;
    ca: Buffer;
  },
): Promise<ClientResult> {
  return new Promise((resolve) => {
    const req = httpsRequest(
      {
        host: "127.0.0.1",
        port,
        method: "GET",
        path: "/",
        ca: options.ca,
        servername: "localhost",
        // The test server cert has CN=localhost but no SAN; node enforces
        // SAN-or-CN against `servername`, but since we're connecting via
        // an IP literal we explicitly skip server-identity verification.
        // The CA chain is still validated (rejectUnauthorized stays true).
        // This test scopes to CLIENT cert validation, not server identity.
        checkServerIdentity: () => undefined,
        ...(options.cert ? { cert: options.cert } : {}),
        ...(options.key ? { key: options.key } : {}),
        rejectUnauthorized: true,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString("utf-8"),
          });
        });
      },
    );
    req.on("error", (e) => resolve({ error: e.message }));
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(skipIfNoOpenssl)("mTLS handshake", () => {
  let dir: string;
  let certs: CertSet;
  let srv: TestServer;
  let caBuf: Buffer;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "comis-mtls-int-"));
    certs = genCerts(dir);
    caBuf = readFileSync(certs.caCert);
    srv = await startMtlsServer(certs);
  }, 60_000);

  afterAll(async () => {
    await srv.close();
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  // The TLS layer surfaces failed handshakes as one of several errors
  // depending on Node version, OpenSSL build, and which side observed the
  // failure first. Across Node 22.x we have observed: "socket hang up",
  // "ECONNRESET", "alert ... certificate", "self-signed certificate",
  // "unknown ca". The contract the test pins is: NO HTTP response status
  // and a non-empty handshake-failure error.
  const HANDSHAKE_FAIL_RE =
    /socket hang up|ECONNRESET|alert.*cert|self.signed|unknown ca|certificate|sslv3|peer did not return a certificate|EPIPE/i;

  it("rejects a connection with NO client cert", async () => {
    const r = await tlsRequest(srv.port, { ca: caBuf });
    // Server tears down the handshake; node surfaces an error rather
    // than an HTTP status code.
    expect(r.status).toBeUndefined();
    expect(r.error).toMatch(HANDSHAKE_FAIL_RE);
  });

  it("rejects a client cert from a different CA (rogue)", async () => {
    const r = await tlsRequest(srv.port, {
      ca: caBuf,
      cert: readFileSync(certs.rogueClientCert),
      key: readFileSync(certs.rogueClientKey),
    });
    expect(r.status).toBeUndefined();
    expect(r.error).toMatch(HANDSHAKE_FAIL_RE);
  });

  it("accepts a CA-signed cert with CN='user_a' and exposes the CN to the handler", async () => {
    const r = await tlsRequest(srv.port, {
      ca: caBuf,
      cert: readFileSync(certs.clientACert),
      key: readFileSync(certs.clientAKey),
    });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(200);
    const json = JSON.parse(r.body ?? "{}") as { ok?: boolean; cn?: string };
    expect(json.ok).toBe(true);
    expect(json.cn).toBe("user_a");
  });

  it("accepts a CA-signed cert with CN='user_b' and exposes the CN to the handler", async () => {
    const r = await tlsRequest(srv.port, {
      ca: caBuf,
      cert: readFileSync(certs.clientBCert),
      key: readFileSync(certs.clientBKey),
    });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(200);
    const json = JSON.parse(r.body ?? "{}") as { ok?: boolean; cn?: string };
    expect(json.cn).toBe("user_b");
  });

  it("the handler observed both CNs from the two successful clients", () => {
    expect(srv.observedCNs).toEqual(
      expect.arrayContaining(["user_a", "user_b"]),
    );
  });
});
