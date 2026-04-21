// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";
import type { TLSSocket } from "node:tls";
import { ok, err } from "@comis/shared";
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * TLS certificate paths for mTLS validation.
 */
export interface CertPaths {
  readonly certPath: string;
  readonly keyPath: string;
  readonly caPath: string;
}

/**
 * Validate that certificate files exist, are readable PEM, and are not expired.
 *
 * Called at startup to fail fast if TLS config is misconfigured.
 * Returns Result<void, Error> — no silent failures.
 */
export function validateCertificates(paths: CertPaths): Result<void, Error> {
  const files = [
    { label: "server certificate", path: paths.certPath },
    { label: "server key", path: paths.keyPath },
    { label: "CA certificate", path: paths.caPath },
  ];

  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(file.path, "utf-8");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(new Error(`Failed to read ${file.label} at ${file.path}: ${msg}`));
    }

    if (!content.includes("-----BEGIN ")) {
      return err(new Error(`${file.label} at ${file.path} does not appear to be PEM format`));
    }
  }

  // Validate cert and CA are not expired
  const certFiles = [
    { label: "server certificate", path: paths.certPath },
    { label: "CA certificate", path: paths.caPath },
  ];

  for (const file of certFiles) {
    try {
      const pem = readFileSync(file.path, "utf-8");
      const cert = new X509Certificate(pem);
      const notAfter = new Date(cert.validTo);
      if (notAfter.getTime() < Date.now()) {
        return err(new Error(`${file.label} at ${file.path} expired on ${cert.validTo}`));
      }
    } catch (e: unknown) {
      // If it's our own Error from above, re-throw; otherwise wrap
      if (e instanceof Error && e.message.startsWith("Failed to read")) {
        return err(e);
      }
      const msg = e instanceof Error ? e.message : String(e);
      return err(new Error(`Failed to parse ${file.label} at ${file.path}: ${msg}`));
    }
  }

  return ok(undefined);
}

/**
 * Extract the Common Name (CN) from a TLS client certificate.
 *
 * Returns null if the socket has no authorized client certificate
 * or the certificate has no subject CN.
 */
export function extractClientCN(socket: TLSSocket): string | null {
  if (!socket.authorized) {
    return null;
  }

  const cert = socket.getPeerCertificate();
  if (!cert || !cert.subject) {
    return null;
  }

  const cn = cert.subject.CN ?? null;
  return Array.isArray(cn) ? cn[0] ?? null : cn;
}
