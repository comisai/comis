// SPDX-License-Identifier: Apache-2.0
/**
 * Device Identity — Ed25519 keypair generation, file persistence, and signing.
 * Produces a stable device identity that persists across process restarts.
 * DeviceId is the SHA-256 fingerprint of the public key raw bytes (DER/SPKI).
 * Private key files are written with mode 0o600 for security.
 * @module
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";

import { ok, err, tryCatch } from "@comis/shared";
import type { Result } from "@comis/shared";
import { safePath } from "@comis/core";
import type { DeviceIdentity, DeviceIdentityPort } from "@comis/core";
import { ensureContainedDir, writeRegularFile } from "@comis/observability";

/**
 * Compute the SHA-256 fingerprint of an Ed25519 public key.
 * Exports the key as DER (SPKI), hashes the raw bytes, returns hex string.
 */
export function fingerprintPublicKey(publicKeyPem: string): string {
  const keyObject = crypto.createPublicKey(publicKeyPem);
  const derBytes = keyObject.export({ type: "spki", format: "der" });
  return crypto.createHash("sha256").update(derBytes).digest("hex");
}

/**
 * Generate a new Ed25519 identity (keypair + deviceId).
 */
export function generateIdentity(): DeviceIdentity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  const privateKeyPem = privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  const deviceId = fingerprintPublicKey(publicKeyPem);
  return { deviceId, publicKeyPem, privateKeyPem };
}

/**
 * Load an existing device identity from disk, or create and persist a new one.
 * Identity is stored at `<stateDir>/identity/device.json`.
 * Private key file is written with mode 0o600.
 * Uses atomic write (temp file + rename) for crash safety.
 */
export function loadOrCreateDeviceIdentity(
  stateDir: string,
): Result<DeviceIdentity, Error> {
  const dirResult = tryCatch(() => safePath(stateDir, "identity"));
  if (!dirResult.ok) return dirResult;
  const identityDir = dirResult.value;

  const fileResult = tryCatch(() => safePath(identityDir, "device.json"));
  if (!fileResult.ok) return fileResult;
  const filePath = fileResult.value;

  // Try loading existing identity
  const readResult = tryCatch(() => fs.readFileSync(filePath, "utf-8"));
  if (readResult.ok) {
    const parseResult = tryCatch(() =>
      JSON.parse(readResult.value) as DeviceIdentity,
    );
    if (!parseResult.ok) return parseResult;
    return ok(parseResult.value);
  }

  // Generate new identity
  const identity = generateIdentity();

  // Create identity directory at mode 0o700 per design §1.4. Migrated to
  // `ensureContainedDir` (Phase 48 OBS-HARD-03); the outer `tryCatch`
  // wrapper is removed — the substrate already returns Result, so wrapping
  // it added a redundant Result-wrapping layer.
  const mkdirResult = ensureContainedDir({
    dir: identityDir,
    mode: 0o700,
    confinedBaseDir: stateDir,
  });
  if (!mkdirResult.ok) return err(mkdirResult.error);

  // Atomic write: substrate-routed tmp write -> rename. The substrate's
  // `fchmod(fd, 0o600)` inside `writeRegularFile` replaces the explicit
  // `chmodSync(tmpPath, 0o600)` step; the rename remains a separate
  // primitive (atomic-replace semantics are out of scope for the
  // substrate, which is a single-file primitive).
  const tmpPath = filePath + `.tmp.${crypto.randomBytes(4).toString("hex")}`;
  const json = JSON.stringify(identity, null, 2);
  const writeResult = writeRegularFile({
    path: tmpPath,
    content: json,
    confinedBaseDir: stateDir,
  });
  if (!writeResult.ok) {
    tryCatch(() => fs.unlinkSync(tmpPath));
    return err(writeResult.error);
  }
  const renameResult = tryCatch(() => fs.renameSync(tmpPath, filePath));
  if (!renameResult.ok) {
    tryCatch(() => fs.unlinkSync(tmpPath));
    return err(renameResult.error);
  }

  return ok(identity);
}

/**
 * Factory: create a DeviceIdentityPort adapter from an existing identity.
 */
export function createDeviceIdentityAdapter(
  identity: DeviceIdentity,
): DeviceIdentityPort {
  return {
    identity,

    sign(data: Buffer): Buffer {
      const privateKey = crypto.createPrivateKey(identity.privateKeyPem);
      return Buffer.from(crypto.sign(null, data, privateKey));
    },

    verify(data: Buffer, signature: Buffer, publicKeyPem: string): boolean {
      const publicKey = crypto.createPublicKey(publicKeyPem);
      return crypto.verify(null, data, publicKey, signature);
    },
  };
}
